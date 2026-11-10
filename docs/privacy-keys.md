# Privacy design, appendix: key formats (version 1)

Status: v2, Nov 10, 2026. Section 15 lists which parts are built in `packages/seal`; nothing uses them yet. This is the appendix `docs/privacy.md` 5.2 asks for before any key code: every derivation label, associated-data string, nonce rule and byte layout. An adversarial review of v1 made 20 findings; this version includes their fixes (section 14). The code in `packages/seal` will follow this file exactly, and its tests will pin each derivation with fixed test vectors, so a change here without a format version bump breaks a test. `docs/privacy.md` says why each thing exists; this file says only what the bytes are and what each side checks.

Not covered here, on purpose: how row changes are written inside an entry's sealed body and inside a snapshot, and how a table is hashed. Those belong to the phases that move edits and bank filing to the device (`docs/privacy.md` section 10, phases 3 and 4).

## 1. Conventions

- `||` joins bytes. `u8`, `u16`, `u32`, `u64` are unsigned, big-endian.
- `str(x)` is `u32(length) || x` for a byte string or a UTF-8 text. Every field of unknown length is written with `str`.
- **A quoted label stands for its ASCII bytes followed by one zero byte.** Labels start with `ledgerline/v1/`, hold no zero byte, and each is used for one purpose only. So no label's bytes are the start of another's, whatever follows.
- `H(x)` is SHA-256. `HMAC(k, x)` is HMAC-SHA-256. `HKDF(ikm, salt, info, n)` is HKDF-SHA-256 (RFC 5869) giving `n` bytes. `zero` is 32 zero bytes.
- `AEAD(k, aad, plain)` is AES-256-GCM with a fresh random 96-bit nonce from `crypto.getRandomValues`, written `nonce(12) || ciphertext || tag(16)`. Never a counter, never a reused nonce.
- **Ids.** `budgetId`, `deviceId`, `linkId` and `snapshotId` are ULIDs: 26 characters of Crockford base32, upper case, as ASCII. `credentialId` is the passkey's raw credential id, at most 1,023 bytes. Any other `str` holding an id is at most 255 bytes.
- **Times** are Unix milliseconds, UTC. **Dates** are days since 1970-01-01.
- A key version `v` is a `u32` that starts at 1 and goes up by exactly 1 at each key change. An inbox version `i` does the same.
- Every stored structure starts with a 4-byte magic that names its kind and format. A reader that meets a magic it doesn't know stops with "Update Ledgerline to continue"; it never guesses.
- **Parsers are strict.** A structure with bytes left over, a length that doesn't fit, a count over its stated maximum, or an id in the wrong form is refused whole.
- **Signatures are never hashed, compared or used as ids.** Ed25519 implementations need not give the same signature bytes twice. Test vectors pin public keys and check that fixed signatures verify.

## 2. The budget key and what comes from it

`BK_v` is 32 random bytes, made on a device (`docs/privacy.md` 5.2). For each key version:

```
salt_v = str(budgetId) || u32(v)
```

| Name         | Derivation                                         | Use                                                            |
| ------------ | -------------------------------------------------- | -------------------------------------------------------------- |
| `K_log_v`    | `HKDF(BK_v, salt_v, "ledgerline/v1/log", 32)`      | AES-256-GCM key for entry bodies (section 6)                   |
| `K_snap_v`   | `HKDF(BK_v, salt_v, "ledgerline/v1/snapshot", 32)` | AES-256-GCM key for snapshot chunks and manifests (section 8)  |
| `K_wrap_v`   | `HKDF(BK_v, salt_v, "ledgerline/v1/wrap", 32)`     | AES-256-GCM key for small wrapped values (section 5)           |
| `signSeed_v` | `HKDF(BK_v, salt_v, "ledgerline/v1/sign", 32)`     | Seed of the Ed25519 signing key pair `signPriv_v`, `signPub_v` |

**Importing a seed.** WebCrypto can't derive an Ed25519 or X25519 key directly, and can't give the public half of a private key it won't export. So, for a 32-byte seed:

1. Build the PKCS#8 bytes: a fixed 16-byte prefix, then the seed.
   - Ed25519: `30 2e 02 01 00 30 05 06 03 2b 65 70 04 22 04 20 || seed`
   - X25519: `30 2e 02 01 00 30 05 06 03 2b 65 6e 04 22 04 20 || seed`
