# Copy

How the app's words are written. `docs/design-system.md` covers how things look; this page covers what they say.
Check a new text against it, and keep the terms below the same everywhere: code, server messages, tests.

## Rules

1. **Short.** One idea per sentence, at most about 15 words. Two sentences at most on screen; anything longer goes
   behind `Why?` (`components/Why.tsx`), or is cut.
2. **Say it once.** A screen states a fact in one place. No helper line that repeats a title, a banner or a
   confirm. A confirm says only what will happen.
3. **Plain words.** No internal or technical words on screen: no codes, field names, HTTP or JSON, "database",
   "rows", "session", "UTC", "Worker", "secret", "Plaid Link", "fronted", "sinking funds", "settling". Use the
   reader's words: "device", not "phone", unless it is only about a phone.
4. **Active, direct, no "we".** The app is "Ledgerline" or not named. Tell the reader what to do: "Sign in again",
   not "A sign-in is required".
5. **Buttons are verbs.** A button says what it does. Never put a reason on a button ("Nothing selected"); a
   disabled button shows its reason in its `why` line.
6. **Numbers read right.** Singular and plural (`1 category`, `2 categories`), no sentence about `$0.00`, no signed
   amount in a title. A money confirmation shows cents, not whole dollars.
7. **Errors say what to do.** Every error is a full sentence the reader can act on. The server never sends a bare
   noun or field name: a missing thing is `This was changed or removed. Check it and try again.` (the app syncs at once, so the screen shows what is there now). The client shows
   `errorMessage()` (`api/client.ts`), never a raw browser or validation message.
8. **Punctuation.** Full sentences end with a period; titles, labels, chips and buttons don't. No semicolons; use
   two sentences.

## Terms

| Say                                              | Not                                           |
| ------------------------------------------------ | --------------------------------------------- |
| bank link (the 10 Plaid links)                   | login, bank login                             |
| {Bank} needs you to sign in again                | asked you to sign in, needs repair            |
| Card payments (the group)                        | Credit card payments                          |
| Low (status)                                     | Running low                                   |
| Owed to you                                      | fronted, not a category                       |
| Needs a category                                 | Choose later, Don't set a category            |
| Memo                                             | Note (on a transaction)                       |
| Pending (a bank row not posted yet)              | Card hold, hold                               |
| Added by you · bank has it (entry paired)        | Matched, linked (for this pairing)            |
| join (payees)                                    | merge                                         |
| Up to date                                       | Already up to date                            |
| passkey                                          | Face ID (except on the Face ID button itself) |
| recovery code                                    | backup code, reset code                       |
| recovery key (opens a locked budget)             | backup key, master key, seed                  |
| locked (a budget only your devices can read)     | sealed, encrypted, end-to-end                 |
| View only until {time} (daily limit for changes) | paused, turned off, database limit            |
| Paused until {time} (daily limit for loading)    | resting, reading is paused                    |
| You're offline                                   | No signal, Network request failed             |
| Something went wrong. Try again.                 | any other wording of it                       |
| Couldn't save that. Try again.                   | Couldn't save that.                           |
| This changed. Check it and try again.            | Pull to refresh, Your budget changed          |
