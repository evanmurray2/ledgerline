// Settings → About (docs/privacy.md 5.9): the release's commit and build hash, and a page that still opens when
// /release.json can't be read.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReleaseFacts } from '../src/screens/settings/About';
import { fetchRelease, parseRelease, shortCommit } from '../src/lib/release';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const HASH = 'ab'.repeat(32);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('release.json', () => {
  it('reads the commit and the build hash', () => {
    const text = JSON.stringify({
      commit: COMMIT,
      hash: HASH,
      files: [{ path: 'index.html', sha256: HASH }],
    });
    expect(parseRelease(text)).toEqual({ commit: COMMIT, hash: HASH });
  });

  it('is null for anything else: the app page, a short hash, no hash', () => {
    expect(parseRelease('<!doctype html><html></html>')).toBeNull();
    expect(parseRelease(JSON.stringify({ commit: COMMIT, hash: 'abc' }))).toBeNull();
    expect(parseRelease(JSON.stringify({ commit: COMMIT }))).toBeNull();
    expect(parseRelease('null')).toBeNull();
  });

  it('is null when the device is offline or the server fails', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Load failed')));
    expect(await fetchRelease()).toBeNull();
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('no', { status: 503 })));
    expect(await fetchRelease()).toBeNull();
  });

  it('asks the server, not a saved copy', async () => {
    const fetched = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ commit: COMMIT, hash: HASH, files: [] }))),
    );
    vi.stubGlobal('fetch', fetched);
    expect(await fetchRelease()).toEqual({ commit: COMMIT, hash: HASH });
    expect(fetched.mock.calls[0]).toEqual(['/release.json', { cache: 'no-store' }]);
  });

  it('shortens a commit and leaves other names alone', () => {
    expect(shortCommit(COMMIT)).toBe('0123456');
    expect(shortCommit('dev')).toBe('dev');
  });
});

describe('Settings → About', () => {
  it('shows the version, the short commit and the build hash, and copies the full commit', async () => {
    const writeText = vi.fn((_text: string) => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(
      <ReleaseFacts
        commit={COMMIT}
        version="0.1.0"
        load={() => Promise.resolve({ commit: COMMIT, hash: HASH })}
      />,
    );
    expect(screen.getByText('0.1.0')).toBeTruthy();
    expect(screen.getByText('0123456')).toBeTruthy();
    expect(await screen.findByText(HASH)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy commit' }));
    expect(writeText).toHaveBeenCalledWith(COMMIT);
    fireEvent.click(screen.getByRole('button', { name: 'Copy build hash' }));
    expect(writeText).toHaveBeenCalledWith(HASH);
  });

  it('still shows the commit when the build hash can’t be read', async () => {
    render(<ReleaseFacts commit={COMMIT} version="0.1.0" load={() => Promise.resolve(null)} />);
    expect(screen.getByText('Checking')).toBeTruthy();
    expect(
      await screen.findByText('Not available now. Connect to the internet and open this page again.'),
    ).toBeTruthy();
    expect(screen.getByText('0123456')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copy build hash' })).toBeNull();
  });

  it('does not show the hash of another release as this one’s', async () => {
    render(
      <ReleaseFacts
        commit={COMMIT}
        version="0.1.0"
        load={() => Promise.resolve({ commit: 'f'.repeat(40), hash: HASH })}
      />,
    );
    expect(
      await screen.findByText('A newer release is ready. Close Ledgerline and open it again.'),
    ).toBeTruthy();
    expect(screen.queryByText(HASH)).toBeNull();
  });

  it('says so when the build is not a release', async () => {
    render(
      <ReleaseFacts
        commit="dev"
        version="0.1.0"
        load={() => Promise.resolve({ commit: 'dev', hash: HASH })}
      />,
    );
    expect(screen.getByText('Test build, not a release')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copy commit' })).toBeNull();
    expect(await screen.findByText(HASH)).toBeTruthy();
  });
});
