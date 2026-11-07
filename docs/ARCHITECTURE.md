# Architecture

## Host identification

`dsh` in this project means **DeepSeek Harness** (`@deepseek-ai/dsh`), the desktop/web
agent harness. The implementation in this workspace is DSH 2.0.22-next with the
0.2.2-rc.1 runtime packages. A DSH plugin is a small npm package that declares:

- `dsh.bundle.patch` — a cordis YAML patch inserting a loader entry;
- `dsh.client` + `exports["./client"]` — a browser bundle served to the web client;
- an ESM host entry (`index.js`) exporting `apply(ctx)`, which registers services,
  routes, tools or timers through Cordis;
- client code wrapped in `window.__ModuleLoader__.load({ id, factory })`, where
  `require()` may resolve host-provided modules such as `react`.

The left sidebar is a slot named `sidebar.panellist`. A plugin registers an entry
there and a matching full-page component in the root `main` keyed slot; the
layout service selects it (`layout.selectPanel(id)`). This is the same mechanism
DSH's own sidebar and the installed `dsh-task-ledger` plugin use.

## Components

```
┌────────────────────────────── DSH web client (sandboxed browser) ──────────────────────────────┐
│ client.js                                                                                      │
│  sidebar.panellist entry  ──►  layout.selectPanel('dsh-whatsapp')  ──►  main slot component     │
│  React UI: QR link, chat list, thread, composer, settings, call banner                         │
│  fetch('/dsh-whatsapp/api/…')   EventSource('/dsh-whatsapp/api/events')                        │
└───────────────────────────────────────────────┬───────────────────────────────────────────────┘
                                                │ same-origin, DSH session cookie
┌───────────────────────────────────────────────▼───────────────────────────────────────────────┐
│ DSH host process — dsh-whatsapp/index.js                                                       │
│  createAdmit(ctx)  ── connection.requestRejection / loopback+Host+Origin fence                  │
│  lib/routes.js     ── JSON API, SSE, raw uploads, binary media                                 │
│  lib/service.js    ── facade: state, events, link lifecycle, queries, sends, calls              │
│  lib/whatsapp-client.js ─ Baileys socket, reconnect, QR, Signal keys, media                    │
│  lib/message-store.js  ── bounded chats/messages, sealed cache                                 │
│  lib/protocol.js       ── pure Baileys → UI mapping                                            │
│  lib/media-cache.js    ── in-memory byte-capped media LRU                                      │
│  lib/auth-store.js     ── encrypted Baileys AuthenticationState                                │
│  lib/crypto.js         ── AES-256-GCM sealed files, key file / scrypt passphrase               │
└───────────────────────────────────────────────┬───────────────────────────────────────────────┘
                                                │ WSS (Noise + Signal, multi-device protocol)
                                    WhatsApp servers  ◄──── phone (primary device)
```

## Session lifecycle

```
idle ──start()/beginLink()──► starting ──QR──► qr ──scan+confirm──► connecting ──► online
  ▲                               │                                   │             │
  │                               └──cancelLink()─────────────────────┘             │
  │                                                                                 │
  ├──loggedOut / forbidden / badSession──◄── close ◄─────────────────────────────────┘
  │        (wipe sealed credentials, needsRelink=true)
  ├──restartRequired / connectionClosed / timedOut──► offline ──backoff──► starting
  └──connectionReplaced──► error (stop; another session took the device slot)
```

A linked device is independent: it has its own Noise/Signal session with WhatsApp.
WhatsApp allows up to four linked devices and unlinks one that has not been used
for about 14 days. The plugin does not keep the phone online; it keeps its own
connection to WhatsApp.

Disconnect classification uses Baileys `DisconnectReason`: `loggedOut` (401),
`forbidden` (403), `multideviceMismatch` (411), `badSession` (500) are terminal and
require re-linking; `restartRequired` (515), `connectionClosed` (428), `timedOut`
(408) are retried with exponential backoff and jitter (1 s → 30 s, 12 attempts);
`connectionReplaced` (440) stops and asks the user to reconnect.

## Storage

```
${DSH_HOME:-~/.dsh}/whatsapp/     0700
├── key.bin                      32-byte master key, 0600 (unless passphrase mode)
├── salt.bin                     16-byte scrypt salt (passphrase mode)
├── creds.enc                    AES-256-GCM sealed device credentials
├── keys.enc                     AES-256-GCM sealed Signal key store
├── store.enc                    AES-256-GCM sealed chat/message cache
└── device.json                  sealed link metadata (phone, linked time; informational)
```

`creds.enc` is written on every `creds.update`; Signal keys are debounced (75 ms,
forced at 1 s) and flushed on dispose. A crash can lose the last fraction of a
second of ratchet state, never the device identity. Files are written to a
unique temporary file, fsynced, renamed, then chmod 0600.

The in-memory cache is bounded: 1000 messages per chat, 20 000 messages total,
2000 chats, and a byte-capped media LRU. Old entries are trimmed; the store never
grows without limit.

## API and realtime

All under `/dsh-whatsapp/api`:

- `GET /state`, `/chats`, `/messages` — small JSON reads.
- `POST /link/start`, `/link/cancel`, `/link/logout`, `/link/relink`,
  `/reconnect` — lifecycle.
- `POST /send`, `/send-media`, `/read`, `/typing`, `/call/reject` — actions.
- `GET /media`, `/avatar` — authenticated binary responses.
- `GET /events` — SSE: an immediate `state` frame, then `qr`, `state`, `message`,
  `message-status`, `chats`, `history`, `typing`, `call`, `error` frames with a
  20 s heartbeat comment.

SSE is a notification channel, not the source of truth: after `chats` or `history`
the client refetches the list, which keeps the stream small and lets a reconnect
simply re-read state. The client falls back to polling if `EventSource` is
unavailable.

## Security boundaries

The browser only sees DSH's authenticated same-origin API; it never receives
WhatsApp credentials or Signal keys. The host process holds the keys. Baileys
performs the protocol cryptography; this plugin does not implement or alter any
Signal primitive and does not decrypt/re-encrypt message payloads. See
[SECURITY.md](SECURITY.md).

## Test seams

`lib/protocol.js` and the reconnect policy helpers are pure and unit-tested.
`lib/routes.js` accepts a fake `webServer` that records `{kind, path, handler}`
registrations and a fake service. `client.js` is mounted with
`dsh-plugin-toolkit/testkit` in jsdom against a stubbed `fetch` and `EventSource`.
No test opens a real WhatsApp socket.
