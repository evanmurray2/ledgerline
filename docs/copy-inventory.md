# Ledgerline: every special-case text (after the rewrite)

The texts that show only in special cases, by screen, as of PR #76 (Nov 7, 2026). `{x}` is a value the app fills in.
The rules and terms are in `docs/copy.md`. A snapshot, not kept up to date: the code is the truth.

## What changed

- **About 300 texts rewritten, about 40 deleted.** Most texts went from two or three sentences to one.
- **One word for each idea.** "bank link", "Card payments", "Low", "Owed to you", "Waiting to match", "Needs a
  category", "Memo", "View only until", "Paused until", "This changed. Pull down to refresh."
- **No raw errors.** Every error is a sentence that says what to do. One-word server errors (`month`, `category`)
  and browser text ("Network request failed") are gone.
- **Removed what never worked:** "Match it by hand" on a check, "Not this purchase" on a refund, and repeated warnings
  about bank links (the screen said it three times; now once).
- **Fixed texts that were wrong:** "Either way the money goes to Ready to Assign", the typed-in "9 days", raw screen
  names on the Note sheet, two time zones for the daily reset, "1 categories" and other plurals, "$0.00" sentences,
  whole dollars in money confirmations.

---

## Whole app

**Top bar**

- "You're offline" + "Some changes still work and are sent when you're back online. {n} waiting to send."
- "You're offline" + "Showing what was loaded at {time}. Changes are off." (budget not saved on the device)
- "Paused until {time}" + "Screens show what's saved on this device. Nothing is lost."
- "View only until {time}" + Why: "Today's free limit for changes is used up. Changes and bank sync start again at
  {time}. Nothing is lost."

**Toasts and buttons**

- "1 offline change couldn't be saved." / "{n} offline changes couldn't be saved."
- Undo and other toast buttons are hidden while changes are off.

**Errors (the same everywhere)**

- "You're offline. Connect to the internet and try again."
- "View only until {time}. Try again then."
- "Paused until {time}. Nothing is lost."
- "Sign in again with your passkey."
- "Confirm it's you with your passkey, then try again."
- "This was changed or removed. Pull down to refresh."
- "This changed. Pull down to refresh."
- "Check what you entered, then try again."
- "Something went wrong. Try again."
- "Couldn't save that. Try again."

## Sign-in and passkeys

- "Cancelled. Try again when you're ready." · "This device already has a Ledgerline passkey." · "Couldn't use your
  passkey. Try again."
- "This browser can't use passkeys. Open Ledgerline in Safari, Chrome, Edge or Firefox."
- Set up: "Ledgerline uses a passkey, not a password. Enter your setup code."
- "Sign-in isn't set up yet. Add a setup code, then reload this page."
- "New device? On a signed-in device, go to Settings → Sign-in → Add a device."
- Add a device: "Create a passkey to sign in on this device. The link works once, for 10 minutes." · "This link is
  missing its code. Make a new one in Settings → Sign-in." · "This device is set up"
- "Confirm it's you" + "Use your passkey to continue."
- Server: "That code or link isn't valid or has expired." · "This passkey is already set up. Sign in with it." · "The
  passkey couldn't be verified." · "This passkey isn't registered with Ledgerline." · "This account is turned off." ·
  "Too many tries. Wait a minute and try again." · "You don't have access to this budget."

## Opening the budget

- "Getting your budget ready" + "Downloading your budget…"
- Why it downloads everything (one sentence each, shown under the title):
  - "This browser can't save your budget, so it downloads each time."
  - "Your passkey can't lock a saved budget, so nothing is saved on this device."
  - "This device was signed out from another one, so it downloads again."
  - "The budget saved on this device couldn't be opened, so it downloads again."
  - "The budget saved on this device was empty, so it downloads again."
  - "This device's storage couldn't be read just now. Its saved budget is kept for next time."
  - (A first download shows no reason.)
- "You're offline" + "Your budget is saved on this device. Open it with your passkey to view it and make small
  changes." + "Open with passkey"
- "Couldn't open your budget" + "Try again" (always) + one of:
  - "Use the passkey you set up this device with."
  - "Your budget isn't saved on this device yet. Connect to the internet to open it."
  - "This passkey can't open the budget saved here. Connect to the internet to open it."
  - "The budget saved on this device couldn't be opened. Connect to the internet to download it again."
  - "You've been offline for more than 7 days. Connect to the internet to open Ledgerline."
  - "Your budget didn't finish downloading. Try again."
  - "This device couldn't read its saved budget. Try again."