2. Work out the public half.
   - Ed25519: import the bytes once as extractable, export as JWK, and read the public half from its `x` field. Drop that key and the JWK. (The JWK holds the seed as text, and JavaScript can't erase a string; dropping it is all that can be done.)
   - X25519: no extractable key is needed. The public half is the X25519 result of the private key and the base point, `u = 9`.
3. Import the bytes as non-extractable. That is the key used from then on.
4. Zero the seed and the PKCS#8 bytes.

Test vectors pin the public half for fixed seeds. Phase 0 confirms that Safari and Workers accept both imports.

The **first signing public key** of a budget, `signPub_1`, is its `genesisSignPub`. It never changes and is what every slot's anchor names (section 4).

## 3. Sealing to a public key (HPKE)

HPKE base mode (mode 0), RFC 9180, single-shot:

- KEM: DHKEM(X25519, HKDF-SHA256), id `0x0020`
- KDF: HKDF-SHA256, id `0x0001`
- AEAD: AES-256-GCM, id `0x0002`

`Seal(pkR, info, aad, plain)` gives `enc(32) || ciphertext || tag(16)`, where `enc` is the sender's one-time public key as its 32 raw bytes. `Open(skR, info, aad, sealed)` reverses it. Rules:

- One sender context makes exactly one seal.
- A shared secret of 32 zero bytes is refused (RFC 9180 7.1.4): WebCrypto implementations differ on small-order points.
- A recipient key pair used for HPKE is used for nothing else.
- The implementation must pass the test vectors for exactly this suite (`0x0020`, `0x0001`, `0x0002`, mode 0) from the CFRG's published HPKE test-vector file. The vectors printed in the RFC's own appendix use other AEADs with X25519 and don't test this suite's key schedule.

HPKE proves nothing about who sealed. Wherever that matters, something else does: a slot's anchor and the public chain (sections 4 and 7), or the Worker's signature (section 9).

## 4. Ways in (slots)

A slot is one way to get the budget key: a passkey, or the recovery key.

### 4.1 A passkey's secrets

Every sign-in asks the passkey's PRF extension with the first input set to one constant for the whole app:

```
prfInput = H("ledgerline/v1/prf/slot")
```

(The copy vault's per-device salt, when a device has one, is the second input: `docs/phone-budget.md` 13.2. Each output depends only on the passkey and its own input.) From the 32-byte output `prf`:

```
slotSalt   = str(budgetId) || str(credentialId)
slotSeed   = HKDF(prf, slotSalt, "ledgerline/v1/slot/x25519", 32)   -> X25519 pair slotPriv, slotPub
anchorKey  = HKDF(prf, slotSalt, "ledgerline/v1/slot/anchor", 32)   -> HMAC key
slotId     = "p:" then base64url(credentialId), no padding           (ASCII text, no zero byte)
```

### 4.2 The recovery key's secrets

The recovery key `R` is 32 random bytes, shown to the person once. It is unique to one budget, so it needs no salt:

```
authSeed   = HKDF(R, zero, "ledgerline/v1/recovery/auth", 32)       -> Ed25519 pair authPriv, authPub
slotSeed   = HKDF(R, zero, "ledgerline/v1/recovery/x25519", 32)     -> X25519 pair
anchorKey  = HKDF(R, zero, "ledgerline/v1/recovery/anchor", 32)     -> HMAC key
slotId     = "r:" then the generation number in decimal, no leading zeros, starting at 1
```

**How it is shown and typed:** Crockford base32, upper case, of `R || c`, where `c` is the first 2 bytes of `H("ledgerline/v1/recovery/check" || R)`: 55 characters, in groups of 5. A typed key whose check bytes don't match is refused before anything is sent.

**Proving it to the server.** The server stores `authPub`, never a secret. To add a passkey, the device sends `authPub`; the server finds the account, and answers with the budget id and 32 random bytes; the device returns `Ed25519(authPriv, "ledgerline/v1/recovery/login" || str(budgetId) || challenge)`. Nothing that could be replayed later passes through the server. This gives a sign-in and no part of the budget key.

Making a new recovery key gives the next generation number and removes the old slot in the same key change.

### 4.3 The slot record

Written in a genesis, slot-change or key-change entry (section 6.3), for key version `v`:

```
slotId      str
anchor      HMAC(anchorKey, "ledgerline/v1/anchor" || str(budgetId) || str(slotId) || genesisSignPub)          32 bytes
sealedKey   Seal(slotPub, "ledgerline/v1/hpke/slot" || str(budgetId) || str(slotId) || u32(v), signPub_v, BK_v) 80 bytes
wrappedPub  AEAD(K_wrap_v, "ledgerline/v1/wrap/slot" || str(budgetId) || str(slotId), slotPub)                 60 bytes
```

| Field        | Who can read it                            |
| ------------ | ------------------------------------------ |
| `slotId`     | Anyone                                     |
| `anchor`     | Anyone; only the slot's owner can check it |
| `sealedKey`  | The slot's owner                           |
| `wrappedPub` | Holders of `BK_v`                          |

- `anchor` is made once, by the device that holds the slot's secret, when the slot is created. It is copied unchanged into every later key-change entry.
- `wrappedPub` is how a device doing a key change learns the other slots' public halves without the server ever seeing them.
- The associated data of `sealedKey` is `signPub_v`. A device that opens it derives `signSeed_v` from the `BK_v` it got and refuses the key unless the public half equals that associated data and the one the chain names.
- A body holds at most 64 slot records, at least 1, and no `slotId` twice.
- The writer of a record opens its own `sealedKey` from the final bytes before it sends the entry.

### 4.4 Opening a budget on a device that holds nothing yet

1. Sign in with a passkey (or prove the recovery key, 4.2) and derive the slot's secrets.
2. Fetch every public entry (kinds 0, 4, 5, 9, 10: section 6.3) and the newest snapshot's header (section 8).
3. **Walk the public chain** (section 7): the genesis entry's signature with the `signPub_1` it holds; every later public entry's signature with the signing key of its `keyVersion`; each one's `prevPublic` naming the one before; each key change stepping the version by exactly 1. The newest snapshot's header must name the last public entry of the walk. A gap, a fork or a mismatch stops the device.
4. Find the **newest** record for this `slotId` among the entries of the chain's last key version (the last key change, or a slot change after it; for version 1, the genesis entry or a slot change). If the last key change left the slot out, stop: this way in was removed.
5. **Check that record's `anchor`** against `signPub_1`. If it fails, stop: the server is showing a budget this slot was never part of.
6. Open `sealedKey` and check it as in 4.3.
7. To read data sealed under an older key version (a snapshot written before the last key change), unwrap the older budget keys from the key-change entries, backwards, as far as needed (section 5).

What this can't catch is in `docs/privacy.md` 5.2: a removed way in and a dishonest server together can show a device that has never seen the real key change a false one.

## 5. Small wrapped values

All are `AEAD(K_wrap_v, aad, plain)`:

```
a slot's public half                    aad = "ledgerline/v1/wrap/slot"     || str(budgetId) || str(slotId)
the inbox private key, version i        aad = "ledgerline/v1/wrap/inbox"    || str(budgetId) || u32(i)
the budget key before this one, BK_v-1  aad = "ledgerline/v1/wrap/prev-key" || str(budgetId) || u32(v - 1)
```

- The inbox key pair is a random X25519 pair. Its private half, wrapped, travels in the genesis entry and in each key change.
- **Each key change carries the budget key it replaces**, wrapped under the new one. Without it, a device that joins after a key change (a recovery sign-in is always one) could not read the snapshot and entries sealed before the change, and if the device that made the change were lost first, the budget would be gone. It gives a removed way in nothing: that way in already held the older key.

## 6. Log entries

An entry is a header, a body and a signature.

### 6.1 Header

| #   | Field             | Bytes                                | Notes                                                                                                                                             |
| --- | ----------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | magic             | 4                                    | `LLE1`                                                                                                                                            |
| 2   | kind              | `u8`                                 | 0 genesis, 1 edit, 2 bank, 3 scan, 4 slot change, 5 key change, 6 sign-out, 8 data migration, 9 key-change intent, 10 intent cancel               |
| 3   | budgetId          | `str`                                |                                                                                                                                                   |
| 4   | number            | `u64`                                | 1 for the genesis entry, then up by 1                                                                                                             |
| 5   | prevHash          | 32                                   | `entryHash` of entry `number - 1`; zeros for the genesis entry                                                                                    |
| 6   | entryId           | 16                                   | Random. The server answers "already stored" for one it holds                                                                                      |
| 7   | time              | `u64`                                | For ordering only: the later of the writer's clock and 1 ms after the entry before                                                                |
| 8   | deviceId          | `str`                                |                                                                                                                                                   |
| 9   | deviceCounter     | `u64`                                | This device's count of entries: its last value + 1, starting at 1                                                                                 |
| 10  | keyVersion        | `u32`                                | The version whose signing key signs this entry                                                                                                    |
| 11  | schemaVersion     | `u32`                                |                                                                                                                                                   |
| 12  | processingVersion | `u32`                                |                                                                                                                                                   |
| 13  | part, parts       | `u16` each                           | `1, 1` for a whole entry (6.4)                                                                                                                    |
| 14  | filedThrough      | `u64`                                | The last bank run this budget has filed, after this entry                                                                                         |
| 15  | receipts          | `u16(count)`, then 32 bytes for each | For a bank entry, the receipt of each run it files, in order (9.3): `count` = `filedThrough` minus the one before. Otherwise count 0. At most 256 |
| 16  | scanThrough       | `u32`                                | The last day scanned, in the budget's time zone; never goes down                                                                                  |
| 17  | bodyHash          | 32                                   | `H(body)`, the bytes as stored                                                                                                                    |

```
entryHash = H(header)
signature = Ed25519(signPriv_keyVersion, "ledgerline/v1/entry" || entryHash)      64 bytes
```

The header holds the budget id, the kind and the number, so an entry can't be replayed in another budget, as another kind, or at another place.

**As sent and stored**, an entry is `str(header) || str(body) || signature`. A reader checks that `H(body)` is the header's `bodyHash` before anything else.

### 6.2 Body of kinds 1, 2, 3, 6, 8: sealed

```
aad   = "ledgerline/v1/body" || H(header fields 1 to 16)
body  = AEAD(K_log_keyVersion, aad, pad(plain))
```

`plain` holds what `docs/privacy.md` 5.3 lists (the row changes; for an edit, the time the person made it; what this device last saw from each other device). Its inner layout is fixed in a later phase.

**Padding.** The steps are 256, 1,024, 4,096, 16,384 and 65,536 bytes. `pad(x)` is `x || 0x80 || zeros` up to the smallest step that fits, so `x` is at most 65,535 bytes; anything larger uses parts (6.4). To unpad: the length must be a step; drop trailing zeros; the last byte left must be `0x80`; and what remains must not have fitted a smaller step. Otherwise the entry is refused.

### 6.3 Body of kinds 0, 4, 5, 9, 10: public structures

These are read by devices that hold no key yet, so their bodies are not sealed. Everything secret inside them is sealed to a slot or wrapped. The signature covers them through `bodyHash`. The server parses them, and they are never split into parts.

Each one after the genesis entry starts with `prevPublic`: the `number` and `entryHash` of the public entry before it.

```
prevPublic = u64(number) || entryHash(32)
```

**Genesis (kind 0)**, entry 1, `keyVersion` 1, signed by `signPriv_1`:

```
LLG1 || signPub_1(32)
     || u32(1) || inboxPub_1(32) || str(wrapped inbox private key 1)
     || u16(slots) || slot records (4.3)
```

**Slot change (kind 4)**, signed by the current signing key. Adds slots only; removing one is always a key change:

```
LLS1 || prevPublic || u16(slots) || slot records (4.3)
```

**Key-change intent (kind 9)** and **cancel (kind 10)**, signed by the current signing key (`docs/privacy.md` 5.2, "One way in can take the whole budget"):

```
LLI1 || prevPublic || u64(notBefore) || u16(count) || str(slotId) ...        the slots it means to remove
LLC1 || prevPublic || u64(intent number) || intent entryHash(32)
```

**Key change (kind 5)**, to version `v + 1`. Header `keyVersion` = `v`, signed by `signPriv_v`:

```
LLK1 || prevPublic
     || u32(v + 1) || signPub_{v+1}(32)
     || str(wrapped BK_v)                                    section 5
     || u32(i + 1) || inboxPub_{i+1}(32)
     || u64(lastOldRun)                                      the highest bank run number that existed when this was written
     || u16(inboxes) || [ u32(k) || str(wrapped inbox private key k) ] ...     the new one, and each older one with unfiled runs; at most 16
     || u16(slots)   || slot records (4.3) for every slot that stays, sealed and wrapped for v + 1
     || u64(intent number) || intent entryHash(32)           zeros when no intent was needed
```

After a key change is stored, the server refuses entries with `keyVersion` = `v`, entry bodies use `K_log_{v+1}`, and the Worker seals bank runs only to `inboxPub_{i+1}`.

**When an intent is needed.** The server knows which way in a session used. A key change that leaves out a slot, made in a session that signed in with the recovery key or with a passkey added less than 7 days ago, is refused unless it names an intent that: is in the log; lists exactly the slots left out; has `notBefore` at least 7 days after the intent's own `time` and not later than the server's clock; and has no cancel after it. Any holder of the current key can write a cancel. Because the key change is written after the wait, with its own fresh `number` and `prevHash`, the log doesn't stop meanwhile.

### 6.4 Parts

A change set over 65,535 bytes is written as `parts` entries (kinds 1, 2, 3 or 8 only):

- consecutive numbers, in one write, all appended or none;
- the same kind, device, key version, `time`, `entryId`, `filedThrough` and `scanThrough` in each; `deviceCounter` goes up by 1 per part;
- `receipts` in part 1 only; count 0 in the others;
- a reader applies nothing until every part has arrived and verified. A log that ends inside a set is a cut-off download, not a shorter log.

## 7. What each side checks

### 7.1 The server, on every append

Without reading anything sealed: the signature against the signing key in force; `keyVersion` is the version in force; `number` and `prevHash` continue the log; `entryId` is new (else "already stored", for the whole part set); `bodyHash`; `time` is not more than 5 minutes ahead of its clock; the part rules (6.4); `filedThrough`, `receipts` and `scanThrough` (9.3, and never down); for a public body, that it parses, that `prevPublic` is the last public entry, that a key change steps the version by 1 and the inbox version by 1, the slot rules (4.3), and the intent rule (6.3); and the rules of `docs/privacy.md` 5.3 (bank runs first, the breaker).

### 7.2 A device, on every entry it takes

The same, for itself, because the server may lie: the signature; `keyVersion` in force, stepping by exactly 1 and only at a key change whose body says `v + 1`; `number` and `prevHash` against the entry before; `deviceCounter` against what it last saw from that device; `time` not earlier than the entry before; the part rules; for a public entry, `prevPublic`; for a bank entry, that the runs it names are the next ones (9.3). It then opens the body, unpads it and applies it.

A device keeps, apart from its copy: the highest `number` it has applied, that entry's `entryHash`, the last public entry's number and hash, and the last checkpoint (section 8).

### 7.3 The public chain

The public entries (kinds 0, 4, 5, 9, 10) are kept for ever, also after older sealed entries are deleted. Through `prevPublic` they form a chain of their own from the genesis entry, which a device with no key can walk (4.4).

## 8. Snapshots

A snapshot is chunks, a sealed manifest, a clear signed header, and later a check record.

```
chunk_k   = AEAD(K_snap_v, "ledgerline/v1/snap/chunk" || str(budgetId) || str(snapshotId) || u32(k) || u32(count), bytes_k)
manifest  = AEAD(K_snap_v, "ledgerline/v1/snap/manifest" || str(budgetId) || str(snapshotId), m)
```

The manifest's plain text `m`:

```
LLM1 || str(snapshotId) || u32(v) || u64(number) || entryHash(32)
     || u32(count) || H(chunk_1 as stored) ... H(chunk_count as stored)
     || u16(tables) || [ str(table name) || H(table) ] ...
     || u16(checkpoints) || [ u64(number) || entryHash(32) ] ...
```

A checkpoint is the `entryHash` of every entry whose number is a multiple of 1,000, plus the snapshot's own.

**The header**, in clear, is what the server acts on:

```
header    = LLN1 || str(budgetId) || str(snapshotId) || u32(v) || u64(number) || entryHash(32)
                 || u64(last public number) || last public entryHash(32)
                 || H(manifest as stored)
signature = Ed25519(signPriv_v, "ledgerline/v1/snap" || H(header))
```

**The check record** says a device rebuilt the budget from the snapshot before this one plus the entries since, and got the same table hashes (`docs/privacy.md` 5.3):

```
check     = Ed25519(signPriv_v, "ledgerline/v1/snap-checked" || H(header) || str(deviceId))
```

The server deletes older entries and filed bank runs only by the one rule in `docs/privacy.md` 5.3, and only for a snapshot whose header and check record both verify.

## 9. What the Worker makes

### 9.1 The Worker's keys

Both come from the Worker secret that already encrypts bank tokens (`TOKEN_KEYS`), so the owner pastes nothing new. For the keyring's key number `n`, **`secret_n` is exactly the 32 bytes that `importKey` in `packages/platform/src/token-crypto.ts` hands to WebCrypto** for that key: the decoded bytes of a base64 key, or the SHA-256 of a passphrase. A test vector pins both forms.

```
K_mac_n       = HKDF(secret_n, "ledgerline/v1/server", "ledgerline/v1/server/mac", 32)          HMAC key
runSignSeed_n = HKDF(secret_n, "ledgerline/v1/server", "ledgerline/v1/server/run-sign", 32)     Ed25519 pair runSignPriv_n, runSignPub_n
```

`secret_n` itself stays the AES-GCM key for bank tokens; the salt and labels keep these two uses apart from it and from each other.

**Changing the Worker's key.**

- The app is built with a list of `(n, runSignPub_n)` it accepts. A new key number is added to that list in a release **before** the Worker starts to use it.
- A public key is never taken off the list except after a compromise: bank runs can wait unfiled for months, and each names its `n`.
- On an ordinary change, a job stamps every HMAC again under the new `n` before the old key leaves the keyring.
- After a compromise, the Worker signs every unfiled run again, in order, chained again, under the new `n`; devices accept a re-signed run only for numbers above `filedThrough`.

### 9.2 The HMACs

Each is stored with its `n`.

```
keyMac  = HMAC(K_mac_n, "ledgerline/v1/mac/key"  || str(budgetId) || u32(version) || u8(kind) || pub(32))
          kind 1: a signing public key, version v.  kind 2: an inbox public key, version i.

linkMac = HMAC(K_mac_n, "ledgerline/v1/mac/link" || str(budgetId) || str(linkId) || str(itemId) || str(token ciphertext))

runsMac = HMAC(K_mac_n, "ledgerline/v1/mac/runs" || str(budgetId) || u64(run) || lastManifestHash(32) || u64(lastRunTime)
                                                 || u16(links) || [ str(linkId) || H(cursor) ] ...)
          run: the budget's last completed run number. The links are in ascending order of linkId.
```

- `keyMac` and `linkMac` stop a database writer from inventing a key or a link, or moving a link to another budget.
- `runsMac` covers the whole of a budget's run state at once: the counter, the last manifest, the last run time and every link's cursor. It is written in the transaction that completes a run, and the Worker checks it before it fetches or signs. So a database writer can't move one part back without the rest. Putting back an **earlier whole state** still verifies; the run made from it fails a device's cursor and chain checks (9.3), which is how a rewind is caught.

### 9.3 A bank run

Each page, balance answer and link description is sealed on its own:

```
sealed_p = Seal(inboxPub_i,
                "ledgerline/v1/hpke/inbox" || str(budgetId) || str(linkId) || u32(i),
                u64(run) || u32(restart) || u16(p) || u8(what),
                r_p || payload_p)
what: 0 a transactions page, 1 balances, 2 liabilities, 3 the link's description (its first run)
r_p:  32 random bytes

receipt  = H("ledgerline/v1/receipt" || r_0 || ... || r_{pages-1})
```

A device can only work out `receipt` by opening every page.

The manifest:

```
LLR1 || str(budgetId) || str(linkId)
     || u64(run)            the budget's run number: 1, 2, 3 ... across all its links
     || u32(restart)        how many times this run started again
     || u32(i) || H(inboxPub_i)
     || u64(runTime) || u64(prevRunTime)        the time of this run and of run - 1; prevRunTime is 0 for run 1
     || H(cursor before) || H(cursor after)     this link's cursor; "before" is H of the empty string for a link's first run
     || u8(flags)           bit 0 has balances, bit 1 has liabilities, bit 2 is a link description
     || u32(added) || u32(modified) || u32(removed)
     || u16(pages) || H(sealed_0) ... H(sealed_{pages-1})
     || H(receipt)
     || prevManifestHash(32)                    H(manifest) of run - 1; zeros for run 1
     || u32(n)
signature = Ed25519(runSignPriv_n, "ledgerline/v1/run" || H(manifest))
```

**A device files run `r` only if all of this holds:**

1. The signature is good for a key number in its list (9.1).
2. `run` is `filedThrough + 1`, and `prevManifestHash` is the hash of the manifest it filed before.
3. The inbox version `i` is not lower than that of the run before. If `run` is above the `lastOldRun` of the newest key change, `i` is that key change's new inbox version; otherwise the device holds the wrapped private key for `i`. `H(inboxPub_i)` matches the key the log names for `i`.
4. `H(cursor before)` equals the `H(cursor after)` of the last run it filed for that link.
5. Every `H(sealed_p)` matches, every page opens, and the receipt worked out from the pages hashes to `H(receipt)`.
6. `runTime` is later than `prevRunTime`, equals what the run before said, and is not later than the device's clock plus 10 minutes.

An inbox key is **retired** once `filedThrough` has reached the `lastOldRun` of the key change that replaced it; the device then deletes its private half.

To file runs `a` to `b`, the entry's `receipts` field holds the receipt of each, in order. The server checks each against the `H(receipt)` it stored and that they are exactly the next runs.

## 10. Adding a device with its own passkey

The new device `N` holds nothing. The signed-in device `O` holds `BK_v`.

```
N:  a one-time X25519 pair (addPriv, addPub), and 32 random bytes nonceN
N -> O:   commit = H("ledgerline/v1/add/commit" || addPub || nonceN)
O -> N:   nonceO (32 random bytes), signPub_v, u32(v), u64(head number), head entryHash
N -> O:   addPub, nonceN                          O checks them against commit

transcript = H("ledgerline/v1/add/transcript" || commit || nonceO || addPub || nonceN
               || str(budgetId) || signPub_v || u32(v) || u64(head number) || head entryHash)
code       = u32(HKDF(transcript, zero, "ledgerline/v1/add/code", 4)) mod 1,000,000         shown as six digits
```

Both devices show `code`, and **the person confirms it on both**:

1. The person taps "the codes match" on `O`. Only then:
   `O -> N:   Seal(addPub, "ledgerline/v1/hpke/device-add" || transcript, signPub_v, BK_v)`
2. `N` opens it **only after** the person taps "the codes match" on `N` too. `N` checks `signPub_v` as in 4.3 and the head it was told against the log.
3. `N -> O:   HMAC(HKDF(BK_v, transcript, "ledgerline/v1/add/confirm", 32), transcript)`. `O` shows "added" only after it verifies.
4. `N`, which holds its own passkey's secret, makes its slot record and appends it in a slot-change entry, which it can now sign.

`O` itself allows 3 attempts per start, then the person must start again; an attempt lasts 10 minutes; a cancelled one leaves nothing.

The server relays every message. It must commit to an `addPub` before it sees `nonceO`, so it gets one guess in a million at a matching code, and a wrong guess shows as two different codes. Because `N` waits for the person too, a server that pretends to be `O` can't hand `N` a budget of its own making unseen.

## 11. Requests signed with the budget's key

Some requests to the server must come from a holder of the budget key, not only from a session (`docs/privacy.md` 5.2, 5.5): storing a new signing or inbox public key, asking for a link token, removing a bank, deleting the account.

```
signature = Ed25519(signPriv_v, "ledgerline/v1/request" || str(budgetId) || u32(v) || str(action)
                                || challenge(32) || H(payload))
```

`action` is a fixed ASCII name for the request. `challenge` is 32 random bytes the server gave for this one request, used once and good for 5 minutes.

## 12. Limits

- AES-GCM with random nonces: well under 2^32 seals per key. A budget makes a few thousand entries a year; a key change starts fresh keys.
- An entry's plain body is at most 65,535 bytes; larger change sets use parts (6.4).
- A filing entry names at most 256 runs. A device with more waiting files them in several writes.
- At most 64 slots, and at most 16 inbox keys carried in a key change.
- X25519 and Ed25519 are not safe against a large quantum computer. `docs/privacy.md` 5.2 says what that exposes and that no claim is made.

## 13. Changes to this file

A change to any label, field or layout needs a new magic or a new `ledgerline/v2/` label, and readers must keep understanding the old one for as long as stored data uses it. The test vectors in `packages/seal` are the check that nothing drifted.

## 14. Review

v1 was reviewed on Nov 10, 2026 by an independent reviewer told to break it. 20 findings; all are fixed here.

| #   | Finding (v1)                                                                                                                             | Severity | Fixed in      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------- |
| 1   | After a key change, a device holding only the new key couldn't read the snapshot or entries before it; losing one device lost the budget | Critical | 5, 6.3, 4.4   |
| 2   | Only the signed-in device confirmed the code, so a server could hand the new device a false budget                                       | Major    | 10            |
| 3   | Public entries didn't name each other, so one could be left out or reordered                                                             | Major    | 6.3, 7.3, 4.4 |
| 4   | The 7-day hold on removing a way in had no format, and would have frozen the log                                                         | Major    | 6.3           |
| 5   | An older inbox key could be put back with its valid HMAC, so new bank data went to a key a removed way in holds                          | Major    | 6.3, 9.3      |
| 6   | The run counter, last manifest and run time had no check of their own                                                                    | Major    | 9.2           |
| 7   | No rules for changing the Worker's key while runs wait                                                                                   | Major    | 9.1           |
| 8   | The server had nothing clear and signed to act on for a snapshot or its check                                                            | Major    | 8             |
| 9   | "The key's 32 bytes" was ambiguous for a passphrase key                                                                                  | Major    | 9.1           |
| 10  | The device's own checks weren't written; rules for several header fields were missing                                                    | Major    | 6.1, 7        |
| 11  | Which slot record a device opens, and that it re-checks the anchor, wasn't stated                                                        | Major    | 4.3, 4.4      |
| 12  | WebCrypto can't give the public half of a non-extractable key                                                                            | Major    | 2             |
| 13  | The RFC's printed test vectors don't cover this HPKE suite                                                                               | Major    | 3             |
| 14  | The recovery sign-in sent a reusable secret; the typed form wasn't specified                                                             | Minor    | 4.2           |
| 15  | A receipt proved only that page 0 was opened                                                                                             | Minor    | 9.3           |
| 16  | Rules for a part set were missing                                                                                                        | Minor    | 6.4           |
| 17  | Padding: the largest body was off by one, and unpadding had no failure rule                                                              | Minor    | 6.2           |
| 18  | Labels weren't prefix-free; signed requests had no format                                                                                | Minor    | 1, 11         |
| 19  | Signature bytes aren't stable across WebCrypto implementations                                                                           | Minor    | 1             |
| 20  | Canonical forms missing: ids, times, counts, strict parsing; who appends the new device's slot                                           | Minor    | 1, 4, 10      |

Still to confirm in phase 0: that Safari and Workers accept both PKCS#8 imports, extractable and not; the lowest browser versions with X25519 and Ed25519; two PRF inputs with an iCloud passkey; the published HPKE test-vector file for this suite.

## 15. What is built

In `packages/seal`, each part with its tests. Nothing in the app or the Worker uses the package yet.

| Part                                                                                            | Sections      | Checked against                                                                                                                               |
| ----------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Byte layouts, labels, the strict reader; SHA-256, HMAC, HKDF; AES-256-GCM; key pairs from seeds | 1, 2          | RFC 5869 test cases 1 and 3, and WebCrypto's own HKDF; RFC 8032 test 1; RFC 7748 section 6.1                                                  |
| HPKE base mode, single-shot                                                                     | 3             | The CFRG's published test vector for this exact suite (mode 0, KEM `0x0020`, KDF `0x0001`, AEAD `0x0002`)                                     |
| Padding                                                                                         | 6.2           | Every step boundary                                                                                                                           |
| The keys derived from a budget key                                                              | 2             | The same derivation done with WebCrypto's HKDF; the signing public key is pinned                                                              |
| Ways in: a passkey's and the recovery key's secrets, the slot record and its anchor, slot ids   | 4             | The anchor, its key and the sealing inputs written out by hand with WebCrypto's HKDF and HMAC; pinned public keys; a forged budget is refused |
| Small wrapped values: an inbox private key, the budget key before this one                      | 5             | The associated data written out by hand; a walk back over two key changes                                                                     |
| The recovery key as shown and typed, and its sign-in by signature                               | 4.2           | A separate implementation of the spelling; every one-character slip is caught                                                                 |
| Log entries: the header, sealed and public bodies, the signature                                | 6             | Written and read back exactly; every broken header refused; a body opens only under its own header                                            |
| The chain a device checks, and the walk of a device with no key                                 | 4.4, 7.2, 7.3 | A small budget written entry by entry, then changed, cut, reordered and forged                                                                |

Not built yet: the server's own append rules that need its clock or session (7.1), snapshots (8), the Worker's keys, HMACs and bank runs (9), adding a device (10), signed requests (11).

Each part's code got an adversarial review of its own before it merged. The review of the first two parts found no wrong byte (it recomputed every label, layout and pinned value with a separate program) and 19 faults in checks and care with secrets, all fixed: a budget key sealed or wrapped is first checked to be the key its keys came from; a one-time key pair seals once; a slot id and base64url have one spelling; a byte-order mark is not dropped from a text field.
