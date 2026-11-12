// A device's copy tied to the budget's sealed log (docs/privacy.md 5.3, "Redoing a refused write"). The copy is a
// confirmed base (the log up to the last entry this device has taken) plus the queue of edits made here and not
// yet in the log; the screens show base plus queue. This object sends each waiting edit as an entry and reads the
// entries of other devices. When the log has moved on (the server answers "behind"), the engine takes the queue
// out, the newer entries are written into the base, and the queue is run again on top: an edit that no longer
// passes is lost, and the person is told.
//
// In this mode the copy's change number (`EngineState.through`) is the number of the last log entry in the base.
import { KIND, readEntry, type Entry } from '@ledgerline/seal';
import type { SyncPage, SyncRow } from '../routes/sync.js';
import type { AppendResult } from '../seal/log-store.js';
import type { DeviceLog } from './device-log.js';
import { RECORDED_TABLES, type LocalEngine } from './engine.js';

/** How the device reaches the server's log store. */
export interface LogTransport {
  /** The entries after `number`, in order, as stored. */
  after(number: number): Promise<Uint8Array[]>;
  /** One write on top of entry `base`. */
  append(base: number, entries: Uint8Array[]): Promise<AppendResult>;
}

/** Guards a loop against a server that says "behind" for ever. */
const MAX_ROUNDS = 8;

export class LogSession {
  constructor(
    private readonly engine: LocalEngine,
    private readonly log: DeviceLog,
    private readonly transport: LogTransport,
    private readonly encode: (e: Entry) => Uint8Array,
  ) {}

  /**
   * Reads what the log holds past this device's place and writes it into the base, under the queue. Gives how
   * many entries came and how many waiting edits were lost to them.
   */
  async pull(): Promise<{ entries: number; lost: number }> {
    const fresh = await this.transport.after(this.log.number);
    if (!fresh.length) return { entries: 0, lost: 0 };
    const entries: Entry[] = [];
    for (const bytes of fresh) entries.push(await readEntry(bytes));
    // Checked by the log's rules before anything is written: a bad entry throws here and the copy is untouched.
    const taken = await this.log.read(entries);
    const rows: SyncRow[] = taken.sets.flatMap((s) => s.set.rows);
    const st = await this.engine.state();
    // Written as one page of changes that ends at the log's new last entry. The device's measured distance from
    // the server's clock stays as it is.
    const received = Date.now();
    const page: SyncPage = {
      format: st.format,
      epoch: st.epoch ?? 'log',
      serverTime: received + st.offset,
      through: taken.number,
      more: false,
      cursor: null,
      rows,
    };
    // The rows go into the copy first (the engine refuses rows no honest device writes, and then nothing is
    // written); only then are the entries this device's place in the log.
    const r = await this.engine.apply(page, received, RECORDED_TABLES);
    taken.commit();
    if (await this.engine.needsDerive()) await this.engine.derive();
    return { entries: entries.length, lost: r.lost ?? 0 };
  }

  /**
   * Sends the waiting edits, oldest first, each as its own write. Gives how many the log took and how many were
   * lost on the way (run again on newer entries, they no longer passed).
   */
  async flush(): Promise<{ sent: number; lost: number }> {
    let sent = 0;
    let lost = 0;
    for (let round = 0; round < MAX_ROUNDS;) {
      const e = (await this.engine.queue())[0];
      if (!e) break;
      const st = await this.engine.state();
      // An edit with no recorded rows, or recorded on another base, can't become an entry as it is: read the log
      // (the engine runs the queue again on top, which records it anew), then look again.
      if (!e.rows || e.through !== st.through || st.through !== this.log.number) {
        round++;
        lost += (await this.pull()).lost;
        const again = (await this.engine.queue())[0];
        if (again?.id === e.id && (!again.rows || again.through !== (await this.engine.state()).through)) {
          // Nothing newer to read and still not exact: this copy can't make the entry (an edit queued by an older
          // version of the app). It is dropped from the queue, and counted.
          await this.engine.queueDone(e.id);
          lost += 1;
        }
        continue;
      }
      const entries = await this.log.build(KIND.edit, { at: e.at, rows: e.rows });
      const answer = await this.transport.append(this.log.number, entries.map(this.encode));
      if (answer.ok) {
        await this.log.take(entries);
        await this.engine.queueSent(e.id, this.log.number);
        sent++;
        continue;
      }
      if (answer.why === 'behind' || answer.retry) {
        // The log moved on (or the server asks to try later): read it, which runs the queue again, and go round.
        round++;
        lost += (await this.pull()).lost;
        if (answer.why !== 'behind') break;
        continue;
      }
      // The server refused the entry for good: the edit comes out of the copy, and the later ones run again.
      const out = await this.engine.queueRefused(e.id);
      lost += 1 + out.lost;
    }
    return { sent, lost };
  }
}
