// Undo after Unpair: the unpair answer names the other side, and picking it pairs the two again, on the seeded
// November budget (Checking's transfer to Marcus savings).
import { app } from './phone.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TxnSheet } from '@ledgerline/contracts';

const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };
const post = (p: string, body: unknown) => app(p, { method: 'POST', headers: H, body: JSON.stringify(body) });
const sheet = async (key: string) => (await (await app(`/api/transactions/${key}`)).json()) as TxnSheet;

describe('unpair, then Undo', () => {
  beforeAll(async () => {
    expect((await post('/__dev/seed-november', {})).status).toBe(200);
  });

  it('names the other side, and a pick of it pairs them again', async () => {
    const before = await sheet('n-to-marcus');
    expect(before.kind).toBe('transfer');
    const un = await post('/api/transfers/n-to-marcus/unpair', {});
    expect(un.status).toBe(200);
    const { otherKey } = (await un.json()) as { otherKey?: string };
    expect(otherKey).toBeTruthy();
    expect((await sheet('n-to-marcus')).kind).not.toBe('transfer');
    expect((await post('/api/transfers/n-to-marcus/pick', { otherKey })).status).toBe(200);
    const after = await sheet('n-to-marcus');
    expect(after.kind).toBe('transfer');
    expect(after.otherAccountName).toBe(before.otherAccountName);
  });
});
