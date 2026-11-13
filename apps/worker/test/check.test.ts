// The robot check's own address (docs/privacy.md 5.6, D-113): the second Worker's page and headers, and the app's
// Worker taking a token only from that address.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHECK_CSP, appSignIn, checkPage, handleCheck } from '../src/check/page.js';
import { verifyTurnstile } from '../src/routes/signup.js';
import { checkHost, signupSwitchOn } from '../src/routes/signup-switch.js';
import type { Env } from '../src/env.js';

const ENV = { APP_URL: 'https://ledgerline.ledger-line.workers.dev', TURNSTILE_SITE_KEY: '0x4AAAAAAAreal' };
const get = (path: string, env = ENV, method = 'GET') =>
  handleCheck(new Request(`https://ledgerline-check.ledger-line.workers.dev${path}`, { method }), env);

describe('the check page', () => {
  it('allows Turnstile and nothing else, sets no cookie, and is not kept', async () => {
    const r = await get('/');
    expect(r.status).toBe(200);
    const csp = r.headers.get('content-security-policy')!;
    expect(csp).toBe(CHECK_CSP);
    // Every outside host it names is Turnstile's.
    expect(csp.match(/https:\/\/[^\s;]+/g)!.every((h) => h === 'https://challenges.cloudflare.com')).toBe(
      true,
    );
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(r.headers.get('set-cookie')).toBeNull();
    expect(r.headers.get('cache-control')).toBe('no-store');
    const html = await r.text();
    // The way back is the app's sign-in, from config: nothing from the request.
    expect(html).toContain('"back":"https://ledgerline.ledger-line.workers.dev/budget"');
    expect(html).toContain('"siteKey":"0x4AAAAAAAreal"');
    expect(html).toContain('<script src="/check.js"></script>');
    // No inline script runs: the config is data.
    expect(html.match(/<script(?![^>]*(src=|type="application\/json"))/g)).toBeNull();
  });

  it('serves its script and style, and nothing else', async () => {
    expect((await get('/check.js')).headers.get('content-type')).toContain('text/javascript');
    expect(await (await get('/check.js')).text()).toContain("action: 'signup'");
    expect((await get('/check.css')).status).toBe(200);
    expect((await get('/api/auth/status')).status).toBe(404);
    expect((await get('/budget')).status).toBe(404);
    expect((await get('/', ENV, 'POST')).status).toBe(404);
    expect(await (await get('/', ENV, 'HEAD')).text()).toBe('');
  });

  it('goes back only to an https app address, or to localhost for local runs', () => {
    expect(appSignIn({ APP_URL: 'https://a.example/x?y' })).toBe('https://a.example/budget');
    expect(appSignIn({ APP_URL: 'http://localhost:8799' })).toBe('http://localhost:8799/budget');
    expect(appSignIn({ APP_URL: 'http://a.example' })).toBeNull();
    expect(appSignIn({ APP_URL: 'javascript:alert(1)' })).toBeNull();
    expect(appSignIn({})).toBeNull();
  });

  it('says it is not set up without a site key or an app address, and a config can’t close its script', () => {
    expect(checkPage({ APP_URL: ENV.APP_URL })).toContain('"siteKey":""');
    expect(checkPage({ TURNSTILE_SITE_KEY: 'k' })).toContain('{"back":null,"siteKey":""}');
    expect(checkPage({ APP_URL: ENV.APP_URL, TURNSTILE_SITE_KEY: '</script><b>' })).not.toContain(
      '</script><b>',
    );
  });
});

describe('the app’s Worker and the check’s address', () => {
  afterEach(() => vi.restoreAllMocks());
  const env = (over: Partial<Env>) =>
    ({ PLAID_ENV: 'production', TURNSTILE_SECRET: 'real-secret', ...over }) as unknown as Env;

  it('keeps sign-up off until the check has its address', () => {
    const on = { SIGNUPS: 'open', CHECK_URL: 'https://ledgerline-check.ledger-line.workers.dev' };
    expect(signupSwitchOn(env(on))).toBe(true);
    expect(signupSwitchOn(env({ ...on, CHECK_URL: undefined }))).toBe(false);
    expect(signupSwitchOn(env({ ...on, CHECK_URL: 'not an address' }))).toBe(false);
    expect(checkHost(env(on))).toBe('ledgerline-check.ledger-line.workers.dev');
  });

  it('takes a token only when Cloudflare says it came from the check’s address', async () => {
    const answer = (hostname: string) =>
      vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(Response.json({ success: true, hostname, action: 'signup' }));
    const e = env({ CHECK_URL: 'https://ledgerline-check.ledger-line.workers.dev' });
    answer('ledgerline-check.ledger-line.workers.dev');
    expect(await verifyTurnstile(e, 't', null, 'signup', checkHost(e)!)).toBe(true);
    answer('ledgerline.ledger-line.workers.dev');
    expect(await verifyTurnstile(e, 't', null, 'signup', checkHost(e)!)).toBe(false);
  });
});
