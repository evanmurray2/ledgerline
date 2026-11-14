#!/usr/bin/env node
// `pnpm check`: the checks to run before pushing, side by side instead of one after another. Formats first (prettier
// --write, so a formatting slip is fixed rather than failed), then runs lint, typecheck, unit, tool (`test:tools`)
// and integration tests at once, with caches (ESLint, Prettier, incremental tsc) under node_modules/.cache. Each
// check's output is printed only if it fails.
import { spawn } from 'node:child_process';

const run = (name, cmd) =>
  new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, { shell: true, env: { ...process.env, FORCE_COLOR: '1' } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => {
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`${code === 0 ? 'ok  ' : 'FAIL'} ${name} (${secs}s)`);
      resolve({ name, code, out });
    });
  });

const format = await run('format', 'pnpm exec prettier --write --cache --log-level warn .');
const results = [
  format,
  ...(await Promise.all([
    run('lint', 'pnpm exec eslint --cache --cache-location node_modules/.cache/eslint/ .'),
    run(
      'typecheck',
      'pnpm -s -r --if-present typecheck --incremental --tsBuildInfoFile node_modules/.cache/tsc.tsbuildinfo',
    ),
    run('unit', 'pnpm -s test:unit'),
    run('tools', 'pnpm -s test:tools'),
    run('integration', 'pnpm -s test:integration'),
  ])),
];

const failed = results.filter((r) => r.code !== 0);
for (const r of failed) console.log(`\n── ${r.name} ──\n${r.out}`);
process.exit(failed.length ? 1 : 0);
