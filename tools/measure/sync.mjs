// Go/no-go: CPU of one fetch step and one apply step at count 500 and 250, plus a calibration run.
// Requires: plaid mock (or Sandbox keys in .dev.vars) and `wrangler dev --inspector-port 9229` with MEASURE=1.
import { CpuProfiler } from './cpu.mjs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const post = async (path, body) => {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${path} ${r.status} ${t.slice(0, 300)}`);
  return JSON.parse(t);
};

const prof = new CpuProfiler();
await prof.connect();

// Calibration: the same loop in Node (wall ≈ CPU, single thread) and under the profiler in workerd.
const ITERS = 2_000_000;
let x = 0;
const t0 = performance.now();
for (let i = 0; i < ITERS; i++) x = (x * 31 + i) % 1000003;
const nodeMs = performance.now() - t0;
await post('/__measure/burn', { iters: 1000 }); // warm
const burn = await prof.profile(() => post('/__measure/burn', { iters: ITERS }));
const noop = [];
for (let i = 0; i < 5; i++) noop.push((await prof.profile(() => post('/__measure/noop'))).cpuMs);
console.log(
  JSON.stringify({
    calibration: { nodeMs: +nodeMs.toFixed(2), workerdProfiledMs: +burn.cpuMs.toFixed(2), x },
    noopMs: noop.map((n) => +n.toFixed(2)),
  }),
);

const out = {};
for (const count of (process.env.COUNTS ?? '500,250,100').split(',').map(Number)) {
  const seed = await post('/__measure/seed');
  const acq = await post('/__measure/acquire', seed);
  const holder = acq.holder;
  const fetches = [];
  let cursor = null;
  let page = 0;
  for (;;) {
    const r = await prof.profile(() => post('/__measure/fetch', { ...seed, holder, page, cursor, count }));
    fetches.push({
      page,
      cpuMs: +r.cpuMs.toFixed(2),
      appMs: +r.appMs.toFixed(2),
      wallMs: +r.wallMs.toFixed(1),
      bytes: r.result.bytes,
      top: page === 0 ? r.top : undefined,
    });
    cursor = r.result.nextCursor;
    page++;
    if (!r.result.hasMore) break;
  }
  const applies = [];
  for (let i = 0; i < page; i++) {
    const r = await prof.profile(() => post('/__measure/apply', { ...seed, holder, page: i }));
    applies.push({
      page: i,
      cpuMs: +r.cpuMs.toFixed(2),
      appMs: +r.appMs.toFixed(2),
      wallMs: +r.wallMs.toFixed(1),
      events: r.result.events,
      rowsWritten: r.result.rowsWritten,
      statements: r.result.statements,
      top: i === 1 ? r.top : undefined,
    });
  }
  out[count] = { pages: page, fetches, applies };
}
console.log(JSON.stringify(out, null, 1));
prof.close();
