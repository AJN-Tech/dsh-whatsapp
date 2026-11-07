# Security

## Assets

1. The WhatsApp account and the ability to act as the user.
2. The end-to-end encryption keys (identity key, pre-keys, Signal sessions,
   sender keys, app-state keys).
3. Message bodies, attachments, contacts, group membership and metadata.
4. The DSH session cookie / local API access.

## Trust boundaries

| Boundary | Who can read | Notes |
| --- | --- | --- |
| Browser sandbox | The user's browser tab | Sees rendered chats; never sees credentials or Signal keys |
| DSH host process | Same OS user | Holds decrypted keys in memory and the master key |
| Data directory at rest | Same OS user (readable files) | Everything sensitive is AES-256-GCM sealed |
| WhatsApp servers | WhatsApp | Transport is Noise/TLS; payloads are E2E encrypted per the protocol |
| Phone | The account owner | Primary device; can unlink this device at any time |

The plugin does not try to protect against malicious code running as the same OS
user, root, a compromised DSH installation, a compromised browser, keyloggers,
screen capture, or a compromised phone. It protects an offline copy of the data
directory (backups, sync folders, stolen disk) and keeps secrets out of the
browser and logs.

## End-to-end encryption

- WhatsApp messaging is E2E encrypted by the Signal protocol. The plugin uses
  Baileys' implementation of the WhatsApp multi-device protocol unchanged. It
  does not implement its own message crypto, does not proxy plaintext through a
  server, and does not "disable" or downgrade encryption.
- The linked device generates its own device identity and keys during QR pairing.
  The phone approves the device and shares the account's app-state keys as the
  protocol defines. No phone number + password or SMS code is used.
- Media keys are handled inside Baileys; the plugin only asks Baileys to download
  a media message that it already decrypted. It never re-uploads plaintext to a
  third party.
- The plugin has no telemetry and contacts no analytics, error-reporting or
  hosting service. Its only outbound connections are to WhatsApp endpoints used
  by Baileys, plus WhatsApp CDN fetches for media/avatars that Baileys performs.
- There is no "message backup to our server" feature. The local cache is local.

## At-rest encryption

Files in `${DSH_HOME:-~/.dsh}/whatsapp/` are sealed with AES-256-GCM:

- 96-bit random IV per file write, 128-bit authentication tag, AAD
  `dsh-whatsapp/v1/<filename>` (so a file cannot be moved to another role).
- Master key: 32 random bytes in `key.bin` (mode 0600, directory 0700), or derived
  with scrypt (`N=2^15, r=8, p=1`) from `DSH_WHATSAPP_PASSPHRASE` and a random
  16-byte `salt.bin`. In passphrase mode no `key.bin` is written.
- Credentials and Signal keys are separate sealed files; chat/message cache is a
  third. Tampering or a wrong key fails authentication and is reported as a
  corrupt/bad-key state, never silently ignored.
- Writes are atomic: unique temp file in the same directory, write, fsync, rename,
  chmod. A crash leaves the previous complete file, not a partial one.
- `creds.enc` is written immediately on `creds.update`; Signal key sets are
  debounced (75 ms, forced at 1 s) and flushed on shutdown. Losing the last
  fraction of a second of ratchet state is recoverable; losing device credentials
  would require a re-link, which is why they are immediate.

**Limits.** The key sits next to the ciphertext unless a passphrase is used, so
encryption-at-rest protects a copied/backed-up directory, not a live process
compromise. A passphrase must be supplied before DSH starts; losing it means
re-linking. There is no OS keychain integration in this version (a deliberate
trade-off to avoid native keyring dependencies and their install/build issues).

## Local API

- Every route runs `admit(req, res)` first. If DSH's `connection` service is
  present, its `requestRejection` decides (session cookie, owner, trusted host).
  Otherwise the fallback accepts only loopback requests with an absent or
  same-host `Origin` and rejects `Sec-Fetch-Site: cross-site`.
- Responses are `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.
  There is no CORS allowance.
- JSON bodies are capped at 64 KiB; uploads at 64 MiB. Paths and jids are
  validated; media is served only for a message present in the requested chat, so
  an opaque message id alone cannot read another chat's attachment.
- The client never receives credentials or key material; it receives rendered
  message data and media bytes it is allowed to display.
- Uploads are written to a private temp file inside the data directory, sent
  through Baileys, then deleted. They are not kept as plaintext.

## Logging

The plugin logs lifecycle events, counts, status codes and error codes. It never
logs QR payloads, credentials, Signal keys, session cookies, message bodies,
contact names, media bytes or attachment contents. Baileys is given a small
pino-compatible logger at `warn` by default (`DSH_WHATSAPP_LOG_LEVEL` can raise
it); its own trace messages contain key counts, not key material.

## Supply chain and dependencies

- Only two runtime dependencies: `@whiskeysockets/baileys` (multi-device
  protocol) and `qrcode` (QR PNG rendering, runs locally). Both are pinned in
  `package-lock.json`/the plugin manifest.
- Baileys 7.0.0-rc14 is a release candidate. It is used because the current stable
  6.7.x line depends on `libsignal` through a git URL, which pnpm's
  `blockExoticSubdeps` refuses when DSH's plugin manager installs a package. The
  7.0 line uses the registry `libsignal` package and installs cleanly. This
  trade-off is restated in [FEASIBILITY.md](FEASIBILITY.md).
- Installing a DSH plugin runs its code in the host process, so review the
  package before installing it, and prefer the tarball you built.

## Incident response

- **Account compromised / lost phone:** unlink the device on the phone
  (Linked devices → this device → Log out), or in DSH Settings → Log out.
- **Suspected data exposure:** `dsh plugin remove dsh-whatsapp` and delete the
  data directory; re-link only if needed. Changing the passphrase or deleting the
  key makes existing sealed files unrecoverable.
- **Ban risk:** no technical control removes it. Use a secondary number you can
  lose; stop using the plugin if WhatsApp shows warnings.

## Reporting

This is a local plugin; there is no hosted service to report to. Treat any
security issue in this code as you would a local application issue and withhold
credentials from bug reports. Never attach `creds.enc`, `keys.enc`, `key.bin` or
QR screenshots.
