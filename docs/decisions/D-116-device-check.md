# D-116: Each device checks its numbers against the other devices' (Nov 13, 2026)

**Before.** Every device works out the budget by itself from the same sealed log (D-102). `apps/worker/test/engine.test.ts`
and `engine-upgrade.test.ts` check the causes we know of, but a fault nobody has found yet (a copy that rebuilt only
part of what changed, an older release's derive, a row a device wrote that no entry holds) would make two devices
show different numbers, and nothing would say so. The build plan held it as an open item; the owner said yes on
Nov 13, 2026.

**Decision.**

1. **What a device hashes.** After a round with the log that leaves its copy settled at entry N (no edit of its own
   waits, no bank run waits to be filed), at most every 5 minutes and once per entry, the device writes out what its
   screens show for the current month, as the budget's own routes answer them: Ready to Assign; each category's
   assigned, activity and available (archived ones too); each card's payment category (available, owed); each
   account's bank, pending and working balance. One line per number, sorted, with no names, so the order of rows
   and a renamed category change nothing (`apps/worker/src/local/device-check.ts screenText`). It skips a month
   whose Ready to Assign is still being worked out. A new day comes with the day's scan entry, so a new month always
   brings a new N.
2. **What it sends.** `HMAC(K_check_v, "ledgerline/v1/device-check/record" || budgetId || deviceId || N || month ||
v || SHA-256(text))`, where `K_check_v = HKDF(BK_v, salt_v, "ledgerline/v1/device-check", 32)`, a new key
   beside the log, snapshot, wrap and sign keys (`packages/seal device-check.ts`; `docs/privacy-keys.md` 2). It
   sends `{deviceId, N, month, mac}` to `POST /api/log/check` and keeps its own last 8 hashes with its copy
   (`local_state`, `note:device_check`).
3. **What the server keeps.** One row per device in `store_note`, so no migration: the key holds the whole record
   (`check:<deviceId>:<month>:<N>:<mac>`), the value when it came. A device's new record replaces its old one;
   records older than 30 days go, and at most 16 are kept. It refuses one while the budget rests, one past the end
   of the log, and a second one from a device within a minute. `GET /api/log` hands every record back with each
   page of entries, so no request is added to read them (`apps/worker/src/seal/device-checks.ts`).
4. **How a device compares.** For another device's record at an N and month it kept, a device makes the HMAC from
   its own hash under the other device's id and compares. The device id is in the HMAC, so the server can't pass
   one device's record off as another's, and two devices' records never look alike to it. A different one is kept
   with the copy and shown until a later check with that device agrees. Records from ids this device wrote the
   log as before (a copy made again on the same device) are not another device.
5. **What the person sees.** Budget → Needs attention shows "Your devices show different numbers", "Another device
   got other numbers for {month}. Rebuild the budget on this device to check again.", with **Rebuild**, which makes
   this device's copy again from the newest checked snapshot (the rebuild the engine already runs when its entries
   are gone), keeping its waiting edits. It counts in the Needs attention chip and the Budget tab's badge. Each of
   the two devices shows it: neither can tell which one is wrong.

**Why the device id is in the HMAC.** Without it, two devices with the same numbers would send the same value, and
the server would learn when two devices agree. With it, every record is different, and only a holder of the budget
key can tell whether two agree.

**Why no name.** The log knows a device by its writer id, not by the name Settings → Sign-in shows. Sending the
name, even sealed, would add a field for little: most people have two devices.

**What it costs.** On the device: the Budget and Accounts screens worked out once, at most every 5 minutes and only
after the log moved. On the server: a range read of at most 16 rows of `store_note` with each page of the log, and
one small write per device at most every 5 minutes (refused under a minute apart), with no new table.

**What it never does.** It never changes how money is counted, never writes the budget's tables, and never blocks
an edit: a check that fails is dropped, and the next round tries again. Derived keys held from a release before this
one have no check key; such a device makes no check until the passkey opens the budget again.

**What the server learns.** For each device that checks: when, at which entry, and for which month, with a 32-byte
value it can't read or make (`docs/privacy.md` 4.3, `docs/claims.md`).
