# Open sign-up: built, switched off

Status: v1 draft, Nov 9, 2026. Decision D-74 (`docs/decisions/D-74-open-signup.md`). It replaces the invite design in `docs/multi-user.md` 7.3 and 7.4. The rest of `docs/multi-user.md` stands.

## 0. What the owner asked

- Drop the invite-only design. Anyone may make an account once sign-up is on.
- Build everything needed for thousands of users, but **keep sign-up off**.
- **Change no other decision.** The $0 free plan (D-26, D-27), no off-site backups (D-29), no staging (D-36), no monitor (D-49), the 10 ms CPU rule and the D-40 breaker all stay. Where scale needs one of them changed, this doc only lists it for the day sign-up is turned on (section 12).

Non-goals: turning sign-up on, paid plans, Plaid Production, email, billing, sharing one budget between people, backups, monitoring.

## 1. Rules that hold everywhere

1. **While the switch is off, nothing anyone can see changes.** The new routes return 404 and the app shows nothing new. The owner's budget works as today.
2. **One user's data is only reachable through that user's session** (`docs/multi-user.md` 11). A test proves it for every route (section 10).
3. **The Plaid link count is account-wide and never undercounts.** Plaid's 10 Trial links are for the whole Plaid account, not per budget.
4. **No user can use up the free plan for everyone** (section 7).
5. **No change to how money is counted.** Nothing here touches `packages/domain`.

## 2. The switch

Worker variables in `apps/worker/wrangler.jsonc` (`vars`). Changing one is a merge to `main` (D-49), so turning sign-up on is a reviewed PR.

| Variable             | Default | Meaning                                                                                |
| -------------------- | ------- | -------------------------------------------------------------------------------------- |
| `SIGNUPS`            | `off`   | `open` lets anyone make an account. Any other value is `off`.                          |
| `MAX_USERS`          | `1`     | Accounts allowed, counting active, turned-off and deleting users.                      |
| `SIGNUPS_PER_DAY`    | `50`    | New accounts allowed per UTC day, account-wide.                                        |
| `NEW_USER_LINKS`     | `0`     | Bank links a new user may use.                                                         |
| `PLAID_LINK_CAP`     | `10`    | Bank links for the whole Plaid account, for life. `0` means no cap (Plaid Production). |
| `TURNSTILE_SITE_KEY` | none    | Cloudflare Turnstile site key (public).                                                |

New secret, added only when turning on: `TURNSTILE_SECRET`.

Sign-up is open only when **all** of these hold: `SIGNUPS` is `open`, `TURNSTILE_SECRET` and `TURNSTILE_SITE_KEY` are set, `devSignIn()` is false, and the first user exists. Otherwise every sign-up route answers 404, the same as an unknown route, and `GET /api/auth/status` returns `signupOpen: false`.

## 3. Making an account

### 3.1 Screens

- Sign-in screen: **Create account** appears under **Sign in** only when `signupOpen` is true.
- Create account: a **Name** field (1–60 characters, shown on the passkey and in Settings), the Turnstile check, then **Create passkey**.
- After the passkey: the recovery code screen (3.4). The user must tick "I saved my recovery code" to go on.
- Then the existing first-run Setup (`apps/web/src/screens/Setup.tsx`) on an empty budget.
- UI text goes into `docs/copy.md` first.

### 3.2 Server

`POST /api/auth/signup/options` with `{ name, turnstileToken }`:

1. The switch check (section 2). Off → 404.
2. The rate limit: the existing `AUTH_LIMITER` (20 a minute per IP), under its own key `signup:<ip>`.
3. Turnstile: the Worker posts the token to Cloudflare's `siteverify` with the secret and the client IP. It checks `success`, the `hostname` (the RP id) and the `action` (`signup`). A token is single use at Cloudflare, so a replayed token fails there.
4. Cheap checks against the Directory, read only: users < `MAX_USERS`, sign-ups today < `SIGNUPS_PER_DAY`. These give a clear "Sign-up is full" message early; step 5 is the real guard.
5. No database write. A new random WebAuthn handle (32 bytes) and the name go into the signed challenge cookie as the grant `{ kind: 'signup', handle, name }`. The registration options use that handle, with `excludeCredentials` empty.

`POST /api/auth/register/verify` with a `signup` grant runs one Directory batch (one SQLite transaction):

