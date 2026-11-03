# D-53: Computers keep the saved copy too (Nov 3, 2026)

**Decided by the owner.** Ledgerline on a computer downloaded the whole budget (about 2,300 rows) every time it opened, because computers kept the copy in memory only. That rule came from the design (`docs/phone-budget.md` 13.1: browser extensions on a computer share the page's storage) and was carried into D-45 and D-48 without the owner being asked about computers. The owner wants computers to work like the phone.

- Every device saves the encrypted copy (`keepsCopy()` in `apps/web/src/copy/passkey.ts`), in a browser or the Home Screen app, when its passkey gives the PRF output. Reopening downloads only what changed. Without PRF it stays in memory only, as before.
- The copy is encrypted the same way (passkey PRF and the server's share), locks after 10 idle minutes, and is listed under Settings → Sign-in while locked, so signing the computer out from another device deletes it (D-52).
- Accepted: an extension that can read the page could read the encrypted copy's storage. It can't decrypt it without the passkey, and an extension that can read the page could already read the budget while it's open.
