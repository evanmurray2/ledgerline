// How much of `ci` a run needs (scope.mjs, D-84) and the deploy gate's decisions (wait-for-ci.mjs), against a fake
// GitHub API. Run by `pnpm test:tools` (in `pnpm check` and ci.yml's `checks` job).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { changedBetween, docsOnly, liveSha, markerFor, plan, treePassed } from './scope.mjs';
import { changesProduction, ciVerdict } from './wait-for-ci.mjs';

const repo = 'owner/app';

/** A fake API: `routes` maps a path (without its query) to a response, or to a function of the full path. */
function fakeApi(routes) {
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    const key = Object.keys(routes).find((k) => path === k || path.startsWith(`${k}?`));
    if (!key) throw new Error(`GitHub API 404 for ${path}`);
    const r = routes[key];
    return typeof r === 'function' ? r(path) : r;
  };
  return Object.assign(api, { calls });
}

/** Routes for a tree whose marker artifact belongs to run `runId` with this conclusion. */
const passedTree = (tree, runId, conclusion = 'success', fullName = repo) => ({
  [`actions/artifacts`]: (path) =>
    path.includes(markerFor(tree))
      ? { artifacts: [{ workflow_run: { id: runId }, expired: false }] }
      : { artifacts: [] },
  [`actions/runs/${runId}`]: {
    path: '.github/workflows/ci.yml',
    conclusion,
    head_repository: { full_name: fullName },
  },
});

describe('docsOnly', () => {
  it('is true for docs/ and top-level Markdown', () => {
    assert.equal(docsOnly(['docs/design.md', 'README.md', 'docs/decisions/D-1-x.md']), true);
    assert.equal(docsOnly(['CLAUDE.md']), true);
  });
  it('is false for code, nested Markdown, an empty list and the privacy policy the app shows', () => {
    assert.equal(docsOnly(['docs/a.md', 'apps/web/src/main.tsx']), false);
    assert.equal(docsOnly(['apps/web/CONTRACT_NOTES.md']), false);
    assert.equal(docsOnly([]), false);
    assert.equal(docsOnly(['docs/privacy-policy.md']), false);
  });
  it('is false for 300 files or more, as GitHub lists no more', () => {
    const many = Array.from({ length: 300 }, (_, i) => `docs/${i}.md`);
    assert.equal(docsOnly(many.slice(0, 299)), true);
    assert.equal(docsOnly(many), false);
  });
});

describe('changedBetween', () => {
  it('lists both names of a rename', async () => {
    const api = fakeApi({
      'compare/a...b': {
        status: 'ahead',
        files: [{ filename: 'docs/new.md', previous_filename: 'docs/old.md' }],
      },
    });
    assert.deepEqual(await changedBetween(api, 'a', 'b'), ['docs/new.md', 'docs/old.md']);
  });
  it('is null when the head is not simply ahead', async () => {
    const api = fakeApi({ 'compare/a...b': { status: 'diverged', files: [] } });
    assert.equal(await changedBetween(api, 'a', 'b'), null);
  });
});

describe('treePassed', () => {
  it('counts only a successful ci run of this repository, not this run itself', async () => {
    assert.equal(await treePassed(fakeApi(passedTree('t1', 7)), repo, 't1', 99), true);
    assert.equal(await treePassed(fakeApi(passedTree('t1', 7)), repo, 't1', 7), false);
    assert.equal(await treePassed(fakeApi(passedTree('t1', 7, 'failure')), repo, 't1', 99), false);
    assert.equal(
      await treePassed(fakeApi(passedTree('t1', 7, 'success', 'fork/app')), repo, 't1', 99),
      false,
    );
    assert.equal(await treePassed(fakeApi(passedTree('t1', 7)), repo, 't2', 99), false);
  });
});

