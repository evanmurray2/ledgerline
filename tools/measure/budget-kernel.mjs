// Workerd CPU of a first-month budget edit's recompute (36 months, 60 categories), per repetition.
import { CpuProfiler } from './cpu.mjs';
const post = (b) =>
  fetch('http://127.0.0.1:8787/__measure/kernel-budget', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(b),
  }).then((r) => r.json());
const p = new CpuProfiler();
await p.connect();
const N = Number(process.env.REPS ?? 10);
const out = {};
for (const months of [36, 12, 6, 3, 1]) {
  await post({ reps: 2, months });
  const one = [],
    many = [];
  let info;
  for (let t = 0; t < 5; t++) {
    one.push((await p.profile(() => post({ reps: 1, months }))).appMs);
    const r = await p.profile(() => post({ reps: N, months }));
    many.push(r.appMs);
    info = { ...r.result, top: r.top.slice(0, 8) };
  }
  const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  out[`months=${months}`] = {
    perEditMedianMs: +((med(many) - med(one)) / (N - 1)).toFixed(2),
    perEditBestMs: +((Math.min(...many) - Math.min(...one)) / (N - 1)).toFixed(2),
    ...info,
  };
  console.error(months, JSON.stringify(out[`months=${months}`]));
}
console.log(JSON.stringify(out, null, 1));
p.close();
