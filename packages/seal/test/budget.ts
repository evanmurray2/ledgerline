// A budget being written entry by entry the way a device would: the helper the log's tests share.
import {
  advance,
  type BudgetKeys,
  type Bytes,
  ChainError,
  type ChainState,
  deriveBudgetKeys,
  encodeGenesis,
  encodeIntent,
  encodeKeyChange,
  encodeSlotChange,
  type Entry,
  type EntryFields,
  type KeyChange,
  KIND,
  type Kind,
  newInbox,
  newSlotRecord,
  passkeySlot,
  publicEntry,
  randomBytes,
  recoverySlot,
  resealSlotRecord,
  rewrapInbox,
  sealedEntry,
  type SlotSecrets,
  startChain,
  utf8,
  wrapPrevKey,
} from '../src/index.js';
import { expect } from 'vitest';

export const BUDGET = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
export const PHONE = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
export const LAPTOP = '01CX5ZZKBKACTAV9WEVGEMMVRZ';
export const T0 = 1_800_000_000_000;

/** A budget being written: its keys, its log, and where the chain stands. */
export class Budget {
  bk!: Bytes;
  keys!: BudgetKeys;
  entries: Entry[] = [];
  state!: ChainState;
  counters = new Map<string, number>();
  time = T0;
  passkey!: SlotSecrets;
  recovery!: SlotSecrets;

  static async create(): Promise<Budget> {
    const b = new Budget();
    b.bk = randomBytes(32);
    b.keys = await deriveBudgetKeys(b.bk, BUDGET, 1);
    b.passkey = await passkeySlot(randomBytes(32), BUDGET, randomBytes(16));
    b.recovery = await recoverySlot(randomBytes(32), 1);
    const inbox = await newInbox(b.keys, BUDGET, 1);
    const body = encodeGenesis({
      signPub: b.keys.sign.pub,
      inboxPub: inbox.pair.pub,
      wrappedInbox: inbox.wrapped,
      slots: [
        await newSlotRecord(b.passkey, b.bk, b.keys, BUDGET, b.keys.sign.pub),
        await newSlotRecord(b.recovery, b.bk, b.keys, BUDGET, b.keys.sign.pub),
      ],
    });
    const e = await publicEntry(b.fields(KIND.genesis, PHONE), body, b.keys);
    b.entries.push(e);
    b.state = await startChain(e, b.checker, BUDGET);
    return b;
  }

  /** The checker's clock is the writer's: the last time handed out. */
  get checker() {
    return { now: this.time, schemaVersion: 1 };
  }

  /** The header fields of the next entry from `device`. */
  fields(kind: Kind, device: string, over: Partial<EntryFields> = {}): EntryFields {
    const counter = (this.counters.get(device) ?? 0) + 1;
    this.counters.set(device, counter);
    this.time += 1000;
    const prev = this.entries.at(-1);
    return {
      kind,
      budgetId: BUDGET,
      number: (prev?.header.number ?? 0) + 1,
      prevHash: prev?.hash ?? (new Uint8Array(32) as Bytes),
      entryId: randomBytes(16),
      time: this.time,
      deviceId: device,
      deviceCounter: counter,
      keyVersion: this.keys?.version ?? 1,
      schemaVersion: 1,
      processingVersion: 1,
      part: 1,
      parts: 1,
      filedThrough: prev?.header.filedThrough ?? 0,
      receipts: [],
      scanThrough: prev?.header.scanThrough ?? 0,
      ...over,
    };
  }

  /** Undoes the counter and clock of entries that were made but refused. */
  undo(): void {
    this.counters = new Map(this.state.counters);
    this.time = this.state.time;
  }

  async take(e: Entry): Promise<Entry> {
    this.state = await advance(this.state, e, this.checker);
    this.entries.push(e);
    return e;
  }

  /** Expects the chain to refuse `e`, and puts the writer's counter and clock back. */
  async refuses(e: Entry | Promise<Entry>, why: string): Promise<void> {
    const p = Promise.resolve(e).then((x) => advance(this.state, x, this.checker));
    await expect(p).rejects.toThrow(ChainError);
    await expect(p).rejects.toThrow(why);
    this.undo();
  }

  edit(device = PHONE, text = 'an edit'): Promise<Entry> {
    return sealedEntry(this.fields(KIND.edit, device), utf8(text), this.keys).then((e) => this.take(e));
  }

  bank(filedThrough: number, device = PHONE): Promise<Entry> {
    const n = filedThrough - this.state.filedThrough;
    const receipts = Array.from({ length: n }, () => randomBytes(32));
    return sealedEntry(
      this.fields(KIND.bank, device, { filedThrough, receipts }),
      utf8('bank rows'),
      this.keys,
    ).then((e) => this.take(e));
  }

  get lastPublic() {
    return this.state.public.lastPublic;
  }

  async addSlot(slot: SlotSecrets, device = PHONE): Promise<Entry> {
    const record = await newSlotRecord(slot, this.bk, this.keys, BUDGET, this.state.public.genesisSignPub);
    const body = encodeSlotChange({ prevPublic: this.lastPublic, slots: [record] });
    return this.take(await publicEntry(this.fields(KIND.slotChange, device), body, this.keys));
  }

  /** The body of a key change that keeps the slots in `keep`, and the keys it puts in force. */
  async keyChangeBody(keep: string[], over: Partial<KeyChange> = {}) {
    const p = this.state.public;
    const bk = randomBytes(32);
    const keys = await deriveBudgetKeys(bk, BUDGET, this.keys.version + 1);
    const inbox = await newInbox(keys, BUDGET, p.inboxVersion + 1);
    const inboxes = [{ version: p.inboxVersion + 1, wrapped: inbox.wrapped }];
    for (const [v, w] of p.inboxes)
      inboxes.push({ version: v, wrapped: await rewrapInbox(this.keys, keys, BUDGET, v, w) });
    const slots = await Promise.all(
      keep.map((id) => resealSlotRecord(p.slots.get(id)!, this.keys, bk, keys, BUDGET)),
    );
    const change: KeyChange = {
      prevPublic: this.lastPublic,
      version: keys.version,
      signPub: keys.sign.pub,
      wrappedPrevKey: await wrapPrevKey(this.keys, keys, BUDGET, this.bk),
      inboxVersion: p.inboxVersion + 1,
      inboxPub: inbox.pair.pub,
      lastOldRun: this.state.filedThrough,
      inboxes,
      slots,
      intent: null,
      ...over,
    };
    return { bk, keys, change };
  }

  async keyChangeEntry(keep: string[], over: Partial<KeyChange> = {}) {
    const { bk, keys, change } = await this.keyChangeBody(keep, over);
    const entry = await publicEntry(this.fields(KIND.keyChange, PHONE), encodeKeyChange(change), this.keys);
    return { bk, keys, entry };
  }

  /** A key change that keeps the slots in `keep` (by id). */
  async keyChange(keep: string[], over: Partial<KeyChange> = {}): Promise<Entry> {
    const { bk, keys, entry } = await this.keyChangeEntry(keep, over);
    await this.take(entry);
    this.bk = bk;
    this.keys = keys;
    return entry;
  }

  intent(notBefore: number, slotIds: string[], device = PHONE): Promise<Entry> {
    return publicEntry(
      this.fields(KIND.intent, device),
      encodeIntent({ prevPublic: this.lastPublic, notBefore, slotIds }),
      this.keys,
    );
  }
}
