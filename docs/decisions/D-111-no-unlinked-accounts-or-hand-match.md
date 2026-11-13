# D-111: No accounts without a bank link, and no matching by hand (Nov 13, 2026)

**Decided by the owner** (chat, Nov 13, 2026), reading the build plan.

1. **No accounts without a bank link.** The owner does not want them. Every account comes from a bank link, as today.
   The open item that waited for D-78 (starting balances for such accounts) is dropped, not deferred.
2. **No way to match a pending row to a posted row by hand.** The matcher asks "Same purchase?" when it is unsure; the
   owner wants that to stay the only way, as long as it asks correctly. A pending row the matcher pairs wrongly, or
   never asks about, is a matcher bug to fix, not a reason for a hand match.
3. Posted bank rows show in the app (owner, Nov 13): the open item that said they did not was dropped.
