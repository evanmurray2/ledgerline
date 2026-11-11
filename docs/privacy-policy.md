# Privacy policy (draft)

Status: a draft for the owner to read, Nov 11, 2026. It is not shown in the app yet. It says what is true **today**,
as Settings → Privacy does, and it changes in the same pull request as each phase of `docs/privacy.md` that changes
who can read what. The facts come from `docs/privacy.md` sections 2 and 15.4. Nothing here is legal advice; a
lawyer has not read it.

Lines marked **(later)** are not true yet. They show what the text becomes when the privacy design is done, so the
two can be compared. They are removed before the policy is shown to anyone.

---

## The short version

- Ledgerline is a budgeting app. It keeps your budget so that you can use it on your devices.
- **Today, whoever runs Ledgerline can read your budget.** It is stored on Ledgerline's server in readable form.
- Ledgerline has no ads and no trackers. It sells nothing and shares nothing, except with the two companies
  named below, which it needs in order to work.
- You do not give a name or an email address to sign up.

**(later)** Your budget is locked on your own devices with a key that the server never has. Whoever runs
Ledgerline can't read it.

## What Ledgerline stores

| What                                                             | Where                                 | Who can read it                                    |
| ---------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------- |
| Your budget: transactions, payees, amounts, categories, notes    | Ledgerline's server                   | Whoever runs Ledgerline; Cloudflare, which runs it |
| What your banks send through Plaid, as it arrived                | Ledgerline's server                   | The same                                           |
| The key to each bank link                                        | Ledgerline's server, locked           | The server, which uses it to fetch                 |
| A copy of your budget on each device you use                     | That device, locked with your passkey | You                                                |
| Your passkeys' and devices' names, and when each last signed in  | Ledgerline's server                   | Whoever runs Ledgerline                            |
| How you use the app: taps and timings, no amounts and no names   | Ledgerline's server                   | Whoever runs Ledgerline                            |
| A log of each request                                            | Cloudflare                            | Whoever runs Ledgerline                            |
| The past 30 days of your budget, so that a mistake can be undone | Cloudflare                            | Whoever runs Ledgerline                            |

- **How you use the app** is recorded only while "Record how I use the app" is on, in Appearance and preferences.
  You can export it.
- **The log of each request** holds the request's address, your IP address, a rough location for it, and your
  browser. It is kept 3 days. The sign-in cookie is not kept in it.

Ledgerline does not store your bank password, your name, or your email address. One exception: the first account,
the owner's, has an email address from before sign-up stopped asking for one.

**(later)** The server stores your budget and your bank data only in locked form. It still knows: that you have an
account, when you use it, how much data you have, which banks you linked (Plaid needs that), and when a bank sent
something. It can't see amounts, payees, categories or notes.

## Who else handles your data

- **Cloudflare** runs the server and stores the data. It can reach what the server holds.
- **Plaid** connects to your banks. You sign in to your bank on Plaid's own site; Ledgerline never gets your bank
  password. Plaid fetches your transactions and keeps them under its own policy, which is separate from this one.
  Plaid may ask you for a phone number. That is between you and Plaid.
- Nobody else. The app loads no outside code.

## What Ledgerline does not do

- No ads, and no trackers.
- It does not sell or share your data.
- It does not read your budget to learn about you. Whoever runs Ledgerline looks at a budget only to fix a fault
  in it.
- It does not send you email. A notice inside the app is the only way Ledgerline can reach you.

## How long things are kept

- Your budget: until you delete your account.
- Request logs: 3 days.
- Past versions of your budget: 30 days.
- Today, nothing is deleted because an account is idle.

**(later)** An account that nobody uses for 90 days stops fetching from its banks. An account that nobody uses for
24 months is deleted. The app shows a notice before each.

## Deleting your account

Delete account, in Settings → Sign-in and devices, deletes your budget and everything in it. It can't be brought back. Two limits
today:

- An account with a linked bank can't be deleted yet, because Ledgerline can't yet remove a bank at Plaid.
- For up to 30 days after you delete, Cloudflare's past versions may still hold the budget. Whether a deleted
  store stays there has not been checked yet (`docs/privacy.md` 15.4).

To remove what Plaid holds about you, ask Plaid: https://my.plaid.com

**(later)** Deleting your account also removes your banks at Plaid.

## If you lose every way in

Today, a recovery code that you made in Settings gets you back in.

**(later)** There is no reset. Your passkeys and your recovery key are the only ways in. If you lose all of them,
nobody can open your budget: not you, and not whoever runs Ledgerline. Keep the recovery key somewhere safe.

## If a court asks

Whoever runs Ledgerline could be made to hand over what the server holds. Today that includes your budget.

**(later)** The server holds your budget only in locked form, with no key. What could be handed over is the list in
"What Ledgerline stores" above. Ledgerline could also be made to fetch new bank data.

## Changes to this policy

The date at the top says when this policy last changed.

**(later)** The app shows a notice when this policy changes.

## Contact

Not set yet. A security contact and a way to ask questions come before other people are invited
(`docs/privacy.md` 11).