- "This device was signed out, so its saved budget was deleted."

## Setup

- "Your budget starts in {Month Year}" · "Card balances aren't subtracted. Each card gets a payment category you fund."
- "Link a bank to continue" · "One bank link can bring in several accounts. Removing a link doesn't give it back." ·
  "{used} of {limit} bank links used"
- "Purchases from before your budget starts go into the starting balance." + Why: "Some of them can come in up to 2
  weeks late. Ledgerline gets 6 months of history, and this can't be changed later. You can import older history from
  a CSV file in Settings. Investment and retirement accounts aren't tracked. Money you send to them counts as Invested."
- "Ledgerline also makes a payment category for each card. Money others owe you shows in Owed to you."
- "{n} categories · next, assign your {cash}" (correct plural; the second part only when there is cash) · "Keep or add
  at least one category"
- Server: "Your budget start is already set." · "Pick the month your budget starts first."

## Budget

**Ready to Assign bar:** "All money assigned" · "Updating" · "Take back"

**Banners above the list**

- Past month: "{Month Year} is over. Changes here carry into {Month}."
- Below 0: "You assigned {amount} more than you have" + "Take it back from a category below." (or, when no category
  has enough: "Open a category and move money to Ready to Assign.")
- After a fix: "Took {amount} from {name}." + Undo
- Empty budget: "Give your {rta} a job" (or "Start your budget" at $0) + "Fund card payments first, then bills,
  spending and savings." (no cards: "Fund bills first, then spending and savings.")
- Day 1 of a month: "{Month} has started" + "Every category keeps what it had left in {Month}."
- "Targets for {Month} · {total}" + "Fill targets · {total}" → "Each target got what it needs this month." + Undo
- Sync problem strip: "{bank} didn't finish syncing · see Accounts"

**Rows:** "Low" / "Overspent" / "Underfunded" / "Overfunded" · "Short" (phone and desktop) · "{n} late" (only when
late) · "Goes back to Ready to Assign when paid back" (Owed to you) · "Invested {amount}" · "{n}% used"

- Server details: "overspent on a card" · "this month is funded · …" · "{amount} more than the target needs" · "needs
  {amount} more" · "· {amount} needs a category" · "…% of the month gone"
- Footer: "Transactions show up in Activity after each bank sync." / "Bars show how much of this month's money is left."

**Needs attention / Low:** "Nothing needs attention." · "Nothing is low." · "Fund all · {total}" · "Done just now" ·
"Moved {amount} back to Ready to Assign" / "Added {amount} from Ready to Assign" · "Needs {amount} more" · "Covering
{a} covers this card too"

**Category sheet:** "Change the amount to save" · "Enter an amount to move" · "Ready to Assign has {rta}." · "{name}
would have {left} left." / "{name} would be overspent by {amount}." · "No transactions in {Month}." · "Name (overspent
by {amount})"

**Assign sheet:** "Assign {rta}" (or "Assign money" at $0 or below) · "Left to assign after this" · "That's {amount}
more than you have." · "Pick a category to assign" · "Assign anyway" / "Assign {sum}" / "Move {amount} back" · "Card
spending not covered yet"

## Targets

- Kinds: "Have an amount ready each month, quarter or year" · "Add the same amount every month" · "Reach a total by a
  month" · "Grow toward a total"
- "Enter an amount" / "Choose a month" (when the month is missing)
- "Needs {amount} this month" + "You have {available} left. Next month needs {need}."
- "Needs {amount} a month" + "{amount} by {Month Year}, in {n} steps. After that, {amount} a month each {quarter}."
- "Needs {amount} every month" + "Spending doesn't change it."
- "Needs {amount} a month" + "{amount} by {Month Year}."
- "Toward {amount}" + "Shows progress only. It asks for nothing each month." / "Until it reaches {amount}."
- Server help: "What's left lowers next month's need." · "Fully funded by the start of {Month}." · "Assign the same
  amount every month." · "No date. Add a monthly amount if you like." · "Add a target to see what this category needs."
- "Remove the target from {name}? The money stays in the category."
- "Every category has a target." · "1 category has no target yet." · "{n} categories have no target yet."

