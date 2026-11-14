// The release this app was built as (docs/privacy.md 5.9). The commit and the version are built into the code. The
// build hash can't be: it covers the code's own files. So the build writes it beside the app, in /release.json
// (tools/ci/build-hashes.mjs), and Settings → About reads that file.
import { BUILT_AS } from '../state/version';

declare const __WEB_VERSION__: string;

/** The app's version number (apps/web/package.json). */
export const WEB_VERSION = typeof __WEB_VERSION__ === 'string' ? __WEB_VERSION__ : 'dev';
/** The commit this code was built from, or "dev" for a build that is not a release. */
export const COMMIT = BUILT_AS;

export interface Release {
  commit: string;
  /** SHA-256 of the list of files: one number for the whole build. */
  hash: string;
}

/** The release in /release.json's text, or null when the text is anything else (offline pages, an old server). */
export function parseRelease(text: string): Release | null {
  try {
    const v = JSON.parse(text) as { commit?: unknown; hash?: unknown } | null;
    if (!v || typeof v.commit !== 'string' || typeof v.hash !== 'string') return null;
    if (!/^[0-9a-f]{64}$/.test(v.hash)) return null;
    return { commit: v.commit, hash: v.hash };
  } catch {
    return null;
  }
}

/** A commit as people quote it: its first 7 characters. */
export function shortCommit(commit: string): string {
  return /^[0-9a-f]{40}$/.test(commit) ? commit.slice(0, 7) : commit;
}
