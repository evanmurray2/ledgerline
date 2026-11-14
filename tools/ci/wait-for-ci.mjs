// Deploy gate: waits for the `ci` workflow run of this exact commit and fails unless it passed. deploy.yml runs it
// before the production job, so a deploy (started by hand or on merge) never ships a commit whose checks failed or
// never ran. Needs GITHUB_TOKEN (actions: read), GITHUB_REPOSITORY and GITHUB_SHA.
// A newer merge cancels this commit's ci run (ci.yml cancel-in-progress). If main has moved on, this commit is
// skipped, not failed: the newer commit's deploy ships it, and a red deploy then always means a real problem (D-51).
// When everything since the commit production runs is documentation, it also skips: a deploy would change nothing
// (D-84). It writes `deploy=true|false` to GITHUB_OUTPUT; deploy.yml runs the production job only on true.
// The decisions are the exported functions below (tools/ci/scope.test.mjs tests them); the loop at the end runs them.
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { changedBetween, docsOnly, github, liveSha } from './scope.mjs';

/**
 * What this commit's `ci` runs say: 'passed' (one succeeded), 'waiting' (none yet, or one still running),
 * 'cancelled' (all finished and all cancelled: deploy only if main hasn't moved on) or 'failed'.
 */
export function ciVerdict(runs) {
  // The push to main is the run that counts; a pull request run of the same commit is accepted as well.
  const done = runs.filter((x) => x.status === 'completed');
  if (done.some((x) => x.conclusion === 'success')) return 'passed';
  if (runs.some((x) => x.status !== 'completed') || !done.length) return 'waiting';
  // Cancelled by a newer merge: skipped quietly. A failed run stays a failure even when main has moved on.
  return done.every((x) => x.conclusion === 'cancelled') ? 'cancelled' : 'failed';
}

/** False only when production's commit is known and nothing but documentation changed since. */
export async function changesProduction(api, sha, log = console.log) {
  try {
    const live = await liveSha(api);
    const files = live && (await changedBetween(api, live, sha));
    if (files && docsOnly(files)) {
      log(`only docs changed since production's ${live.slice(0, 7)}: nothing to deploy`);
      return false;
    }
  } catch (e) {
    log(`couldn't compare with production (${e.message}): deploying`);
  }
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !GITHUB_SHA)
    throw new Error('GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA');
  const WAIT_MS = Number(process.env.CI_WAIT_MS ?? 25 * 60_000);
  const POLL_MS = 5_000;
  const api = github(GITHUB_REPOSITORY, GITHUB_TOKEN);
  const deadline = Date.now() + WAIT_MS;
  const output = (deploy) => {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `deploy=${deploy}\n`);
  };

  for (;;) {
    const runs =
      (await api(`actions/workflows/ci.yml/runs?head_sha=${GITHUB_SHA}&per_page=20`)).workflow_runs ?? [];
    const verdict = ciVerdict(runs);
    if (verdict === 'passed') {
      console.log(`ci passed for ${GITHUB_SHA.slice(0, 7)}`);
      output(await changesProduction(api, GITHUB_SHA));
      break;
    }
    if (verdict === 'cancelled') {
      const head = (await api('commits/main')).sha;
      if (head !== GITHUB_SHA) {
        console.log(
          `ci for ${GITHUB_SHA.slice(0, 7)} was cancelled by a newer merge (${head.slice(0, 7)}); that deploy ships it`,
        );
        output(false);
        break;
      }
    }
    if (verdict === 'cancelled' || verdict === 'failed') {
      const conclusions = runs.filter((x) => x.status === 'completed').map((x) => x.conclusion);
      throw new Error(
        `ci did not pass for ${GITHUB_SHA.slice(0, 7)} (${conclusions.join(', ')}): fix it first`,
      );
    }
    if (Date.now() > deadline)
      throw new Error(`no finished ci run for ${GITHUB_SHA.slice(0, 7)} after waiting`);
    console.log(runs.length ? 'ci is still running; waiting' : 'ci has not started yet; waiting');
    await new Promise((res) => setTimeout(res, POLL_MS));
  }
}
