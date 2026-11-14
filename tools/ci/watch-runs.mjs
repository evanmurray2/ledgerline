#!/usr/bin/env node
// Watches the GitHub Actions runs for one commit and prints a line as each named workflow finishes, then exits:
// 0 when all passed (or were skipped), 1 when any failed or was cancelled. When a run was cancelled because a newer
// commit landed on `main` (a later merge cancels the earlier `ci`, and that deploy skips production), it follows
// the newest commit on `main` instead, since that deploy ships both. A deploy whose `production` job was skipped
// prints as skipped. Run it from a Claude session as a background watcher instead of guessing with timers:
//   node tools/ci/watch-runs.mjs <sha> ci            (a PR's latest commit)
//   node tools/ci/watch-runs.mjs <sha> ci deploy     (a merge commit on main)
// When a watched workflow hasn't started, it also checks the commit's pull request: a PR in conflict with `main` gets
// no CI at all, so it reports the conflict and exits 1 instead of waiting for runs that never come. It does the same
// when no run has started after 10 minutes (WATCH_NO_RUN_MIN).
// It sends GH_TOKEN (or GITHUB_TOKEN) when set; without one it still works, as the repository is public, but GitHub
// allows fewer requests an hour. A failed poll (a rate limit too) is printed and retried after a back-off.
import { githubApi, repoSlug } from './github-api.mjs';

const [first, ...names] = process.argv.slice(2);
let sha = first;
if (!first || !names.length) {
  console.error('usage: watch-runs.mjs <sha> <workflow name>...');
  process.exit(2);
}
const api = githubApi(repoSlug());
const every = Number(process.env.WATCH_INTERVAL_S ?? 30) * 1000;
const limit = Date.now() + Number(process.env.WATCH_TIMEOUT_MIN ?? 60) * 60_000;
const done = new Map();
const started = Date.now();
const noRunLimit = Number(process.env.WATCH_NO_RUN_MIN ?? 10) * 60_000;
let lastPrCheck = 0;
/** Workflows that have a run for the commit, from the last poll that worked. */
const seen = new Set();
/** The last poll's error, while polls fail; and how many failed in a row. */
let lastError = null;
let failures = 0;

while (done.size < names.length) {
  if (Date.now() > limit) {
    const left = names.filter((n) => !done.has(n));
    console.log(`timed out still waiting for: ${left.join(', ')}`);
    process.exit(1);
  }
  try {
    const { workflow_runs: runs } = api(`actions/runs?head_sha=${sha}&per_page=100`);
    for (const r of runs) seen.add(r.name);
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
          seen.clear();
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
    lastError = null;
    failures = 0;
  } catch (e) {
    // Printed, and retried after a back-off (nextWait).
    lastError = e;
    failures++;
    console.log(`poll failed (${failures} in a row): ${e.message}`);
  }
  // Outside the poll above, so a failed poll doesn't stop these checks: workflows with no run seen yet.
  const missing = names.filter((n) => !done.has(n) && !seen.has(n));
  if (missing.length && Date.now() - started > 60_000 && Date.now() - lastPrCheck > 60_000) {
    lastPrCheck = Date.now();
    let conflict = null;
    try {
      conflict = conflictedPr(sha);
    } catch (e) {
      // Couldn't ask about the PR this round: the no-run limit below still applies.
      console.log(`couldn't check the pull request: ${e.message}`);
    }
    if (conflict) {
      console.log(
        `merge conflict: PR #${conflict.number} can't merge with ${conflict.base.ref}, so ${missing.join(', ')} won't run. ${conflict.html_url}`,
      );
      process.exit(1);
    }
    if (Date.now() - started > noRunLimit) {
      const why = lastError ? ` (the last ${failures} polls failed: ${lastError.message})` : '';
      console.log(
        `no ${missing.join(', ')} run seen for ${sha.slice(0, 12)} after ${noRunLimit / 60_000} minutes${why}`,
      );
      process.exit(1);
    }
  }
  if (done.size < names.length) await new Promise((res) => setTimeout(res, nextWait()));
}
const ok = [...done.values()].every((c) => c === 'success' || c === 'skipped');
console.log(ok ? 'all passed' : 'FAILED');
process.exit(ok ? 0 : 1);

/** The time to the next poll: the interval, or longer after failures (what a rate limit asks for, at most 15 min). */
function nextWait() {
  if (!lastError) return every;
  const backOff = Math.min(every * 2 ** Math.min(failures, 5), 15 * 60_000);
  const wait = Math.min(
    Math.max(backOff, lastError.waitMs ?? 0),
    15 * 60_000,
    Math.max(limit - Date.now(), 1000),
  );
  console.log(`${lastError.rateLimited ? 'rate limited: ' : ''}next poll in ${Math.ceil(wait / 1000)} s`);
  return wait;
}

/** The head of `main` when it is newer than `sha` and contains it, else null. */
function supersededBy(at) {
  const c = api(`compare/${at}...main`);
  return c.status === 'ahead' ? c.commits.at(-1).sha : null;
}

/** The open pull request for `at` when GitHub says it conflicts with its base, else null. */
function conflictedPr(at) {
  for (const pr of api(`commits/${at}/pulls`)) {
    if (pr.state !== 'open') continue;
    // GitHub works out mergeability in the background: null means not yet known.
    const full = api(`pulls/${pr.number}`);
    if (full.mergeable === false || full.mergeable_state === 'dirty') return full;
  }
  return null;
}
