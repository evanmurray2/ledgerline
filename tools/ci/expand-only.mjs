// Expand-only rule for Durable Object migrations (docs/multi-user.md 5.7), used by migration-check.mjs.

/** The statements in a new migration that an older release, after a rollback, could trip over. */
export function nonExpanding(sql) {
  if (/^--\s*expand-only: removal of /m.test(sql)) return [];
  const code = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const found = [];
  for (const [re, what] of [
    [/\bDROP\s+(TABLE|VIEW|TRIGGER|INDEX)\b/i, 'DROP'],
    [/\bALTER\s+TABLE\b[^;]*\bDROP\b/i, 'ALTER TABLE … DROP COLUMN'],
    [/\bALTER\s+TABLE\b[^;]*\bRENAME\b/i, 'ALTER TABLE … RENAME'],
  ])
    if (re.test(code)) found.push(what);
  return found;
}