describe('plan', () => {
  const pr = (files) => ({
    api: fakeApi({ 'pulls/5/files': files.map((filename) => ({ filename })) }),
    repo,
    eventName: 'pull_request',
    event: { pull_request: { number: 5, changed_files: files.length } },
    sha: 'head',
    tree: 'tree1',
    runId: 1,
  });

  it('runs only `checks`, with no marker, for a docs-only pull request', async () => {
    assert.deepEqual(await plan(pr(['docs/a.md', 'README.md'])), { run: 'checks', marker: '' });
  });
  it('runs everything for a pull request that changes code, and records the tree', async () => {
    assert.deepEqual(await plan(pr(['docs/a.md', 'tools/ci/scope.mjs'])), {
      run: 'all',
      marker: markerFor('tree1'),
    });
  });

  const push = (routes, before = 'parent') => ({
    api: fakeApi(routes),
    repo,
    eventName: 'push',
    event: { ref: 'refs/heads/main', before },
    sha: 'head',
    tree: 'tree1',
    runId: 99,
  });

  it('runs nothing on main when these exact files already passed', async () => {
    assert.deepEqual(await plan(push(passedTree('tree1', 7))), { run: 'none', marker: '' });
  });
  it('runs only `checks` on main for docs after a commit that passed, and counts as passed', async () => {
    const routes = {
      ...passedTree('ptree', 8),
      'compare/parent...head': { status: 'ahead', files: [{ filename: 'docs/a.md' }] },
      'git/commits/parent': { tree: { sha: 'ptree' } },
    };
    assert.deepEqual(await plan(push(routes)), { run: 'checks', marker: markerFor('tree1') });
  });
  it('runs everything on main for docs after a commit that did not pass', async () => {
    const routes = {
      ...passedTree('other', 8),
      'compare/parent...head': { status: 'ahead', files: [{ filename: 'docs/a.md' }] },
      'git/commits/parent': { tree: { sha: 'ptree' } },
    };
    assert.deepEqual(await plan(push(routes)), { run: 'all', marker: markerFor('tree1') });
  });
  it('runs everything on main for code, or a new branch with no commit before it', async () => {
    const routes = {
      'actions/artifacts': { artifacts: [] },
      'compare/parent...head': { status: 'ahead', files: [{ filename: 'apps/worker/src/index.ts' }] },
    };
    assert.equal((await plan(push(routes))).run, 'all');
    assert.equal((await plan(push(routes, '0000000000000000000000000000000000000000'))).run, 'all');
  });
  it('runs everything for a push to another branch', async () => {
    const p = push({});
    p.event.ref = 'refs/heads/feature';
    assert.equal((await plan(p)).run, 'all');
    assert.deepEqual(p.api.calls, []);
  });
});

describe('the deploy gate', () => {
  const run = (status, conclusion = null) => ({ status, conclusion });

  it('passes when any ci run of the commit succeeded', () => {
    assert.equal(ciVerdict([run('completed', 'failure'), run('completed', 'success')]), 'passed');
    assert.equal(ciVerdict([run('in_progress'), run('completed', 'success')]), 'passed');
  });
  it('waits while there is no run, or one is still going', () => {
    assert.equal(ciVerdict([]), 'waiting');
    assert.equal(ciVerdict([run('queued'), run('completed', 'failure')]), 'waiting');
  });
  it('calls runs that were all cancelled `cancelled`, and any other finish a failure', () => {
    assert.equal(ciVerdict([run('completed', 'cancelled'), run('completed', 'cancelled')]), 'cancelled');
    assert.equal(ciVerdict([run('completed', 'cancelled'), run('completed', 'failure')]), 'failed');
    assert.equal(ciVerdict([run('completed', 'skipped')]), 'failed');
  });

  const deployed = (files) => ({
    deployments: [{ id: 1, sha: 'live' }],
    'deployments/1/statuses': [{ state: 'success' }],
    'compare/live...head': { status: 'ahead', files: files.map((filename) => ({ filename })) },
  });
  const quiet = () => {};

  it('skips the deploy when only docs changed since production', async () => {
    assert.equal(await changesProduction(fakeApi(deployed(['docs/a.md'])), 'head', quiet), false);
  });
  it('deploys when code changed, or production is unknown, or GitHub fails', async () => {
    assert.equal(
      await changesProduction(fakeApi(deployed(['docs/a.md', 'apps/web/x.ts'])), 'head', quiet),
      true,
    );
    assert.equal(await changesProduction(fakeApi({ deployments: [] }), 'head', quiet), true);
    assert.equal(await changesProduction(fakeApi({}), 'head', quiet), true);
  });
  it('finds production from the newest deployment that succeeded', async () => {
    const api = fakeApi({
      deployments: [
        { id: 2, sha: 'broken' },
        { id: 1, sha: 'live' },
      ],
      'deployments/2/statuses': [{ state: 'failure' }],
      'deployments/1/statuses': [{ state: 'success' }],
    });
    assert.equal(await liveSha(api), 'live');
  });
});
