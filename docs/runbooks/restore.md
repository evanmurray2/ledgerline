# Recovery

There is no off-site backup (decisions.md D-29), and the server can't restore a budget (D-102). Every budget is
locked: the server holds it sealed and can't read it, and rolling its store back would undo the log the devices
hold. The point-in-time restore and its undo (D-77) were removed with D-102. Your devices hold the budget, and your
own full backup is made on a device.

## Your own copies

Settings → Backup and export has the full backup. Save it to Files or iCloud now and then: it is the only copy that
survives losing every device, the Cloudflare account, or damage found later.

- **Full backup** (`.locked`, or `.sqlite` without a lock): made on the device from its copy, after a passkey prompt
  (D-99). By default it is sealed with your recovery key, which the screen asks you to type; only that key opens it
  (`openBackup` in `packages/seal`). The server never sees it and can't load it back. Without a lock, anyone with the
  file can read the whole budget.

## Losing devices

- **One device lost:** sign in on another device with its passkey. A new device opens the budget's newest checked
  snapshot and reads the log on.
- **Every passkey lost:** sign in with the recovery key (Sign in → Use your recovery key). It opens the budget and
  adds the new device's passkey as a way in (`docs/privacy-keys.md` 4.2).
- **The recovery key and every passkey lost:** the budget can't be opened again. Nobody can recover it.
