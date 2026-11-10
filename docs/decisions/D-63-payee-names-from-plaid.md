# D-63: Payees from Plaid's values, no cleanup of bank text (Nov 5, 2026)

**Decided by the owner** (`docs/payee-names.md`, approved v7, answers in its section 13). PR 2 of its section 11.

**Context.** `docs/design.md` (Payee normalization and merge) made payees from the bank text: strip processor
prefixes, store numbers, dates and city, then title case, and join look-alikes. On Nov 1 Plaid sent one card's history
before its merchant names were ready, so sync made "Stm Streamplus Streamco" and "Streamco" from the text. The rows came again
on Nov 2 with merchant name "Streamco", but a filed row was never named or filed again, and a merge then kept the app's
name.

**Decision.**

1. A bank row's keys are Plaid's merchant id, `merchant_name` and Plaid's `name` (the bank text only when neither name
   is there), compared only by `payeeNameKey`. The first key a payee has decides; otherwise sync makes a payee named
   `merchant_name`, else Plaid's `name`, else the bank text exactly, and gives it every key no payee has yet. A filed
   row never moves; sync never joins two payees.
2. While a payee is new (`named_by = 'sync'`, none of its transactions categorized by you), its name follows its
   earliest transaction as Plaid sends it again, never into another payee's name. A rename, a join or a category
   fixes it.
3. A rename or join gives the payee the key `n:<its new name>`; Undo of a join moves keys and `named_by` back.
4. A one-time job files every existing transaction again by these rules, in date order (`src/sync/refile-payees.ts`).
   A payee keeps its name only if an audit row shows you chose it. An Undo of a join made before the job is refused.
5. Old cleaned-text (`d:`) aliases are read as a last fallback and no longer written, until PR 4 deletes them.

**Money effect: none.** Only which payee a transaction shows, and payee names, change. Categories, memos, owed marks,
splits and amounts are never touched; every transaction counts as before.
