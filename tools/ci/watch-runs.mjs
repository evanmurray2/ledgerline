#!/usr/bin/env node
// Watches the GitHub Actions runs for one commit and prints a line as each named workflow finishes, then exits:
// 0 when all passed (or were skipped), 1 when any failed or was cancelled. When a run was cancelled because a newer
// commit landed on `main` (a later merge cancels the earlier `ci`, and that deploy skips production), it follows
// the newest commit on `main` instead, since that deploy ships both. A deploy whose `production` job was skipped
// prints as skipped. Run it from a Claude session as a background watcher instead of guessing with timers:
//   node tools/ci/watch-runs.mjs <sha> ci            (a PR's latest commit)
//   node tools/ci/watch-runs.mjs <sha> ci deploy     (a merge commit on main)
// The repository is public, so the Actions API needs no token here.
import { execFileSync } from 'node:child_process';

const [first, ...names] = process.argv.slice(2);
let sha = first;
if (!first || !names.length) {
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
    const { workflow_runs: runs } = api(`actions/runs?head_sha=${sha}&per_page=100`);
    for (const name of names) {
      if (done.has(name)) continue;
      // The newest attempt of this workflow for the commit.
      const run = runs.filter((x) => x.name === name).sort((a, b) => b.run_number - a.run_number)[0];
      if (run?.status !== 'completed') continue;
      let result = run.conclusion;
      if (result === 'cancelled') {
        const newer = supersededBy(sha);
        if (newer) {
          console.log(
            `${name}: cancelled by a newer commit on main; following ${newer.slice(0, 12)}, whose deploy ships both`,
          );
          sha = newer;
          done.clear();
          break;
        }
      }
      if (result === 'success' && name === 'deploy') {
        const { jobs } = api(`actions/runs/${run.id}/jobs`);
        if (jobs.some((j) => j.name === 'production' && j.conclusion === 'skipped')) result = 'skipped';
      }
      done.set(name, result);
      console.log(`${name}: ${result} ${run.html_url}`);
    }
  } catch {
    // A failed poll is retried on the next round.
  }
  if (done.size < names.length) await new Promise((res) => setTimeout(res, every));
}
const ok = [...done.values()].every((c) => c === 'success' || c === 'skipped');
console.log(ok ? 'all passed' : 'FAILED');
process.exit(ok ? 0 : 1);

/** GET from the GitHub API with curl (Node's fetch ignores HTTPS_PROXY, which cloud sessions need). */
function api(path) {
  const body = execFileSync(
    'curl',
    ['-sSf', '-H', 'accept: application/vnd.github+json', `https://api.github.com/repos/${repo}/${path}`],
    { encoding: 'utf8', timeout: 30_000 },
  );
  return JSON.parse(body);
}

/** The head of `main` when it is newer than `sha` and contains it, else null. */
function supersededBy(at) {
  const c = api(`compare/${at}...main`);
  return c.status === 'ahead' ? c.commits.at(-1).sha : null;
}
