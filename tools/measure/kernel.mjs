// Times each sync step's own compute inside workerd: `reps` repetitions per request, CPU divided by reps.
// Run 1 rep and N reps; (cpu(N) − cpu(1)) / (N − 1) removes the fixed per-request overhead.
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
const N = Number(process.env.REPS ?? 20);
const out = {};
for (const kind of ['fetch', 'apply']) {
  for (const count of (process.env.COUNTS ?? '500,250,100,50').split(',').map(Number)) {
    await post('/__measure/kernel', { kind, count, reps: 2 }); // warm the JIT, as a reused isolate would be
    const one = [];
    const many = [];
    for (let t = 0; t < 5; t++) {
      one.push((await prof.profile(() => post('/__measure/kernel', { kind, count, reps: 1 }))).appMs);
      many.push((await prof.profile(() => post('/__measure/kernel', { kind, count, reps: N }))).appMs);
    }
    const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const min = (xs) => Math.min(...xs);
    out[`${kind}@${count}`] = {
      perRepMedianMs: +((med(many) - med(one)) / (N - 1)).toFixed(2),
      perRepBestMs: +((min(many) - min(one)) / (N - 1)).toFixed(2),
      singleRequestMedianMs: +med(one).toFixed(2),
    };
    console.error(kind, count, JSON.stringify(out[`${kind}@${count}`]));
  }
}
{
  const one = [];
  const many = [];
  for (let t = 0; t < 5; t++) {
    one.push((await prof.profile(() => post('/__measure/io-shell', { reps: 1 }))).appMs);
    many.push((await prof.profile(() => post('/__measure/io-shell', { reps: N }))).appMs);
  }
  const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  out.ioShellPerStep = {
    medianMs: +((med(many) - med(one)) / (N - 1)).toFixed(2),
    bestMs: +((Math.min(...many) - Math.min(...one)) / (N - 1)).toFixed(2),
  };
  const noop = [];
  for (let t = 0; t < 9; t++) noop.push((await prof.profile(() => post('/__measure/noop'))).appMs);
  out.requestOverhead = { medianMs: +med(noop).toFixed(2), bestMs: +Math.min(...noop).toFixed(2) };
}
console.log(JSON.stringify(out, null, 1));
prof.close();
