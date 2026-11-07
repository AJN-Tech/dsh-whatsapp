# Troubleshooting

## The WhatsApp entry is not in the left sidebar

0. **Restart DSH once after install.** A plugin installed into an already-running
   host can have its client entry cached as failed; a fresh process reads the
   current bundle and shows the row. This is the usual fix after the first
   install or after replacing the package.
1. Confirm the package is installed in the active profile:
   `dsh plugin list` or DSH → Plugins. The package name is `dsh-whatsapp`.
2. Confirm the profile's `package.json` `dsh.profile.bundles` contains
   `dsh-whatsapp` (the plugin manager adds it when installing). If you edited
   files by hand, add it and restart DSH.
3. Restart DSH once after the first install. A bundle installed by hand is not
   mounted until the loader reads the profile again.
4. Check the DSH logs for `[dsh-whatsapp]` lines. A load failure is reported with
   the reason (usually a missing `client.js` export or a bad patch file).

## Install fails: "ignored build scripts" / pendingBuilds

Recent pnpm blocks `@whiskeysockets/baileys` (preinstall Node check) and
`protobufjs` (postinstall codegen). Use DSH's Plugins page → **Allow these scripts
and retry**, or approve those two packages, then install again. The scripts are
not required for the shipped Baileys build; `npm install --ignore-scripts` works
for a manual install.

## Install fails: `ERR_PNPM_EXOTIC_SUBDEP`

You are installing a plugin version that pins Baileys 6.7.x, whose `libsignal`
dependency is a git URL. This package pins Baileys 7.0.0-rc14 and does not need
that. Check `package.json` in the folder you packed.

## The QR code never appears

- The panel shows the current link state; if it says **Disconnected** with a
  Reconnect button, press it.
- If the API returns 401/403, the page is not authenticated with DSH. Reload the
  DSH window and try again; do not open `/dsh-whatsapp/api` in another tab.
- A QR expires in under a minute. Baileys emits a new one; the panel replaces the
  image. If it does not, press **Refresh QR** / **Re-link**.
- A firewall/proxy that blocks `web.whatsapp.com` or WhatsApp's WebSocket hosts
  prevents linking. Baileys uses the system proxy only if configured; corporate
  TLS interception breaks the Noise handshake.

## "Couldn't link device" on the phone

- Make sure the phone is online and WhatsApp is up to date.
- The account may already have four linked devices. Remove an old one on the
  phone first (Linked devices).
- A number restricted from WhatsApp Web/linked devices cannot be linked.
- Try again with a fresh QR; pairing codes are single-use.

## "Logged out" / "Session expired" screen

WhatsApp unlinked this device (another device was linked, the phone logged out all
devices, the account was restricted, or the ~14-day inactivity limit passed). The
sealed credentials are wiped. Press **Re-link** and scan again. This is expected;
it is not a bug.

## It disconnects repeatedly

- Check the status chip and the reconnect countdown. Transient `restartRequired`
  is normal right after linking; the plugin reconnects automatically.
- A "connection replaced" error means another client took the device slot. Close
  the other client or re-link.
- A flapping network/VPN/proxy causes repeated disconnects. Try a stable network.
- If attempts exhaust (12), press **Reconnect**. If the phone shows the device as
  still linked but the plugin insists on re-linking, log out from DSH and unlink
  the stale device on the phone, then link again.

## Media will not load or download

- Old media may no longer be served by WhatsApp's CDN. The UI reports the failure;
  open the chat on the phone.
- Large files count against the 64 MiB plugin upload limit. Use the phone or
  WhatsApp Web/Desktop for bigger files.
- Media is cached in memory only; after a DSH restart it is re-downloaded on demand.
- A message whose media key is missing (e.g. received while the device was
  offline and the payload was pruned) cannot be decrypted; this is a WhatsApp
  limitation, not a decryption shortcut the plugin may take.

## Calls do not work

They are intentionally not implemented beyond incoming-call notification and
Reject. Baileys has no call audio/video transport and WhatsApp has no call API for
linked devices. Use the phone or official WhatsApp Web/Desktop for calls. See
[FEASIBILITY.md](FEASIBILITY.md#calling-feasibility).

## Phone is off — will it keep working?

Yes, a linked device keeps its own connection and can send/receive while the phone
is off. WhatsApp unlinks devices that have not been used for about 14 days, and
some account-security actions on the phone may unlink this device sooner. If the
plugin shows the re-link screen, scan again.

## Where is my data? How do I reset it?

`${DSH_HOME:-~/.dsh}/whatsapp/`. Log out in Settings (or Re-link) to wipe the
sealed credentials; then delete the directory if you want the chat cache gone too.
Removing the plugin does not delete the directory automatically. If
`DSH_WHATSAPP_PASSPHRASE` is set and lost, the sealed files cannot be opened:
delete the directory and re-link.

## Debugging

Set `DSH_WHATSAPP_LOG_LEVEL=debug` before starting DSH for more lifecycle logs.
Logs never contain message bodies, credentials, keys or QR payloads. For a
reproducible bug, include the DSH version, plugin version, connection status and
the redacted log lines; never attach `creds.enc`, `keys.enc`, `key.bin` or QR
screenshots.
