# Build plan

Open work only, one line per item. Add an item when you find work that is left; delete its line in the PR that finishes it. Don't log finished work here: the PR's title and description record it. Work up to Nov 4, 2026 is in `docs/build-history.md` (D-59).

This file merges with `merge=union` (`.gitattributes`): after a local merge, check for an item listed twice.

Legend: **(manual)** needs the owner (Cloudflare, Plaid Production, GitHub settings).

## Open

- [ ] On the owner's iPhone after deploy: PRF in the Home Screen app with the existing passkey, first download time, Face ID unlock with no signal.
- [ ] The sealed log, left open (`docs/privacy.md` 5.3): a rebuild's peak memory is not measured on a phone with the 2 MB bank log (the old copy is closed first and kept gzipped, `local/web-entry.ts` `rebuild`).
- [ ] A new budget made on the device (D-102, `local/start-device.ts`): a first snapshot that still does not read back after three tries is not written again, so if the server truly lost it, a second device can't join until a later snapshot is checked (and `checkSnapshot` builds on the first one while none is checked).
- [ ] Banks of a locked budget (`docs/privacy.md` 5.5, D-87): linking and removing are tested with a fake Plaid only, never against Plaid itself (never on a real link without the owner's yes).
- [ ] Fetch steps on Cloudflare after the Nov 13 changes (D-110, fewer key derivations and one transaction for the last page): with invocation logs off (D-112), judge their CPU a few days after the deploy from the analytics (`exceededResources` counts, daily CPU quantiles; `docs/measurements.md`).
- [ ] Ways in of a locked budget: the owner sets the recovery key's sign-in once in Settings → Sign-in → Recovery key (the owner's budget was locked before that was set at the lock).
- [ ] Notices (`docs/privacy.md` 5.8): read when the copy opens, right after each sync that brings entries, and every 5 minutes; not pushed, since the free plan has no push service, so a closed app learns of a change when it opens. Dismissals stay on each device by design: a device that broke in must not hide its own notice on the others.
- [ ] Claims 2 and 3, 30 days after the old tables are dropped **(manual)**: Cloudflare's point-in-time recovery keeps 30 days of a store's past states, so it holds the old tables until 30 days after store migration 0010 ran in the owner's store (D-106). Then "no readable copy" is true for that history too: change claims 2 and 3 in `docs/claims.md` to true. Whether SQLite keeps freed pages readable inside a Durable Object is the phase 0 question, still open.
- [ ] Privacy design, phase 0 checks still to do (`docs/privacy.md` 15.4). On the owner's iPhone **(manual)**: peak memory while a real budget is filed (the Settings → Device check page that tested the browser was removed, D-108: this needs a new way to run). On Plaid: whether an old cursor is accepted days later in Production (Sandbox accepts it minutes later, Nov 13: `docs/privacy.md` 15.4). On Cloudflare: what a wiped store and deleted rows leave behind; the sealing steps' CPU (measured locally, `docs/measurements.md`).
- [ ] After D-112 (invocation logs off): no invocation log has come since its deploy (checked Nov 13, 18:54 UTC). Still to check, with a read-only Workers observability query: a line the app logs during a request holds no IP address or location; then delete this line.
- [ ] Comparable releases, left open after phase 7 (D-96, `docs/runbooks/verify-build.md`): compare a build made on macOS with the release (only Linux was tried); run `gh attestation verify` where Sigstore's hosts can be reached (the Nov 13 check could not: this container's proxy blocks them).
- [ ] `docs/privacy-policy.md` is a draft the owner has not read yet **(manual)**. The app shows it at `/privacy-policy`. Before other people are invited: the owner reads the **(owner reads)** lines, and a contact is set (`docs/privacy.md` 11).
- [ ] Sign-up's robot check on its own address (D-113) is built, not deployed **(manual)**: the owner said yes to the second Worker (`ledgerline-check`) on Nov 13, 2026, to deploy only when sign-up is turned on, and doesn't want sign-up on yet; then the owner makes its Turnstile widget (`docs/open-signup.md` 13); then try the trip there and back from the Home Screen app on an iPhone.

- [ ] Tech-debt review, left open (Nov 14, 2026): two `parseCents` read money differently (`apps/web/src/lib/money.ts` reads typed money; `packages/domain/src/money.ts` also takes `(12.00)` and `+5`). One parser is the owner's Money-rules choice.
- [ ] Tech-debt review, left open: a new store runs budget migrations 0001–0012 and store migration 0010 then drops their tables; the device makes and drops the change_log triggers on each open (`local/engine.ts` `migrateLocal`). Changing it is a migration: only with the owner's yes.
- [ ] Tech-debt review, left open: the whole log append route is still over 10 ms in Node at 16 entries of 64 KB (`docs/measurements.md`). Measure a large write on Cloudflare before anything raises a write's size.
- [ ] Tech-debt review, left open: the rest of the `apps/web/src/copy/copy.ts` split (sync loop, sealed keys, edit queue share about 15 module-level `let`s; needs one state object first).
- [ ] Tech-debt review, left open: the engine as a package (`packages/engine`). The web app now takes the engine's shapes from `local/engine-types.ts`, but still loads `web-entry.ts` and the `#november-*` aliases by a path into `apps/worker/src`.
- [ ] Tech-debt review, left open: an unused-export check (knip lists about 118 exports and 22 files, mostly in `apps/worker/src`); and whether the 94 typed-in sizes in `apps/web/src` (`gap-[3px]`, `w-[140px]`…) need tokens (`docs/design-system.md`).

## Contract gaps (not blocking)

The UI works around these (details in `apps/web/CONTRACT_NOTES.md`):
