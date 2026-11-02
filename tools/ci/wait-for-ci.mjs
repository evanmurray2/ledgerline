// Deploy gate: waits for the `ci` workflow run of this exact commit and fails unless it passed. deploy.yml runs it
// before the production job, so a deploy (started by hand or on merge) never ships a commit whose checks failed or
// never ran. Needs GITHUB_TOKEN (actions: read), GITHUB_REPOSITORY and GITHUB_SHA.
const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA } = process.env;
if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !GITHUB_SHA)
  throw new Error('GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA');
const WAIT_MS = Number(process.env.CI_WAIT_MS ?? 25 * 60_000);
const POLL_MS = 20_000;
const url = `https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/workflows/ci.yml/runs?head_sha=${GITHUB_SHA}&per_page=20`;
const deadline = Date.now() + WAIT_MS;

for (;;) {
  const r = await fetch(url, {
    headers: { authorization: `Bearer ${GITHUB_TOKEN}`, accept: 'application/vnd.github+json' },
  });
  if (!r.ok) throw new Error(`GitHub API ${r.status}`);
  const runs = (await r.json()).workflow_runs ?? [];
  // The push to main is the run that counts; a pull request run of the same commit is accepted as well.
  const done = runs.filter((x) => x.status === 'completed');
  if (done.some((x) => x.conclusion === 'success')) {
    console.log(`ci passed for ${GITHUB_SHA.slice(0, 7)}`);
    break;
  }
  const pending = runs.some((x) => x.status !== 'completed');
  if (!pending && done.length) {
    throw new Error(
      `ci did not pass for ${GITHUB_SHA.slice(0, 7)} (${done.map((x) => x.conclusion).join(', ')}): fix it first`,
    );
  }
  if (Date.now() > deadline)
    throw new Error(`no finished ci run for ${GITHUB_SHA.slice(0, 7)} after waiting`);
  console.log(runs.length ? 'ci is still running; waiting' : 'ci has not started yet; waiting');
  await new Promise((res) => setTimeout(res, POLL_MS));
}
