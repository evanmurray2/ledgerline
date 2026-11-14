#!/usr/bin/env node
// Lists repository paths in backticks in the docs that name no file or folder in the working tree:
//   node tools/docs/missing-paths.mjs [file.md...]     (default: every living doc)
// A path counts when it is found from the repository root, or from one of the usual bases a doc leaves out
// (`routes/x.ts` for apps/worker/src/routes/x.ts, `test/x.test.ts` for apps/worker/test/x.test.ts, `src/x.ts` in a
// package). Skipped: docs/build-history.md (frozen), docs/prototype, docs/decisions (each is a record of its day),
// a path in a sentence (or under a list lead-in) that says "removed", "gone", "deleted" or "dropped", key labels
// (`ledgerline/v1/`) and build output (`dist/`). It exits 1 when it finds any; `pnpm test:tools` runs it.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const SKIP = [/^docs\/build-history\.md$/, /^docs\/prototype\//, /^docs\/decisions\//];
const PATH =
  /^(?:\.github\/|[\w@.-]+\/)[\w@./[\]-]*(?:\.(?:ts|tsx|mts|mjs|js|md|json|jsonc|sql|yml|yaml|css|html|txt)|\/)$/;
const packages = readdirSync(join(root, 'packages')).map((p) => `packages/${p}/`);
const apps = readdirSync(join(root, 'apps')).map((p) => `apps/${p}/`);
const BASES = [
  '',
  ...apps,
  ...apps.map((a) => `${a}src/`),
  ...packages,
  ...packages.map((p) => `${p}src/`),
  'e2e/',
  'docs/',
];

/** The paths in backticks on one line of Markdown that could name a repository file. */
export function pathsIn(line) {
  return [...line.matchAll(/`([^`\s]+)`/g)]
    .map((m) => m[1].replace(/[:#]\d+(?:-\d+)?$/, '').replace(/[),.;]+$/, ''))
    .filter((p) => PATH.test(p) && !/[*<]|^http|^ledgerline\/|(^|\/)dist\//.test(p));
}

const found = (p) => BASES.some((b) => existsSync(join(root, b, p)));

const REMOVED = /\b(removed|gone|deleted|dropped)\b/i;

/** True when the sentence that names `p` on line `i` says it was removed, or, in a list, an item or lead-in above it. */
function saysRemoved(lines, i, p) {
  const item = /^(\s*)- /;
  const sentences = lines[i].split(/(?<=[.:;])\s+(?=[A-Z*`(])/);
  if (sentences.some((s) => s.includes(`\`${p}`) && REMOVED.test(s))) return true;
  let indent = item.exec(lines[i])?.[1].length;
  for (let j = i - 1; indent !== undefined && j >= 0; j--) {
    if (!lines[j].trim()) continue;
    const m = item.exec(lines[j]);
    if (!m) return REMOVED.test(lines[j]); // the list's lead-in
    if (m[1].length < indent) {
      if (REMOVED.test(lines[j])) return true;
      indent = m[1].length;
    }
  }
  return false;
}

function docs(dir) {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    if (SKIP.some((s) => s.test(rel) || s.test(`${rel}/`))) return [];
    if (statSync(join(root, rel)).isDirectory()) return docs(rel);
    return rel.endsWith('.md') ? [rel] : [];
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files =
    process.argv.length > 2
      ? process.argv.slice(2).map((f) => relative(root, f))
      : [
          ...docs('docs'),
          ...readdirSync(root).filter((f) => f.endsWith('.md')),
          'apps/web/CONTRACT_NOTES.md',
        ];
  let missing = 0;
  for (const file of files) {
    const lines = readFileSync(join(root, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const p of pathsIn(line)) {
        if (found(p) || saysRemoved(lines, i, p)) continue;
        missing++;
        console.log(`${file}:${i + 1}: ${p}`);
      }
    });
  }
  console.log(missing ? `${missing} missing paths` : 'no missing paths');
  process.exit(missing ? 1 : 0);
}
