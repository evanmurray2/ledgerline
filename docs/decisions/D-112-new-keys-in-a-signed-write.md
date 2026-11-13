# D-112: New keys come in a signed write to the log; `store-inbox-key` is never asked (Nov 13, 2026)

**Before.** `docs/privacy-keys.md` 11 listed `store-sign-key` and `store-inbox-key` as two signed requests, and
`docs/privacy.md` 5.2 said the server takes a signing or inbox public key "only in a request with a recent passkey
check, signed by the current signing key". As built, the keys came only in a key change (6.3), sent as an ordinary
write to the log (`POST /api/log/append`) with no request signature and no passkey check; the two names existed in
`packages/seal` and nothing asked for them. The build plan listed this as left open.

**Decision.**

1. A write to the log that holds a key change is a signed request, `store-sign-key`, over the write's body, signed by
   the key in force where the device stands (the key that also signs the key change). The engine asks the Directory
   for the challenge and signs in its Web Worker (`apps/worker/src/local/web-entry.ts sealedAppend`). The store
   refuses such a write without a good signature (`seal/log-store.ts keysSigned`, answered as 403 "unsigned"), and
   asks nothing of a write without a key change.
2. The Directory asks for a passkey check under 15 minutes old on a signed write to the log (`store/directory.ts
authenticate`). Every key change starts from Settings → Sign-in or a notice's Finish now, which ask the passkey
   first, so the person sees no new prompt.
3. `store-inbox-key` is never asked, and its name stays reserved (a name is never reused). An inbox key only ever
   comes in a key change, which also brings the signing key, and one signature covers the body with both. A
   request that stored an inbox key alone would be a second way to change the key bank runs are sealed to.

**Why not leave it to the entry's signature.** The key change is already signed by the key in force, and the log's
rules check it, so a session alone can't make one. The request's signature adds the Directory's fresh challenge,
bound to this session, and the passkey check: a key change that someone with a stolen session was handed (from a
device they briefly held) can't be sent from that session.

**What stays.** A new budget's first entry (`/api/start/*`) is not signed this way: there is no key in force before
it, and a budget that holds anything refuses it. No format changes; the request message is the one in section 11.
