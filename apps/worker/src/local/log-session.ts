// A device's copy tied to the budget's sealed log (docs/privacy.md 5.3, "Redoing a refused write"). The copy is a
// confirmed base (the log up to the last entry this device has taken) plus the queue of edits made here and not
// yet in the log; the screens show base plus queue. This object sends each waiting edit as an entry and reads the
// entries of other devices. When the log has moved on (the server answers "behind"), the engine takes the queue
// out, the newer entries are written into the base, and the queue is run again on top: an edit that no longer
// passes is lost, and the person is told.
//
// In this mode the copy's change number (`EngineState.through`) is the number of the last log entry in the base.
import type { BankDataProvider } from '@ledgerline/bank-provider';
import {
  fromHex,
  KIND,
  readEntry,
  readRunManifest,
  RunError,
  toHex,
  type Entry,
  type SealedRun,
} from '@ledgerline/seal';
import type { SyncPage, SyncRow } from '../routes/sync.js';
import type { AppendResult } from '../seal/log-store.js';
import { entryIdOf, TooLarge, type DeviceLog } from './device-log.js';
import { FilingInterrupted, RECORDED_TABLES, type LocalEngine } from './engine.js';
import { CopyAhead, fileOpened, filedOf, filingState, openRuns } from './sealed-filing.js';

/** How the device reaches the server's log store. */
export interface LogTransport {
  /** The entries after `number`, in order, as stored. */
  after(number: number): Promise<Uint8Array[]>;
  /** One write on top of entry `base`. */
  append(base: number, entries: Uint8Array[]): Promise<AppendResult>;
}

/** How the device reaches the server's store of sealed bank runs (seal/log-routes.ts). */
export interface RunTransport {
  /** The complete runs after `run`, in order: each manifest, its signature and its number of pages. */
  runs(after: number): Promise<{ run: number; manifest: Uint8Array; signature: Uint8Array; pages: number }[]>;
  /** One sealed page of a complete run. */
  page(run: number, page: number): Promise<Uint8Array>;
}

/** What filing needs besides the log: the Worker's run-signing keys this app accepts, and a reader of bank pages. */
export interface FilingDeps {
  /** By key number (docs/privacy-keys.md 9.1): built into the app. */
  workerKeys: Map<number, Uint8Array>;
  /** Reads a page (`parsePage`): the bank's format, no network. */
  provider: BankDataProvider;
  /** The device's clock, as the server's (the engine's `now`). */
  now: number;
}

/** The most runs one bank entry files: a return after weeks away is a handful of writes (docs/privacy.md section 9). */
export const RUNS_PER_ENTRY = 16;

/** Guards a loop against a server that says "behind" for ever. */
const MAX_ROUNDS = 8;

export class LogSession {
  constructor(
    private readonly engine: LocalEngine,
    private readonly log: DeviceLog,
    private readonly transport: LogTransport,
    private readonly encode: (e: Entry) => Uint8Array,
  ) {}

  /** The name the device's place in the log is kept under, with its copy (`LocalEngine.note`). */
  static readonly PLACE = 'device_log';