- `INSERT INTO user … SELECT … WHERE (SELECT count(*) FROM user) < MAX_USERS AND (SELECT count(*) FROM user WHERE created_at >= today_utc) < SIGNUPS_PER_DAY`. Columns: a new id, `email = 'u:' || id` (the column is `NOT NULL UNIQUE`; email is not identity, 7.1), `display_name`, `is_admin = 0`, `status = 'active'`, `link_allowance = NEW_USER_LINKS`, `webauthn_handle` from the grant.
- `INSERT INTO budget`, `INSERT INTO budget_member` and `INSERT INTO passkey`, each `SELECT … WHERE` the user row from the first statement exists.
- `INSERT INTO recovery_code` (3.4).

If the user insert changed no row, the response is 403 "Sign-up is full right now." Then the session is made as today (`newSession`, with the challenge id under its unique index, so a replay fails). Then the Worker calls the new store's `health()`, which creates it and runs its migrations. A new store fills its first-run rows on its first request, as in `docs/multi-user.md` 6.4; an interrupted sign-up leaves an empty budget that works.

The owner's first-user setup with `SETUP_CODE` stays as it is. A sign-up grant can never make an admin.

### 3.3 Abuse

- Turnstile stops scripted sign-ups. The per-IP rate limit and `SIGNUPS_PER_DAY` cap what gets through.
- A new account can do nothing costly: no bank links (`NEW_USER_LINKS = 0`), and a daily share of the free plan (section 7).
- An admin can turn an account off (section 9).

### 3.4 Recovery codes

Invites came with a reset link the owner sent by hand. That doesn't work for strangers, and email needs a domain. So each non-admin user gets a recovery code. Passkeys synced by iCloud Keychain or Google Password Manager make losing every passkey rare; the code covers the rest.

- The code: 20 random bytes as 32 base32 characters in groups of 4. Only its SHA-256 is stored (`recovery_code.code_hash`); the code has 160 bits, so a slow hash adds nothing.
- Shown once, at sign-up, with Copy. Settings → Sign-in → **New recovery code** (recent passkey check) replaces it and shows the new one once.
- **Use:** Sign-in → **Use a recovery code** → code + Turnstile → `POST /api/auth/recover/options`. A match gives the grant `{ kind: 'recovery', ref: userId }` in the challenge cookie, and nothing is written yet. `register/verify` with that grant runs one batch: delete the code row (`WHERE code_hash = ?` and `changes = 1`, so a code works once), delete the user's passkeys, sessions and device links, revoke their devices (clear `share`, set `revoked_at`, so saved copies are deleted, D-52), insert the new passkey and a new recovery code. Then a session and the new-code screen.
- Not for admins. The owner keeps D-27's device link and the runbook.
- A turned-off account can't recover (the user row must be `active`).
- Wrong codes go through the same rate limit as sign-in.

## 4. Each user's own passkey handle

Today a passkey made with no stored handle falls back to `ledgerline-owner` (`apps/worker/src/routes/auth.ts:204`). That fallback stays only for the setup grant. Every other grant uses the user's own handle (made on first use, as today). Sign-in already checks that the passkey's `userHandle` matches its user.

## 5. Bank links, account-wide

**Problem today:** `link-token` counts connections in the asking budget (`ITEM_LIMIT = 10` in `apps/worker/src/routes/settings/connections.ts`). With two users, each could link 10, and the Plaid account would pass its 10 for life.

**Change:** the Directory owns the count, in `plaid_link_slot` (already in migration 0003, unused).

- Directory migration 0008 backfills one `used` slot for every row in `connection_route`, so the owner's links are counted. The owner's `link_allowance` is already 10.
- `PLAID_LINKS_USED_BEFORE` (default `0`): links Plaid counts that no route records (for example a bank removed before routes existed). Before merging 0008, the count is checked against Plaid's dashboard (7 used on Nov 2); if the routes show fewer, this variable makes up the difference.
- Links used, account-wide = `PLAID_LINKS_USED_BEFORE` + slots that are `used` + slots that are `reserved` and not expired.

**Flow** (`docs/multi-user.md` 6.4):

