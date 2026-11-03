#!/usr/bin/env node
// Watches the GitHub Actions runs for one commit and prints a line as each named workflow finishes, then exits:
// 0 when all passed (or were skipped), 1 when any failed or was cancelled. Run it from a Claude session as a
// background watcher instead of guessing with timers, e.g. after a push or a merge:
//   node tools/ci/watch-runs.mjs <sha> ci            (a PR's latest commit)
//   node tools/ci/watch-runs.mjs <sha> ci deploy     (a merge commit on main)
// The repository is public, so the Actions API needs no token here.
import { execFileSync } from 'node:child_process';

const [sha, ...names] = process.argv.slice(2);
if (!sha || !names.length) {
  console.error('usage: watch-runs.mjs <sha> <workflow name>...');
  process.exit(2);
}
const repo = process.env.GITHUB_REPOSITORY ?? 'evanmurray2/ledgerline';
const every = Number(process.env.WATCH_INTERVAL_S ?? 30) * 1000;
const limit = Date.now() + Number(process.env.WATCH_TIMEOUT_MIN ?? 60) * 60_000;
const done = new Map();

while (done.size < names.length) {
  if (Date.now() > limit) {
    const left = names.filter((n) => !done.has(n));
    console.log(`timed out still waiting for: ${left.join(', ')}`);
    process.exit(1);
  }
  try {
    // curl, not fetch: Node's fetch ignores HTTPS_PROXY, which cloud sessions need.
    const body = execFileSync(
      'curl',
      [
        '-sSf',
        '-H',
        'accept: application/vnd.github+json',
        `https://api.github.com/repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`,
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );
    const { workflow_runs: runs } = JSON.parse(body);
    for (const name of names) {
      if (done.has(name)) continue;
      // The newest attempt of this workflow for the commit.
      const run = runs.filter((x) => x.name === name).sort((a, b) => b.run_number - a.run_number)[0];
      if (run?.status !== 'completed') continue;
      done.set(name, run.conclusion);
      console.log(`${name}: ${run.conclusion} ${run.html_url}`);
    }
  } catch {
    // A failed poll is retried on the next round.
  }
  if (done.size < names.length) await new Promise((res) => setTimeout(res, every));
}
const ok = [...done.values()].every((c) => c === 'success' || c === 'skipped');
console.log(ok ? 'all passed' : 'FAILED');
process.exit(ok ? 0 : 1);
