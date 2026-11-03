// The copy's keys (docs/phone-budget.md 13.2, D-45): the passkey's PRF output and the device's server share together
// open the copy; neither alone does, another passkey doesn't, opening with no signal stops after 7 days, and a changed copy
// doesn't decrypt.
import { describe, expect, it } from 'vitest';
import {
  CopyUnreadable,
  newKeys,
  openCopy,
  randomBytes,
  sameBytes,
  sealCopy,
  openKey,
  openKeyOffline,
  type CopyRecord,
} from '../src/copy/vault';

const base = () => ({
  key: 'owner@example.com:b1',
  who: { budgetId: 'b1', userId: 'owner@example.com', email: 'owner@example.com' },
  deviceId: 'dev1',
  salt: randomBytes(32),
  lastServerTime: Date.now(),
  savedAt: Date.now(),
});
const bytes = new TextEncoder().encode('SQLite format 3 — the budget').buffer;

async function made() {
  const prf = randomBytes(32);
  const share = randomBytes(32);
  const { record, dataKey } = await newKeys(base(), 'cred1', prf, share);
  const r: CopyRecord = { ...record, blob: await sealCopy(record, dataKey, bytes) };
  return { r, prf, share };
}

describe('the copy’s keys', () => {
  it('the passkey and the share open it', async () => {
    const { r, prf, share } = await made();
    const u = await openKey(r, 'cred1', prf, share);
    expect(new TextDecoder().decode((await openCopy(r, u.dataKey))!)).toContain('the budget');
  });

  it('a wrong share (a revoked device) or a wrong passkey output does not', async () => {
    const { r, prf, share } = await made();
    await expect(openKey(r, 'cred1', prf, randomBytes(32))).rejects.toThrow();
    await expect(openKey(r, 'cred1', randomBytes(32), share)).rejects.toThrow();
    await expect(openKey(r, 'cred2', prf, share)).rejects.toThrow('other_passkey');
  });

  it('opens with no signal for 7 days after the last sign-in, never with the clock set back', async () => {
    const { r, prf } = await made();
    const key = await openKeyOffline(r, 'cred1', prf, r.lastServerTime + 6 * 86_400_000);
    expect(new TextDecoder().decode((await openCopy(r, key))!)).toContain('the budget');
    await expect(openKeyOffline(r, 'cred1', prf, r.lastServerTime + 8 * 86_400_000)).rejects.toThrow(
      'offline_expired',
    );
    await expect(openKeyOffline(r, 'cred1', prf, r.lastServerTime - 60_000)).rejects.toThrow(
      'offline_expired',
    );
  });

  it('a changed copy, or one moved to another device, does not decrypt', async () => {
    const { r, prf, share } = await made();
    const { dataKey } = await openKey(r, 'cred1', prf, share);
    const data = new Uint8Array(r.blob!.data.slice(0));
    data[5] = data[5]! ^ 1;
    await expect(openCopy({ ...r, blob: { ...r.blob!, data: data.buffer } }, dataKey)).rejects.toThrow();
    await expect(openCopy({ ...r, deviceId: 'dev2' }, dataKey)).rejects.toThrow();
  });

  it('says which step could not be opened, so the app can start a new copy', async () => {
    const { r, prf } = await made();
    await expect(openKey(r, 'cred1', prf, randomBytes(32))).rejects.toEqual(new CopyUnreadable('key'));
    await expect(openKeyOffline(r, 'cred1', randomBytes(32), r.lastServerTime)).rejects.toEqual(
      new CopyUnreadable('share'),
    );
    expect(sameBytes(r.salt, r.salt.slice(0))).toBe(true);
    expect(sameBytes(r.salt, randomBytes(32))).toBe(false);
  });
});
