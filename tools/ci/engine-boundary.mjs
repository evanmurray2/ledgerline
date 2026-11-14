// The boundary between the server and the engine on the device (docs/architecture.md, "Where code runs"). Both live
// in apps/worker/src. The Worker (src/index.ts) runs the Directory and each BudgetStore; the device's Web Worker
// (src/local/web-entry.ts) runs the engine on the budget's tables. esbuild follows each entry's runtime imports
// (type-only imports vanish), and this fails when:
//   - the Worker reaches a file only the engine should run (the budget's routes, views, ledger, filing), or
//   - the engine reaches the server's own code (the Durable Objects, the fetch job, the server's routes), or
//   - a file is newly shared by both without being listed in SHARED below.
// A new shared file is fine when both sides need it: add it to SHARED in the same pull request.
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(path.resolve('apps/web/package.json'));
const esbuild = createRequire(require.resolve('vite'))('esbuild');
const SRC = 'apps/worker/src/';

/** The files both sides run, on purpose: small helpers, the SQL interface, the log's formats. */
const SHARED = new Set([
  'db/scoped.ts',
  'http/clock.ts',
  'http/context.ts',
  'http/errors.ts',
  'http/security.ts',
  'seal/device-checks.ts',
  'seal/log-store.ts',
  'seal/log-versions.ts',
  'store/adapter.ts',
  'store/migrations.gen.ts',
  'sync/lease.ts',
  'sync/provider.ts',
]);
/**
 * Files in a server folder that only the device runs: formats the server writes with their types alone (type imports
 * vanish), and the device reads.
 */
const FORMATS = new Set(['seal/link-description.ts']);
/** Folders only the engine on the device runs. */
const ENGINE_ONLY = ['local/', 'views/', 'ledger/', 'budget/'];
/** Folders only the server runs. */
const SERVER_ONLY = ['store/', 'seal/', 'ops/'];

async function inputs(entry) {
  const r = await esbuild.build({
    entryPoints: [SRC + entry],
    bundle: true,
    write: false,
    metafile: true,
    format: 'esm',
    platform: 'neutral',
    packages: 'external',
    logLevel: 'silent',
    plugins: [
      {
        name: 'external-assets',
        setup(b) {
          b.onResolve({ filter: /^cloudflare:|\?|\.(wasm|html|sql)$/ }, (a) => ({
            path: a.path,
            external: true,
          }));
        },
      },
    ],
  });
  return new Set(
    Object.keys(r.metafile.inputs)
      .filter((f) => f.startsWith(SRC))
      .map((f) => f.slice(SRC.length)),
  );
}

const server = await inputs('index.ts');
const device = await inputs('local/web-entry.ts');
const problems = [];
const engineOnly = (f) => ENGINE_ONLY.some((d) => f.startsWith(d));
for (const f of server)
  if (engineOnly(f)) problems.push(`The Worker runs ${f}, which only the engine on the device should run.`);
for (const f of device)
  if (!server.has(f) && SERVER_ONLY.some((d) => f.startsWith(d)) && !FORMATS.has(f))
    problems.push(`The engine on the device runs ${f}, which is the server's own code.`);
for (const f of server)
  if (device.has(f) && !SHARED.has(f) && !engineOnly(f))
    problems.push(
      `${f} is now run by both the Worker and the device: list it in SHARED, or keep it on one side.`,
    );
for (const f of SHARED)
  if (!(server.has(f) && device.has(f)))
    problems.push(`${f} is in SHARED but no longer run by both: remove it.`);
for (const f of FORMATS)
  if (server.has(f) || !device.has(f))
    problems.push(`${f} is in FORMATS but is not run by the device alone: move it.`);

if (problems.length) {
  for (const p of problems) console.error(p);
  process.exit(1);
}
console.log(
  `engine boundary: the Worker runs ${server.size} files, the device ${device.size}, ${SHARED.size} shared`,
);