1. `link-token` (new mode) calls `Directory.reserveSlot(userId, budgetId)`. In one transaction it checks the account-wide count against `PLAID_LINK_CAP` and the user's own used and reserved slots against their `link_allowance`, then inserts a `reserved` slot that expires with the link token (4 hours). It returns the slot id, or why not ("All bank links are used" / "Bank links aren't available on your account. Import a CSV file instead.").
2. The store asks Plaid for the link token and stores `slot_id` with it (hashed link token → slot id, in the Directory slot row: `link_token_hash`).
3. The app gets `{ linkToken, slotId }` and sends `slotId` back with `exchange`.
4. `exchange` **always** saves the Item first, as today: once Link finishes, Plaid has counted it. Then it queues `register_link` with the slot id.
5. `register_link` (already a store job) calls `registerRoute` and then `Directory.useSlot(slotId, userId, budgetId, connectionId)`. `useSlot` never refuses: it marks the slot `used`, or, if the slot is missing, expired or someone else's, inserts a new `used` slot for this user. A link is never lost and never left uncounted.
6. Closing Link without finishing calls `releaseSlot(slotId)`. A slot not released expires on its own.
7. Repair (update mode) never reserves a slot, as today.
8. Slots are never deleted, so removed banks still count, as Plaid counts them.

The confirm step on Plaid Production (`confirmSlot`) stays. The Bank connections screen shows "used of allowance" from the Directory.

The per-budget `ITEM_LIMIT` check stays as a second guard for the owner.

## 6. The breaker's limits become settings

`sync/breaker.ts` has the free plan's daily limits as constants. Each becomes a Worker variable with today's value as its default: `LIMIT_ROWS_WRITTEN` (100,000), `LIMIT_ROWS_READ` (5,000,000), `LIMIT_DO_REQUESTS` (100,000), `LIMIT_DO_GBS` (13,000), `LIMIT_WORKER_REQUESTS` (100,000). The 70% / 90% / 95% rules (D-40) don't change. On a paid plan the owner sets these to the plan's limits in the same PR that upgrades.

Invalid or missing values fall back to the defaults.

## 7. Each user's share of the free plan

The breaker is account-wide, so one busy user could pause everyone, the owner included. `docs/multi-user.md` 9.2 cut per-user shares "until there are many users". They are built now, active only while more than one user is active.

- Each store already counts its own rows read and written and sends them to the Directory (`NOTE_USAGE`). It also counts its own Durable Object requests (each `api` call and each alarm). `noteUsage` gains the budget id and adds to `budget_usage_day` (already in migration 0003) as well as `usage_day`.
- A budget's share, per UTC day: `USER_DAILY_WRITES` (default 10,000), `USER_DAILY_DO_REQUESTS` (default 3,000). A user past a share gets the D-40 states for their own budget only: background work waits until 00:00 UTC; past 1.5 × the share, changes are refused with "Paused until tomorrow. Nothing is lost."
- Admins have no share. The account-wide breaker still covers everyone.
- The Directory checks the share in `authenticate` (it already reads the breaker state there), from a per-budget cache refreshed at most once a minute.
- A new bank's first sync writes about 20,000 rows (`docs/multi-user.md` 9.3). It runs as background work, so it waits a day at a time past the share rather than failing. With `NEW_USER_LINKS = 0` no new user can link a bank on Trial anyway.

## 8. Scale

What already scales: one SQLite database per budget, the phone does the budget math (D-45, D-46), incremental sync, and the daily `ensure_all` walks budgets 25 at a time.

The single Directory is the shared point. Today every API request calls `Directory.authenticate`, which reads the session, the membership and the sync epoch.

- **Session cache, built, off by default.** `SESSION_CACHE_S` (default `0`). When set, the Worker keeps a GET request's authentication answer in the isolate for that many seconds (`docs/multi-user.md` 5.1). Writes and routes that need a recent passkey always ask the Directory. The cache key is the session token's hash. On sign-out the app clears its own entry in that isolate. `threat-model.md` records the read window. At `0` nothing changes.
- **`last_seen_at`** is written at most once an hour per user, in `authenticate`.
- **Not built:** splitting sessions out of the Directory (`docs/multi-user.md` 5.2). The Directory's request count is in GraphQL Analytics already; section 12 lists it.
- **Free plan storage** is 5 GB for the account. At about 9 MB a year per active budget, that is a few hundred users. Section 12 lists it.