## Owed to you

- "It goes back to Ready to Assign when you're paid back."
- "Leave {amount} in Ready to Assign for {name}" + Why: "This payment takes {amount} from Ready to Assign until you're
  paid back. Ready to Assign has {rta} now."
- "{payee} +{amount} is waiting to match" · "{name} is covered" · "{n} more" / "Show less"
- "Nothing is owed to you." · "Late · expected by {date}" · "Expected by {date}" · "Late" · "No date" · "of {amount}
  owed" · "Paid back in full" / "{amount} still open"
- Close out (amounts in cents):
  - "They won't pay it": "{category} is charged {amount} in {Month}. Ready to Assign gets {amount} back." → "Closed.
    {category} was charged {amount} in {Month}."
  - "I marked it by mistake": "{category} is charged the {amount} too, in the purchase's month. Ready to Assign gets
    {amount} back." → "Removed. {category} is charged the {amount} too."
  - "Give it more time": "Set a new date, so it isn't late." → "Now expected by {date}."
- Server: "That's more than came in. Lower an amount." · "That's more than is still owed. Lower the amount." · "Enter
  how much is owed to you." · "$x owed to you. Ready to Assign would go to $z."

## Reports

- "No spending in {Month}." · "Spent by month" · "No history yet."
- "So far this month. Money owed to you isn't counted." / "Money owed to you isn't counted."
- "Bank and card accounts only." (+ the owed sentence only when something is owed)

## Activity

**List:** "Searching all months" · "No transactions match." · "No transactions in {Month}." · "Nothing needs
attention."

- Sections: "Money to match" · "Transfers to sort out" · "Check these" · "Pending · counts now" · "Upcoming · counts on
  its date" · "Posted · newest first"
- Badges: "Pick the account" · "Cleared after all"

**Toasts:** "{payee} → {category}" / "{n} transactions → {category}" + Undo · "… · Overspent by {amount}. Cover it on
Budget." · "1 transaction" / "{n} transactions" · "Joined into {payee}" · "{payee} · marked OK" · "Couldn't categorize
that. Try again." · "Couldn't load more. Try again."

**Needs category:** "Everything has a category." · "Same as your {payee}?" + Join · "New payee · {bank name}" · "Use
{name}" · "Use {n} suggestions" · "Past categories for {payee}" · "No category called "{q}"."

**Same purchase?:** "both count until you answer" · "Paired as one purchase" / "Kept as two purchases" · Server: "Your
bank paired these two itself, so they stay one purchase." · "This isn't paired with another transaction."

**Transfer to sort out**

- "Which account got this money?" + "No account / 1 account / {n} accounts got {amount} within a few days."
- "Looking for the other account" · "It was a payment" + "Give it a category like other spending"
- "Kept as spending. It needs a category. The deposit counts as income." · "Paired with {account}. It needs no category."
  (+ "The other deposit counts as income." when there was more than one)

**Check not cleared**

- "Not at the bank after {n} days" (the real age) · "It still counts in your budget. Checks can take a few weeks to
  clear."
- Keep waiting: "You won't be asked again for 14 days." → "Still waiting. You'll be asked again in 14 days if it
  hasn't cleared."
- "Fix the amount" + "If you wrote it for a different amount." + "Save amount" (now saves)
- Delete: "The check was voided or never sent. {category} gets {amount} back." → "Deleted. {category} got {amount}
  back."

**Add a transaction**

- "Enter an amount" / "Enter a payee" / "Choose an account"
- "Already happened": "Not at the bank yet, like a check. It counts now."
- "Coming up": "A bill or paycheck on a future date. It counts from that date."
- "When the bank shows it, the bank's amount wins." + Why: "The two become one transaction. If the bank doesn't show
  it after a few days, you'll see an alert."

**Match money back**

- "What is this money?" + "It stays out of Ready to Assign until you decide."
- "Nothing is marked as owed to you." · "of {amount}, rest stays owed"
- "It's for something I didn't mark…" → "Open that purchase in Activity and set Owed to you. It then shows up here."
- "The other {amount}": "Keep it waiting to match" / "Count it as income" / "I'll send it back"
- "The matched money goes to Ready to Assign." + Why: "What it pays back leaves Owed to you. Income also goes to Ready
  to Assign. Money you'll send back stays out until it leaves."
