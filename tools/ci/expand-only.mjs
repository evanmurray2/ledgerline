// Expand-only rule for Durable Object migrations (docs/multi-user.md 5.7), used by migration-check.mjs.

/** The statements in a new migration that an older release, after a rollback, could trip over. */
export function nonExpanding(sql) {
  if (/^--\s*expand-only: removal of /m.test(sql)) return [];
  const code = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const found = [];
  // A view dropped and recreated under the same name in the same file is a redefinition, not a removal: a rollback's
  // code still finds it. (Keep its columns: the check can't compare them.)
  const recreated = new Set([...code.matchAll(/\bCREATE\s+VIEW\s+(\w+)/gi)].map((m) => m[1].toLowerCase()));
  const views = [...code.matchAll(/\bDROP\s+VIEW\s+(\w+)/gi)];
  if (views.some((m) => !recreated.has(m[1].toLowerCase()))) found.push('DROP VIEW');
  for (const [re, what] of [
    [/\bDROP\s+(TABLE|TRIGGER|INDEX)\b/i, 'DROP'],
    [/\bALTER\s+TABLE\b[^;]*\bDROP\b/i, 'ALTER TABLE … DROP COLUMN'],
    [/\bALTER\s+TABLE\b[^;]*\bRENAME\b/i, 'ALTER TABLE … RENAME'],
  ])
    if (re.test(code)) found.push(what);
  return found;
}
