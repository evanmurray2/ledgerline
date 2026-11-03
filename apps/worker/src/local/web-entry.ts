// The phone's engine in a Web Worker (docs/phone-budget.md, D-44). The web app (apps/web/src/copy/host.ts) starts it
// with `new Worker(new URL(...))`; Vite bundles it with sql.js. It holds the decrypted copy in memory only: the app
// decrypts the saved copy before `open` and encrypts what `export` returns. Messages are { id, op, ...args } and
// every answer is { id, ok, value } or { id, ok: false, error }.
import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { LocalEngine, migrateLocal, type EngineIdentity } from './engine.js';
import { SqlJsD1 } from './sqljs-d1.js';
import type { SyncPage } from '../routes/sync.js';

interface Ctx {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(m: unknown, transfer?: ArrayBuffer[]): void;
}
const ctx = self as unknown as Ctx;

type Msg =
  | { id: number; op: 'open'; who: EngineIdentity; bytes: ArrayBuffer | null }
  | { id: number; op: 'apply'; page: SyncPage; receivedAt: number }
  | { id: number; op: 'next' }
  | { id: number; op: 'derive' }
  | { id: number; op: 'request'; method: string; path: string; body?: unknown }
  | { id: number; op: 'export' }
  | { id: number; op: 'state' }
  | { id: number; op: 'rta' }
  | { id: number; op: 'clear' }
  | { id: number; op: 'get'; key: string }
  | { id: number; op: 'put'; key: string; value: string | null }
  | { id: number; op: 'close' };

let sqlite: Awaited<ReturnType<typeof initSqlJs>> | null = null;
let db: SqlJsD1 | null = null;
let engine: LocalEngine | null = null;

function need(): { db: SqlJsD1; engine: LocalEngine } {
  if (!db || !engine) throw new Error('The copy isn’t open');
  return { db, engine };
}

async function handle(m: Msg): Promise<{ value: unknown; transfer?: ArrayBuffer[] }> {
  switch (m.op) {
    case 'open': {
      sqlite ??= await initSqlJs({ locateFile: () => wasmUrl });
      db?.db.close();
      db = new SqlJsD1(m.bytes ? new sqlite.Database(new Uint8Array(m.bytes)) : new sqlite.Database());
      const d1 = db as unknown as D1Database;
      await migrateLocal(d1, Date.now());
      engine = new LocalEngine(
        d1,
        m.who,
        () => Date.now(),
        async (r) => ctx.postMessage({ event: 'identity', ...r }),
      );
      return { value: await engine.state() };
    }
    case 'apply':
      return { value: await need().engine.apply(m.page, m.receivedAt) };
    case 'next':
      return { value: await need().engine.nextRequest() };
    case 'derive':
      return { value: await need().engine.derive() };
    case 'request': {
      const r = await need().engine.request(m.method, m.path, m.body);
      const text = await r.text();
      return { value: { status: r.status, body: text } };
    }
    case 'export': {
      const bytes = need().db.db.export();
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      return { value: buf, transfer: [buf] };
    }
    case 'state':
      return { value: await need().engine.state() };
    case 'rta':
      return { value: await need().engine.rta() };
    case 'clear':
      await need().engine.clear();
      return { value: null };
    case 'get': {
      const r = await need()
        .db.prepare(`SELECT value FROM local_state WHERE key = ?1`)
        .bind(m.key)
        .first<{ value: string }>();
      return { value: r?.value ?? null };
    }
    case 'put': {
      const d = need().db;
      await (m.value === null
        ? d.prepare(`DELETE FROM local_state WHERE key = ?1`).bind(m.key).run()
        : d
            .prepare(
              `INSERT INTO local_state (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
            )
            .bind(m.key, m.value)
            .run());
      return { value: null };
    }
    case 'close':
      db?.db.close();
      db = null;
      engine = null;
      return { value: null };
  }
}

// One message at a time, in order: the engine's SQL never interleaves.
let queue: Promise<void> = Promise.resolve();
ctx.onmessage = (e: MessageEvent) => {
  const m = e.data as Msg;
  queue = queue.then(async () => {
    try {
      const { value, transfer } = await handle(m);
      ctx.postMessage({ id: m.id, ok: true, value }, transfer);
    } catch (err) {
      ctx.postMessage({ id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
};
