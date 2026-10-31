// Bundle size budget: the Worker (gzip, Workers Free allows 3 MB) and the SPA's JavaScript (gzip).
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const WORKER_BUDGET = 1024 * 1024;
const WEB_BUDGET = 400 * 1024;
execFileSync('pnpm', ['exec', 'wrangler', 'deploy', '--dry-run', '--outdir', '.bundle'], {
  cwd: 'apps/worker',
  stdio: 'inherit',
});
const walk = (d) =>
  readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const gz = (files) => files.reduce((a, f) => a + gzipSync(readFileSync(f)).length, 0);
const worker = gz(walk('apps/worker/.bundle').filter((f) => f.endsWith('.js')));
const web = gz(walk('apps/web/dist').filter((f) => f.endsWith('.js')));
console.log(
  `worker ${(worker / 1024).toFixed(0)} KiB gz (budget ${WORKER_BUDGET / 1024}), web ${(web / 1024).toFixed(0)} KiB gz (budget ${WEB_BUDGET / 1024})`,
);
if (worker > WORKER_BUDGET || web > WEB_BUDGET) process.exit(1);
