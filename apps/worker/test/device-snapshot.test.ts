// A copy as a snapshot's chunks, and the hash of every table (src/local/device-snapshot.ts): a copy rebuilt from
// the chunks has the same hashes, and a copy that differs in one row says which table.
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  differingTables,
  dumpChunks,
  rowsOfChunk,
  schemaOfChunk,
  SnapshotFormatError,
  tableHashes,
  HASH_START,
  hashStep,
} from '../src/local/device-snapshot.js';
import type { LocalEngine } from '../src/local/engine.js';
import { syncPhone } from './phone.js';
import { newPhone } from './twin.js';

const ORIGIN = 'https://ledgerline.test';
const H = { origin: ORIGIN, 'content-type': 'application/json', 'x-ledgerline': '1' };

const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

describe('a copy as a snapshot', () => {
  let a: LocalEngine;
  beforeAll(async () => {
    const r = await SELF.fetch(`${ORIGIN}/__dev/seed-november`, { method: 'POST', headers: H, body: '{}' });
    expect(r.status).toBe(200);
    a = await syncPhone(await newPhone());
  });

  it('rebuilt from its chunks, a copy has the same table hashes', async () => {
    const hashes = await tableHashes(a.db);
    // Hashed a few rows at a time, with the place kept as plain JSON between the steps (the server's freeze
    // does so), the hashes are the same.
    for (const rows of [1, 7, 10_000]) {
      let p = HASH_START;
      let steps = 0;
      for (;;) {
        const r = await hashStep(a.db, JSON.parse(JSON.stringify(p)) as typeof p, rows, 1_000_000);
        steps++;
        p = r.progress;
        if (r.finished) break;
      }
      expect(p.done.map((t) => t.hash)).toEqual(hashes.map((t) => toHex(t.hash)));
      expect(p.done.map((t) => t.name)).toEqual(hashes.map((t) => t.name));
      if (rows === 1) expect(steps).toBeGreaterThan(50);
    }
    // A step also ends on its byte limit.
    expect((await hashStep(a.db, HASH_START, 10_000, 1)).finished).toBe(false);
    expect(hashes.length).toBeGreaterThan(10);
    // Worked out again, the same.
    expect(differingTables(hashes, await tableHashes(a.db))).toEqual([]);

    // Small chunks, to cut the copy in many places.
    const chunks = await dumpChunks(a.db, 20_000);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(20_000);
    // One chunk holds it all at the usual size, and the bytes are the same.
    const whole = await dumpChunks(a.db);
    expect(whole.length).toBe(1);
    expect(whole[0]!.length).toBe(chunks.reduce((n, c) => n + c.length, 0));

    const b = await newPhone();
    for (const c of chunks) await b.applyRows(rowsOfChunk(c));
    expect(differingTables(hashes, await tableHashes(b.db))).toEqual([]);
    // What a copy works out for itself is not in a snapshot: the rebuilt copy works it out.
    const rta = async (e: LocalEngine) =>
      (await e.db.prepare(`SELECT rta FROM budget`).first<{ rta: number }>())!.rta;
    await b.derive();
    expect(await rta(b)).toBe(await rta(a));
    expect(differingTables(hashes, await tableHashes(b.db))).toEqual([]);

    // One row differs: the table is named.
    await b.db
      .prepare(`UPDATE category SET name = name || '!' WHERE id = (SELECT id FROM category LIMIT 1)`)
      .run();
    expect(differingTables(hashes, await tableHashes(b.db))).toEqual(['category']);
    // A row more, in a table that had none.
    await b.db.prepare(`INSERT INTO txn_key_move (old_key, new_key, at) VALUES ('old', 'new', 1)`).run();
    expect(differingTables(hashes, await tableHashes(b.db))).toEqual(['category', 'txn_key_move']);
  });

  it('an empty copy is one empty chunk; bytes that are not rows are refused', async () => {
    const empty = await newPhone();
    const chunks = await dumpChunks(empty.db);
    // One chunk: the line that lists each table's columns, and no row.
    expect(chunks.length).toBe(1);
    expect(rowsOfChunk(chunks[0]!)).toEqual([]);
    const schema = schemaOfChunk(chunks[0]!);
    expect(schema.category).toContain('name');
    expect(schema.budget).not.toContain('rta');
    expect(() => schemaOfChunk(new TextEncoder().encode('{"t":"category","k":[1],"d":{}}\n'))).toThrow(
      SnapshotFormatError,
    );
    expect(() => schemaOfChunk(new TextEncoder().encode('{"schema":{"category":["name; DROP"]}}\n'))).toThrow(
      SnapshotFormatError,
    );
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(() => rowsOfChunk(enc('{"t":"category"}\n'))).toThrow(SnapshotFormatError);
    expect(() => rowsOfChunk(enc('not json\n'))).toThrow(SnapshotFormatError);
    expect(() => rowsOfChunk(new Uint8Array([0xff, 0xfe]))).toThrow(SnapshotFormatError);
  });
});
