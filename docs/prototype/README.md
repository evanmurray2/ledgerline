# Ledgerline prototype screens

Copied from the clickable prototype artifact ("Ledgerline mobile mockups", page *Prototype (clickable)*): every file under `project/p/` plus `project/canvas.json`.
Board titles below come from `canvas.json`. Phone boards are 390 x 844, desktop boards 1280 x 800.

These are mockups with fake shared state. The app matches their screens, layout, wording, states and themes; it does not reuse their code.
The files load `./support.js` and the artifact type's runtime, which are not part of the design and are not copied, so they do not render on their own.

Canvas notes:

- Dark mode: open Settings (phone or desktop) and pick Light, Dark or Match device. Every screen follows it. Each artboard's Tweaks also has a theme switch to force one screen light or dark.
- Shared sheets show one example item: most categories open the Groceries sheet and most transactions the Uber Eats sheet. The main numbers are live and shared between screens (Budget, Assign, Activity, Match, Owed, Close, badges). Settings › Reset prototype numbers puts them back.


## First run: sign in, budget start, link banks, make categories

| File | Board title | Size |
| --- | --- | --- |
| [`p/Welcome.dc.html`](p/Welcome.dc.html) | Welcome and sign-in | 390 x 844 |
| [`p/StartMonth.dc.html`](p/StartMonth.dc.html) | 1 · Budget start | 390 x 844 |
| [`p/LinkBanks.dc.html`](p/LinkBanks.dc.html) | 2 · Link banks | 390 x 844 |
| [`p/FirstSort.dc.html`](p/FirstSort.dc.html) | 3 · Make your categories | 390 x 844 |

## Budget: assign, move, targets, owed to you

| File | Board title | Size |
| --- | --- | --- |
| [`p/Budget.dc.html`](p/Budget.dc.html) | Budget (home) · All / Needs attention filter | 390 x 844 |
| [`p/Category.dc.html`](p/Category.dc.html) | Category sheet | 390 x 844 |
| [`p/Target.dc.html`](p/Target.dc.html) | Edit target | 390 x 844 |
| [`p/Assign.dc.html`](p/Assign.dc.html) | Assign | 390 x 844 |
| [`p/Owed.dc.html`](p/Owed.dc.html) | Owed to you (a list, not a category) | 390 x 844 |
| [`p/Close.dc.html`](p/Close.dc.html) | Close out what's owed | 390 x 844 |

## Activity: categorize, pending, splits, matching, transfers

| File | Board title | Size |
| --- | --- | --- |
| [`p/Activity.dc.html`](p/Activity.dc.html) | Activity · All / Needs attention / Not posted yet | 390 x 844 |
| [`p/Txn.dc.html`](p/Txn.dc.html) | Transaction sheet | 390 x 844 |
| [`p/Split.dc.html`](p/Split.dc.html) | Split | 390 x 844 |
| [`p/Match.dc.html`](p/Match.dc.html) | Match money back | 390 x 844 |
| [`p/Transfer.dc.html`](p/Transfer.dc.html) | Transfer: pick the other side (only when unclear) | 390 x 844 |
| [`p/AddPending.dc.html`](p/AddPending.dc.html) | Add pending or upcoming | 390 x 844 |
| [`p/CheckPending.dc.html`](p/CheckPending.dc.html) | Check not cleared: keep waiting, fix, match, delete | 390 x 844 |

## Accounts and Reports

| File | Board title | Size |
| --- | --- | --- |
| [`p/Accounts.dc.html`](p/Accounts.dc.html) | Accounts | 390 x 844 |
| [`p/Register.dc.html`](p/Register.dc.html) | Card register · Sapphire | 390 x 844 |
| [`p/RegisterAlly.dc.html`](p/RegisterAlly.dc.html) | Savings register · Ally (RegisterCash, account="ally") | 390 x 844 |
| [`p/Repair.dc.html`](p/Repair.dc.html) | Repair a connection | 390 x 844 |
| [`p/Reports.dc.html`](p/Reports.dc.html) | Reports | 390 x 844 |
| [`p/RegisterFreedom.dc.html`](p/RegisterFreedom.dc.html) | Card register · Freedom (same screen, card="freedom") | 390 x 844 |
| [`p/RegisterMarcus.dc.html`](p/RegisterMarcus.dc.html) | Savings register · Marcus | 390 x 844 |

