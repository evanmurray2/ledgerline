// The parts of github-api.mjs that need no network: the repository from a remote, and what a rate limit asks for.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiError, lastHeaders, slugFromRemote, waitFromHeaders } from './github-api.mjs';

describe('github-api', () => {
  it('reads owner/name from an https, ssh or session proxy remote', () => {
    assert.equal(slugFromRemote('https://github.com/owner/app'), 'owner/app');
    assert.equal(slugFromRemote('https://github.com/owner/app.git'), 'owner/app');
    assert.equal(slugFromRemote('git@github.com:owner/app.git'), 'owner/app');
    assert.equal(slugFromRemote('http://local_proxy@127.0.0.1:1234/git/owner/app'), 'owner/app');
    assert.equal(slugFromRemote('https://example.com/owner/app'), null);
  });

  it("takes the last response's headers, after a proxy's CONNECT reply", () => {
    const dump =
      'HTTP/1.1 200 Connection established\r\n\r\nHTTP/2 403\r\nX-RateLimit-Remaining: 0\r\nx-ratelimit-reset: 120\r\n\r\n';
    assert.deepEqual(lastHeaders(dump), { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '120' });
  });

  it('waits for Retry-After, or until the limit resets when none are left', () => {
    assert.equal(waitFromHeaders({ 'retry-after': '60' }), 60_000);
    assert.equal(
      waitFromHeaders({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '120' }, 100_000),
      20_000,
    );
    assert.equal(waitFromHeaders({ 'x-ratelimit-remaining': '5', 'x-ratelimit-reset': '120' }, 100_000), 0);
  });

  it('tells a rate limit from another refusal', () => {
    assert.equal(
      new ApiError('GitHub API 403 for x: API rate limit exceeded for 1.2.3.4', 403).rateLimited,
      true,
    );
    assert.equal(new ApiError('GitHub API 429 for x: slow down', 429).rateLimited, true);
    assert.equal(new ApiError('GitHub API 403 for x: Resource not accessible', 403).rateLimited, false);
  });
});
