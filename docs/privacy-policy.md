# Privacy policy (draft)

Status: a draft for the owner to read, Nov 12, 2026. The app shows it at `/privacy-policy` (Sign in, Create
account and Settings link to it), read from this file: the app drops these notes, everything above the `---` line,
and the **(owner reads)** marks, and leaves out any paragraph marked **(later)**. It describes a **locked**
budget, as the owner's has been since Nov 12, 2026 (`docs/privacy.md` section 8); sign-up is closed, so every
budget is locked. It says what is true **today**, as `docs/claims.md` does, and it changes in
the same pull request as each phase of `docs/privacy.md` that changes who can read what. The facts come from
`docs/privacy.md` sections 2, 4.3 and 15.4 and from the code named in `docs/claims.md`. Nothing here is legal
advice; a lawyer has not read it.

Lines marked **(later)** are not true yet; none are left. Three went on Nov 12, 2026, because the move made them
true. On Nov 13, 2026 the rest went: two that are now built became **(owner reads)** lines (the 90-day and 24-month
rules, and signing in with the recovery key), and three that are not built were dropped (a notice before each idle
rule, removing banks at Plaid when you delete, a notice when this policy changes).

Lines marked **(owner reads)** changed on Nov 12 or 13, 2026 and need the owner's reading before other people
are invited (sign-up is closed, so only the owner sees the page now).

---

Last changed: November 13, 2026.

## The short version

- Ledgerline is a budgeting app. It keeps your budget so that you can use it on your devices.
- **(owner reads)** Your budget is locked on your own devices with a key that Ledgerline's server never has. The
  server stores it only in locked form.
- **(owner reads)** The readable copy from before your budget was locked is deleted from the server. Cloudflare's
  past versions keep it 30 days more (see "How long things are kept").
- Ledgerline has no ads and no trackers. It sells nothing and shares nothing, except with the two companies
  named below, which it needs in order to work.
- You do not give a name or an email address to sign up.

## What Ledgerline stores

| What                                                                | Where                                 | Who can read it                                  |
| ------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------ |
| **(owner reads)** Your budget: every change you make, and snapshots | Ledgerline's server, locked           | Only your devices                                |
| **(owner reads)** What your banks send through Plaid                | Ledgerline's server, locked at once   | Only your devices                                |
| **(owner reads)** The copy of your budget from before it was locked | Ledgerline's server, readable         | Whoever runs Ledgerline, until it is deleted     |
| The key to each bank link                                           | Ledgerline's server, locked           | The server, which uses it to fetch               |
| A copy of your budget on each device you use                        | That device, locked with your passkey | You                                              |
| Your passkeys' and devices' names, and when each last signed in     | Ledgerline's server                   | Whoever runs Ledgerline                          |
| **(owner reads)** Facts about your locked budget, listed below      | Ledgerline's server                   | Whoever runs Ledgerline                          |
| A log of each request                                               | Cloudflare                            | Whoever runs Ledgerline                          |
| The past 30 days of what the server holds                           | Cloudflare                            | Whoever runs Ledgerline, in the form it was then |

- **(owner reads)** **What the server can see about a locked budget:** that your account exists and when you use
  it; the size and time of each change, and how many there are; for each bank link, Plaid's id for it, when it was
  linked, whether it needs you to sign in again, when each bank update came, how many rows it brought, and its
  size. It can't see amounts, payees, categories, memos or the names of your accounts, or the budget's name.
  Plaid shows whoever runs Ledgerline which bank each link is with.
- **(owner reads)** **How you use the app:** while "Record how I use the app" is on, the app sends taps and timings.
  For a locked budget the server keeps none of it. What it kept before the lock was deleted with the readable copy.
- **The log of each request** holds the request's address, your IP address, a rough location for it, and your
  browser. It is kept 3 days. The sign-in cookie is not kept in it.

Ledgerline does not store your bank password, your name, or your email address. One exception: the first account,
the owner's, has an email address from before sign-up stopped asking for one.

## Who else handles your data

- **Cloudflare** runs the server and stores the data. It can reach what the server holds. **(owner reads)** For a
  locked budget, that is locked data and the facts above. Your bank data passes through the server in readable
  form for a moment, before it is locked, so Cloudflare could see it there.
- **Plaid** connects to your banks. You sign in to your bank on Plaid's own site; Ledgerline never gets your bank
  password. Plaid fetches your transactions and keeps them under its own policy, which is separate from this one.
  Plaid may ask you for a phone number. That is between you and Plaid. **(owner reads)** Ledgerline's server asks
  Plaid for your bank updates, in the background, with the key to your bank link. It locks each update for your
  devices as it arrives. This means Ledgerline could ask Plaid for your bank data again.
- Nobody else. The app loads no outside code.

## What Ledgerline does not do

- No ads, and no trackers.
- It does not sell or share your data.
- **(owner reads)** It can't read your locked budget. Until the copy from before the lock is deleted, whoever runs
  Ledgerline could read that copy, and looks at it only to fix a fault.
- It does not send you email. A notice inside the app is the only way Ledgerline can reach you.

## How long things are kept

- Your budget: until you delete your account.
- **(owner reads)** The readable copy from before the lock: deleted on the day of the release that dropped it
  (November 2026). Cloudflare's past versions keep it 30 days more.
- Request logs: 3 days.
- Past versions of what the server holds: 30 days.

**(owner reads)** When nobody opens a budget for 90 days, Ledgerline stops fetching from its banks. It starts again
when you next open the app. When nobody opens an account for 24 months, it is marked, and 30 days later it is
deleted, as Delete account does. Opening the app before then clears the mark. The owner's account is never deleted
this way.

## Deleting your account

Delete account, in Settings → Sign-in and devices, deletes your budget and everything in it. It can't be brought
back. Two limits today:

- An account with a linked bank can't be deleted yet, because Ledgerline can't yet remove a bank at Plaid.
- For up to 30 days after you delete, Cloudflare's past versions may still hold the budget. Whether a deleted
  store stays there has not been checked yet (`docs/privacy.md` 15.4). **(owner reads)** What is locked there opens
  only with your own keys.

To remove what Plaid holds about you, ask Plaid: https://my.plaid.com

## If you lose every way in

**(owner reads)** There is no reset. Ledgerline's server can't open or restore a locked budget, because it never
has the key. Your passkeys and your recovery key open it. If you lose all of them, nobody can open your budget:
not you, and not whoever runs Ledgerline. Keep the recovery key somewhere safe.

**(owner reads)** A recovery code that you made in Settings still gets you signed in, but it doesn't open a locked
budget. A passkey added that way opens it only after one of your devices lets it in.

**(owner reads)** Your recovery key also signs you in, with no passkey: Sign in → Use your recovery key.

## If a court asks

**(owner reads)** Whoever runs Ledgerline could be made to hand over what the server holds: your budget in locked
form, with no key, and the facts listed in "What Ledgerline stores". For 30 days after it was deleted, Cloudflare's
past versions also hold the readable copy from before the lock. Ledgerline could also be made to fetch new bank data
from Plaid, or to send your browser changed code.

## Changes to this policy

The date at the top says when this policy last changed.

## Contact

Not set yet. A security contact and a way to ask questions come before other people are invited
(`docs/privacy.md` 11).
