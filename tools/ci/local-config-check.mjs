// apps/worker/wrangler.local.jsonc must be wrangler.jsonc plus only the local D1 and Workflows, so local dev and
// tests run the same bindings, classes and settings as production.
import { readFileSync } from 'node:fs';

const read = (f) =>
  JSON.parse(
    readFileSync(new URL(`../../apps/worker/${f}`, import.meta.url), 'utf8')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/,(\s*[}\]])/g, '$1'),
  );
const prod = read('wrangler.jsonc');
const local = read('wrangler.local.jsonc');
const extra = new Set(['d1_databases', 'workflows']);
const problems = [];
for (const k of new Set([...Object.keys(prod), ...Object.keys(local)])) {
  if (extra.has(k)) {
    if (k in prod) problems.push(`${k} must not be in wrangler.jsonc (production has no D1 or Workflows)`);
    continue;
  }
  if (JSON.stringify(prod[k]) !== JSON.stringify(local[k])) problems.push(`${k} differs`);
}
if (problems.length) {
  console.error(`wrangler.local.jsonc is out of step with wrangler.jsonc:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('wrangler.local.jsonc matches wrangler.jsonc plus local D1 and Workflows');
