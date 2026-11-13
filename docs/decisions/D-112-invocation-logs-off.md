# D-112: Cloudflare's invocation logs are off (Nov 13, 2026)

**Decided by the owner** (chat, Nov 13, 2026): asked whether to turn off Cloudflare's invocation logs, the owner chose
"Turn them off". Until now the owner kept them on (`docs/privacy.md` 15.4).

**Decision.** `invocation_logs` is `false` in `apps/worker/wrangler.jsonc`. Workers Logs stays on for the app's own log
lines, which hold only an allowlist of fields (`apps/worker/src/http/context.ts` `log`).

**What this changes.**

- Cloudflare no longer keeps, for 3 days, each request's IP address, a location for it, the browser, its full address
  and its headers (`docs/privacy.md` 15.4 lists what they held). `docs/claims.md` says so.
- Each request's CPU time was read from these logs. CPU on Cloudflare is now judged from local measurements
  (`docs/measurements.md`) and from errors; to measure a step on Cloudflare again, turn them on in a PR for that, and
  off again after.
- Fixing a problem in production has less to go on: the app's own log lines and the response codes only.

**Still to check.** Whether Cloudflare adds request fields (the IP address) to a line the app logs during a request.
`docs/privacy.md` 15.4 saw none inside a store and left a line logged in a request unchecked. Checked after the deploy
with a read-only query of the Workers observability API.
