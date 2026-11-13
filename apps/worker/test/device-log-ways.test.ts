// A public entry the app makes with the budget key in hand (a way in added or removed: apps/web/src/copy/
// sealed-ways.ts) goes where the device's log says (DeviceLog.writePlace), and the log takes it by its own rules;
// the keys of a new version are handed to the log (DeviceLog.holdKeys).
import {
  deriveBudgetKeys,
  encodeGenesis,
  encodeSlotChange,
  KIND,
  newInbox,
  newSlotRecord,
  passkeySlot,
  publicEntry,
  randomBytes,
  recoverySlot,
  startChain,
  type Bytes,
} from '@ledgerline/seal';
import { describe, expect, it } from 'vitest';
import { DeviceLog } from '../src/local/device-log.js';

const BUDGET = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const PHONE = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const T0 = 1_800_000_000_000;

const fields = (o: Record<string, unknown>) => ({
  budgetId: BUDGET,
  entryId: randomBytes(16),
  deviceId: PHONE,
  keyVersion: 1,
  schemaVersion: 1,
  processingVersion: 1,
  part: 1,
  parts: 1,
  filedThrough: 0,
  receipts: [],
  scanThrough: 0,
  ...o,
});

describe('a public entry the app makes, on the device’s log', () => {
  it('goes on top of the device’s place, with its next counter and a later time, and is taken', async () => {
    const bk = randomBytes(32);
    const keys = await deriveBudgetKeys(bk, BUDGET, 1);
    const inbox = await newInbox(keys, BUDGET, 1);
    const pub = keys.sign.pub;
    const genesis = await publicEntry(
      fields({
        kind: KIND.genesis,
        number: 1,
        prevHash: new Uint8Array(32) as Bytes,
        time: T0,
        deviceCounter: 1,
      }),
      encodeGenesis({
        signPub: pub,
        inboxPub: inbox.pair.pub,
        wrappedInbox: inbox.wrapped,
        slots: [
          await newSlotRecord(
            await passkeySlot(randomBytes(32), BUDGET, randomBytes(16)),
            bk,
            keys,
            BUDGET,
            pub,
          ),
          await newSlotRecord(await recoverySlot(randomBytes(32), 1), bk, keys, BUDGET, pub),
        ],
      }),
      keys,
    );
    // The device's clock is behind the entry before: the time still goes up.
    let clock = T0 - 5000;
    const log = new DeviceLog(
      keys,
      await startChain(genesis, { now: T0, schemaVersion: 1 }, BUDGET),
      PHONE,
      () => clock,
    );
    const at = log.writePlace();
    expect(at).toMatchObject({
      number: 1,
      deviceId: PHONE,
      deviceCounter: 1,
      filedThrough: 0,
      scanThrough: 0,
      time: T0 + 1,
      keyVersion: 1,
      whole: true,
      lastPublic: { number: 1 },
    });
    expect([...at.hash]).toEqual([...genesis.hash]);

    clock = T0 + 60_000;
    const slot = await publicEntry(
      fields({
        kind: KIND.slotChange,
        number: at.number + 1,
        prevHash: at.hash,
        time: log.writePlace().time,
        deviceCounter: at.deviceCounter + 1,
      }),
      encodeSlotChange({
        prevPublic: at.lastPublic,
        slots: [
          await newSlotRecord(
            await passkeySlot(randomBytes(32), BUDGET, randomBytes(16)),
            bk,
            keys,
            BUDGET,
            pub,
          ),
        ],
      }),
      keys,
    );
    expect(await log.take([slot])).toEqual([]);
    // The clock has not moved since: one millisecond after the entry before.
    expect(log.writePlace()).toMatchObject({
      number: 2,
      deviceCounter: 2,
      time: T0 + 60_001,
      lastPublic: { number: 2 },
    });
    expect((log.publicState.slots as Map<string, unknown>).size).toBe(3);

    // The keys of a new version join the ones held; a version held already is kept as it is.
    const next = await deriveBudgetKeys(randomBytes(32), BUDGET, 2);
    log.holdKeys([await deriveBudgetKeys(randomBytes(32), BUDGET, 1), next]);
    expect(log.keysHeld().map((k) => k.version)).toEqual([1, 2]);
    expect(log.keysHeld()[0]).toBe(keys);
  });
});
