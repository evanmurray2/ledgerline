// The robot check's own address (docs/privacy.md 5.6) for the e2e configs that sign up: the second Worker
// (apps/worker/wrangler.check.jsonc) on 127.0.0.1, which is another origin than the app's localhost, as the
// check's workers.dev name is in production. Cloudflare's always-pass test site key: the page sends the browser
// straight back with the dummy token, with no network call.
export function checkServer(appPort: number) {
  const port = appPort + 1000;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    /** The app's Worker takes tokens from this address. */
    appVars: `--var CHECK_URL:${url} --var TURNSTILE_SECRET:1x0000000000000000000000000000000AA`,
    webServer: {
      command:
        `cd ../apps/worker && pnpm exec wrangler dev -c wrangler.check.jsonc --ip 127.0.0.1 --port ${port} ` +
        `--inspector-port ${port + 1} --persist-to .wrangler/e2e-check-${port} ` +
        `--var APP_URL:http://localhost:${appPort} --var TURNSTILE_SITE_KEY:1x00000000000000000000AA`,
      url: `${url}/check.js`,
      stdout: 'pipe' as const,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  };
}
