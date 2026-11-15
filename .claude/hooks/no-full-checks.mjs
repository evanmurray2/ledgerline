#!/usr/bin/env node
// PreToolUse hook (owner's rule, CLAUDE.md "Let CI run the full checks"): blocks the whole-repo check and test
// commands, which CI runs on every push. Targeted runs (vitest on a file, playwright -g, prettier/eslint on files) pass.
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  let cmd = '';
  try {
    cmd = JSON.parse(input)?.tool_input?.command ?? '';
  } catch {
    process.exit(0);
  }
  // Only the commands themselves: not heredoc bodies (a commit message) or quoted text.
  cmd = cmd
    .replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\b/g, '')
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const full =
    /\bpnpm\s+(-\S+\s+)*(check|test|test:unit|test:integration|test:e2e|test:tools)\b(?!:)/.test(cmd) ||
    /\bpnpm\s+(-\S+\s+)*-r\s+(--\S+\s+)*test\b/.test(cmd) ||
    /\btools\/check\.mjs\b/.test(cmd);
  if (!full) process.exit(0);
  process.stderr.write(
    'Blocked: the owner lets CI run the full checks (CLAUDE.md). Run only the tests that cover your change ' +
      '(vitest on a file, playwright -g), prettier and eslint on the changed files, then push.\n',
  );
  process.exit(2);
});
