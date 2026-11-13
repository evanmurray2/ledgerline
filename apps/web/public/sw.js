// Offline start: keeps the app's own files on the phone so it opens with no signal, showing the screens saved on
// the device (src/state/saved.ts) with changes turned off. Never caches anything under /api: money data only
// comes from the server or from the saved copy the app manages itself.
//   Pages: network first, so a new release shows at once; the saved shell only when offline.
//   /assets/*: file names carry a content hash, so a saved copy is always right; kept from the release in use.
//   Every file of the release under /assets is saved at once (release.json lists them), lazy screens too: a screen
//   first opened with no signal must not fail to load and reload the app, which would lose the edits waiting to send.
const CACHE = 'ledgerline-shell-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const res = await fetch('/', { cache: 'no-store' });
      if (!res.ok) return;
      const html = await res.clone().text();
      await cache.put('/', res);
      // The scripts and styles the page starts with, then every other file of the release.
      const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
      await cache.addAll([...new Set(assets)]);
      await saveRelease(cache);
    })().catch(() => undefined),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          // Keep the newest shell, and only the assets it uses.
          if (res.ok) {
            const cache = await caches.open(CACHE);
            await cache.put('/', res.clone());
            const html = await res.clone().text();
            event.waitUntil(
              saveRelease(cache)
                .then((release) => prune(cache, html, release))
                .catch(() => undefined),
            );
          }
          return res;
        } catch {
          return (await caches.match('/')) ?? Response.error();
        }
      })(),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      (async () => {
        const hit = await caches.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) await (await caches.open(CACHE)).put(req, res.clone());
        return res;
      })(),
    );
  }
});

/**
 * Saves every /assets file of the release the server has now (its release.json, written by the build) and gives
 * back their paths. A file already saved isn't fetched again: its name carries its content hash. Nothing when
 * release.json can't be read.
 */
async function saveRelease(cache) {
  const res = await fetch('/release.json', { cache: 'no-store' }).catch(() => null);
  if (!res || !res.ok) return [];
  const body = await res.json().catch(() => null);
  const files = body && Array.isArray(body.files) ? body.files : [];
  const paths = files
    .map((f) => (f && typeof f.path === 'string' ? `/${f.path}` : ''))
    .filter((p) => p.startsWith('/assets/'));
  for (const p of paths) if (!(await cache.match(p))) await cache.add(p).catch(() => undefined);
  return paths;
}

/**
 * Drops saved assets of older releases: keeps what the current page starts with, the release's own files, and the
 * lazily loaded screens its scripts refer to by name.
 */
async function prune(cache, html, release = []) {
  const keep = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
  if (!keep.length) return;
  let scripts = '';
  for (const p of keep.filter((x) => x.endsWith('.js'))) {
    const res = await cache.match(p);
    if (res) scripts += await res.text();
  }
  for (const req of await cache.keys()) {
    const p = new URL(req.url).pathname;
    if (!p.startsWith('/assets/') || keep.includes(p) || release.includes(p)) continue;
    if (!scripts.includes(p.split('/').pop())) await cache.delete(req);
  }
}
