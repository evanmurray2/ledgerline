#!/usr/bin/env node
// Decides how much of `ci` a run needs (D-84). ci.yml's first job runs it and the other jobs read its answer:
//   run=all     every job: the default, and the answer whenever something here can't be worked out;
//   run=checks  only `checks` (format, lint, typecheck, unit tests, build): the change touches only docs;
//   run=none    nothing: on `main`, these exact files already passed `ci`, as a pull request's test merge.
// "These exact files" is the commit's git tree. A run that tests a tree uploads an empty artifact named after it
// (`marker`); the artifact counts only once that run has ended in success. So a squash merge of a pull request that
// was up to date with `main` skips the second, identical run, and a merge that mixed in other changes is tested.
// On `main` a docs-only change runs only `checks` when the commit before it had passed, and then counts as passed too.
// wait-for-ci.mjs (the deploy gate) uses `docsOnly` and `liveSha` to skip a deploy that would change nothing.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DOCS = /^(docs\/|[^/]+\.md$)/;
/** Docs the web build reads (the app's privacy policy page): a change to one is built and deployed. */
const SHIPPED = new Set(['docs/privacy-policy.md']);
/** GitHub lists at most 300 changed files for a comparison: that many is never treated as docs only. */
const MOST_FILES = 300;

/** True when every changed file is documentation: `docs/` or a Markdown file at the top of the repository, but not one the app shows. */
export function docsOnly(files) {
  return files.length > 0 && files.length < MOST_FILES && files.every((f) => DOCS.test(f) && !SHIPPED.has(f));
}

/** A GitHub API reader for this repository. */
export function github(repo, token) {
  return async (path) => {
    const r = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
    });
    if (!r.ok) throw new Error(`GitHub API ${r.status} for ${path}`);
    return r.json();
  };
}

/** The files a comparison changed, with a rename's old name; null when GitHub can't say (too many, or no common base). */
export async function changedBetween(api, base, head) {
  const c = await api(`compare/${base}...${head}?per_page=1`);
  if (c.status !== 'ahead' || !c.files || c.files.length >= MOST_FILES) return null;
  return c.files.flatMap((f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename]));
}

export const markerFor = (tree) => `ci-passed-${tree}`;

/** True when a finished, successful `ci` run of this repository (not a fork's) tested this tree. */
export async function treePassed(api, repo, tree, notRun) {
  const { artifacts = [] } = await api(`actions/artifacts?name=${markerFor(tree)}&per_page=30`);
  for (const a of artifacts) {
    const id = a.workflow_run?.id;
    if (!id || a.expired || String(id) === String(notRun)) continue;
    const run = await api(`actions/runs/${id}`);
    if (
      run.path === '.github/workflows/ci.yml' &&
      run.conclusion === 'success' &&
      run.head_repository?.full_name === repo
    )
      return true;
  }
  return false;
}

/** The commit that production runs: the newest `production` deployment that succeeded; null when unknown. */
export async function liveSha(api) {
  for (const d of await api('deployments?environment=production&per_page=10')) {
    const [latest] = await api(`deployments/${d.id}/statuses?per_page=1`);
    if (latest?.state === 'success') return d.sha;
  }
  return null;
}

/** What this run of `ci` does, and the marker to upload ('' for none). */
export async function plan({ api, repo, eventName, event, sha, tree, runId }) {
  const all = { run: 'all', marker: markerFor(tree) };
  if (eventName === 'pull_request') {
    const { number, changed_files: count } = event.pull_request;
    if (count >= MOST_FILES) return all;
    const files = [];
    for (let page = 1; files.length < count && page <= 3; page++) {
      const batch = await api(`pulls/${number}/files?per_page=100&page=${page}`);
      for (const f of batch) files.push(f.filename, ...(f.previous_filename ? [f.previous_filename] : []));
      if (batch.length < 100) break;
    }
    // No marker: what `main` was when this ran is not known to have passed.
    return docsOnly(files) ? { run: 'checks', marker: '' } : all;
  }
  if (eventName === 'push' && event.ref === 'refs/heads/main') {
    if (await treePassed(api, repo, tree, runId)) return { run: 'none', marker: '' };
    const before = event.before;
    if (!before || /^0+$/.test(before)) return all;
    const files = await changedBetween(api, before, sha);
    if (!files || !docsOnly(files)) return all;
    const parent = await api(`git/commits/${before}`);
    return (await treePassed(api, repo, parent.tree.sha, runId))
      ? { run: 'checks', marker: markerFor(tree) }
      : all;
  }
  return all;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_RUN_ID } =
    process.env;
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
  let answer = { run: 'all', marker: markerFor(tree) };
  try {
    answer = await plan({
      api: github(GITHUB_REPOSITORY, GITHUB_TOKEN),
      repo: GITHUB_REPOSITORY,
      eventName: GITHUB_EVENT_NAME,
      event: JSON.parse(readFileSync(GITHUB_EVENT_PATH, 'utf8')),
      sha: GITHUB_SHA,
      tree,
      runId: GITHUB_RUN_ID,
    });
  } catch (e) {
    console.log(`couldn't work out the scope (${e.message}): running everything`);
  }
  console.log(`tree ${tree}: run=${answer.run}${answer.marker ? `, marker ${answer.marker}` : ''}`);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `run=${answer.run}\nmarker=${answer.marker}\n`);
}
