# D-60: No rules; categories are suggested, then OK'd (Nov 4, 2026)

**Decided by the owner.** The owner has never used rules (Settings → Rules showed 0 on Nov 4) and wants every
category to come from their own tap. Design and review: `docs/payees.md`.

**Decision**

- Rules are gone: the Rules screen and editor, the Settings row, the "Always" offer, the rules routes and the
  rules export, sync's rule step, and the rules engine in `packages/domain`. Old `/settings/rules` links open
  Settings.
- Sync finds the payee, pairs transfers and holds person-to-person money in Waiting to match as before, and sets
  no category.
- Needs category suggests the category you've used most for the payee, and you OK it, one row or all the clear
  ones at once (built before this, `docs/payees.md` section 2).
- A category can now be deleted when nothing uses it, whatever rules or payee defaults said; the `rule` table,
  `payee.remember_category` and `payee.default_category_id` stay (migrations are forward-only) and nothing reads
  them. Transactions a rule already categorized keep their category and their "Set by rule" chip.

**Replaces**

- The design's "Categorization rules and payee cleanup" rule list, rule preview, rule-made splits, transfers,
  memos, previous-month counting and paybacks (the rent rule), and the payee's remembered category.
- Money rule 13 (projected fronts) still applies to owed items you mark yourself. No Money rule changes: with no
  rules, nothing that was counted changes.