## Settings

| File | Board title | Size |
| --- | --- | --- |
| [`p/Settings.dc.html`](p/Settings.dc.html) | Settings | 390 x 844 |
| [`p/Categories.dc.html`](p/Categories.dc.html) | Categories and groups | 390 x 844 |
| [`p/Rules.dc.html`](p/Rules.dc.html) | Rules | 390 x 844 |
| [`p/Rule.dc.html`](p/Rule.dc.html) | Edit rule | 390 x 844 |
| [`p/Payees.dc.html`](p/Payees.dc.html) | Payees and merging | 390 x 844 |
| [`p/Connections.dc.html`](p/Connections.dc.html) | Bank connections | 390 x 844 |
| [`p/Data.dc.html`](p/Data.dc.html) | Import and export | 390 x 844 |
| [`p/TabBar.dc.html`](p/TabBar.dc.html) | Tab bar (shared component) | 390 x 72 |

## Transaction variants, editing sheets, feedback note

| File | Board title | Size |
| --- | --- | --- |
| [`p/TxnPosted.dc.html`](p/TxnPosted.dc.html) | Transaction · posted (set by rule) | 390 x 844 |
| [`p/TxnIncome.dc.html`](p/TxnIncome.dc.html) | Transaction · income | 390 x 844 |
| [`p/TxnRefund.dc.html`](p/TxnRefund.dc.html) | Transaction · card refund | 390 x 844 |
| [`p/TxnPaid.dc.html`](p/TxnPaid.dc.html) | Transaction · paid back, with Unlink | 390 x 844 |
| [`p/RegisterCash.dc.html`](p/RegisterCash.dc.html) | Checking register | 390 x 844 |
| [`p/CategoryEdit.dc.html`](p/CategoryEdit.dc.html) | New / edit category | 390 x 844 |
| [`p/RenamePayee.dc.html`](p/RenamePayee.dc.html) | Rename payee | 390 x 844 |
| [`p/Note.dc.html`](p/Note.dc.html) | Feedback note | 390 x 844 |
| [`p/XferPaired.dc.html`](p/XferPaired.dc.html) | Transfer · paired automatically | 390 x 844 |

## States

| File | Board title | Size |
| --- | --- | --- |
| [`p/StateEmpty.dc.html`](p/StateEmpty.dc.html) | First budget (nothing assigned yet) | 390 x 844 |
| [`p/StateLimited.dc.html`](p/StateLimited.dc.html) | Offline / daily limit reached | 390 x 844 |
| [`p/StateSync.dc.html`](p/StateSync.dc.html) | Bank sync failed, retry | 390 x 844 |
| [`p/StateBlocked.dc.html`](p/StateBlocked.dc.html) | Wrong account signed in | 390 x 844 |
| [`p/StateOverAssigned.dc.html`](p/StateOverAssigned.dc.html) | Assigned more than you have | 390 x 844 |
| [`p/StateNewMonth.dc.html`](p/StateNewMonth.dc.html) | New month starts (December) | 390 x 844 |

## Desktop: click through Budget, Activity, Accounts, Reports, Settings

| File | Board title | Size |
| --- | --- | --- |
| [`p/DBudget.dc.html`](p/DBudget.dc.html) | Desktop · Budget | 1280 x 800 |
| [`p/DActivity.dc.html`](p/DActivity.dc.html) | Desktop · Activity | 1280 x 800 |
| [`p/DAccounts.dc.html`](p/DAccounts.dc.html) | Desktop · Accounts | 1280 x 800 |
| [`p/DReports.dc.html`](p/DReports.dc.html) | Desktop · Reports | 1280 x 800 |
| [`p/DSettings.dc.html`](p/DSettings.dc.html) | Desktop · Settings and Appearance | 1280 x 800 |
| [`p/DNav.dc.html`](p/DNav.dc.html) | Desktop sidebar (shared) | 220 x 800 |
