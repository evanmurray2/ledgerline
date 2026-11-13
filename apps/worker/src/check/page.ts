// The robot check's own address (docs/privacy.md 5.6, D-113): a second, tiny Worker (wrangler.check.jsonc, entry
// index.ts) on its own workers.dev name. Sign-up's robot check (Cloudflare Turnstile) needs a script and a frame from
// challenges.cloudflare.com, and the app's address must never run an outside script, because its pages can reach
// the keys the app holds. So the check runs here: this Worker has no bindings, sets no cookie and stores nothing.
// Its one page runs the check and sends the browser back to the app's sign-in with the one-use token in the
// address's fragment (#check=…), which never reaches a server or its logs. The app's Worker then checks the token
// with Cloudflare (routes/signup.ts), and the token's hostname must be this address.
// Nothing here is read from the request: the way back is APP_URL, so the page can't send anyone elsewhere.

export interface CheckEnv {
  /** The app's address, e.g. https://ledgerline.ledger-line.workers.dev (no trailing slash needed). */
  APP_URL?: string;
  /** Cloudflare Turnstile's public site key for this address. Empty: the page says the check isn't set up. */
  TURNSTILE_SITE_KEY?: string;
}

/** Only Turnstile: its script, its frame and its calls. Styles may be inline, for the widget's own. */
export const CHECK_CSP = [
  "default-src 'none'",
  "script-src 'self' https://challenges.cloudflare.com",
  'frame-src https://challenges.cloudflare.com',
  'connect-src https://challenges.cloudflare.com',
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const HEADERS: Record<string, string> = {
  'content-security-policy': CHECK_CSP,
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  // The origin only: Turnstile checks which address it runs on. The page's address holds nothing else.
  'referrer-policy': 'strict-origin',
  'cross-origin-opener-policy': 'same-origin',
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'cache-control': 'no-store',
};

/** The app's sign-in, where the token goes back to: APP_URL's origin, or null when it isn't a usable address. */
export function appSignIn(env: CheckEnv): string | null {
  try {
    const u = new URL(env.APP_URL ?? '');
    if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return null;
    return `${u.origin}/budget`;
  } catch {
    return null;
  }
}

/** JSON safe inside a <script> element: no "<" can close it. */
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Said when the check can't load or fails (the app said the same before the check moved here). */
export const CHECK_FAILED = 'The robot check couldn’t load. Check your connection, then try the check again.';
const NOT_SET_UP = 'The robot check isn’t set up yet. Go back to Ledgerline.';

export function checkPage(env: CheckEnv): string {
  const back = appSignIn(env);
  const siteKey = (env.TURNSTILE_SITE_KEY ?? '').trim();
  const config = { back, siteKey: back ? siteKey : '' };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>Robot check · Ledgerline</title>
<link rel="stylesheet" href="/check.css">
</head>
<body>
<main>
<p class="brand">Ledgerline</p>
<h1>Robot check</h1>
<p data-state="wait">Cloudflare checks that you’re not a robot. Then you go back to Ledgerline.</p>
<div id="box"></div>
<div data-state="failed" hidden>
<p role="alert">${CHECK_FAILED}</p>
<button type="button" id="again">Try the check again</button>
</div>
<p data-state="unset" role="alert" hidden>${NOT_SET_UP}</p>
${back ? `<p><a href="${esc(back)}">Back to Ledgerline</a></p>` : ''}
</main>
<script type="application/json" id="config">${scriptJson(config)}</script>
<script src="/check.js"></script>
</body>
</html>
`;
}

/**
 * The page's script. Cloudflare's documented test site keys (1x… passes, 2x… and 3x… fail) hand back their dummy
 * token at once without loading anything, for local runs and e2e, as the app did before. A real key loads
 * Turnstile, and a check that can't load or fails says so and offers to try again.
 */
export const CHECK_JS = `'use strict';
(function () {
  var config = JSON.parse(document.getElementById('config').textContent);
  function show(state) {
    var all = document.querySelectorAll('[data-state]');
    for (var i = 0; i < all.length; i++) all[i].hidden = all[i].getAttribute('data-state') !== state;
  }
  if (!config.back || !config.siteKey) return show('unset');
  function done(token) {
    location.replace(config.back + '#check=' + encodeURIComponent(token));
  }
  if (/^[123]x0{20}AA$/.test(config.siteKey))
    return done(config.siteKey.charAt(0) === '1' ? 'XXXX.DUMMY.TOKEN.XXXX' : 'fails');
  var id = null;
  var over = false;
  function fail() {
    if (over) return;
    over = true;
    show('failed');
  }
  document.getElementById('again').addEventListener('click', function () {
    location.reload();
  });
  function draw() {
    if (!window.turnstile) return fail();
    try {
      id = window.turnstile.render('#box', {
        sitekey: config.siteKey,
        action: 'signup',
        callback: function (token) {
          over = true;
          done(token);
        },
        'error-callback': fail,
        'expired-callback': fail,
      });
    } catch (e) {
      fail();
    }
  }
  // Blocked or slow: the check never shows, so say so instead of waiting for ever.
  setTimeout(function () {
    if (!id) fail();
  }, 20000);
  var s = document.createElement('script');
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  s.async = true;
  s.onload = draw;
  s.onerror = fail;
  document.head.appendChild(s);
})();
`;

/** No colors or sizes of its own: the browser's, light or dark. */
export const CHECK_CSS = `body { margin: 0; font-family: system-ui, -apple-system, sans-serif; line-height: 1.5; }
main { max-width: 400px; margin: 0 auto; padding: 40px 16px; display: flex; flex-direction: column; gap: 12px; }
h1, p { margin: 0; }
.brand { font-weight: bold; text-transform: uppercase; letter-spacing: 0.08em; }
button { font: inherit; padding: 8px 16px; }
[hidden] { display: none; }
`;

export function handleCheck(req: Request, env: CheckEnv): Response {
  const path = new URL(req.url).pathname;
  const send = (body: string, type: string, status = 200) =>
    new Response(req.method === 'HEAD' ? null : body, {
      status,
      headers: { ...HEADERS, 'content-type': `${type}; charset=utf-8` },
    });
  if (req.method !== 'GET' && req.method !== 'HEAD') return send('Not found.', 'text/plain', 404);
  if (path === '/') return send(checkPage(env), 'text/html');
  if (path === '/check.js') return send(CHECK_JS, 'text/javascript');
  if (path === '/check.css') return send(CHECK_CSS, 'text/css');
  return send('Not found.', 'text/plain', 404);
}
