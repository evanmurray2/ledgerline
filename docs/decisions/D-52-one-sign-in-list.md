# D-52: No "Phones with a copy" list: signing a device out deletes its saved budget (Nov 3, 2026)

**Decided by the owner.** Settings → Sign-in had a second list, "Phones with a copy", with its own Turn off button (D-45). The owner didn't want it: one list of where you're signed in, and signing a device out also removes the budget saved on it.

1. **One list.** Settings → Sign-in lists each sign-in and each locked phone with a saved copy (locking ends the sign-in, but the copy still opens with Face ID, so it's still signed in in the sense that matters). A phone that's open now is one entry: its copy remembers the sign-in it last opened with (`device.session_id`, directory migration 0007). Rows say "budget saved on it" and "Locked · last opened …".
2. **Signing a device out** (`sign-out-session`) turns its copy off first (the server forgets its share) and then ends its sign-in. "Sign out other devices" does the same for every other entry. The Turn off button, `POST /api/settings/security/devices/:id/revoke`, the `devices` list in `SecurityView` and the `x-device-id` header are gone.
3. **The phone deletes it before showing anything.** When the app opens, and whenever its sign-in ends, a phone with a saved copy asks `POST /api/auth/copy-status` (no sign-in needed; it answers only `{ off }` for a random 128-bit device id) and deletes a copy that was turned off. The next online sign-in also finds the share gone and deletes it. A phone kept offline can still open its copy until it connects or for 7 days, as before (13.6).
4. **Sign out of this device** deletes every copy on the phone first, then ends the sign-in with `forget`, so the server forgets those shares too. Locking still ends the sign-in and keeps the copy. On the lock screen, "Remove the copy from this phone" is now "Sign out and delete it from this phone".
5. Status checks (`/api/auth/status`, `/api/auth/copy-status`) count against the per-IP limit separately from sign-in attempts, so opening the app often never uses up sign-ins.

Existing copies have no `session_id` until the phone next unlocks, so until then the phone can show twice (its sign-in and its locked copy).
