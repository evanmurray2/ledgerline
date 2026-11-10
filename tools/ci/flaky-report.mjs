#!/usr/bin/env node
// Lists the e2e tests that only passed on their retry, from the "Flaky e2e test" warnings that e2e/retry-log.ts
// leaves on each CI job, newest first, then a count per test:
//   node tools/ci/flaky-report.mjs [days]     (default 14)
// The repository is public, so this needs no token; with GH_TOKEN set it is allowed more requests per hour.
import { execFileSync } from 'node:child_process';

const days = Number(process.argv[2] ?? 14);
const repo = process.env.GITHUB_REPOSITORY ?? 'evanmurray2/ledgerline';
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
  for (const job of jobs.filter((j) => j.name.startsWith('e2e'))) {
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

function api(path) {
  const auth = process.env.GH_TOKEN ? ['-H', `authorization: Bearer ${process.env.GH_TOKEN}`] : [];
  const body = execFileSync(
    'curl',
    [
      '-sSf',
      '--retry',
      '3',
      '-H',
      'accept: application/vnd.github+json',
      ...auth,
      `https://api.github.com/repos/${repo}/${path}`,
    ],
    { encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(body);
}
