# Privacy design, appendix: key formats (version 1)

Status: v2, Nov 10, 2026. Section 15 lists which parts are built in `packages/seal`; nothing uses them yet. This is the appendix `docs/privacy.md` 5.2 asks for before any key code: every derivation label, associated-data string, nonce rule and byte layout. An adversarial review of v1 made 20 findings; this version includes their fixes (section 14). The code in `packages/seal` will follow this file exactly, and its tests will pin each derivation with fixed test vectors, so a change here without a format version bump breaks a test. `docs/privacy.md` says why each thing exists; this file says only what the bytes are and what each side checks.

Not covered here, on purpose: how row changes are written inside a snapshot, and how a table is hashed (the row changes inside an entry's sealed body are in 6.2). Those belong to the phases that move edits and bank filing to the device (`docs/privacy.md` section 10, phases 3 and 4).

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

Making a new recovery key takes two entries: a slot change adds the slot of the next generation number, then a key change leaves the old one out. A key change never adds a slot.

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
- **A full backup made on the device** (`docs/privacy.md` 5.8) is sealed with the recovery key alone: `"LEDGERLINE-BACKUP\n1\n" || AEAD(K, aad = that magic, plain)`, where `K = HKDF(R, zero, "ledgerline/v1/backup", 32)` and `plain` is the copy's SQLite file. It needs no budget key, so it opens where only the recovery key is left (`sealBackup`, `openBackup`; D-99).

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
| 16  | scanThrough       | `u32`                                | The last day scanned, in the budget's time zone; only a scan entry raises it                                                                      |
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

`plain` holds what `docs/privacy.md` 5.3 lists (the row changes; for an edit, the time the person made it; what this device last saw from each other device). For kinds 1, 2 and 3 it is a **change set**, UTF-8 JSON (`apps/worker/src/local/device-log.ts`):

```
{ "v": 1, "at": ms, "rows": [ { "t": table, "k": [key values], "d": row or null } ], "seen": { deviceId: [number, entryHash hex] } }
```

- `at`: for an edit, when the person made it; for a bank entry, the update's time; for a scan, its planned time.
- `rows`: the changed rows as they are after the change, in the order they last changed; `d` is the whole row (column name to value), or `null` for a row that is gone. The tables are the ones a copy keeps and the two only a recording carries (`RECORDED_TABLES` in `apps/worker/src/local/engine.ts`). A reader writes the rows and runs nothing.
- `seen`: the last entry this device has taken from each other device.
- A reader refuses a body that is not this shape (`v` other than 1 is a newer app's: the header's schema version says so first).

With parts (6.4), `plain` is the JSON's bytes cut in order; a reader joins the parts before it reads the JSON.

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

**When an intent is needed.** The server knows which way in a session used. **Every** key change made in a session that signed in with the recovery key or with a passkey added less than 7 days ago is refused unless it names an intent that: is in the log; lists exactly the slots left out; has `notBefore` at least 7 days after the intent's own `time` and not later than the server's clock; and has no cancel after it. The rule can't be "a key change that leaves out a slot": the server can't see into a slot's sealed record, so a key change that keeps a slot's id may still lock it out. An intent names at least one slot, so such a session can't change the key and remove nothing. Any holder of the current key can write a cancel. Because the key change is written after the wait, with its own fresh `number` and `prevHash`, the log doesn't stop meanwhile.

### 6.4 Parts

A change set over 65,535 bytes is written as `parts` entries (kinds 1, 2, 3 or 8 only):

- consecutive numbers, in one write, all appended or none;
- the same kind, device, key version, `time`, `entryId`, `filedThrough` and `scanThrough` in each; `deviceCounter` goes up by 1 per part;
- `receipts` in part 1 only; count 0 in the others;
- a reader applies nothing until every part has arrived and verified. A log that ends inside a set is a cut-off download, not a shorter log.

## 7. What each side checks

### 7.1 One set of rules, run by both sides

The rules of the log are one piece of code (`packages/seal/src/chain.ts`). **The server runs it on every append before it stores an entry, and a device runs it on every entry it takes**, because the server may lie. Since both run the same code, an entry a device would refuse is a refused write, never an entry that sits in the log and stops every device for good.

The shared rules, on each entry:

- its `entryHash` and `bodyHash` are its own, worked out again;
- the budget; `number` and `prevHash` continue the log;
- `keyVersion` is the version in force, and the signature is good for that version's signing key;
- `time` is later than the entry before (equal only inside a part set), and not more than 10 minutes after the checker's own clock;
- `deviceCounter` is that device's last value + 1; a device not seen before starts at 1;
- `entryId` is not the one of the entry before;
- the part rules (6.4);
- only a bank entry raises `filedThrough`, by at least 1, with one receipt for each run; no other kind carries receipts;
- only a scan entry raises `scanThrough`, and not past tomorrow by the checker's clock;
- a public body parses, names the public entry before it, and obeys the rules below;
- a schema version newer than the reader's stops it with "Update Ledgerline to continue", which is not an error in the log.

For the public entries:

- **Slot change:** no slot that is already there; at most 64 slots in all.
- **Key change:** the key version and the inbox version each step by exactly 1; `lastOldRun` is not below `filedThrough` or below the last key change's; every slot it keeps is in force today with its anchor unchanged, and it adds none; it carries the new inbox key, no inbox key twice, none the log doesn't hold, and **every inbox key that still has unfiled runs** (without it those runs could never be opened).
- **Intent:** only recorded. At most 16 are open at once.
- **Cancel:** names an open intent, which is then closed.
- **A key change that names an intent:** the intent is open; its `notBefore` is at least 7 days after the intent's own `time`; the key change's `time` is not before `notBefore`; and the slots the key change leaves out are exactly the ones the intent lists. The intent is then closed.

An intent is judged when it is used, not when it is written, so an intent from an honest device with an odd clock can't stop the log. A writer sets `notBefore` to the intent's own `time` plus 7 days, and writes the key change once its clock has reached `notBefore`.

### 7.2 What only one side checks

**The server only**, because it needs its clock and its session:

- `time` is within 5 minutes of the server's clock, either way. This is what makes the 7-day wait real: an intent can't be back-dated, and a key change can't be dated ahead.
- `entryId` is new in the whole log. A write whose every entry the log holds, **with the same entry hashes**, gets "already stored". An id the log holds with other content is refused; so is a write with some entries held and some new, and one id used for two changes in a write.
- A write is stored whole or not at all. One that ends inside a part set is refused. A write holds at most 16 entries, so a change set has at most 16 parts (about 1 MB): a larger write would not fit the server's 10 ms of CPU for a request. The server checks and stores a write under one lock.
- `schemaVersion` and `processingVersion` are not above those of the released app. A newer one would be stored and then stop every device.
- `scanThrough` is at most tomorrow by the server's clock.
- When an intent is required (6.3): the key change must name one, and the intent's `notBefore` is not later than the server's clock.
- A key change's `lastOldRun` is exactly the last complete run. Lower, and a waiting run could never be filed, which would hold back every edit for good. Higher, and the replaced inbox key would never retire.
- The kinds the breaker never holds back have small limits of their own: at most 4 in a write, a daily count for each budget, and a sign-out body of the smallest padding step only.
- "Bank runs first": an edit is refused unless its `filedThrough` has reached the last complete run. The same write may file that run first.
- The breaker refuses edits, bank entries, scans and data migrations while writes rest. It never holds back a slot change, a key change, a sign-out, an intent or a cancel; nor does "bank runs first" (`docs/privacy.md` 5.3).
- A bank entry files only complete runs, and its receipts match the `H(receipt)` stored for exactly those runs, in order (9.3).

**A device only:**

- for a bank entry, that the runs it names are the next ones and open (9.3);
- an entry dated ahead of the device's clock, or a scan date ahead of it, is tried again later. It is the device's clock that may be wrong, so it is not treated as proof that the server lied;
- its remembered position: apart from its copy it keeps the highest `number` it has applied, that entry's `entryHash`, the last public entry's number and hash, and the last checkpoint (section 8). A device that walks the public chain (4.4) requires the walk to pass the public entry it remembers, and opens a snapshot only by the rules in section 8.

A device can't check the 5-minute rule on entries from the past. It trusts the server for the real length of the 7-day wait, as `docs/privacy.md` 5.2 says: a thief who also controls the server isn't stopped.

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
     || u16(devices) || [ str(deviceId) || u64(deviceCounter) ] ...            each device's last counter
```

The checkpoints are exactly these, in order: the `entryHash` of every entry before the snapshot's whose number is a multiple of 1,000, then the snapshot's own entry. A manifest with any other list is refused.

The last line is each device's last counter: with the entry the snapshot stands at, it is what a device needs to check the entry after the snapshot. The devices are in ascending order of id, at least 1 and at most 4,096. Each entry raised one device's counter by 1, so the counters add up to the snapshot's `number`; a manifest where they don't is refused.

A snapshot never stands inside a part set (6.4): the server refuses a header whose entry is not the last part of its set. The server keeps the entry a snapshot stands at for as long as it keeps the snapshot.

**A chain that starts at a snapshot.** A device that opens a snapshot does not hold the entries before it. It takes:

- the public state from the public chain, walked up to the public entry the header names;
- the time, entry id, filed runs and scan date from **the entry the snapshot stands at**, which must hash to the header's `entryHash`, be signed by the key in force, and end its part set. So these are the log's own values and not a writer's copy;
- each device's counter from the manifest. They must add up to the number, and the entry's writer must have the entry's own counter.

From there it checks each later entry by the rules of 7.1, as if it had read the log from the start.

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

A device signs a check record only for a header whose own signature it has verified.

**A device opens a snapshot only if all of this holds:**

1. The header is for this budget, and its signature is good under the key version it names.
2. The public entry the header names is on the public chain the device walked (4.4), with that number and hash, and the key version in force after it is the header's.
3. The next public entry on that chain, if there is one, has a number above the snapshot's. So a snapshot can't hide a later key change or slot change.
4. The snapshot is not older than the entry the device has already applied.
5. The manifest as stored hashes to the header's value, opens, and names the same snapshot, version, number and entry hash.
6. The manifest holds the checkpoint the device remembers (7.2).

Each chunk must then hash to the manifest's value and open as that chunk.

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

The run being fetched has a stamp of its own, written by every step and checked by the next, so a step goes on only from what the step before left:

```
stageMac = HMAC(K_mac_n, "ledgerline/v1/mac/stage" || str(budgetId) || str(linkId) || u64(run) || u32(restart) || u32(bankRestarts)
                                                   || u32(i) || u32(n) || str(first cursor) || str(cursor) || u8(hasMore) || u8(describes)
                                                   || u16(pages) || u32(added) || u32(modified) || u32(removed) || pagesHash(32) || u64(startedAt))
pagesHash: zeros, then H(pagesHash || u8(what_p) || H(sealed_p)) for each page stored, in order.
```

The Worker signs a run only when the stored pages chain to `pagesHash`. This stamp never leaves the server, and a run being fetched lives for minutes, so its layout may change with a release.

- `itemId` is 1 to 255 printable ASCII characters (`0x21` to `0x7e`). `token ciphertext` is the bytes of the stored text, as the database holds it.
- In `runsMac`, a `run` of 0 goes with a zero hash and a zero time, and no other run does.
- A check of a stamp never fails with an error: a stored value that could not have been stamped is a bad stamp.

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
r_p:  HMAC(K_mac_n, "ledgerline/v1/receipt-part" || str(budgetId) || str(linkId) || u64(run) || u32(restart) || u16(p))

receipt  = H("ledgerline/v1/receipt" || r_0 || ... || r_{pages-1})
```

A device can only work out `receipt` by opening every page. The Worker works `r_p` out again when it signs the run, so it keeps nothing secret between sealing a page and signing. A run that starts again has a new `restart`, so new `r_p`.

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
     || u16(pages) || [ u8(what_p) || H(sealed_p) ] ...     each page in order; the flags are those the page list gives
     || H(receipt)
     || prevManifestHash(32)                    H(manifest) of run - 1; zeros for run 1
     || u32(n)
signature = Ed25519(runSignPriv_n, "ledgerline/v1/run" || H(manifest))
```

**A device files run `r` only if all of this holds:**

1. The manifest reads strictly, and the signature is good for a key number in its list (9.1). The manifest is for this budget.
2. `run` is `filedThrough + 1`, and `prevManifestHash` is the hash of the manifest it filed before.
3. The inbox version `i` is not lower than that of the run before, and not higher than the version the log has brought this device. If `i` is not the version in force, a key change replaced it, and `run` is not above that key change's `lastOldRun`. The device holds the private key for `i`, and `H(inboxPub_i)` matches the key the log names for `i`.
4. `H(cursor before)` equals the `H(cursor after)` of the last run it filed for that link. A link's first run, and no other, holds the link's description.
5. Every `H(sealed_p)` matches, every page opens, and the receipt worked out from the pages hashes to `H(receipt)`.
6. `runTime` is later than `prevRunTime`, `prevRunTime` equals the `runTime` of the run before, and `runTime` is not later than the device's clock plus 10 minutes.

Three failures may be the device's own state and not a bad run, so the device tries the run again later: a run dated in the future, an inbox version the device's log has not reached, and an inbox key the device does not hold yet. Any other failure means the server sent what the Worker could not have made, or out of order.

**The Worker**, when it signs a run:

- sets `runTime` to its clock, or to 1 ms after the run before if its clock is not later. A manifest whose `runTime` is not later than its `prevRunTime` can't be written or read.
- reads the inbox version in force in the transaction that completes the run. If the run's pages are sealed to a replaced version and `run` is above that key change's `lastOldRun`, it does not sign: it starts the run again with the next `restart`, sealed to the key in force.

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

**The messages as sent.** The commitment is 32 bytes. The offer is `nonceO(32) || signPub_v(32) || u32(v) || u64(head number) || head entryHash(32)`, 108 bytes. The reveal is `addPub(32) || nonceN(32)`. The sealed key is 80 bytes and the confirmation 32.

**The order is the protection, so each side keeps it:**

- `N` answers **one** offer per try. It never shows its key for a second offer: a server that could send one would choose its nonce after it saw `N`'s, and so choose the code.
- `N` starts a new try only when the person asks. The app never starts one by itself.
- `O` makes an offer only for a commitment it already holds, and takes one reveal per offer.
- `O` makes at most 3 offers per start by the person, **shown or not**; then the person must start again. An offer lasts 10 minutes. A cancelled one leaves nothing.
- `O` refuses a small-order `addPub` before it shows a code.
- `O` seals the key once per start.
- Before `N` opens the sealed key, it checks the offer against the log it was given: `signPub_v` and `v` are those in force at the end of the public chain it walked (4.4), and the head's hash is the hash of that entry in the log. An offer that does not agree is refused. This is `N`'s only tie to the real budget, because its passkey has no slot yet and so no anchor.
- The confirmation proves that the other end holds `BK_v` and the transcript. `O` shows "added" when it verifies **and** the new device's slot change is in the log.

The server relays every message. It must commit to an `addPub` before it sees `nonceO`, so it gets one guess in a million at a matching code, and a wrong guess shows as two different codes. Because `N` waits for the person too, a server that pretends to be `O` can't hand `N` a budget of its own making unseen.

## 11. Requests signed with the budget's key

Some requests to the server must come from a holder of the budget key, not only from a session (`docs/privacy.md` 5.2, 5.5): storing a new signing or inbox public key, asking for a link token, finishing a new bank's link, removing a bank, deleting the account, starting to delete the readable copy, and setting the recovery key's sign-in half. A stolen session with a fresh passkey check can do none of these alone.

```
signature = Ed25519(signPriv_v, "ledgerline/v1/request" || str(budgetId) || u32(v) || str(action)
                                || challenge(32) || H(payload))
```

`action` is a fixed ASCII name for the request: `store-sign-key`, `store-inbox-key`, `link-token` (to add or to repair a bank), `remove-bank`, `delete-account`, `link-finish` (a new bank's link), `purge-old-copy` (`docs/privacy.md` section 8, step 8), `set-recovery-sign-in` (4.2). A name is never reused for another request. `challenge` is 32 random bytes the server gave for this one request, used once and good for 5 minutes.

- **The challenge.** The device asks the Directory for one, naming the request (`POST /api/settings/security/request-challenge`). The Directory writes nothing: the challenge travels in a token with an HMAC under a key derived from the Worker's secret, bound to the session and to the request's name. The device sends the token and the signature (hex) in two headers, `x-ledgerline-challenge` and `x-ledgerline-signature`. The Directory marks the token used before anything checks the signature, so a token is good for one try, right or wrong; a token of another session or another request is no challenge.
- **Who checks.** The server names the request by the path, never by the token. The budget's store checks the signature for its own routes, with the key in force in its log's public state; the Directory checks it for its own routes (Delete account, the recovery key's sign-in half), with the key the store reports. A budget that is not locked needs no signature.
- **On the device.** The engine signs (`sealedSign` in the Web Worker): the signing key never leaves it. It signs with the key in force where the device stands in the log; after a key change it has not read yet, the server refuses, and the next sync brings it level.

- `payload` is the request's body, exactly the bytes sent. Every parameter of the request is in the body and none in the address. The server hashes the bytes it received.
- A request that names a key or a bank (`store-sign-key`, `store-inbox-key`, `remove-bank`, `link-finish`, `set-recovery-sign-in`) has a payload that is not empty. Removing a bank names it in the body (`connectionId`), and the server refuses a body that names another bank than the address.
- The server takes `signPub_v` and `v` from the log, never from the request.

**Signing keys.** The 14 encodings of Ed25519 points of small order are never a signing key: a genesis entry or a key change that names one is refused, and no signature verifies under one.

## 12. Limits

- AES-GCM with random nonces: well under 2^32 seals per key. A budget makes a few thousand entries a year; a key change starts fresh keys.
- An entry's plain body is at most 65,535 bytes; larger change sets use parts (6.4).
- A filing entry names at most 256 runs. A device with more waiting files them in several writes.
- A write holds at most 16 entries. At most 4,096 devices ever write to one budget; an entry from one more is refused by both sides.
- At most 64 slots, at most 16 inbox keys carried in a key change, and at most 16 open intents.
- A public body is at most 128 KB. A sealed body is exactly a padding step plus 28 bytes.
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

In `packages/seal`, each part with its tests. Outside the package so far, and used by nothing in production: the server's store of the log (`apps/worker/src/seal/log-store.ts`, 7.2), a device's side of the log (`apps/worker/src/local/device-log.ts`, 6.2 and 6.4), the Worker's stamp on a bank link (`apps/worker/src/store/stamp-links.ts`, 9.2), which runs in production, and the bank runs of a sealed budget (`apps/worker/src/seal/runs.ts`, 9.2 and 9.3; store migration 0006): the stamps on the signing and inbox keys a stored write brings, the run state under its one stamp, and a run as job steps (begin, a page fetched and sealed, the bank's answers, sign and complete). The run being fetched is under its own stamp (9.2). A run never goes back to an older inbox version than the run before it, whose manifest the stamped run state names. A link's first run holds its description and fetches no transactions, so its cursor after is the empty one.

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
| The rules of the log, and the walk of a device with no key                                      | 4.4, 7.1, 7.3 | A small budget written entry by entry, then changed, cut, reordered and forged                                                                |
| Snapshots: chunks, the manifest, the signed header, the check record                            | 8             | Each rule for opening one broken in turn; a snapshot that hides a later public entry is refused                                               |
| The Worker's keys and its three stamps                                                          | 9.1, 9.2      | Both forms of the Worker secret pinned against the token code; the run-signing public key pinned; stored values that can't be stamped         |
| Bank runs: sealing a page, signing a run, a device's checks, the server's receipt check         | 9.3           | Runs across one and two key changes, a rewound link, a restarted run, changed, missing and reordered pages                                    |
| Adding a device: the three messages, the code, the sealed key, the confirmation                 | 10            | A separate program worked out the pinned commitment, transcript, code and confirmation; each step out of order is refused                     |
| Requests signed with the budget's key                                                           | 11            | The signed bytes written out by a separate program; every changed field fails; small-order keys never verify                                  |
| The server's own rules for a write                                                              | 7.2           | Each rule broken in turn on a small budget: the clock, a write sent again, receipts, bank runs first, the breaker, the intent                 |
| A chain that starts at a snapshot                                                               | 8             | At every place a snapshot can stand, the resumed state equals the state read from the start, field by field, and goes on the same             |
| A full backup sealed with the recovery key                                                      | 5             | The key written out by hand with WebCrypto's HKDF; a wrong key, a changed byte and a file that is not one are refused                         |

Every section of this file is built.

The ways in, in the app and the Directory (Nov 12, 2026; 4.2, 4.4, 6.3): a passkey that is no way in to a locked budget (`NoSlotError` in `apps/web/src/keys/budget.ts`) shows "Open your budget with your recovery key"; the typed key opens the budget from the public entries, the engine joins from a snapshot, and the device adds the passkey as a way in with a slot change (`apps/web/src/copy/sealed-ways.ts`), so the passkey alone opens it after that. A public entry the app makes goes on top of the engine's place (`DeviceLog.writePlace`, the engine's `sealedPlace` and `sealedAppend`), and the engine reads it back by the log's rules; a key change hands the new version's keys to the engine (`DeviceLog.holdKeys`). The Directory keeps the recovery key's `authPub` (directory migration 0009, `apps/worker/src/routes/recovery-key.ts`): the move sets it, Settings → Sign-in sets it from a typed key that opens the budget, and Sign in → Use your recovery key proves the key by the signature in 4.2 and then makes a new passkey. The recovery code stays for budgets that are not locked. Settings → Sign-in for a locked budget: a new recovery key (the slot change, then the key change), and removing a passkey removes its slot with a key change. A session counts as a fresh way in while its passkey is less than 7 days old (a recovery-key sign-in always makes a new one), so from it a key change becomes an intent and waits 7 days (6.3); the app says so, and Settings → Sign-in lists the planned changes with Finish and Cancel. Another device that finds a key version it doesn't hold asks for the passkey again.

A device's remembered position (7.2) and a copy made again (Nov 13, 2026; 7.2, 8): a device keeps with its place its own last 64 entries and an entry list it must pass through (`DeviceLog.save`), and refuses as another history (`LogFork`, "The server showed this device a different history. Nothing was changed.") an entry that does not continue its place, a log that does not pass through an entry it saw, an entry whose writer says it saw another entry at a number the device knows (the change set's `seen`), and a snapshot that leaves out entries it saw (a device counter below the one it had). A gap in the entries after its place (`BelowFloor`), or a copy stopped with `CopyAhead` or `FilingInterrupted`, makes the copy again from the newest trusted snapshot in a second database, with the walk passing the remembered public entry and checkpoint, the waiting edits run again, and the log read on through the old place (`apps/worker/src/local/rebuild.ts`; `test/sealed-rebuild.test.ts`). Bank runs and missed days' scans are filed in one order by time (`LogSession.catchUp`; `test/sealed-catch-up.test.ts`), and the bank log travels in bank entries and snapshots (D-103).

Adding a device with its own passkey, in the app and the Directory (Nov 13, 2026; 10): Settings → Sign-in and devices → Add a device on a locked budget asks the passkey once for the budget key, starts an add on the server, and shows the device link; the new device signs in with the link and its own passkey, which is no way in yet, so it shows "Open your budget on this device" (with "Type your recovery key instead"). Each side is the object of `device-add.ts`, and their messages go through the Directory's relay (`apps/worker/src/routes/device-add.ts`, directory migration 0010_device_add): one add per user for 10 minutes, started after a passkey check under 15 minutes old, joined by one other sign-in of the same user made after the start, each message written once and in order, at most 3 offers, and the row deleted when either device ends it. The relay holds the commitment, the offer, the reveal, the sealed key and the confirmation, never a secret. Both devices show the six digits; after They match on the signed-in device the key is sealed to the new one; after They match there too, the new device checks the offer against the public chain and the entry at the offer's head in the log the server gives, opens the key, joins from a snapshot, adds its own passkey's way in with a slot change (step 4: only it holds that passkey's secret), and then sends the confirmation. The signed-in device says the device is added when the confirmation verifies and a new passkey's way in is in the log.

The server's side of the log (Nov 13, 2026; 7.2, 8; D-104): a write is checked against the state it read and stored in one transaction that first checks the log still ends at the write's base, so two writes checked against one state can't both be stored (a test holds one at its storing step while another is stored). Each device's counter is a row of its own (`store_note`, `device:<id>`), read only for the devices of a write, and the server checks the 4,096-device limit itself; the list of public entries is not kept, since the server never reads it. A state stored as one value before then is read as it is and moved to rows at its next write. Entries are stored as BLOBs (rows stored as base64 stay readable). The never-held kinds are counted per budget per day in a note the delete rule doesn't touch, and no entry is deleted while a snapshot row names it. A whole append of 16 entries of 64 KB measured 10.5 ms (median, Node), down from 30.7 ms (`docs/measurements.md`). A first bank run larger than 16 parts is to be compressed before it is sealed; that is not built (D-104).

Requests signed with the budget's key (Nov 13, 2026; 11): for a locked budget, a link token (to add or to repair a bank), a new bank's link finish, removing a bank, Delete account, Delete the readable copy and the recovery key's sign-in half each need the signature, checked by the store (`apps/worker/src/http/signed-request.ts`, `seal/sealed-routes.ts`, `seal/cutover-routes.ts`) or the Directory (`routes/people.ts`, `routes/recovery-key.ts`). The app signs in its engine (`sealedSign`; `apps/web/src/api/client.ts`, `copy.ts signedHeaders`). Tests: each request refused unsigned, under another key, for another request, over another body, with another session's challenge and with a challenge used once already (`test/sealed-link.test.ts`, `test/purge-route.test.ts`, `test/objects/recovery-key.test.ts`, `test/signup/people.test.ts`); the move's own request in a browser (`e2e/tests/move.spec.ts`).

Notices on every device (Nov 13, 2026; `docs/privacy.md` 5.8): a device that opens a locked budget reads the public entries by the log's rules and shows a notice for a way in that another device added (a slot change), a change another device planned (an intent), and a recovery-key sign-in (the Directory notes the time, `app_state`; `GET /api/session` gives it for 14 days); a planned change that is due shows on every device with Finish now (`apps/web/src/copy/notices.ts`, `screens/SealedNotices.tsx`). Each device dismisses a notice for itself, in its own storage; the server keeps no dismissal. A device knows its own entries by every writer id it has had (a copy made again is a new writer).

Each part's code got an adversarial review of its own before it merged. The review of the cutover (Nov 12, 2026) found 4 major faults, three shown with tests, all fixed: the freeze was written by one clock and read by another; a write that left the budget's version alone passed as "nothing changed" (the freeze now notes the change log's number and the size of every table without one); the moved keys could not be brought level with the server, which also replaces and deletes them (they are read whole each time); any signed-in person could move their budget once the switch was on, and the way back hung on the same switch (the switch names one budget, and the way back needs none). The server now also compares the phone's table hashes itself. The review of snapshots in the Worker and on a device (Nov 12, 2026) found 1 critical and 6 major faults, three shown with tests, all fixed: a check could be built on a snapshot that was never checked, or that a check had refused, after which the server deleted the true history (a check is now built only on a snapshot with a check record the device verified itself, the record's request names that base, and the server keeps exactly it); a later snapshot at the same entry could displace a checked one; a device took the server's word that a snapshot was checked; a device sent to a snapshot did not compare it with its own place and checkpoint; a device that started at a multiple of 1,000 could never write a snapshot; a new column made every stored snapshot unopenable (a snapshot now lists its writer's columns); a snapshot could be written while the copy moved. Smaller fixes: a check reads and opens every chunk of its target; a check record counts only under the key in force; the manifest must be the one the header names; a snapshot has at most 256 chunks and the delete rule removes few large rows a call; a failed open leaves the copy empty. The review of a device filing sealed runs and of the fetch job (Nov 12, 2026) found 1 critical and 4 major faults, the critical one shown with two tests, all fixed: a run filed a second time (after its entry lost to another device's, or was refused) filed nothing and was still noted as filed, so its bank rows were lost on every device (the run's leftovers now go first, and a run is noted as filed only when every record the Worker counted is in the bank log); a filing that failed left the link locked for ever; a fetch job went on working on another link's run after its own was replaced (each step now acts only on the run its job began); filed runs that could not be taken out of a copy were dropped from the queue and stayed in the copy; a copy closed in the middle of a filing had no way out (both now stop with an error that says the copy must be made again). The review of the bank runs in the Worker (Nov 12, 2026) found 3 major faults, each shown with a test, all fixed: the run being fetched had no stamp, so a database writer could drop a page, move the cursor or change the counts and still get the Worker's signature (it now has one, with a running hash of its pages); a step that answered late, after its run was given up, wrote its page into the next link's run (every step now goes on only from the exact stage it read); the log's state put back to before a key change sent a run to the replaced inbox key (a run now never uses an older inbox version than the last signed run). Smaller fixes: a completed run and a stored log write each check that the other did not move meanwhile; a run left alone for 90 minutes, or with a bad stamp, makes way; a restart for a key change does not count against the bank's limit; a key the log takes replaces whatever row was there; the bank token is opened inside the step from the stamped link. The review of the server's rules and of the chain from a snapshot found 2 critical and 4 major faults, each with a working attack, all fixed: a fresh way in could lock out every other way in at once, by a key change that kept the slot ids and put noise in their records, so every key change from a fresh way in now waits; a key change that named too low a last run ended bank filing and every edit for good, and too high a one ended key changes after 15, so it must name the last complete run; a schema version from the future was stored and stopped every device; the kinds the breaker never holds back were a way around every limit; a full write cost far more than 10 ms; a snapshot's position was a writer's copy that nobody checked, so a device now takes it from the log's own entry. A separate test of 12 random logs, resumed at 430 places with 8,058 real and changed next entries, found no place where the two chains disagree. The review of adding a device and signed requests found no wrong byte and 4 major faults in the order of steps, each shown with a working attack and all fixed: the new device answered a second offer, so a server could pick the code; the signed-in device made an offer without a commitment; nothing counted offers; the new device got the key before it checked the offer against the log. Each side is now an object that allows each step once, in order. Smaller fixes: small-order signing keys are refused; a check of a signed request never fails on a wrong type. The review of the move itself (Settings → Privacy, the stepped freeze, the sealed budget's bank routes) found 2 critical and 4 major faults, all fixed: the first entry, dated when the keys are made, was refused as more than 5 minutes old once the person had written the recovery key down, so the cutover takes it up to an hour old (and the app starts again after 50 minutes); a lost answer to the seal could show a second, useless recovery key, so the server refuses to offer the move for a sealed budget and the app asks the server before it makes a key; each freeze step counted whole tables against the day's read allowance, so the steps in between compare only what is read from the end of an index; a move that stopped left an emptied copy, so the app asks the server where it stands, ends a freeze or takes the way back, deletes the copy and starts again; the way back taken on the server with the app closed before the device forgot it stranded the device, so the device forgets first and deletes a copy of a sealed budget the server no longer holds as sealed; the passkey check could run out in the middle, so the steps after the freeze need none and the move itself needs one under 2 minutes old. Also: a freeze is ended at once after a failure; the clock skew is bounded; the Privacy screen and the move card hold a sealed budget as sealed with no signal; a key in hand is given up when the screen closes. The review of the app's sealed start (`apps/web/src/copy/copy.ts`, `sealed-session.ts`) found 1 critical and 4 major faults, all fixed: a server that answered for a sealed budget as if it were not made the app send the budget's changes in the clear, so a device now remembers each budget it knew as sealed (outside the copy too), refuses such an answer, and the engine refuses the old sync and the old queue for a copy that has a place in the log; a sealed open is saved at once, so the next start does not join again as a new writer; a copy open as a plain budget when the budget is sealed starts again from the log; the sign-in's secrets are kept for a second try; the session the screens read is made from the copy before the copy says it is ready. Also: the last public entry seen is kept outside the copy too; held keys that are too old are never made fresh; no build setting can replace the Worker's run keys the app accepts. The review of snapshots, the Worker's keys and bank runs found 1 critical and 5 major faults, all fixed: after two key changes a run could be accepted under the first inbox key, so each replaced inbox version now has its own last run; a run that a key change overtook is started again and not signed; a snapshot must sit on the public chain the device walked, before the next public entry; a run's time must be later than the run before; a stamp check on a bad stored value answers "bad" and does not fail; a page's receipt bytes come from the Worker's key and the page's place, so the Worker holds no state between steps. The review of the entries and the chain found no wrong byte and 8 major faults in the rules, all fixed: an entry's hashes are worked out again and not trusted; the rules are one piece of code for the server and the device, so no honest entry can stop the log; an intent is judged when it is used; an inbox key with unfiled runs can't be dropped; an entry can't be dated in the checker's future; only a scan moves the scan date. The review of the first two parts found no wrong byte (it recomputed every label, layout and pinned value with a separate program) and 19 faults in checks and care with secrets, all fixed: a budget key sealed or wrapped is first checked to be the key its keys came from; a one-time key pair seals once; a slot id and base64url have one spelling; a byte-order mark is not dropped from a text field.
