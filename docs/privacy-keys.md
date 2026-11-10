# Privacy design, appendix: key formats (version 1)

Status: v1 draft, Nov 10, 2026. Nothing here is built. This is the appendix `docs/privacy.md` 5.2 asks for before any key code: every derivation label, associated-data string, nonce rule and byte layout. The code in `packages/seal` will follow it exactly, and its tests will pin each derivation with fixed test vectors, so a change to this file without a format version bump breaks a test. `docs/privacy.md` says why each thing exists; this file says only what the bytes are.

Not covered here, on purpose: how row changes are written inside an entry's sealed body, and inside a snapshot. Those belong to the phases that move edits and bank filing to the device (`docs/privacy.md` section 10, phases 3 and 4).

## 1. Conventions

- `||` joins bytes. `u8`, `u16`, `u32`, `u64` are unsigned, big-endian.
- `str(x)` is `u32(length) || x` for a byte string or a UTF-8 text. Every field of unknown length is written with `str`, so two different field lists can never give the same bytes.
- `H(x)` is SHA-256. `HMAC(k, x)` is HMAC-SHA-256. `HKDF(ikm, salt, info, n)` is HKDF-SHA-256 (RFC 5869) giving `n` bytes.
- `AEAD(k, aad, plain)` is AES-256-GCM with a fresh random 96-bit nonce from `crypto.getRandomValues`, written `nonce(12) || ciphertext || tag(16)`. Never a counter, never a reused nonce.
- Labels are ASCII and start with `ledgerline/v1/`. A label is used for one purpose only.
- Ids (`budgetId`, `deviceId`, `linkId`, `snapshotId`) are the ASCII text of the id. `credentialId` is the passkey's raw credential id bytes.
- A key version `v` is a `u32` that starts at 1 and goes up by 1 at each key change.
- Every stored structure starts with a 4-byte magic that names its kind and format. A reader that meets a magic it doesn't know stops with "Update Ledgerline to continue"; it never guesses.

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

WebCrypto can't derive an Ed25519 or X25519 key directly. A 32-byte seed is imported as PKCS#8 by putting a fixed 16-byte prefix before it, and the seed bytes are zeroed after the import:

- Ed25519: `30 2e 02 01 00 30 05 06 03 2b 65 70 04 22 04 20 || seed`
- X25519: `30 2e 02 01 00 30 05 06 03 2b 65 6e 04 22 04 20 || seed`

The **first signing public key** of a budget, `signPub_1`, is its `genesisSignPub`. It never changes and is what every slot's anchor names (section 4).

## 3. Sealing to a public key (HPKE)

HPKE base mode, RFC 9180, single-shot:

- KEM: DHKEM(X25519, HKDF-SHA256), id `0x0020`
- KDF: HKDF-SHA256, id `0x0001`
- AEAD: AES-256-GCM, id `0x0002`

`Seal(pkR, info, aad, plain)` gives `enc(32) || ciphertext || tag(16)`, where `enc` is the sender's one-time public key. `Open(skR, info, aad, sealed)` reverses it. The implementation is checked against the RFC's published test vectors for this KEM and KDF before it is used for anything.

HPKE proves nothing about who sealed. Wherever that matters, something else does: a slot's anchor and the key-change chain (sections 4 and 7), or the Worker's signature (section 9).

## 4. Ways in (slots)

A slot is one way to get the budget key: a passkey, or the recovery key.

### 4.1 A passkey's secrets

Every sign-in asks the passkey's PRF extension with the first input set to one constant for the whole app:

```
prfInput = H("ledgerline/v1/prf/slot")
```