## 9. Admin: Settings → Users

For admins, shown only while `SIGNUPS` is `open` or more than one user exists:

- Counts: users of `MAX_USERS`, sign-ups today of `SIGNUPS_PER_DAY`, bank links used of `PLAID_LINK_CAP`.
- A list, 50 at a time, newest first, with search by name: name, joined, last seen, links used of allowance, status.
- Per user: **Turn off** / **Turn on** (off deletes their sessions and pauses their bank syncs, `docs/multi-user.md` 7.1) and **Bank links** (set the allowance, 0 to 10, never below links already used).
- No reset link (recovery codes replace it) and no deleting other people's accounts (users delete their own, section 11). Admin actions need a recent passkey check and go into the Directory's audit rows.

## 10. Keeping users apart

- An integration test signs up users A and B through the real sign-up route, gives both data, then calls **every route** in the API as A with B's ids in the path, the query and the body. The route list comes from the Hono apps themselves, so a new route can't be left out. Every answer must be 404 or 403, or A's own data.
- The same test checks the webhook: an Item routed to B starts a sync only in B's store.
- `wipe` and `dumpChunk` refuse without a matching Directory record (`docs/multi-user.md` 10).

## 11. Deleting an account

`docs/multi-user.md` 10, built as written:

1. Settings → Sign-in → **Delete account**: a recent passkey check and typing the budget name. The screen offers the full backup first and says the data will be gone.
2. One Directory batch: `status = 'deleting'`, delete the user's sessions, devices and device links. A `delete_account` Directory job takes over.
3. Job steps, each idempotent and retried: the store removes each Plaid Item at Plaid (its slot stays used); the store wipes itself (`ctx.storage.deleteAll()` and its alarm); the Directory deletes the user's passkeys, recovery code, membership, budget and routes. `plaid_link_slot` rows stay.
4. The last admin can't be deleted.

After a wipe, Cloudflare's point-in-time recovery can't bring the data back. That is the point.

## 12. Before turning sign-up on (not now)

Turning on is a PR that sets `SIGNUPS` to `open`. Before it, the owner decides each of these. **None of them is done or changed by this work.**

- **Plaid:** whether Trial terms allow other people's banks; Plaid Production and its costs; `NEW_USER_LINKS` and `PLAID_LINK_CAP`.
- **Cloudflare plan:** Free or Paid; the `LIMIT_*` values; `MAX_USERS`, `SIGNUPS_PER_DAY` and the per-user shares for that plan. On Free, storage (5 GB) and rows written limit it to a few hundred users at most.
- **Turnstile:** make the widget in the Cloudflare dashboard (free, no card); add `TURNSTILE_SECRET` to the GitHub `production` environment; set `TURNSTILE_SITE_KEY`. The same PR adds `https://challenges.cloudflare.com` to `script-src` and `frame-src` in `apps/web/public/_headers`. The live CSP doesn't change before then.
- **Decisions to look at again:** no off-site backups (D-29), no monitor (D-49), no staging (D-36), the 10 ms rule on a paid plan, `SESSION_CACHE_S`, splitting sessions out of the Directory.
- **Not code:** terms of service and a privacy policy, a support contact, billing if users pay.

## 13. What it changes in the database

- **Directory migration 0008** (forward-only, owner approval before merge): an index `user_created ON user (created_at)` for the daily count; the slot backfill from `connection_route` (5); a `budget_id`-keyed `requests` column on `budget_usage_day` for section 7; an `admin_audit` table (`id`, `admin_id`, `user_id`, `action`, `before`, `after`, `created_at`).
- **No budget migration.**

## 14. Build order

Each step is its own PR, with `pnpm check` and CI green. With the switch off and one user, each one changes nothing the owner sees, except where noted.

1. This doc, D-74 and the doc updates.
2. Each user's own passkey handle (4) and the isolation test (10).
3. Breaker limits as settings (6).
4. Account-wide bank-link slots (5), with Directory migration 0008. The owner's link flow gains the slot step; with allowance 10 and cap 10 the result is the same. Owner approval before merge.
5. Per-user shares (7).
6. Sign-up and recovery codes behind the switch (2, 3), with e2e tests that turn the switch on in the test Worker only.
7. Account deletion (11) and Settings → Users (9).
8. The session cache, off (8).
