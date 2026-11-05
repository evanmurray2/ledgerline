# D-66: The bank difference is a quiet line, not a badge (Nov 5, 2026)

**Decided by the owner** (chat, Nov 5, 2026). Changes the "drift badge" in `docs/design.md` (Will cleared balances
always match the bank?).

**Context.** The balance on Accounts is the bank's figure from Plaid, so it matches the bank. The posted rows come
from a separate Plaid feed, so starting balance plus posted rows can differ from it: a missed or doubled row, a bank
that counted pending in the balance at link, or the balance updating before the row arrives. The server worked out
this difference (`drift` on each Accounts row) but no screen showed it. Most differences are timing and clear within
a day or two, so a loud badge would raise false alarms.

**Decision.** When `drift` isn't zero, Accounts shows a muted line under the balance ("$40.00 off from bank") and the
account's page says by how much the transactions differ from the bank balance. No red, no alert, no direction. If the
line shows up too often from timing alone, a later change can show it only after it lasts 2 days or more.

**Money effect.** None: it only shows a number the server already worked out.
