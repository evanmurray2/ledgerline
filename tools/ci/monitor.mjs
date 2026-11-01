// The outside monitor (design: Monitoring from both sides).
const base = process.env.BASE_URL;
if (!base) throw new Error('BASE_URL is not set');
const res = await fetch(`${base}/api/health`, {
  headers: { authorization: `Bearer ${process.env.OPS_TOKEN ?? ''}` },
});
if (res.status !== 200) throw new Error(`health returned ${res.status}`);
const h = await res.json();
const now = Date.now();
const problems = [];
for (const c of h.connections)
  if (c.stale) problems.push(`connection ${c.id} has not synced in over 24 hours`);
if (!h.lastBackupAt || now - h.lastBackupAt > 36 * 3600e3)
  problems.push('last backup is more than 36 hours old');
if (h.usage.readPct >= 70 || h.usage.writePct >= 70)
  problems.push(`D1 usage at ${h.usage.readPct}% reads / ${h.usage.writePct}% writes`);
if (h.watermarkLag > 0) console.log(`note: watermark lag ${h.watermarkLag}`);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('healthy');
