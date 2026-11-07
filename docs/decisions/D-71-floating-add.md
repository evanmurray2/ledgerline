# D-71: Activity's Add floats at the bottom right on a phone (Nov 7, 2026)

The owner asked whether Add has a better place on a phone. It sat as a "+" icon in the top-right corner of the
Activity header: the hardest spot to reach with one thumb on an iPhone, and easy to miss beside the month and the
search box.

- **On a phone, Add is a round accent button (56 px) at the bottom right of Activity, just above the tab bar**
  (`FloatingAction` in `components/buttons.tsx`). The header's right side is empty, so the month stays centered.
- It shows on Activity only. A "+" in the middle of the tab bar was turned down: Plaid brings in most
  transactions, so adding one by hand is not common enough to take a tab slot, the four tabs would get narrower,
  and the tab bar would mix places with an action.
- It hides while Select is on, since the "N selected" bar takes the bottom of the screen.
- The list gets extra space at its end (`pb-20`), so the last row's amount can scroll out from under the button.
- A toast on a phone ends to the left of the button while it shows (`useToastRoomForFab`), at the same height.
- The floating Note button moves up from 150 px to 164 px above the bottom, so the two round buttons don't touch.
- On a computer nothing changes: Add stays the "Add transaction" header pill.

Changes D-54's "a screen's own header action is one style" for Activity's Add on a phone only; Refresh on
Accounts and New rule on Rules stay header actions. Nothing here changes how money is counted.