(The copy vault's per-device salt, when a device has one, is the second input: `docs/phone-budget.md` 13.2.) From the 32-byte output `prf`:

```
slotSalt   = str(budgetId) || str(credentialId)
slotSeed   = HKDF(prf, slotSalt, "ledgerline/v1/slot/x25519", 32)   -> X25519 pair slotPriv, slotPub
anchorKey  = HKDF(prf, slotSalt, "ledgerline/v1/slot/anchor", 32)   -> HMAC key
slotId     = "p:" || base64url(credentialId)
```

### 4.2 The recovery key's secrets

The recovery key `R` is 32 random bytes, shown to the person once. It is unique to one budget, so it needs no salt:

```
zero       = 32 zero bytes
authHalf   = HKDF(R, zero, "ledgerline/v1/recovery/auth", 32)       the server stores only H(authHalf)
slotSeed   = HKDF(R, zero, "ledgerline/v1/recovery/x25519", 32)     -> X25519 pair
anchorKey  = HKDF(R, zero, "ledgerline/v1/recovery/anchor", 32)     -> HMAC key
slotId     = "r:" || decimal generation number, starting at 1
```

`authHalf` lets the server allow a new passkey; it gives no part of the budget key. Making a new recovery key gives the next generation number and removes the old slot in the same key change.

### 4.3 The slot record

Written in a slot entry or a key-change entry (section 7), for key version `v`:

| Field        | Bytes                                     | Who can read it |
| ------------ | ----------------------------------------- | --------------- |
| `slotId`     | `str`                                     | Anyone          |
| `anchor`     | `HMAC(anchorKey, "ledgerline/v1/anchor"   |                 | str(budgetId) |     | str(slotId)            |                   | genesisSignPub)`, 32 bytes | Anyone; only the slot's owner can check it |
| `sealedKey`  | `Seal(slotPub, "ledgerline/v1/hpke/slot"  |                 | str(budgetId) |     | str(slotId)            |                   | u32(v), signPub_v, BK_v)`  | The slot's owner                           |
| `wrappedPub` | `AEAD(K_wrap_v, "ledgerline/v1/wrap/slot" |                 | str(budgetId) |     | str(slotId), slotPub)` | Holders of `BK_v` |

- `anchor` is made once, by the device that holds the slot's secret, when the slot is created. It is copied unchanged into every later key-change entry.
- `wrappedPub` is how a device doing a key change learns the other slots' public halves without the server ever seeing them.
- The associated data of `sealedKey` is `signPub_v`. A device that opens it derives `signSeed_v` from the `BK_v` it got and refuses the key unless the public half equals that associated data and the one the chain names.

### 4.4 Opening a budget on a device that holds nothing yet

1. Sign in with a passkey (or type the recovery key) and derive the slot's secrets.
2. Fetch the budget's genesis entry and every slot and key-change entry. They are public structures (section 7).
3. Find this slot's record in the genesis entry or the slot entry that added it. **Check `anchor` against the genesis entry's `signPub_1`.** If it fails, stop: the server is showing a budget this slot was never part of.
4. Check the genesis entry's signature with `signPub_1`, then each key-change entry's signature with the signing key of the version before it, and each slot entry's with the signing key of its version. Each names the entry before it; a gap or a fork stops the device.
5. Open `sealedKey` from the newest key-change entry (or the genesis entry). Check it as in 4.3.

What this can't catch is in `docs/privacy.md` 5.2: a removed way in and a dishonest server together can show a device that has never seen the real key change a false one.

## 5. Small wrapped values

All are `AEAD(K_wrap_v, aad, plain)`:

| Value                              | `aad`                       |
| ---------------------------------- | --------------------------- |
| A slot's public half               | `"ledgerline/v1/wrap/slot"  |     | str(budgetId) |     | str(slotId)` |
| The inbox private key, version `i` | `"ledgerline/v1/wrap/inbox" |     | str(budgetId) |     | u32(i)`      |

The inbox key pair is a random X25519 pair with its own version `i`, which goes up at each key change. A key-change entry carries the new inbox public key and **every** older inbox private key that still has unfiled runs, each wrapped under the new `K_wrap`.

## 6. Log entries

An entry is a header, a body and a signature.

### 6.1 Header

| #   | Field             | Bytes       | Notes                                                                                                            |
| --- | ----------------- | ----------- | ---------------------------------------------------------------------------------------------------------------- |
| 1   | magic             | 4           | `"LLE1"`                                                                                                         |
| 2   | kind              | `u8`        | 0 genesis, 1 edit, 2 bank, 3 scan, 4 slot change, 5 key change, 6 sign-out, 7 unseal, 8 data migration           |
| 3   | budgetId          | `str`       |                                                                                                                  |
| 4   | number            | `u64`       | 1 for the genesis entry, then up by 1                                                                            |
| 5   | prevHash          | 32          | `entryHash` of entry `number - 1`; zeros for the genesis entry                                                   |
| 6   | entryId           | 16          | Random. The server answers "already stored" for one it holds                                                     |
| 7   | time              | `u64`       | Milliseconds. For ordering only                                                                                  |
| 8   | deviceId          | `str`       |                                                                                                                  |
| 9   | deviceCounter     | `u64`       | This device's own count of entries                                                                               |
| 10  | keyVersion        | `u32`       | The version whose signing key signs this entry                                                                   |
| 11  | schemaVersion     | `u32`       |                                                                                                                  |
| 12  | processingVersion | `u32`       |                                                                                                                  |
| 13  | part, parts       | `u16` each  | `1, 1` for a whole entry. A change set over 64 KB is `parts` entries with consecutive numbers, appended together |
| 14  | filedThrough      | `u64`       | The last bank run this budget has filed, after this entry                                                        |
| 15  | receipts          | `u16(count) |                                                                                                                  | 32 × count` | The receipt of each run this entry files, in order (section 9.3); count 0 otherwise. At most 256 |
| 16  | scanThrough       | `u32`       | Days since 1970-01-01 of the last day scanned, in the budget's time zone; may only go up                         |
| 17  | bodyHash          | 32          | `H(body)`, the bytes as stored                                                                                   |

```
entryHash = H(header)
signature = Ed25519(signPriv_keyVersion, "ledgerline/v1/entry" || entryHash)      64 bytes
```

The server checks the signature, `number`, `prevHash`, `entryId`, `keyVersion`, `bodyHash` and the rules of `docs/privacy.md` 5.3. It never needs the body's plain text.

### 6.2 Body of kinds 1, 2, 3, 6, 7, 8: sealed

```
aad   = "ledgerline/v1/body" || H(header fields 1 to 16)
body  = AEAD(K_log_keyVersion, aad, pad(plain))
```

`plain` holds what `docs/privacy.md` 5.3 lists (the row changes; for an edit, the time the person made it; what this device last saw from each other device). Its inner layout is fixed in a later phase.

`pad(x)` is `x || 0x80 || zeros` up to the next size step: 256 bytes, 1 KB, 4 KB, 16 KB, 64 KB. To unpad, drop the trailing zeros and the `0x80`.

### 6.3 Body of kinds 0, 4, 5: public structures

Genesis, slot-change and key-change entries are read by devices that hold no key yet, so their bodies are not sealed. Everything secret inside them is already sealed to a slot or wrapped. The signature covers them through `bodyHash`.

**Genesis (kind 0)**, `keyVersion` = 1, signed by `signPriv_1`:

```
"LLG1" || signPub_1(32) || u32(inboxVersion) || inboxPub(32) || u16(slots) || slot records (4.3)
```

**Slot change (kind 4)**, signed by the current signing key. Adds slots only; removing one is always a key change:

```
"LLS1" || u16(slots) || slot records (4.3)
```

**Key change (kind 5)**, to version `v + 1`. Header `keyVersion` = `v`, signed by `signPriv_v`:

```
"LLK1" || u32(v + 1) || signPub_{v+1}(32)
       || u32(inboxVersion) || inboxPub(32)
       || u16(slots)   || slot records (4.3) for every slot that stays, sealed and wrapped for v + 1
       || u16(inboxes) || [ u32(i) || str(wrapped inbox private key i) ] ...
```

After a key change is stored, the server refuses entries with `keyVersion` = `v`, and entry bodies use `K_log_{v+1}`.

## 7. The chain a device checks

- Every entry names the hash of the one before it (`prevHash`), so the log is one chain from the genesis entry.
- A device keeps, apart from its copy: the highest `number` it has applied, that entry's `entryHash`, and the last checkpoint hash (section 8).
- The public entries (kinds 0, 4, 5) are kept for ever, also after older sealed entries are deleted, so a device can always walk from the genesis entry to the current key version.

## 8. Snapshots

```
chunk_k   = AEAD(K_snap_v, "ledgerline/v1/snap/chunk" || str(budgetId) || str(snapshotId) || u32(k) || u32(count), bytes_k)
manifest  = AEAD(K_snap_v, "ledgerline/v1/snap/manifest" || str(budgetId) || str(snapshotId), m)
signature = Ed25519(signPriv_v, "ledgerline/v1/snap" || H(manifest as stored))
```

The manifest's plain text `m`:

```
"LLM1" || str(snapshotId) || u32(v) || u64(number) || entryHash(32)
       || u32(count) || H(chunk_1 as stored) ... H(chunk_count as stored)
       || u16(tables) || [ str(table name) || H(table's rows in key order) ] ...
       || u16(checkpoints) || [ u64(number) || entryHash(32) ] ...
```

A checkpoint is the `entryHash` of every entry whose number is a multiple of 1,000, plus the snapshot's own. How a table's rows are written for its hash is fixed with the row format, in a later phase.

## 9. What the Worker makes

### 9.1 The Worker's keys

Both come from the Worker secret that already encrypts bank tokens (`TOKEN_KEYS`), so the owner pastes nothing new. For the keyring's key number `n`, with `secret_n` its 32 bytes:

```
K_mac_n       = HKDF(secret_n, zero, "ledgerline/v1/server/mac", 32)          HMAC key
runSignSeed_n = HKDF(secret_n, zero, "ledgerline/v1/server/run-sign", 32)     Ed25519 pair runSignPriv_n, runSignPub_n
```

The app is built with a list of `(n, runSignPub_n)` it accepts. A new key number is added to that list in a release before the Worker starts to use it.

### 9.2 The HMACs

```
keyMac  = HMAC(K_mac_n, "ledgerline/v1/mac/key"  || str(budgetId) || u32(v) || u8(kind) || pub(32))
          kind: 1 a signing public key, 2 an inbox public key (v is then the inbox version)
linkMac = HMAC(K_mac_n, "ledgerline/v1/mac/link" || str(budgetId) || str(linkId) || str(itemId)
                                                 || str(token ciphertext) || str(cursor) || u64(runs))
          runs: how many runs this link has completed
```

Each is stored with `n`. They stop a database writer from inventing a key or a link row. They can't stop an older, validly stamped row from being put back; the run manifest catches that at the next run (9.3).

### 9.3 A bank run

Each page, balance answer and link description is sealed on its own:

```
sealed_p = Seal(inboxPub_i,
                "ledgerline/v1/hpke/inbox" || str(budgetId) || str(linkId) || u32(i),
                u64(run) || u32(restart) || u16(p) || u8(what),
                plain_p)
what: 0 a transactions page, 1 balances, 2 liabilities, 3 the link's description (its first run)
```

`plain_0` starts with the run's 32 random receipt bytes, then the page.

The manifest:

```
"LLR1" || str(budgetId) || str(linkId)
       || u64(run)            the budget's run number: 1, 2, 3 ... across all its links
       || u32(restart)        how many times this run started again
       || u32(i) || H(inboxPub_i)
       || u64(runTime) || u64(prevRunTime)        milliseconds; the time of this run and of run - 1
       || H(cursor before) || H(cursor after)     this link's cursor
       || u8(flags)           bit 0 has balances, bit 1 has liabilities, bit 2 is a link description
       || u32(added) || u32(modified) || u32(removed)
       || u16(pages) || H(sealed_0) ... H(sealed_{pages-1})
       || H(receipt)
       || prevManifestHash(32)                    H(manifest) of run - 1; zeros for run 1
       || u32(n)
signature = Ed25519(runSignPriv_n, "ledgerline/v1/run" || H(manifest))
```

A device files run `r` only if: the signature is good for a key number in its list; `run` is `filedThrough + 1`; `prevManifestHash` is the hash of the manifest it filed before; `i` and `H(inboxPub_i)` name an inbox key it holds and has not retired; `H(cursor before)` equals the `H(cursor after)` of the last run it filed for that link (for a link's first run, the hash of the empty string); every `H(sealed_p)` matches; `runTime` is later than `prevRunTime` and not later than the device's clock plus 10 minutes; and the receipt inside page 0 hashes to `H(receipt)`.

To file runs `a` to `b`, the entry's `receipts` field holds the receipt of each, in order. The server checks each against the `H(receipt)` it stored.

## 10. Adding a device with its own passkey

The new device `N` holds nothing. The signed-in device `O` holds `BK_v`.

```
N:  a one-time X25519 pair (addPriv, addPub), and 32 random bytes nonceN
N -> O:   commit = H("ledgerline/v1/add/commit" || addPub || nonceN)
O -> N:   nonceO (32 random bytes), signPub_v, u32(v), u64(head number), head entryHash
N -> O:   addPub, nonceN                          O checks them against commit

transcript = H("ledgerline/v1/add/transcript" || commit || nonceO || addPub || nonceN
               || str(budgetId) || signPub_v || u32(v) || u64(head number) || head entryHash)
code       = u32(first 4 bytes of HKDF(transcript, zero, "ledgerline/v1/add/code", 4)) mod 1,000,000     six digits
```

Both devices show `code`. **The person confirms it on `O`.** Only then:

```
O -> N:   Seal(addPub, "ledgerline/v1/hpke/device-add" || transcript, signPub_v, BK_v)
```

`N` opens it, checks `signPub_v` as in 4.3 and checks the head it was told against the log. `N` then makes its passkey's slot record and appends it in a slot-change entry, which it can now sign. One attempt per code; 10 minutes; a cancelled attempt leaves nothing.

The server relays every message. It must commit to an `addPub` before it sees `nonceO`, so it gets one guess in a million at a matching code, and a wrong guess shows as two different codes.

## 11. Limits

- AES-GCM with random nonces: well under 2^32 seals per key. A budget makes a few thousand entries a year; a key change starts fresh keys.
- An entry's body is at most 64 KB before sealing; larger change sets use parts (6.1, field 13).
- A filing entry names at most 256 runs. A device with more waiting files them in several writes.
- X25519 and Ed25519 are not safe against a large quantum computer. `docs/privacy.md` 5.2 says what that exposes and that no claim is made.

## 12. Changes to this file

A change to any label, field or layout needs a new magic or a new `ledgerline/v2/` label, and readers must keep understanding the old one for as long as stored data uses it. The test vectors in `packages/seal` are the check that nothing drifted.
