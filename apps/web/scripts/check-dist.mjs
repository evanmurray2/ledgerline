// Fails the build if development-only code reached dist/: the mock API (src/mock) or a third-party font link.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIST = new URL('../dist/', import.meta.url).pathname;
const FORBIDDEN = [
  ['__ledgerlineMock', 'mock API installer'],
  ['MockServer', 'mock API server'],
  ['link-sandbox-mock', 'mock Plaid token'],
  ['Venmo cashout', 'mock November data'],
  ['fonts.googleapis.com', 'third-party font'],
];

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const problems = [];
for (const file of walk(DIST).filter((f) => /\.(js|css|html)$/.test(f))) {
  const text = readFileSync(file, 'utf8');
  for (const [needle, what] of FORBIDDEN)
    if (text.includes(needle)) problems.push(`${file}: contains ${what} (${needle})`);
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('dist is clean: no mock API or third-party fonts');
