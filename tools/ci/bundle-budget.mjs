// Bundle size budget: the Worker (gzip, Workers Free allows 3 MB) and the SPA's JavaScript (gzip).
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const WORKER_BUDGET = 1024 * 1024;
// 420: the sealed budget's code in the app (keys, the move, the log) and Settings → About (Nov 12, 2026).
// 430: the bug sweep's fixes (Nov 13, 2026): the target sheet uses the domain's own target math, and new sheets and messages.
// 450 (Nov 13, 2026): adding a device, signed requests, notices and the rebuild.
// 425 (Nov 13, 2026): the old server path removed (D-102) brought it to 418.
// 435 (Nov 13, 2026): the privacy policy page, adding a device by its slot, the rebuild's kept copy and the bank
// filing tests' hooks brought it to 425.
const WEB_BUDGET = 435 * 1024;
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
