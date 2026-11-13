# D-113: Sign-up's robot check on its own address (Nov 13, 2026)

**Builds** `docs/privacy.md` 5.6: Turnstile needs a script and a frame from `challenges.cloudflare.com`, and no page on
the app's address may run an outside script, because those pages can reach the keys the app holds.

**Replaces** `docs/open-signup.md` 3.1 and 13: the Turnstile check was a widget on the Create account screen, and
turning sign-up on added `https://challenges.cloudflare.com` to the app's CSP. The app's CSP now never changes for it.

**Decision.**

1. **A second Worker,** `ledgerline-check` (`apps/worker/wrangler.check.jsonc`, `apps/worker/src/check/`), on its own
   `workers.dev` name: free, no bindings, no storage, no secrets, no request logs. It serves one page (`/`) with its
   script and style. Its CSP allows only `challenges.cloudflare.com` (script, frame, calls). It reads nothing from
   the request: the way back is its `APP_URL` variable, and the site key is its `TURNSTILE_SITE_KEY` variable.
2. **The way there and back.** Create account on Sign in goes to `CHECK_URL`. When the check passes, the page sends
   the browser to `APP_URL/budget#check=<token>`. The token is in the fragment, so no server or log sees it. The app
   reads it once, takes it out of the address, and opens Create account. `location.replace` keeps the check page out
   of history.
3. **The app's Worker** has `CHECK_URL` instead of `TURNSTILE_SITE_KEY`. The sign-up switch needs it (a valid
   address), `GET /api/auth/status` gives it as `checkUrl`, and `siteverify`'s `hostname` must be its host. A token
   is taken once, so after a failed try Create account offers **Do the robot check again**.
4. **Not deployed by this change.** `deploy.yml` deploys only `wrangler.jsonc`. Deploying the second Worker makes a new
   Worker in the owner's Cloudflare account, so it waits for the owner, with the other steps to turn sign-up on
   (`docs/open-signup.md` 13). Sign-up stays off (`SIGNUPS`).
5. **Tests.** `apps/worker/test/check.test.ts` (headers, page, the host check); the signup and lock e2e configs run the
   second Worker on `127.0.0.1` (another origin than the app's `localhost`) with Cloudflare's test site key
   (`e2e/check-server.ts`), and `e2e/tests/signup.spec.ts` goes through it and checks the page's "couldn't load"
   path with the script blocked.

**Not checked:** a real Turnstile widget on that page (needs the owner's widget), and the trip there and back from
the Home Screen app on an iPhone (a link on Plaid's site came back into the app the same way, `docs/privacy.md` 15.4).