- "Pick what it pays back" + "Match" → "Counted as income. Ready to Assign is now {rta}." / "Matched {amount}. 1 item is
  paid back. Ready to Assign is now {rta}."

## Transaction sheet

- Tags: "Pending" · "Posted" · "Income · posted" · "Refund · posted" · "Paid back" · "Transfer" · "Added by you" ·
  "Upcoming" · "Before your budget" · "Pending · your estimate" · "Pending · won't clear" · "Bank says: {name}"
- Estimate: "When it posts, the bank's amount wins. You'll see an alert if they differ."
- Refund: "The {amount} goes back to {category}." (+ on a card: "The card payment needs {amount} less.")
- Income: "Ready to Assign now" / "Save for {Month}" + "Adds {amount} to Ready to Assign on {Month} 1."
- "Money back for something owed to you?" + Match
- Owed: "{category} pays only your share. The rest comes out of Ready to Assign until it's paid back."
- Won't clear: "Turning this on removes what's owed" / "Stop counting this hold"
- Memo: "Add a memo"
- Same purchase: "Same purchase as {other}" + "Not the same" → "Kept as two purchases"
- Paid back: "It went to Ready to Assign and paid back {amount}." · "Unlinked": "{name} is owed again. This {amount} is
  back in Waiting to match."
- Transfer: "It moves money between your accounts. No category changes." · "Unpair" → "Unpaired": "Both halves now
  need a category."
- Before your budget: "Part of your starting balance": "It came in after you linked this account. It changes your
  starting balance, not a category." · "Not counted": "It posted before this account's budget start. Your budget
  doesn't count it."
- Split: "Split {amount}" · "Lines add up to the total" · "Lines are over the total by {amount}" · "Choose a category
  for every line" · "Save split"
- Server: "The lines must add up to {amount}." · "Only a pending bank charge can have an estimate." · "You can change
  the amount only on a transaction you added." · "This has posted, so it can't be marked won't clear." · "Bank
  transactions can't be deleted. Mark it won't clear instead." · "This is before your budget, so it can't be changed."

## Rename payee

- "Enter a name to save" · "Change the name to save" · "You're offline" · "Join payees" / "Save name"
- "You have a payee named {name}. Saving joins them." · "Applies to past and future transactions."
- Server: "Pick at least two different payees, including the one to keep." · "This payee changed, so it can't be
  undone. Pull down to refresh." · "This payee was joined or removed." · "You have a payee named {name}. Join them
  instead."

## Accounts

- Rows: "may be out of date" · "{amount} pending at bank" · "after pending {amount}" · "Differs from bank by {amount}" ·
  "Bank balance includes {amount} pending"
- Banners: "{bank} needs you to sign in again" · "Syncing {bank}…" · "{bank} is up to date" · "{bank} didn't finish
  syncing" · "{bank} still didn't sync" · "{n} banks need you" / "{n} things need you"
- Sync: "Pull to sync banks" · "Release to sync" · "Syncing banks…" · "Up to date" · "Your banks are still syncing. New
  transactions show up in a few minutes."
- Register: "not synced yet" · "· sign in again on Accounts" / "· see Accounts" · "You owe the bank" · "nothing pending"
  · "Covered by payment category" / "Not covered yet" · "Payment category" · "After pending" · "may still change" /
  "final" · "No transactions yet." / "No transactions match."
- "{payee} {amount} from {day} came in late. It's in your starting balance, not your budget."
- "Your transactions differ from the bank balance by {amount}. One may be missing or doubled."
- "The bank balance already counts {amount} of your pending. Ledgerline counts it once."
- "Upcoming bills aren't subtracted here."
- "{names} is overspent by {amount} on this card. Cover it on Budget to fix the card payment too."
- Starting balance: "Older purchases count in the {starting balance}." · "Dated before {date}, came in late" · "Until
  {date}, late purchases from before {date} are added here." / "This won't change now."
- Alerts: "Ledgerline hasn't checked your banks in over a day." · "{bank} hasn't synced in over a day." · "A posted
  {amount} transaction in {Month Year} was removed or re-issued. Check for a double." · "A posted charge matched one of
  several pending charges. Check that it's the right one." · "…nothing posted. It was likely a released hold." · "The
  bank removed a posted transaction and added new ones. Check for a double." · "Ready to Assign for {Month Year} was
  off by {amount} on a device. Pull down to sync again."

