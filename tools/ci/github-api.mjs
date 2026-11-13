// The GitHub REST API from a Claude session or a laptop, for watch-runs.mjs and flaky-report.mjs. It calls curl, not
// fetch: Node's fetch ignores HTTPS_PROXY, which cloud sessions need. It sends GH_TOKEN (or GITHUB_TOKEN) when one is
// set; without one the repository is public, so it works with GitHub's lower limit of requests per hour.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A failed API call: `status` is the HTTP status (0 when curl itself failed), `waitMs` how long GitHub asks to wait. */
export class ApiError extends Error {
  constructor(message, status, waitMs = 0) {
    super(message);
    this.status = status;
    this.waitMs = waitMs;
  }
  /** True for GitHub's rate limits (403 or 429 that say so), when waiting is the fix. */
  get rateLimited() {
    return this.status === 429 || (this.status === 403 && /rate limit/i.test(this.message));
  }
}

/** owner/name from GITHUB_REPOSITORY, else from the `origin` remote, else the project's own repository. */
export function repoSlug() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const slug = slugFromRemote(url);
    if (slug) return slug;
  } catch {
    // No git or no origin remote: use the fallback.
  }
  return 'evanmurray2/ledgerline';
}

/** owner/name from a GitHub remote URL (https or ssh); null for any other host. A session's git proxy URL ends the same way. */
export function slugFromRemote(url) {
  const m =
    /github\.com[:/]+([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url) ??
    /\/git\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
  return m ? m[1] : null;
}

/** How long to wait from a response's headers: Retry-After, or until x-ratelimit-reset when none are left. */
export function waitFromHeaders(headers, now = Date.now()) {
  const after = Number(headers['retry-after']);
  if (after > 0) return after * 1000;
  if (headers['x-ratelimit-remaining'] === '0') {
    const reset = Number(headers['x-ratelimit-reset']) * 1000;
    if (reset > now) return reset - now;
  }
  return 0;
}

/** The headers of the last response in a curl -D dump (a proxy's CONNECT reply comes first), lower-cased. */
export function lastHeaders(dump) {
  const blocks = dump.split(/\r?\n\r?\n/).filter((b) => b.startsWith('HTTP/'));
  const headers = {};
  for (const line of (blocks.at(-1) ?? '').split(/\r?\n/).slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return headers;
}

/** A GET reader for `repo`; it throws an ApiError that says what GitHub answered. */
export function githubApi(repo, token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
  return (path) => {
    const dir = mkdtempSync(join(tmpdir(), 'gh-api-'));
    const headerFile = join(dir, 'headers');
    try {
      let out;
      try {
        out = execFileSync(
          'curl',
          [
            '-sS',
            '--retry',
            '3',
            '-D',
            headerFile,
            '-w',
            '\n%{http_code}',
            '-H',
            'accept: application/vnd.github+json',
            ...(token ? ['-H', `authorization: Bearer ${token}`] : []),
            `https://api.github.com/repos/${repo}/${path}`,
          ],
          {
            encoding: 'utf8',
            timeout: 30_000,
            maxBuffer: 64 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
      } catch (e) {
        throw new ApiError(`curl failed for ${path}: ${String(e.stderr || e.message).trim()}`, 0);
      }
      const cut = out.lastIndexOf('\n');
      const status = Number(out.slice(cut + 1));
      const body = out.slice(0, cut);
      if (status >= 200 && status < 300) return JSON.parse(body);
      let message = body.slice(0, 200);
      try {
        message = JSON.parse(body).message ?? message;
      } catch {
        // Not JSON (a proxy's page): keep the start of the text.
      }
      let headers = {};
      try {
        headers = lastHeaders(readFileSync(headerFile, 'utf8'));
      } catch {
        // No headers written.
      }
      throw new ApiError(`GitHub API ${status} for ${path}: ${message}`, status, waitFromHeaders(headers));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
