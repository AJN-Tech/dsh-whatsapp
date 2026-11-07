# Feasibility, approach and risk

## Host platform: what "dsh" is here

`dsh` is **DeepSeek Harness** (`@deepseek-ai/dsh`, version 0.2.2-rc.1 in this
installation). It is an agent harness with a desktop shell and a web GUI. Its plugins
are npm packages that declare a Cordis patch and an optional browser bundle. The
left navigation is a slot (`sidebar.panellist`) and root panels are keyed `main`
slots; API routes are registered on the `webServer` service; browser code runs
through `window.__ModuleLoader__.load`. This plugin follows those conventions
exactly (see `package.json`, `cordis.patch.yml`, `index.js`, `client.js`). No
assumption about a different host was needed.

## The hard constraint

WhatsApp provides **no public API for personal accounts**. The official WhatsApp
Business Platform (Cloud API) is for business numbers and does not mirror a
personal account or provide its chat history. Any solution that mirrors a personal
account must act as a WhatsApp Web/linked-device client, which WhatsApp does not
officially support for third parties.

## Chosen approach: Baileys, the multi-device protocol

[Baileys](https://github.com/WhiskeySockets/Baileys) is an open-source TypeScript
implementation of the WhatsApp Web **multi-device** protocol. It speaks the Noise
handshake and Signal protocol directly over a WebSocket; it does not drive a
browser. This is the closest legitimate technical match for the requirement:

- It registers as an **independent linked device** — the same model as
  web.whatsapp.com and WhatsApp Desktop, with its own E2E keys.
- It receives history sync and app-state changes, sends/receives messages and
  media, and handles group state.
- It keeps its own server connection, so it can work while the phone is offline
  (subject to WhatsApp's linked-device rules, ~14 days since last use; up to four
  linked devices).
- It does not weaken E2E encryption; it implements the protocol.

### Alternatives considered

| Option | Why not |
| --- | --- |
| Official Cloud API | Business-only; no personal-account mirroring, no chat history, requires a business number and a hosted webhook. |
| `whatsapp-web.js` | Automates WhatsApp Web in a headless Chromium. Still unofficial, much heavier (Chromium + Puppeteer), more fragile, and it is not a native multi-device client. |
| `whatsmeow` (Go) | Technically solid, but a Go sidecar binary in a Node DSH plugin adds build/cross-compile and packaging complexity. |
| Matrix bridge (`mautrix-whatsapp`) | Runs a separate bridge homeserver and Matrix client; far from a single DSH panel. |
| Reverse-engineer a private API | Explicitly disallowed by this task and by the platform's terms. |

### Version choice

`@whiskeysockets/baileys@7.0.0-rc14` (a release candidate as of this writing) was
chosen over the current stable 6.7.x because 6.7.x depends on `libsignal` through
a **git URL**, and pnpm's `blockExoticSubdeps` refuses to install that when DSH's
plugin manager installs a package. The 7.0 line depends on the registry
`libsignal` package and installs cleanly. The cost is a release-candidate
dependency; it is pinned exactly and its protocol behaviour is covered by the
plugin's tests where it can be without a live account. If a stable 7.x ships,
update the pin and re-run the suite.

## Terms of service and account-ban risk — read this

Using an unofficial WhatsApp client **violates WhatsApp's Terms of Service**. Meta
actively detects and bans accounts that use unofficial clients, sometimes
permanently, and sometimes without a warning. The risk is real and is not
mitigated by this plugin. It applies to the linked phone number, not just to the
plugin. Recommendations:

- Use a secondary number you can afford to lose, not your primary/business number.
- Do not send bulk, automated or unsolicited messages. This plugin is for a human
  using their own chats.
- Do not use it alongside other unofficial clients on the same number.
- Stop and unlink if WhatsApp warns you.
- There is no warranty and no support from WhatsApp or Meta.

## Calling feasibility

Baileys 7.0.0-rc14 exposes `rejectCall` and emits call signalling events
(`offer`, `ringing`, `accept`, `reject`, `terminate`), but it has **no call media
transport** (no WebRTC, no audio/video codecs, no relay). WhatsApp does not expose
a call API for linked devices. Therefore:

- Incoming call notification + Reject: implemented. This is real signalling.
- Outgoing voice/video or accepting with audio/video: not implemented, and the UI
  disables those controls with an explanation rather than pretending.
- A user who needs calls should use the phone or official WhatsApp Web/Desktop.

## Media and history limitations

- History is what WhatsApp chooses to sync to a new linked device: recent chats
  and messages, not the entire archive. Media older than WhatsApp's server
  retention cannot always be downloaded; the UI reports a download failure.
- Media is cached in memory only, bounded (see SECURITY.md); re-download is
  possible while WhatsApp still serves it.
- Status/stories, channels/newsletters, payments, catalog and disappearing-message
  management are out of scope. The plugin does not show fake versions of them.
- Read receipts and presence follow the account's privacy settings; if the account
  hides read receipts, the UI cannot show them for the other side.

## What was verified here, and what was not

Verified in this environment:

- The DSH plugin loads, registers a left-sidebar entry and a full-page panel, and
  the host API routes respond (the plugin is installed into the running DSH
  profile; see the delivery notes).
- Unit tests for the encrypted vault, auth-state round-trip, protocol mapping,
  bounded/encrypted message store, reconnect classification/backoff, HTTP routes
  with a fake service, and the client bundle mounted in jsdom.
- The package passes `node --check`, `npm pack --dry-run`, and the plugin
  manifest checks (`dsh-plugin-toolkit doctor`).
- A live socket smoke test against WhatsApp's servers reached the QR stage and
  produced a valid PNG QR (the probe then removed its temporary unlinked
  credential state; no account was linked). This verifies the Baileys handshake and QR path, not
  the account-confirmation step.

Not verified here:

- A real QR scan, live history sync, sends and media against WhatsApp servers.
  That needs a real WhatsApp account and phone; this environment has neither, and
  the plugin does not ship credentials or a fake account. The code path is the
  standard Baileys flow; no claim of a live end-to-end test is made.

## Failure modes the code handles

- Session expiry/logout (`loggedOut`, `forbidden`, `badSession`): credentials are
  wiped and the UI switches to the re-link screen; no silent loop.
- Normal disconnects (`restartRequired`, `connectionClosed`, `timedOut`):
  exponential backoff with jitter, capped and counted; the UI shows a countdown
  and manual reconnect.
- Device slot taken (`connectionReplaced`): stop and ask the user; do not fight
  the other client for the device.
- QR expiry: Baileys emits a new QR; the client replaces the image. Cancel/relink
  is available.
- Corrupt or tampered sealed files: authentication failure is reported as
  `needsRelink`/error instead of starting with bad state.
- Upload too large, invalid chat, invalid JSON, media for the wrong chat: stable
  4xx responses with codes; no unhandled rejection.
- Phone offline: the device keeps its own connection; the Settings sheet explains
  the ~14-day linked-device rule rather than claiming the phone is required.