  /** Keeps this device's place in the log with its copy, so a closed app goes on from there. */
  private async keep(): Promise<void> {
    await this.engine.note(LogSession.PLACE, this.log.save());
  }

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
    // A change of this device's own that the log holds already (its answer was lost, or the app was closed before
    // it was noted) leaves the queue as sent: its rows are in the copy and in the entry, and it is not run again.
    const mine = new Set(taken.sets.filter((s) => s.deviceId === this.log.deviceId).map((s) => s.entryId));
    if (mine.size)
      for (const e of await this.engine.queue())
        if (mine.has(toHex(await entryIdOf(e.id)))) await this.engine.queueDone(e.id);
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
    await this.keep();
    if (await this.engine.needsDerive()) await this.engine.derive();
    return { entries: entries.length, lost: r.lost ?? 0 };
  }

  /**
   * Sends the waiting edits, oldest first, each as its own write. Gives how many the log took and how many were
   * lost on the way (run again on newer entries, they no longer passed).
   */
  async flush(
    o: { onlyBank?: boolean } = {},
  ): Promise<{ sent: number; lost: number; bank?: 'sent' | 'waits' | 'out' | 'too large' }> {
    let sent = 0;
    let lost = 0;
    let bank: 'sent' | 'waits' | 'out' | 'too large' | undefined;
    /** Filed runs come out of the copy exactly, or the copy can't be used as it is. */
    const bankOut = async (id: string) => {
      const out = await this.engine.queueRefused(id);
      if (out.redownload) throw new CopyAhead();
      lost += out.lost;
      bank = 'out';
    };
    for (let round = 0; round < MAX_ROUNDS;) {
      const e = (await this.engine.queue())[0];
      if (!e || (o.onlyBank && !e.bank)) break;
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
          if (again.bank) await bankOut(e.id);
          else {
            await this.engine.queueDone(e.id);
            lost += 1;
          }
        } else if (e.bank && again?.id !== e.id) bank = 'out';
        continue;
      }
      let entries: Entry[];
      try {
        const entryId = await entryIdOf(e.id);
        entries = e.bank
          ? await this.log.build(
              KIND.bank,
              { at: e.at, rows: e.rows },
              {
                filedThrough: e.bank.filedThrough,
                receipts: e.bank.receipts.map((r) => fromHex(r)),
                entryId,
              },
            )
          : await this.log.build(KIND.edit, { at: e.at, rows: e.rows }, { entryId });
      } catch (x) {
        // Too many runs for one write: they come out of the copy, and the device files fewer at a time.
        if (!(x instanceof TooLarge) || !e.bank) throw x;
        await bankOut(e.id);
        bank = 'too large';
        break;
      }
      const answer = await this.transport.append(this.log.number, entries.map(this.encode));
      if (answer.ok) {
        await this.log.take(entries);
        await this.engine.queueSent(e.id, this.log.number);
        await this.keep();
        sent++;
        if (e.bank) bank = 'sent';
        continue;
      }
      if (answer.why === 'behind' || answer.retry) {
        // The log moved on (or the server asks to try later): read it, which runs the queue again, and go round.
        round++;
        lost += (await this.pull()).lost;
        if (e.bank) bank = (await this.engine.queue())[0]?.id === e.id ? 'waits' : 'out';
        if (answer.why !== 'behind') break;
        continue;
      }
      if (answer.why === 'entry id') {
        // The log holds an entry with this change's id: the change itself, sent before with its answer lost
        // (sealed again, its bytes differ). Read the log: the device knows its own entry, and the change leaves
        // the queue as sent. Only if it is still waiting after that was it refused.
        round++;
        lost += (await this.pull()).lost;
        if ((await this.engine.queue())[0]?.id !== e.id) {
          if (e.bank) bank = 'sent';
          continue;
        }
      }
      // The server refused the entry for good: the edit comes out of the copy, and the later ones run again.
      if (e.bank) {
        // Filed runs the server won't take are not sent again in this call: the device opens the runs anew.
        await bankOut(e.id);
        break;
      }
      const out = await this.engine.queueRefused(e.id);
      lost += 1 + out.lost;
    }
    return bank ? { sent, lost, bank } : { sent, lost };
  }

  /**
   * Files the bank runs that wait on the server, oldest first, up to `RUNS_PER_ENTRY` to an entry: each run is
   * checked and opened, filed on the copy under the waiting edits, and sent as a bank entry with the receipts
   * that prove this device opened every page. Gives how many runs the log took. `waiting`: runs are left that
   * this device can't file yet (a run dated ahead of its clock, an inbox key it hasn't got) or couldn't get into
   * the log this time. A run that is not what the Worker made throws `RunError`; one this app can't file throws
   * `UnsupportedRun`. A copy that can't be used as it is throws `CopyAhead` or `FilingInterrupted`: it is made
   * again from the log. Nothing is skipped: edits wait behind unfiled runs (5.3, "bank runs first").
   */
  async fileRuns(
    src: RunTransport,
    deps: FilingDeps,
  ): Promise<{ filed: number; waiting: boolean; lost: number }> {
    let filed = 0;
    let lost = 0;
    let limit = RUNS_PER_ENTRY;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (await this.engine.filingInterrupted()) throw new FilingInterrupted();
      lost += (await this.pull()).lost;
      // Runs filed here and not yet in the log go first.
      const waits = (await this.engine.queue())[0];
      if (waits?.bank) {
        const runs = waits.bank.receipts.length;
        const r = await this.flush({ onlyBank: true });
        lost += r.lost;
        if (r.bank === 'sent') filed += runs;
        else if (r.bank === 'too large') {
          // One run alone that is too large for a write can't be filed by this version of the app.
          if (limit === 1) throw new TooLarge('one bank run is too large for one write');
          limit = Math.max(1, limit >> 1);
        } else if (r.bank !== 'out') return { filed, waiting: true, lost };
        continue;
      }
      const from = this.log.filedThrough;
      // The copy stands where the log does: what it has filed is what the log says is filed. A copy that says
      // more holds filed rows that are in neither the queue nor the log.
      const copy = (await filedOf(this.engine.db, this.log.budgetId)).run;
      if (copy > from) throw new CopyAhead();
      if (copy < from) return { filed, waiting: true, lost };
      // An edit that can't be taken out exactly (it is on its way, or has nothing kept for it) must go first.
      if (!(await this.engine.canFileBank())) return { filed, waiting: true, lost };
      const next = (await src.runs(from)).slice(0, limit);
      if (!next.length) return { filed, waiting: false, lost };
      const sealed: SealedRun[] = [];
      for (const r of next) {
        // How many pages a run has is what its manifest says, never what the server says beside it.
        let count = 0;
        try {
          count = readRunManifest(r.manifest).pages.length;
        } catch {
          count = 0;
        }
        const pages: Uint8Array[] = [];
        for (let p = 0; p < count; p++) pages.push(await src.page(r.run, p));
        sealed.push({ manifest: r.manifest, signature: r.signature, pages });
      }
      const state = await filingState(this.engine.db, this.log.budgetId, {
        workerKeys: deps.workerKeys,
        ...this.log.inboxes,
        inbox: (v) => this.log.inbox(v),
        now: deps.now,
      });
      let opened;
      try {
        opened = await openRuns(state, sealed);
      } catch (x) {
        // The cause may be this device (its clock, a key it hasn't got yet): the runs wait, and nothing is wrong.
        if (x instanceof RunError && x.retry) return { filed, waiting: true, lost };
        throw x;
      }
      const last = opened[opened.length - 1]!;
      const done = await this.engine.fileBank(
        `bank-${from + 1}-${last.manifest.run}-${crypto.randomUUID().slice(0, 8)}`,
        last.manifest.runTime,
        { filedThrough: last.manifest.run, receipts: opened.map((f) => toHex(f.receipt)) },
        async (env) => {
          for (const f of opened) await fileOpened(env, this.log.budgetId, f, deps.provider);
        },
      );
      if (done) lost += done.lost;
    }
    return { filed, waiting: true, lost };
  }
}
