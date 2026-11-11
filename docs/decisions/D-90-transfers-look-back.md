# D-90: Transfer matching looks back at rows with no partner (Nov 11, 2026)

**Decided by the owner** (chat, Nov 11, 2026: "Yes on both", to the three details below and to keeping
Cloudflare's request logs for now). It settles what D-86 item 2 left open. Nothing is built yet; it takes effect
when bank updates are filed one at a time (`docs/privacy.md` 14.2, A2).

**Context.** Today the two sides of a transfer pair by themselves only when they are filed in the same batch
(`packages/domain/src/transfers.ts`, `apps/worker/src/sync/file-fresh.ts`). A checking side that arrives on
Monday and a card side that arrives on Tuesday stay unsorted. D-86 chose that a new row also looks at earlier rows
with no partner, and left the exact rule to this decision.

**Decision.**

1. **How far back:** the two rows' dates are at most 5 days apart, as today. When each row arrived does not matter.
2. **Two or more possible partners:** nothing is paired and the person is asked, as today. A possible partner is
   a row in the new update, or an earlier row that has no partner and that the person has not sorted by hand.
3. **A pair that Ledgerline made stays.** A second possible partner that arrives later does not break it; the
   person is asked about the later row.

The rest of today's rule is unchanged: only an outflow that the bank marks as a transfer or a payment starts a
pair; the amounts are equal and opposite; the accounts differ; the inflow could belong to only that outflow.

**What the person can still do.** Unpair, as today. Rows the person unpaired or sorted by hand are never paired
again by Ledgerline.

**Money effect.** No amount and no balance changes. More transfers between two accounts pair by themselves, and a
card payment that pairs is in its payment category without being sorted by hand. A row that was shown as
unsorted on Monday can become paired on Tuesday, when its partner arrives.

**Also decided here.** Cloudflare's invocation logs stay on for now (`docs/privacy.md` 15.4 says what they
hold). They are turned off before any claim about IP addresses, and before other people are invited.
