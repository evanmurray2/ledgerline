// Nightly: a real Plaid Sandbox sync through the Workflow on local wrangler dev (no deploy, no Production keys).
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
  console.log('Plaid Sandbox keys are not configured; skipping.');
  process.exit(0);
}
writeFileSync(
  'apps/worker/.dev.vars',
  [
    `PLAID_CLIENT_ID=${process.env.PLAID_CLIENT_ID}`,
    `PLAID_SECRET=${process.env.PLAID_SECRET}`,
    `TOKEN_KEYS=1:${randomBytes(32).toString('base64')}`,
    'TOKEN_KEY_CURRENT=1',
    'MEASURE=1',
    'DEV_AUTH_EMAIL=ci@example.com',
  ].join('\n'),
);
const dev = spawn('pnpm', ['exec', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--local'], {
  cwd: 'apps/worker',
  stdio: 'inherit',
});
await new Promise((r) => dev.on('exit', r));
const w = spawn('pnpm', ['exec', 'wrangler', 'dev', '--port', '8787'], {
  cwd: 'apps/worker',
  stdio: 'inherit',
});
try {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch('http://127.0.0.1:8787/__measure/noop', { method: 'POST' })).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  const post = async (p, b) =>
    (
      await fetch(`http://127.0.0.1:8787/__measure${p}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(b ?? {}),
      })
    ).json();
  const seed = await post('/seed');
  const run = await post('/workflow', seed);
  let s;
  for (let i = 0; i < 120; i++) {
    s = await (await fetch(`http://127.0.0.1:8787/__measure/workflow/${run.id}`)).json();
    if (['complete', 'errored', 'terminated'].includes(s.status)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const count = await (await fetch('http://127.0.0.1:8787/__measure/count')).json();
  console.log(JSON.stringify({ status: s.status, events: count[0][0].n, txns: count[1][0].n }));
  if (s.status !== 'complete' || count[1][0].n === 0) process.exit(1);
} finally {
  w.kill();
}