## Sign in to a bank again

- "Sign in to {bank} again" · "{bank} needs you to sign in again" + "Nothing is lost. Everything up to the last sync is
  kept."
- "Accounts" · "Last sync" · "You sign in with {bank} in Plaid's secure window. It doesn't use another bank link."
- "Syncing {bank}" + "You can leave this screen. It keeps going."
- "{bank} is connected again" + "New transactions show up in Activity." (or "Its sync didn't finish. Tap Sync on
  Accounts to try again.")
- "This bank doesn't need you to sign in again." + Done
- "You closed the window. Nothing changed."
- "The bank sign-in window didn't open. Check your connection and try again."

## Settings

- "Rename and join · {n} payees" · "{used} of {limit} bank links used · {bank} needs you to sign in again" (or "· {n}
  banks need you")
- Time zone: "US Pacific", "Eastern Time" and so on · Appearance: "Follows your device" · "Saved on this device."
- "Recording stopped. What was recorded is deleted after 90 days."
- Note sheet: "It's saved with your last 20 taps, but no amounts or payee names." → "Saved."

**Sign-in devices**

- "Added {date} · not used yet" · "Remove the passkey {name}? That device can't sign in with it any more."
- "Open this link on the new device" + "It works once, until {time}. Send it only to yourself." · "Link copied"
- "Sign out your other devices and delete the budget saved on them? This device stays signed in."
- "Sign out and delete the budget saved on this device? Sign in with your passkey to get it back."
- "A sign-in ends after 10 idle minutes, or after 24 hours."
- Server: "You can't remove your only passkey." · "That device is already signed out."

**Bank connections**

- "{used} of {limit} bank links used" · "{left} left" · "Removing a link doesn't give it back." + Why: "The free Plaid
  plan allows {limit} bank links in total. If a bank stops syncing, sign in again from Accounts."
- "All {limit} bank links are used. You can import a CSV file in Import and export."
- "Use 1 of your {left} bank links?" / "Use your last bank link?" + "If a bank stopped syncing, sign in again from
  Accounts instead."
- "Link a bank" / "Link another bank" · "Linked. Transactions show up in Activity in a few minutes."
- "{bank} is set up. Its transactions are on the way."
- Chips: "Setup unfinished" · "Synced {when}" · "Not syncing" · "Sync failed" · "Removed" · "Sign in again" · "Test
  mode: test banks only."
- Server: "All 10 bank links are used. Import a CSV file instead." · "Confirm that you want to use one of your bank
  links." · "Your bank is linked, but its accounts aren't set up yet. Tap Finish setup in Bank connections. It doesn't
  use another link."

**Categories**

- "{name} archived" / "{name} restored" · "{name} deleted" · "{name} archived. Reports keep its history." · "{name}
  removed"
- "Bills group" + "Its categories never show as Low"
- "For money you move out to grow, like a brokerage or an IRA. Reports show it as Invested."
- "Most categories. Money you save to spend later, like Vacation, is Spending too."
- "To remove this group, move or remove its categories first." · "Remove the group {name}?"
- "Remove {name}? Its {amount} goes back to Ready to Assign. If it has history, it's archived and reports keep it."
- Server: "Rename the card on Accounts to rename its payment category." · "Card payment categories can't be removed." ·
  "Card payment categories can't be archived."

**Payees:** "No payees match." · "No payees yet." · "To join two payees, give one the other's name."

**Import and export**

- "Upload a CSV file from your bank or another app. It becomes history for search and reports, not your budget."
- "Link a bank first. Imports go into one of its accounts."
- "Transactions {n}" · "Import {n} transactions" → "Imported {n} transactions as history." (+ "Skipped {m} already in
  your linked accounts." only when some were skipped)
- "Your whole budget, in a file that can be restored" → "Saved. Keep it somewhere safe."
- "Your budget can be rewound to any minute" · "Last 30 days" + Why: "Rewinding isn't on this screen, so a stolen
  sign-in can't wipe your data. The steps are in the restore guide."
- Server: "The CSV file needs date, payee and amount columns." · "Type the budget's name to confirm." · "Pick a time in
  the last 30 days." · "Restoring isn't available here."
