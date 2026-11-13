// A device writing a budget's log, entry on entry (as packages/seal/test/budget.ts does), for the Worker's tests
// of the log store and its routes.
import {
  deriveBudgetKeys,
  encodeGenesis,
  KIND,
  newInbox,
  newSlotRecord,
  passkeySlot,
  publicEntry,
  randomBytes,
  recoverySlot,
  sealedEntry,
  utf8,
  type BudgetKeys,
  type Bytes,
  type Entry,
  type Kind,
} from '@ledgerline/seal';

export const BUDGET = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
export const PHONE = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
export const T0 = 1_800_000_000_000;

/** A device writing a budget's log, entry on entry (as packages/seal/test/budget.ts does). */
export class Writer {
  constructor(
    readonly budgetId: string = BUDGET,
    start: number = T0,
  ) {
    this.time = start;
  }

  keys!: BudgetKeys;
  bk = randomBytes(32);
  last: Entry | null = null;
  time: number;
  counter = 0;
  /** The inbox pair of version 1, private half too: a device holds it. */
  inbox: unknown = null;

  fields(kind: Kind, over: Record<string, unknown> = {}) {
    this.time += 1000;
    return {
      kind,
      budgetId: this.budgetId,
      number: (this.last?.header.number ?? 0) + 1,
      prevHash: this.last?.hash ?? (new Uint8Array(32) as Bytes),
      entryId: randomBytes(16),
      time: this.time,
      deviceId: PHONE,
      deviceCounter: ++this.counter,
      keyVersion: 1,
      schemaVersion: 1,
      processingVersion: 1,
      part: 1,
      parts: 1,
      filedThrough: 0,
      receipts: [],
      scanThrough: 0,
      ...over,
    };
  }

  async genesis(): Promise<Entry> {
    this.keys = await deriveBudgetKeys(this.bk, this.budgetId, 1);
    const inbox = await newInbox(this.keys, this.budgetId, 1);
    this.inbox = inbox.pair;
    const pub = this.keys.sign.pub;
    const body = encodeGenesis({
      signPub: pub,
      inboxPub: inbox.pair.pub,
      wrappedInbox: inbox.wrapped,
      slots: [
        await newSlotRecord(
          await passkeySlot(randomBytes(32), this.budgetId, randomBytes(16)),
          this.bk,
          this.keys,
          this.budgetId,
          pub,
        ),
        await newSlotRecord(await recoverySlot(randomBytes(32), 1), this.bk, this.keys, this.budgetId, pub),
      ],
    });
    return (this.last = await publicEntry(this.fields(KIND.genesis), body, this.keys));
  }

  /** A sealed entry of any kind with a change set's place (a bank entry, a scan). */
  async entry(kind: Kind, text: string, over: Record<string, unknown> = {}): Promise<Entry> {
    return (this.last = await sealedEntry(this.fields(kind, over), utf8(text), this.keys));
  }

  async edit(text: string, over: Record<string, unknown> = {}): Promise<Entry> {
    return (this.last = await sealedEntry(this.fields(KIND.edit, over), utf8(text), this.keys));
  }
}
