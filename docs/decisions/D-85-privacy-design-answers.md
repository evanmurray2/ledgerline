# D-85: The owner's answers on the privacy design (Nov 10, 2026)

**Decided by the owner** (chat, Nov 10, 2026), in answer to the questions in `docs/privacy.md` section 14. Nothing in
that design is built yet; these answers shape it, and each takes effect when its part is built.

**Decision.**

1. **No reset.** "Lose the passkeys and the recovery key, lose the budget" is accepted, for the product and for the
   owner's own budget ("Yeah"). The owner gets a recovery key too, which changes "not for admins"
   (`docs/open-signup.md` 4).
2. **D-78 is lifted for this design** ("Start now"). The parts that exist only for other people (delete account with
   banks, the optional name, Turnstile on its own page) no longer wait for Plaid Production. Open sign-up itself still
   needs a bank source other people can use.
3. **Abandoned and idle accounts are removed** ("We should find a way to remove inactive or abandoned accounts";
   idle deletion: "Yes"). The design uses 24 months without an open, and exempts the owner's account. This replaces
   "nothing is deleted for being idle" (`docs/open-signup.md` 1 and 9) when built.
4. **No restore** ("Let's remove the restore in the app feature and run book in this design. I won't use it."). A
   sealed budget has no restore in the app and no restore runbook; D-77's restore and undo are retired at the
   cutover. Until then the runbook stays as it is.
5. **The owner reviews changes to the key code and the shipping path before they merge** ("Yea sure"). It starts when
   that code exists, with a change to `CLAUDE.md` then.
6. **The address will change later, not soon.** The design must keep passkeys working across that move.
7. **Replacing the 7 bank tokens is tabled** until it is settled whether Plaid stays the bank source.
8. **No spending is agreed.** The $0 rule stands; the audit, a lawyer and paid plans stay out.
9. **Plaid stays the bank source** ("Let's stick with plaid"). No other source is tried.

10. **Background fetch with sealing** (the design's shape B): the server keeps each bank key, fetches in the
    background as today, and seals each page at once ("Sure background sealing is fine for now"). Arrival times
    stay the server's, so D-67 and D-68 are unchanged. The device's bank code is built so a later switch to the
    relay shape stays possible.
11. **Raw Plaid pages are no longer kept** once the design is built ("Yes stop keeping them"). The bank log stays.
12. **The owner's own data comes out of the public docs** ("yes clean up docs"): purchases, bank names, the
    Cloudflare account id. The git history keeps the old text.

13. **Sign-up never asks for a name or an email** ("Sign up should never ask for name or email"). Today it requires
    a name; the field goes when this is built.

**Money effect.** None. No Money rule changes with these answers. Shape A in the design would change what "arrived"
means for D-67 and D-68; it is not chosen.
