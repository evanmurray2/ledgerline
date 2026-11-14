#!/usr/bin/env node
// Lists the e2e tests that only passed on their retry, from the "Flaky e2e test" warnings that e2e/retry-log.ts
// leaves on each CI job, newest first, then a count per test:
//   node tools/ci/flaky-report.mjs [days]     (default 14)
// The repository is public, so this needs no token; with GH_TOKEN (or GITHUB_TOKEN) set it is allowed more requests
// per hour. Any failed call (a rate limit too) stops it with GitHub's answer: a part-done count would mislead.
import { githubApi, repoSlug } from './github-api.mjs';

const days = Number(process.argv[2] ?? 14);
const get = githubApi(repoSlug());
const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

const runs = [];
for (let page = 1; ; page++) {
  const { workflow_runs: batch } = api(
    `actions/workflows/ci.yml/runs?per_page=100&created=%3E%3D${since}&page=${page}`,
  );
  runs.push(...batch);
  if (batch.length < 100) break;
}

const counts = new Map();
for (const run of runs) {
  const { jobs } = api(`actions/runs/${run.id}/jobs?per_page=100`);
  for (const job of jobs.filter(isE2ePart)) {
    for (const note of api(`check-runs/${job.id}/annotations?per_page=100`)) {
      if (note.title !== 'Flaky e2e test') continue;
      const test = note.message.replace(/: [^›]*$/, '');
      counts.set(test, (counts.get(test) ?? 0) + 1);
      console.log(`${run.created_at.slice(0, 16)} ${run.head_branch} ${note.message}\n  ${job.html_url}`);
    }
  }
}
console.log(`\n${runs.length} ci runs since ${since}; tests that needed a retry:`);
for (const [test, n] of [...counts].sort((a, b) => b[1] - a[1]))
  console.log(`${String(n).padStart(4)}  ${test}`);
if (!counts.size) console.log('   none');

/** An e2e job that ran tests: not `e2e (mock)` or `e2e (worker)`, the two jobs that only report for the parts. */
function isE2ePart(job) {
  return job.name.startsWith('e2e') && !/^e2e \((mock|worker)\)$/.test(job.name);
}

function api(path) {
  try {
    return get(path);
  } catch (e) {
    const hint = e.rateLimited
      ? `: rate limited${e.waitMs ? `, try again in ${Math.ceil(e.waitMs / 60_000)} min` : ''}${process.env.GH_TOKEN || process.env.GITHUB_TOKEN ? '' : ', or set GH_TOKEN for a higher limit'}`
      : '';
    console.error(`flaky-report: ${e.message}${hint}`);
    process.exit(1);
  }
}
