/**
 * dsh-whatsapp — client half.
 *
 * A single self-contained browser bundle (no build step, no JSX, no imports)
 * that registers:
 *   • a "WhatsApp" entry in the left sidebar panel list, and
 *   • a full-page WhatsApp Web-style panel keyed `dsh-whatsapp`.
 *
 * It talks only to the host half over the same-origin JSON/SSE API described in
 * CONTRACT.md (`/dsh-whatsapp/api/...`), never to WhatsApp directly.
 *
 * Only `react` may be required from the host loader.
 */
window.__ModuleLoader__.load({
  id: 'dsh-whatsapp',
  factory: function dshWhatsAppFactory(require) {
    'use strict'
    const React = require('react')
    const module = { exports: {} }
    const h = React.createElement

    // ── contract constants ─────────────────────────────────────────────────
    const NS = 'dsh-whatsapp'
    const API = '/dsh-whatsapp/api'
    const SLOT_SIDEBAR = 'sidebar.panellist'
    const SLOT_MAIN = 'main'
    const PANEL_ID = 'dsh-whatsapp'
    const VERSION = '0.1.0'
    const BUNDLE_ID = 'dsh-whatsapp.client'
    const FETCH_TIMEOUT_MS = 20000
    const POLL_INTERVAL_MS = 5000
    const TYPING_TTL_MS = 10000
    const SEARCH_DEBOUNCE_MS = 220
    const CHATS_DEBOUNCE_MS = 450
    const QR_TTL_MS = 60000
    const CALL_TTL_MS = 45000
    const MAX_RENDERED_MESSAGES = 300
    const MAX_STORED_MESSAGES = 500
    const MAX_COPIED_CHARS = 4000

    // ── copy (single source of every user-facing English string) ───────────
    const COPY = {
      'entry.label': 'WhatsApp',
      'entry.aria': 'Open WhatsApp',

      'common.retry': 'Retry',
      'common.cancel': 'Cancel',
      'common.close': 'Close',
      'common.back': 'Back to chats',
      'common.settings': 'Settings',
      'common.search': 'Search chats',
      'common.today': 'Today',
      'common.yesterday': 'Yesterday',
      'common.you': 'You',
      'common.loading': 'Loading…',
      'common.dismiss': 'Dismiss',
      'common.download': 'Download',
      'common.copy': 'Copy text',
      'common.reply': 'Reply',
      'common.offline': 'Offline',
      'common.online': 'Online',
      'common.connecting': 'Connecting…',

      'loading.title': 'Connecting to WhatsApp…',
      'loading.body': 'Reading the linked-device state from the harness.',

      'auth.title': 'Not signed in to DeepSeek Harness',
      'auth.body': 'The local WhatsApp service rejected this request (HTTP {status}). Sign in to the harness in this browser tab and try again.',
      'auth.retry': 'Retry',

      'service.title': 'WhatsApp service is not reachable',
      'service.body': 'The plugin’s local API did not answer ({detail}). The host half may still be starting, or the plugin may have failed to load.',
      'service.retry': 'Retry',

      'connection.starting': 'Starting the WhatsApp connection…',
      'connection.connecting': 'Connecting to WhatsApp…',
      'connection.offline': 'WhatsApp is offline. Sent messages will deliver when the connection returns.',
      'connection.error': 'The WhatsApp connection reported an error.',
      'connection.reconnectIn': 'Reconnecting in {seconds}s',
      'connection.attempt': 'Attempt {n}',
      'connection.reconnect': 'Reconnect',
      'connection.relink': 'Re-link device',
      'connection.label': 'Connection status',

      'link.title': 'Link your WhatsApp account',
      'link.subtitle': 'Scan the code with your phone to use your WhatsApp account from this machine. This works like WhatsApp Web: a linked device, not a replacement.',
      'link.step1': 'Open WhatsApp on your phone.',
      'link.step2': 'Tap Settings (iPhone) or the ⋮ menu (Android).',
      'link.step3': 'Choose Linked devices, then Link a device.',
      'link.step4': 'Point your phone at the code to the left.',
      'link.qrAlt': 'WhatsApp linking QR code',
      'link.waiting': 'Waiting for WhatsApp to send a QR code…',
      'link.expires': 'QR codes are single-use and expire after about a minute. Refresh if scanning takes longer.',
      'link.expired': 'This QR code expired. Refresh it and scan again.',
      'link.start': 'Start linking',
      'link.refresh': 'Refresh QR code',
      'link.cancel': 'Cancel linking',
      'link.busy': 'Starting…',
      'link.riskTitle': 'Unofficial client — use at your own risk',
      'link.risk': 'This plugin is not affiliated with, endorsed by, or supported by WhatsApp or Meta. Linking it counts as an unofficial linked device: WhatsApp’s Terms of Service prohibit unofficial clients, and using one can get the account limited or banned. Only link an account you can afford to lose.',
      'link.storage': 'The session credentials and the local message cache are encrypted on this machine with AES-256-GCM. The key lives in a 0600 key file or derives from DSH_WHATSAPP_PASSPHRASE, depending on how the plugin is configured.',
      'link.error': 'Could not start linking: {message}',
      'link.sessionNote': 'Linking replaces any previous link for this plugin. Your phone stays the primary device.',

      'relink.title': 'Link this device again',
      'relink.body': 'The WhatsApp session for this device expired or was removed from your phone. A linked-device session cannot be recovered once WhatsApp revokes it, so a fresh link is required.',
      'relink.reason': 'Reason: {reason}',
      'relink.button': 'Re-link device',
      'relink.busy': 'Re-linking…',

      'rail.meOnline': 'Connected',
      'rail.meOffline': 'Offline',
      'rail.meConnecting': 'Connecting…',
      'rail.meLinked': 'Linked device',
      'rail.searchLabel': 'Search chats',
      'rail.searchPlaceholder': 'Search or start a new chat',
      'rail.empty': 'No conversations yet',
      'rail.emptyBody': 'Chats show up here once WhatsApp syncs them.',
      'rail.emptySearch': 'No chats match “{query}”',
      'rail.unread': '{count} unread',
      'rail.pinned': 'Pinned',
      'rail.muted': 'Muted',
      'rail.group': 'Group',
      'rail.lastFromYou': 'You: {text}',
      'rail.refresh': 'Refresh chat list',

      'chat.selectTitle': 'WhatsApp',
      'chat.selectBody': 'Select a conversation to read and send messages.',
      'chat.selectBullet1': 'Messages use WhatsApp’s end-to-end encryption — this plugin never re-encrypts their bodies.',
      'chat.selectBullet2': 'This device keeps its own encrypted copy of the local cache.',
      'chat.selectBullet3': 'Calls are not supported by linked-device clients; incoming calls can only be rejected.',
      'chat.openSettings': 'Open settings',

      'thread.back': 'Back to chats',
      'thread.typing': 'typing…',
      'thread.groupSub': 'Group chat',
      'thread.directSub': 'Direct chat',
      'thread.voiceCall': 'Voice call — unavailable',
      'thread.videoCall': 'Video call — unavailable',
      'thread.callsInfo': 'Why are calls unavailable?',
      'thread.callsNote': 'Linked-device clients cannot carry call audio or video. You will still get a banner when someone calls, so you can reject the call, but answering or starting a call is not possible in this client.',
      'thread.loadOlder': 'Load older messages',
      'thread.loadingOlder': 'Loading older messages…',
      'thread.noMessages': 'No messages here yet.',
      'thread.jumpLatest': 'Jump to latest',
      'thread.history': 'Message history',
      'thread.messagesLog': 'Messages',
      'thread.olderCap': 'Older messages are available — scroll up to load them.',

      'composer.placeholder': 'Type a message',
      'composer.aria': 'Message',
      'composer.send': 'Send message',
      'composer.attach': 'Attach file',
      'composer.emoji': 'Insert emoji',
      'composer.emojiLabel': 'Emoji picker',
      'composer.replyTo': 'Replying to {name}',
      'composer.cancelReply': 'Cancel reply',
      'composer.removeFile': 'Remove attachment',
      'composer.fileSize': '{size}',
      'composer.uploading': 'Uploading…',
      'composer.uploadError': 'Could not send: {message}',
      'composer.retryUpload': 'Retry',
      'composer.dropHere': 'Drop the file to attach it',
      'composer.oneFile': 'Only the first file was attached.',
      'composer.sendHint': 'Enter to send, Shift+Enter for a new line',

      'msg.pending': 'Sending',
      'msg.sent': 'Sent',
      'msg.delivered': 'Delivered',
      'msg.read': 'Read',
      'msg.played': 'Played',
      'msg.error': 'Not sent',
      'msg.retry': 'Retry sending',
      'msg.deleted': 'This message was deleted',
      'msg.edited': 'edited',
      'msg.image': 'Photo',
      'msg.video': 'Video',
      'msg.audio': 'Voice message',
      'msg.document': 'Document',
      'msg.sticker': 'Sticker',
      'msg.location': 'Location',
      'msg.contact': 'Contact card',
      'msg.call': 'Call',
      'msg.system': 'System message',
      'msg.unknown': 'Unsupported message',
      'msg.photoAlt': 'Image attachment',
      'msg.videoAlt': 'Video attachment',
      'msg.openImage': 'Open image',
      'msg.openVideo': 'Open video',
      'msg.downloadFile': 'Download {name}',
      'msg.quotedMissing': 'Quoted message',
      'msg.replyTo': 'Replying to {name}',
      'msg.locationCoords': '{lat}, {lng}',
      'msg.contactCard': 'Contact card',
      'msg.callEvent': 'WhatsApp call',
      'msg.timeAt': '{time}',

      'call.incomingTitle': 'Incoming {kind} call',
      'call.kindVoice': 'voice',
      'call.kindVideo': 'video',
      'call.caller': 'from {name}',
      'call.reject': 'Reject',
      'call.rejectAria': 'Reject incoming call',
      'call.answer': 'Answer',
      'call.answerUnavailable': 'Answer is unavailable: linked-device clients cannot carry call audio or video.',
      'call.timeout': 'Only rejecting is supported in this client.',
      'call.rejected': 'Call rejected.',
      'call.rejectError': 'Could not reject the call: {message}',
      'call.unknownCaller': 'Unknown caller',

      'settings.title': 'Settings',
      'settings.close': 'Close settings',
      'settings.account': 'Account',
      'settings.device': 'Linked device',
      'settings.name': 'Name',
      'settings.phone': 'Phone',
      'settings.linkedAt': 'Linked at',
      'settings.lastConnected': 'Last connected',
      'settings.connection': 'Connection',
      'settings.storage': 'Local storage',
      'settings.storageEncrypted': 'Encrypted at rest (AES-256-GCM)',
      'settings.storageUnknown': 'Not reported',
      'settings.storageDetail': 'Credentials, Signal keys and the cached chats/messages are sealed on disk. The key is either a private key.bin (mode 0600) or derived from DSH_WHATSAPP_PASSPHRASE with salt.bin.',
      'settings.phoneOffline': 'Phone-offline model',
      'settings.phoneOfflineFallback': 'A linked device keeps its own session, so your phone does not need to be online for this client to send and receive. WhatsApp may delay delivery while the primary phone is unreachable.',
      'settings.calls': 'Calls',
      'settings.callsDetail': 'Voice and video calls cannot be carried by a linked-device client. Incoming calls can be rejected from the banner; answering or starting a call is not possible here.',
      'settings.stats': 'Local cache',
      'settings.statsDetail': '{chats} chats · {messages} messages',
      'settings.limitations': 'Known limitations',
      'settings.limit1': 'This is a linked device; your phone remains the primary device and is not mirrored.',
      'settings.limit2': 'Calls cannot be answered or started.',
      'settings.limit3': 'Group participant lists and contact presence are not synced by this version.',
      'settings.limit4': 'Unofﬁcial client: use at your own risk — WhatsApp can limit or ban the account.',
      'settings.version': 'Version',
      'settings.build': 'Bundle',
      'settings.api': 'API',
      'settings.lastError': 'Last error',
      'settings.noError': 'No recent errors.',
      'settings.logout': 'Log out and unlink',
      'settings.logoutConfirm': 'This wipes the encrypted credentials and unlinks the device.{wipe} You will need your phone to link again.',
      'settings.logoutWipe': ' It also deletes this device’s cached messages.',
      'settings.logoutWipeLabel': 'Also delete locally cached messages',
      'settings.logoutYes': 'Yes, log out',
      'settings.logoutBusy': 'Logging out…',
      'settings.relink': 'Re-link device',
      'settings.relinkConfirm': 'This clears the current credentials and this device\u2019s cached chats, then starts a fresh QR linking flow. The old session stops working immediately.',
      'settings.relinkYes': 'Re-link',
      'settings.relinkBusy': 'Re-linking…',
      'settings.reconnect': 'Reconnect now',
      'settings.reconnectBusy': 'Reconnecting…',
      'settings.openWhyCalls': 'Calls are disabled',

      'toast.reconnecting': 'Reconnecting to WhatsApp…',
      'toast.reconnectSent': 'Reconnect requested.',
      'toast.linkStarted': 'Starting the linking flow…',
      'toast.linkCancelled': 'Linking cancelled.',
      'toast.loggedOut': 'Logged out. Link the device again to continue.',
      'toast.relinkStarted': 'Re-linking the device…',
      'toast.polling': 'Live updates are unavailable; polling for changes every few seconds.',
      'toast.copied': 'Copied to clipboard.',
      'toast.copyFailed': 'Could not copy to the clipboard.',
      'toast.error': 'Something went wrong: {message}',
      'toast.sent': 'Message sent.',
      'toast.refreshed': 'Chat list refreshed.',

      'empty.chatsError': 'Could not load chats: {message}',
      'empty.messagesError': 'Could not load messages: {message}',
      'empty.retry': 'Retry',

      'sr.notification': 'Notification',
    }

    // ── translator (bound to the host locale service when present) ─────────
    let boundTranslate = null

    function formatTemplate(template, values) {
      if (!values) return template
      return template.replace(/\{(\w+)\}/g, (match, name) => (
        Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match
      ))
    }

    /** Translate a copy key; falls back to the bundle's English table. */
    function tx(key, values) {
      let template = null
      if (typeof boundTranslate === 'function') {
        try {
          const translated = boundTranslate(key, values)
          if (typeof translated === 'string' && translated !== '' && translated !== key) template = translated
        } catch (error) {
          template = null
        }
      }
      if (template === null) template = Object.prototype.hasOwnProperty.call(COPY, key) ? COPY[key] : key
      return formatTemplate(template, values)
    }

    // ── tiny value helpers ─────────────────────────────────────────────────
    function str(value) {
      if (typeof value === 'string') return value
      if (value === null || value === undefined) return ''
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      return ''
    }

    function num(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value : 0
    }

    function numOrNull(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value : null
    }

    function pad2(value) {
      return String(value).padStart(2, '0')
    }

    const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

    function dayStart(timestamp) {
      const date = new Date(timestamp)
      if (Number.isNaN(date.getTime())) return 0
      return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
    }

    function isSameDay(a, b) {
      return dayStart(a) === dayStart(b)
    }

    function formatClock(timestamp) {
      if (!timestamp) return ''
      const date = new Date(timestamp)
      if (Number.isNaN(date.getTime())) return ''
      return pad2(date.getHours()) + ':' + pad2(date.getMinutes())
    }

    function formatDayLabel(timestamp) {
      const now = Date.now()
      if (isSameDay(timestamp, now)) return tx('common.today')
      if (isSameDay(timestamp, now - 86400000)) return tx('common.yesterday')
      if (now - timestamp < 6 * 86400000) return DAY_NAMES[new Date(timestamp).getDay()]
      const date = new Date(timestamp)
      return date.getDate() + ' ' + MONTH_SHORT[date.getMonth()] + ' ' + date.getFullYear()
    }

    function formatListTime(timestamp) {
      if (!timestamp) return ''
      const now = Date.now()
      if (isSameDay(timestamp, now)) return formatClock(timestamp)
      if (isSameDay(timestamp, now - 86400000)) return tx('common.yesterday')
      if (now - timestamp < 6 * 86400000) return DAY_SHORT[new Date(timestamp).getDay()]
      const date = new Date(timestamp)
      if (date.getFullYear() === new Date(now).getFullYear()) return pad2(date.getDate()) + '/' + pad2(date.getMonth() + 1)
      return pad2(date.getDate()) + '/' + pad2(date.getMonth() + 1) + '/' + date.getFullYear()
    }

    function formatFull(timestamp) {
      if (!timestamp) return '—'
      const date = new Date(timestamp)
      if (Number.isNaN(date.getTime())) return '—'
      return date.getDate() + ' ' + MONTH_SHORT[date.getMonth()] + ' ' + date.getFullYear() + ', ' + formatClock(timestamp)
    }

    function formatBytes(bytes) {
      const size = num(bytes)
      if (size <= 0) return ''
      if (size < 1024) return size + ' B'
      if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB'
      if (size < 1024 * 1024 * 1024) return (size / (1024 * 1024)).toFixed(1) + ' MB'
      return (size / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
    }

    function formatDuration(seconds) {
      const total = Math.max(0, Math.round(num(seconds)))
      return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60)
    }

    function initials(name) {
      const value = str(name).trim()
      if (value === '') return '?'
      const words = value.replace(/[+()\s-]+/g, ' ').trim().split(' ').filter(Boolean)
      if (words.length === 0) return '?'
      if (words.length === 1) {
        const word = words[0]
        if (/^\+?\d+$/.test(word)) return word.replace(/\D/g, '').slice(-2) || '?'
        return word.slice(0, 2).toUpperCase()
      }
      return (words[0][0] + words[words.length - 1][0]).toUpperCase()
    }

    const AVATAR_PALETTE = ['#3e6f63', '#7a5a3f', '#56568a', '#8a4f5f', '#3f6a80', '#6a6a3c', '#6f4f80', '#3f6f5a']

    function avatarColor(seed) {
      const value = str(seed)
      let hash = 0
      for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0
      return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length]
    }

    function phoneFromJid(jid) {
      const value = str(jid)
      if (value === '') return ''
      const local = value.split('@')[0].split(':')[0]
      return local.startsWith('+') ? local : '+' + local
    }

    function truncate(text, max) {
      const value = str(text)
      if (value.length <= max) return value
      return value.slice(0, Math.max(0, max - 1)) + '…'
    }

    function safeDateValue(timestamp) {
      const value = num(timestamp)
      return value > 0 ? value : null
    }

    function apiUrl(path, params) {
      let url = API + path
      if (params && typeof params === 'object') {
        const parts = []
        Object.keys(params).forEach((key) => {
          const value = params[key]
          if (value === undefined || value === null || value === '') return
          parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)))
        })
        if (parts.length > 0) url += '?' + parts.join('&')
      }
      return url
    }

    function mediaUrl(chatId, messageId) {
      return apiUrl('/media', { chat: chatId, id: messageId })
    }

    // ── errors / HTTP ──────────────────────────────────────────────────────
    function makeApiError(message, status, code, body) {
      const error = new Error(message)
      error.name = 'ApiError'
      error.status = status || 0
      error.code = code || 'http'
      error.body = body || null
      return error
    }

    function isAuthError(error) {
      return Boolean(error && (error.status === 401 || error.status === 403))
    }

    function isAbortish(error) {
      return Boolean(error && (error.name === 'AbortError' || error.code === 'aborted' || error.code === 'timeout'))
    }

    function messageOf(error) {
      if (error === null || error === undefined) return 'unknown error'
      const message = str(error.message) || String(error)
      return truncate(message, 300)
    }

    function isBlobLike(value) {
      return Boolean(value) && typeof value === 'object' && typeof value.arrayBuffer === 'function' && typeof value.size === 'number'
    }

    /**
     * Same-origin JSON request against the plugin API. Throws ApiError with
     * `.status` (401/403 identify an unauthenticated harness session) and
     * `.code` (`auth`, `network`, `timeout`, `http`).
     */
    async function apiFetch(path, options) {
      const opts = options || {}
      const method = opts.method || 'GET'
      if (typeof fetch !== 'function') throw makeApiError('fetch is not available', 0, 'network')
      const headers = Object.assign({ accept: 'application/json' }, opts.headers || {})
      const init = { method: method, credentials: 'same-origin', cache: 'no-store', headers: headers }
      if (opts.body !== undefined) {
        if (isBlobLike(opts.body)) {
          init.body = opts.body
        } else {
          headers['content-type'] = 'application/json'
          init.body = JSON.stringify(opts.body)
        }
      }
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      let timer = null
      let detachExternal = null
      if (controller !== null) {
        timer = setTimeout(() => {
          try { controller.abort() } catch (error) { /* ignore */ }
        }, opts.timeoutMs || FETCH_TIMEOUT_MS)
        if (opts.signal) {
          if (opts.signal.aborted === true) {
            try { controller.abort() } catch (error) { /* ignore */ }
          } else {
            detachExternal = () => {
              try { controller.abort() } catch (error) { /* ignore */ }
            }
            try { opts.signal.addEventListener('abort', detachExternal) } catch (error) { detachExternal = null }
          }
        }
        init.signal = controller.signal
      }
      try {
        const response = await fetch(apiUrl(path, opts.params), init)
        const status = response && typeof response.status === 'number' ? response.status : 0
        if (status === 401 || status === 403) throw makeApiError('HTTP ' + status, status, 'auth')
        let body = null
        const responseLike = Boolean(response)
          && (typeof response.json === 'function' || typeof response.ok === 'boolean' || typeof response.status === 'number')
        if (responseLike) {
          try {
            if (typeof response.json === 'function') body = await response.json()
          } catch (parseError) {
            body = null
          }
        } else if (response && typeof response === 'object') {
          // Some embedders (and the plugin testkit's function routes) hand
          // back the decoded body directly rather than a Response object.
          body = response
        }
        if (response && response.ok === false) {
          const detail = body && typeof body === 'object' && typeof body.error === 'string' ? body.error : 'HTTP ' + status
          throw makeApiError(truncate(detail, 300), status, (body && body.code) || 'http', body)
        }
        return body
      } catch (error) {
        if (error && (error.code === 'auth' || error.status === 401 || error.status === 403)) throw error
        if (error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')) throw makeApiError('request timed out', 0, 'timeout')
        if (error && typeof error.message === 'string' && error.message.indexOf('timed out') !== -1) throw error
        throw makeApiError(messageOf(error), 0, 'network')
      } finally {
        if (timer !== null) clearTimeout(timer)
        if (detachExternal !== null) {
          try { opts.signal.removeEventListener('abort', detachExternal) } catch (error) { /* ignore */ }
        }
      }
    }

    // ── data normalization (host may evolve; the client stays tolerant) ────
    const MESSAGE_KINDS = {
      text: true, image: true, video: true, audio: true, document: true, sticker: true,
      location: true, contact: true, call: true, system: true, unknown: true,
    }

    const MESSAGE_STATUSES = {
      pending: true, sent: true, delivered: true, read: true, played: true, error: true, unknown: true,
    }

    function normalizeKind(value) {
      return MESSAGE_KINDS[value] === true ? value : 'unknown'
    }

    function normalizeStatus(value) {
      return MESSAGE_STATUSES[value] === true ? value : 'unknown'
    }

    function normalizeQuoted(raw) {
      if (!raw || typeof raw !== 'object') return null
      return {
        id: str(raw.id),
        authorName: str(raw.authorName) || null,
        text: str(raw.text),
      }
    }

    function normalizeMedia(raw) {
      if (!raw || typeof raw !== 'object') return null
      return {
        mimetype: str(raw.mimetype),
        fileName: str(raw.fileName),
        fileLength: num(raw.fileLength),
        seconds: numOrNull(raw.seconds),
        width: numOrNull(raw.width),
        height: numOrNull(raw.height),
        ptt: raw.ptt === true,
        animated: raw.animated === true,
        hasThumbnail: raw.hasThumbnail === true,
      }
    }

    function normalizeLocation(raw) {
      if (!raw || typeof raw !== 'object') return null
      return {
        lat: num(raw.lat),
        lng: num(raw.lng),
        name: str(raw.name),
        address: str(raw.address),
      }
    }

    function normalizeContact(raw) {
      if (!raw || typeof raw !== 'object') return null
      return { displayName: str(raw.displayName), vcard: str(raw.vcard) }
    }

    let fallbackMessageId = 0

    // Monotonic ids for optimistic (not-yet-saved) messages.
    let localMessageCounter = 0

    function nextLocalMessageId() {
      localMessageCounter += 1
      return 'local-' + Date.now() + '-' + localMessageCounter
    }

    function normalizeMessage(raw) {
      if (!raw || typeof raw !== 'object') return null
      const timestamp = num(raw.timestamp) || Date.now()
      let id = str(raw.id)
      if (id === '') {
        fallbackMessageId += 1
        id = 'm-' + timestamp + '-' + fallbackMessageId
      }
      return {
        id: id,
        chatId: str(raw.chatId),
        fromMe: raw.fromMe === true,
        author: raw.author === null || raw.author === undefined ? null : str(raw.author),
        authorName: raw.authorName === null || raw.authorName === undefined ? null : str(raw.authorName),
        timestamp: timestamp,
        kind: normalizeKind(raw.kind),
        text: str(raw.text),
        quoted: normalizeQuoted(raw.quoted),
        media: normalizeMedia(raw.media),
        thumbnail: typeof raw.thumbnail === 'string' && raw.thumbnail !== '' ? raw.thumbnail : null,
        location: normalizeLocation(raw.location),
        contact: normalizeContact(raw.contact),
        status: normalizeStatus(raw.status),
        revoked: raw.revoked === true,
        edited: raw.edited === true,
        local: str(raw.id) === '',
        errorMessage: null,
      }
    }

    function normalizeChat(raw) {
      if (!raw || typeof raw !== 'object') return null
      const id = str(raw.id)
      if (id === '') return null
      let lastMessage = null
      if (raw.lastMessage && typeof raw.lastMessage === 'object') {
        lastMessage = {
          id: str(raw.lastMessage.id),
          text: str(raw.lastMessage.text),
          fromMe: raw.lastMessage.fromMe === true,
          timestamp: num(raw.lastMessage.timestamp),
          kind: normalizeKind(raw.lastMessage.kind),
        }
      }
      return {
        id: id,
        name: str(raw.name) || phoneFromJid(id) || id,
        isGroup: raw.isGroup === true,
        unread: Math.max(0, Math.round(num(raw.unread))),
        pinned: raw.pinned === true,
        muted: raw.muted === true,
        archived: raw.archived === true,
        timestamp: num(raw.timestamp) || (lastMessage ? lastMessage.timestamp : 0),
        lastMessage: lastMessage,
      }
    }

    function normalizeChatList(raw) {
      let list = []
      if (Array.isArray(raw)) list = raw
      else if (raw && Array.isArray(raw.chats)) list = raw.chats
      else if (raw && Array.isArray(raw.items)) list = raw.items
      return list.map(normalizeChat).filter((chat) => chat !== null)
    }

    function compareMessages(a, b) {
      if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
      const left = String(a.id)
      const right = String(b.id)
      if (left === right) return 0
      return left < right ? -1 : 1
    }

    function mergeMessageLists(primary, secondary) {
      const byId = new Map()
      const push = (message) => {
        if (!message || typeof message.id !== 'string') return
        const existing = byId.get(message.id)
        if (existing === undefined) byId.set(message.id, message)
        else byId.set(message.id, Object.assign({}, existing, message))
      }
      ;(secondary || []).forEach(push)
      ;(primary || []).forEach(push)
      const merged = Array.from(byId.values())
      merged.sort(compareMessages)
      return merged
    }

    function normalizeMessagesResponse(raw) {
      let list = []
      if (Array.isArray(raw)) list = raw
      else if (raw && Array.isArray(raw.messages)) list = raw.messages
      const messages = list.map(normalizeMessage).filter((message) => message !== null)
      messages.sort(compareMessages)
      const hasMore = raw && typeof raw.hasMore === 'boolean' ? raw.hasMore : messages.length >= 50
      return { messages: messages, hasMore: hasMore }
    }

    function normalizeState(raw) {
      let source = raw
      if (raw && typeof raw === 'object' && raw.state && typeof raw.state === 'object') source = raw.state
      if (!source || typeof source !== 'object') source = {}
      const connection = typeof source.connection === 'string' ? source.connection : 'idle'
      let me = null
      if (source.me && typeof source.me === 'object') {
        me = {
          id: str(source.me.id),
          name: str(source.me.name) || str(source.me.phone) || str(source.me.id) || 'You',
          phone: str(source.me.phone),
        }
      }
      let lastError = null
      if (source.lastError && typeof source.lastError === 'object') {
        lastError = {
          code: str(source.lastError.code),
          message: str(source.lastError.message),
          at: num(source.lastError.at),
        }
      }
      return {
        linked: source.linked === true,
        connection: connection,
        qr: typeof source.qr === 'string' && source.qr !== '' ? source.qr : null,
        me: me,
        linkedAt: numOrNull(source.linkedAt),
        lastConnectedAt: numOrNull(source.lastConnectedAt),
        reconnectInMs: numOrNull(source.reconnectInMs),
        reconnectAttempt: Math.round(num(source.reconnectAttempt)),
        lastError: lastError,
        needsRelink: source.needsRelink === true,
        phoneOfflineModel: str(source.phoneOfflineModel),
        callsSupported: false,
        messageCount: Math.round(num(source.messageCount)),
        chatCount: Math.round(num(source.chatCount)),
        storage: source.storage === 'encrypted' ? 'encrypted' : str(source.storage) || 'unknown',
      }
    }

    function normalizeCall(raw) {
      if (!raw || typeof raw !== 'object') return null
      return {
        id: str(raw.id),
        from: str(raw.from),
        chatId: str(raw.chatId),
        isVideo: raw.isVideo === true,
        date: num(raw.date) || Date.now(),
        status: str(raw.status).toLowerCase(),
      }
    }

    function isIncomingCallStatus(status) {
      const value = str(status).toLowerCase()
      return value === 'offer' || value === 'ringing' || value === 'incoming' || value === 'pending' || value === 'calling' || value === ''
    }

    function deriveKindFromFile(file) {
      const type = str(file && file.type).toLowerCase()
      const name = str(file && file.name).toLowerCase()
      if (type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|heic)$/.test(name)) return 'image'
      if (type.startsWith('video/') || /\.(mp4|mov|webm|mkv|3gp)$/.test(name)) return 'video'
      if (type.startsWith('audio/') || /\.(mp3|ogg|opus|m4a|wav|aac)$/.test(name)) return 'audio'
      return 'document'
    }

    function linkifyText(text) {
      const value = str(text)
      if (value === '') return []
      const pattern = /(https?:\/\/[^\s<>"']{2,})/g
      const parts = []
      let lastIndex = 0
      let match = pattern.exec(value)
      let key = 0
      while (match !== null) {
        if (match.index > lastIndex) parts.push(h(React.Fragment, { key: 't' + key }, value.slice(lastIndex, match.index)))
        key += 1
        parts.push(h('a', {
          key: 'a' + key,
          className: 'dshwa-link',
          href: match[1],
          target: '_blank',
          rel: 'noopener noreferrer',
        }, match[1]))
        lastIndex = match.index + match[1].length
        match = pattern.exec(value)
      }
      if (lastIndex < value.length) parts.push(h(React.Fragment, { key: 't' + key }, value.slice(lastIndex)))
      return parts
    }

    // ── scoped stylesheet (one <style id="dsh-whatsapp-style">) ─────────────
    const STYLE = `
.dshwa {
  --wa-bg: #e9edef;
  --wa-panel: #ffffff;
  --wa-panel-2: #f0f2f5;
  --wa-panel-3: #f7f9fa;
  --wa-border: #e3e7ea;
  --wa-border-soft: #eef1f3;
  --wa-text: #111b21;
  --wa-text-2: #55646d;
  --wa-text-3: #5f6e77;
  --wa-meta: #5c6b73;
  --wa-quote-author: #006b57;
  --wa-quote-text: #4f5e66;
  --wa-badge-text: #006b57;
  --wa-step-text: #006b57;
  --wa-unread-bg: #007a63;
  --wa-btn-bg: #008069;
  --wa-btn-text: #ffffff;
  --wa-ghost-text: #006b57;
  --wa-accent: #00a884;
  --wa-accent-strong: #008069;
  --wa-accent-soft: #d9fdd3;
  --wa-out: #d9fdd3;
  --wa-in: #ffffff;
  --wa-hover: #f5f6f6;
  --wa-active: #f0f2f5;
  --wa-search-bg: #f0f2f5;
  --wa-chat-bg: #efeae2;
  --wa-chat-dot: rgba(17, 27, 33, 0.05);
  --wa-blue: #53bdeb;
  --wa-danger: #ea0038;
  --wa-warn-bg: #fff4d4;
  --wa-warn-text: #5c4403;
  --wa-error-bg: #ffe4e8;
  --wa-error-text: #7a0b22;
  --wa-info-bg: #e7f3ff;
  --wa-info-text: #0b4a6f;
  --wa-incoming-bg: #075e54;
  --wa-day-bg: #ffffff;
  --wa-day-text: #54656f;
  --wa-toast-bg: #233138;
  --wa-toast-text: #f7f9fa;
  --wa-tooltip-bg: #233138;
  --wa-scroll: #c4cdd2;
  --wa-focus: #00a884;
  --wa-shadow-sm: 0 1px 1px rgba(11, 20, 26, 0.06);
  --wa-shadow-md: 0 2px 10px rgba(11, 20, 26, 0.14);
  --wa-shadow-lg: 0 8px 32px rgba(11, 20, 26, 0.28);
  --wa-radius: 10px;
  --wa-avatar-bg: #dfe5e7;
  --wa-avatar-text: #ffffff;

  position: relative;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  height: 100%;
  width: 100%;
  overflow: hidden;
  background: var(--wa-bg);
  color: var(--wa-text);
  font-family: "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif;
  font-size: 14px;
  line-height: 1.4;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
.dshwa[data-theme="dark"] {
  --wa-bg: #0b141a;
  --wa-panel: #111b21;
  --wa-panel-2: #202c33;
  --wa-panel-3: #182229;
  --wa-border: #222d34;
  --wa-border-soft: #1f2a31;
  --wa-text: #e9edef;
  --wa-text-2: #a3b2ba;
  --wa-text-3: #8b9aa3;
  --wa-meta: #c0d3d8;
  --wa-quote-author: #8ee6c9;
  --wa-quote-text: #c8dde3;
  --wa-badge-text: #8ee6c9;
  --wa-step-text: #8ee6c9;
  --wa-unread-bg: #007a63;
  --wa-btn-bg: #008069;
  --wa-btn-text: #ffffff;
  --wa-ghost-text: #06cf9c;
  --wa-accent: #00a884;
  --wa-accent-strong: #06cf9c;
  --wa-accent-soft: #005c4b;
  --wa-out: #005c4b;
  --wa-in: #202c33;
  --wa-hover: #202c33;
  --wa-active: #2a3942;
  --wa-search-bg: #202c33;
  --wa-chat-bg: #0b141a;
  --wa-chat-dot: rgba(233, 237, 239, 0.035);
  --wa-day-bg: #182229;
  --wa-day-text: #8696a0;
  --wa-warn-bg: #443a1c;
  --wa-warn-text: #ffe58a;
  --wa-error-bg: #4b1a24;
  --wa-error-text: #ffb3c0;
  --wa-info-bg: #1a3040;
  --wa-info-text: #a8d8ff;
  --wa-incoming-bg: #005c4b;
  --wa-toast-bg: #233138;
  --wa-toast-text: #f7f9fa;
  --wa-scroll: #374248;
  --wa-avatar-bg: #2a3942;
  --wa-shadow-sm: 0 1px 1px rgba(0, 0, 0, 0.25);
  --wa-shadow-md: 0 2px 10px rgba(0, 0, 0, 0.4);
  --wa-shadow-lg: 0 8px 32px rgba(0, 0, 0, 0.55);
}
.dshwa *, .dshwa *::before, .dshwa *::after { box-sizing: border-box; }
.dshwa :where(button) { font: inherit; color: inherit; background: none; border: 0; padding: 0; margin: 0; cursor: pointer; text-align: inherit; }
.dshwa :where(button:disabled) { cursor: default; }
.dshwa input, .dshwa textarea { font: inherit; color: inherit; }
.dshwa :focus-visible { outline: 2px solid var(--wa-focus); outline-offset: 2px; border-radius: 6px; }
.dshwa ::-webkit-scrollbar { width: 7px; height: 7px; }
.dshwa ::-webkit-scrollbar-thumb { background: var(--wa-scroll); border-radius: 4px; }
.dshwa ::-webkit-scrollbar-track { background: transparent; }
.dshwa svg { display: block; flex: 0 0 auto; }
.dshwa-app { display: flex; flex: 1 1 auto; min-height: 0; min-width: 0; position: relative; overflow: hidden; }

.dshwa-sr-only {
  position: absolute !important; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
.dshwa-link { color: #027eb5; text-decoration: underline; word-break: break-word; }
.dshwa[data-theme="dark"] .dshwa-link { color: #53bdeb; }

.dshwa-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  border-radius: 999px; padding: 8px 16px; font-size: 13px; font-weight: 600;
  background: var(--wa-btn-bg); color: var(--wa-btn-text); border: 0; white-space: nowrap;
  transition: filter 0.15s ease, background-color 0.15s ease;
}
.dshwa-btn:hover { filter: brightness(1.06); }
.dshwa-btn:disabled { opacity: 0.6; filter: none; }
.dshwa-btn[data-variant="ghost"] { background: transparent; color: var(--wa-ghost-text); border: 1px solid var(--wa-border); }
.dshwa-btn[data-variant="ghost"]:hover { background: var(--wa-hover); }
.dshwa-btn[data-variant="danger"] { background: var(--wa-danger); }
.dshwa-btn[data-variant="plain"] { background: transparent; color: var(--wa-text-2); }
.dshwa-btn[data-variant="plain"]:hover { color: var(--wa-text); background: var(--wa-hover); }
.dshwa-btn[data-size="sm"] { padding: 6px 12px; font-size: 12px; }

.dshwa-iconbtn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 40px; height: 40px; border-radius: 50%; color: var(--wa-text-2);
  flex: 0 0 auto; position: relative; transition: background-color 0.12s ease, color 0.12s ease;
}
.dshwa-iconbtn:hover { background: var(--wa-hover); color: var(--wa-text); }
.dshwa-iconbtn:disabled, .dshwa-iconbtn[aria-disabled="true"] { opacity: 0.4; cursor: not-allowed; }
.dshwa-iconbtn:disabled:hover, .dshwa-iconbtn[aria-disabled="true"]:hover { background: transparent; color: var(--wa-text-2); }
.dshwa-iconbtn[data-size="sm"] { width: 32px; height: 32px; }

.dshwa-avatar {
  width: 49px; height: 49px; border-radius: 50%; flex: 0 0 auto;
  display: flex; align-items: center; justify-content: center;
  background: var(--wa-avatar-bg); color: var(--wa-avatar-text);
  font-weight: 600; font-size: 16px; letter-spacing: 0.02em; text-transform: uppercase;
  overflow: hidden; position: relative; user-select: none;
}
.dshwa-avatar[data-size="sm"] { width: 40px; height: 40px; font-size: 14px; }
.dshwa-avatar[data-size="xs"] { width: 32px; height: 32px; font-size: 12px; }
.dshwa-avatar[data-size="lg"] { width: 72px; height: 72px; font-size: 22px; }
.dshwa-avatar img { width: 100%; height: 100%; object-fit: cover; }

.dshwa-banner {
  display: flex; gap: 10px; align-items: center; flex: 0 0 auto;
  padding: 8px 14px; font-size: 13px; background: var(--wa-warn-bg); color: var(--wa-warn-text);
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
}
.dshwa-banner[data-tone="error"] { background: var(--wa-error-bg); color: var(--wa-error-text); }
.dshwa-banner[data-tone="info"] { background: var(--wa-info-bg); color: var(--wa-info-text); }
.dshwa-banner-text { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.dshwa-banner-actions { display: flex; gap: 6px; align-items: center; flex: 0 0 auto; }
.dshwa-banner .dshwa-btn { padding: 5px 11px; font-size: 12px; }

.dshwa-incoming {
  display: flex; gap: 12px; align-items: center; flex: 0 0 auto;
  padding: 10px 16px; background: var(--wa-incoming-bg); color: #ffffff;
}
.dshwa-incoming-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.dshwa-incoming-title { font-weight: 600; font-size: 14px; }
.dshwa-incoming-sub { font-size: 12px; opacity: 0.9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dshwa-incoming .dshwa-btn { background: var(--wa-danger); }
.dshwa-incoming .dshwa-btn[data-variant="ghost"] { background: transparent; color: #ffffff; border-color: rgba(255, 255, 255, 0.5); }

.dshwa-rail {
  width: clamp(300px, 32%, 400px); min-width: 280px; flex: 0 0 auto;
  display: flex; flex-direction: column; min-height: 0;
  background: var(--wa-panel); border-right: 1px solid var(--wa-border);
}
.dshwa-rail-head {
  display: flex; align-items: center; gap: 10px; padding: 10px 12px;
  background: var(--wa-panel-2); border-bottom: 1px solid var(--wa-border); flex: 0 0 auto;
}
.dshwa-rail-me { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.dshwa-name { font-weight: 600; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dshwa-sub { font-size: 12px; color: var(--wa-text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dshwa-rail-status-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dshwa-live-pill {
  flex: 0 0 auto; max-width: 138px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  background: var(--wa-warn-bg); color: var(--wa-warn-text); font-size: 12px; line-height: 1.5;
  padding: 1px 8px; border-radius: 999px;
}
.dshwa-search { position: relative; padding: 8px 12px; background: var(--wa-panel); border-bottom: 1px solid var(--wa-border); flex: 0 0 auto; }
.dshwa-search svg { position: absolute; left: 25px; top: 50%; transform: translateY(-50%); color: var(--wa-text-2); pointer-events: none; }
.dshwa-search input {
  width: 100%; height: 36px; border-radius: 9px; border: 1px solid transparent;
  background: var(--wa-search-bg); color: var(--wa-text); padding: 0 12px 0 42px; font-size: 13px;
}
.dshwa-search input::placeholder { color: var(--wa-text-3); }
.dshwa-chatlist { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 2px 0; }
.dshwa-chatrow {
  display: flex; gap: 12px; align-items: center; width: 100%; padding: 9px 12px;
  border-bottom: 1px solid var(--wa-border-soft); position: relative;
  transition: background-color 0.1s ease;
}
.dshwa-chatrow:hover { background: var(--wa-hover); }
.dshwa-chatrow[data-active="true"] { background: var(--wa-active); }
.dshwa-chatrow-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.dshwa-chatrow-top { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.dshwa-chatrow-name { flex: 1 1 auto; min-width: 0; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dshwa-chatrow-time { flex: 0 0 auto; font-size: 12px; color: var(--wa-text-2); }
.dshwa-chatrow[data-unread="true"] .dshwa-chatrow-time { color: var(--wa-accent-strong); font-weight: 600; }
.dshwa-chatrow-bottom { display: flex; align-items: center; gap: 5px; min-width: 0; color: var(--wa-text-2); font-size: 13px; }
.dshwa-chatrow-preview { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dshwa-chatrow[data-unread="true"] .dshwa-chatrow-preview { color: var(--wa-text); }
.dshwa-chatrow-flags { display: flex; gap: 3px; align-items: center; flex: 0 0 auto; color: var(--wa-text-3); }
.dshwa-unread {
  min-width: 19px; height: 19px; padding: 0 5px; border-radius: 10px;
  background: var(--wa-unread-bg); color: #ffffff; font-size: 12px; font-weight: 700;
  display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto;
}
.dshwa-chatrow[data-muted="true"] .dshwa-unread { background: var(--wa-text-3); }

.dshwa-main { flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; flex-direction: column; position: relative; }
.dshwa-thread { flex: 1 1 auto; display: flex; flex-direction: column; min-height: 0; position: relative; background-color: var(--wa-chat-bg); }
.dshwa-thread[data-pattern="true"] {
  background-image:
    radial-gradient(circle at 50% 50%, var(--wa-chat-dot) 1px, transparent 1.6px),
    radial-gradient(circle at 50% 50%, var(--wa-chat-dot) 1px, transparent 1.6px);
  background-size: 44px 44px, 62px 62px;
  background-position: 0 0, 22px 28px;
}
.dshwa-thread-head {
  display: flex; align-items: center; gap: 10px; padding: 7px 12px; min-height: 59px;
  background: var(--wa-panel); border-bottom: 1px solid var(--wa-border); flex: 0 0 auto; z-index: 3;
}
.dshwa-thread-head-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.dshwa-thread-title { font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dshwa-thread-sub { font-size: 12px; color: var(--wa-text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dshwa-thread-sub[data-typing="true"] { color: var(--wa-accent-strong); }
.dshwa-thread-actions { display: flex; align-items: center; gap: 2px; flex: 0 0 auto; }
.dshwa-call-unavailable { display: inline-flex; }

.dshwa-msgs { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; padding: 12px 6% 8px; }
.dshwa-msgs-inner { width: 100%; max-width: 1120px; margin: 0 auto; display: flex; flex-direction: column; gap: 2px; }
.dshwa-day {
  align-self: center; margin: 10px 0 8px; background: var(--wa-day-bg); color: var(--wa-day-text);
  font-size: 12px; padding: 5px 12px; border-radius: 8px; box-shadow: var(--wa-shadow-sm);
}
.dshwa-history-loader { align-self: center; margin: 6px 0 10px; }
.dshwa-history-loader .dshwa-btn { font-size: 12.5px; }
.dshwa-msg { display: flex; width: 100%; margin: 1px 0; }
.dshwa-msg[data-mine="true"] { justify-content: flex-end; }
.dshwa-msg[data-system="true"] { justify-content: center; margin: 8px 0; }
.dshwa-system-pill {
  background: var(--wa-day-bg); color: var(--wa-day-text); font-size: 12px;
  padding: 6px 12px; border-radius: 8px; box-shadow: var(--wa-shadow-sm); max-width: 86%;
  text-align: center; overflow-wrap: anywhere;
}
.dshwa-bubble-wrap { position: relative; display: flex; align-items: flex-start; gap: 6px; max-width: min(78%, 560px); }
.dshwa-msg[data-media="true"] .dshwa-bubble-wrap { max-width: min(56%, 460px); }
.dshwa-msg[data-mine="true"] .dshwa-bubble-wrap { flex-direction: row-reverse; }
.dshwa-bubble {
  position: relative; min-width: 76px; padding: 6px 8px 6px 9px; border-radius: 8px;
  box-shadow: var(--wa-shadow-sm); overflow-wrap: anywhere; word-break: break-word;
}
.dshwa-msg[data-mine="false"] .dshwa-bubble { background: var(--wa-in); border-top-left-radius: 2px; }
.dshwa-msg[data-mine="true"] .dshwa-bubble { background: var(--wa-out); border-top-right-radius: 2px; }
.dshwa-msg[data-mine="false"] .dshwa-bubble::before,
.dshwa-msg[data-mine="true"] .dshwa-bubble::before {
  content: ""; position: absolute; top: 0; width: 0; height: 0;
  border-bottom: 8px solid transparent;
}
.dshwa-msg[data-mine="false"] .dshwa-bubble::before { left: -7px; border-right: 7px solid var(--wa-in); }
.dshwa-msg[data-mine="true"] .dshwa-bubble::before { right: -7px; border-left: 7px solid var(--wa-out); }
.dshwa-bubble[data-sticker="true"] { background: transparent !important; box-shadow: none; padding: 0; }
.dshwa-bubble[data-sticker="true"]::before { display: none; }
.dshwa-bubble-text { white-space: pre-wrap; font-size: 14px; line-height: 1.4; padding: 1px 2px 0; }
.dshwa-bubble-meta {
  display: flex; align-items: center; justify-content: flex-end; gap: 4px;
  font-size: 12px; color: var(--wa-meta); margin-top: 2px; padding-right: 1px; user-select: none;
}
.dshwa-bubble-meta .dshwa-edited { margin-right: auto; font-style: italic; color: var(--wa-meta); }
.dshwa-receipt { display: inline-flex; align-items: center; color: var(--wa-text-3); }
.dshwa-receipt[data-status="read"], .dshwa-receipt[data-status="played"] { color: var(--wa-blue); }
.dshwa-receipt[data-status="error"] { color: var(--wa-danger); }
.dshwa-receipt[data-status="pending"] { color: var(--wa-text-3); }

.dshwa-quoted {
  display: flex; flex-direction: column; gap: 1px; margin: 2px 2px 5px;
  padding: 5px 8px; border-left: 4px solid var(--wa-accent);
  background: rgba(0, 0, 0, 0.055); border-radius: 5px; cursor: pointer; min-width: 0;
}
.dshwa[data-theme="dark"] .dshwa-quoted { background: rgba(255, 255, 255, 0.06); }
.dshwa-quoted-author { font-size: 12px; font-weight: 600; color: var(--wa-quote-author); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dshwa-quoted-text { font-size: 12px; color: var(--wa-quote-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.dshwa-media { margin: 0 -3px 4px; border-radius: 6px; overflow: hidden; position: relative; background: rgba(0, 0, 0, 0.05); }
.dshwa-media img { display: block; width: 100%; max-height: 320px; object-fit: cover; cursor: zoom-in; }
.dshwa-media[data-kind="sticker"] img { max-height: 160px; max-width: 160px; object-fit: contain; cursor: zoom-in; background: transparent; }
.dshwa-media video { display: block; width: 100%; max-height: 320px; background: #000; }
.dshwa-media-play {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.18); color: #ffffff; border: 0;
}
.dshwa-media-play span {
  display: inline-flex; align-items: center; justify-content: center; width: 54px; height: 54px;
  border-radius: 50%; background: rgba(0, 0, 0, 0.5);
}
.dshwa-filecard {
  display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 7px;
  background: rgba(0, 0, 0, 0.05); margin-bottom: 4px; text-decoration: none; color: inherit;
}
.dshwa[data-theme="dark"] .dshwa-filecard { background: rgba(255, 255, 255, 0.06); }
.dshwa-filecard:hover { background: rgba(0, 0, 0, 0.09); }
.dshwa[data-theme="dark"] .dshwa-filecard:hover { background: rgba(255, 255, 255, 0.1); }
.dshwa-filecard-body { min-width: 0; display: flex; flex-direction: column; }
.dshwa-filecard-name { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dshwa-filecard-meta { font-size: 12px; color: var(--wa-meta); }
.dshwa-audio { display: flex; align-items: center; gap: 8px; padding: 4px 2px; min-width: 220px; }
.dshwa-audio audio { width: 100%; height: 34px; }
.dshwa-location { display: flex; gap: 8px; align-items: flex-start; padding: 4px 2px; }
.dshwa-location-name { font-weight: 600; font-size: 13px; }
.dshwa-location-address { font-size: 12px; color: var(--wa-text-2); }
.dshwa-contactcard { display: flex; gap: 10px; align-items: center; padding: 6px 2px; }
.dshwa-contactcard-name { font-weight: 600; font-size: 13px; }
.dshwa-contactcard-sub { font-size: 12px; color: var(--wa-text-2); }
.dshwa-callevent { display: flex; gap: 8px; align-items: center; padding: 4px 2px; font-size: 13px; }
.dshwa-deleted { font-style: italic; color: var(--wa-text-2); font-size: 13px; }
.dshwa-kindicon { color: var(--wa-text-3); }

.dshwa-msg-actions {
  display: flex; align-items: center; gap: 2px; padding-top: 4px; opacity: 0;
  transition: opacity 0.12s ease; align-self: center;
}
.dshwa-msg:hover .dshwa-msg-actions, .dshwa-msg:focus-within .dshwa-msg-actions { opacity: 1; }
.dshwa-msg-actions .dshwa-iconbtn { width: 28px; height: 28px; color: var(--wa-text-2); background: var(--wa-panel); box-shadow: var(--wa-shadow-sm); }
.dshwa-msg[data-mine="true"] .dshwa-msg-actions { order: -1; }
.dshwa-jump {
  position: sticky; bottom: 8px; align-self: flex-end; display: inline-flex; align-items: center; gap: 6px;
  background: var(--wa-panel); color: var(--wa-text); border-radius: 999px; padding: 7px 13px;
  font-size: 12.5px; box-shadow: var(--wa-shadow-md); z-index: 4; margin-top: auto;
}
.dshwa-thread-empty {
  flex: 1 1 auto; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 8px; padding: 28px; text-align: center; color: var(--wa-text-2);
}
.dshwa-thread-empty-title { font-size: 16px; font-weight: 600; color: var(--wa-text); }

.dshwa-composer { flex: 0 0 auto; background: var(--wa-panel-2); border-top: 1px solid var(--wa-border); padding: 8px 12px 12px; position: relative; }
.dshwa-compose-row {
  display: flex; align-items: flex-end; gap: 6px; background: var(--wa-panel);
  border-radius: 12px; padding: 5px 6px; box-shadow: var(--wa-shadow-sm); position: relative;
}
.dshwa-compose-row[data-dragover="true"] { outline: 2px dashed var(--wa-accent); outline-offset: -4px; }
.dshwa-compose-input {
  flex: 1 1 auto; min-width: 0; border: 0; background: transparent; color: var(--wa-text);
  resize: none; min-height: 38px; max-height: 140px; padding: 9px 4px; font-size: 14px;
  line-height: 1.4; outline: none;
}
.dshwa-compose-input::placeholder { color: var(--wa-text-3); }
.dshwa-compose-send {
  width: 42px; height: 42px; border-radius: 50%; background: var(--wa-accent); color: #ffffff;
  display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto;
}
.dshwa-compose-send:disabled { background: var(--wa-panel-2); color: var(--wa-text-3); }
.dshwa-replybar {
  display: flex; align-items: center; gap: 9px; margin: 0 4px 6px; padding: 6px 10px;
  border-left: 4px solid var(--wa-accent); background: var(--wa-panel); border-radius: 6px;
}
.dshwa-replybar-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.dshwa-replybar-title { font-size: 12px; font-weight: 600; color: var(--wa-accent-strong); }
.dshwa-replybar-text { font-size: 12.5px; color: var(--wa-text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dshwa-attach-chip {
  display: flex; align-items: center; gap: 9px; margin: 0 4px 6px; padding: 7px 10px;
  background: var(--wa-panel); border-radius: 8px; box-shadow: var(--wa-shadow-sm);
}
.dshwa-attach-thumb { width: 38px; height: 38px; border-radius: 5px; object-fit: cover; background: var(--wa-panel-2); }
.dshwa-attach-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.dshwa-attach-name { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dshwa-attach-meta { font-size: 11.5px; color: var(--wa-text-2); }
.dshwa-composer-error {
  display: flex; align-items: center; gap: 10px; margin: 0 4px 6px; padding: 7px 10px;
  background: var(--wa-error-bg); color: var(--wa-error-text); border-radius: 8px; font-size: 12.5px;
}
.dshwa-composer-error span { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.dshwa-composer-hint { margin: 6px 4px 0; font-size: 12px; color: var(--wa-text-2); text-align: center; }

.dshwa-emoji {
  position: absolute; left: 6px; bottom: calc(100% + 8px); z-index: 12;
  width: 292px; max-width: calc(100vw - 24px); background: var(--wa-panel);
  border: 1px solid var(--wa-border); border-radius: 12px; box-shadow: var(--wa-shadow-lg); padding: 8px;
}
.dshwa-emoji-grid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 2px; max-height: 208px; overflow-y: auto; }
.dshwa-emoji-grid button { font-size: 20px; line-height: 1; padding: 6px; border-radius: 8px; text-align: center; }
.dshwa-emoji-grid button:hover { background: var(--wa-hover); }

.dshwa-welcome {
  flex: 1 1 auto; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 14px; padding: 32px; text-align: center; background: var(--wa-panel-2);
  border-bottom: 5px solid var(--wa-accent);
}
.dshwa-welcome-logo { color: var(--wa-accent); opacity: 0.9; }
.dshwa-welcome-title { font-size: 26px; font-weight: 300; margin: 0; color: var(--wa-text); }
.dshwa-welcome-body { font-size: 14px; color: var(--wa-text-2); max-width: 480px; margin: 0; }
.dshwa-welcome-list { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 7px; max-width: 520px; text-align: left; }
.dshwa-welcome-list li { display: flex; gap: 9px; align-items: flex-start; font-size: 13px; color: var(--wa-text-2); }
.dshwa-welcome-list svg { margin-top: 2px; color: var(--wa-accent); }
.dshwa-welcome-foot { font-size: 12px; color: var(--wa-text-2); margin-top: 10px; }

.dshwa-center-screen {
  flex: 1 1 auto; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 14px; padding: 32px 24px; text-align: center; background: var(--wa-bg); overflow-y: auto;
}
.dshwa-card {
  width: 100%; max-width: 560px; background: var(--wa-panel); border-radius: 14px;
  box-shadow: var(--wa-shadow-md); padding: 26px 28px; display: flex; flex-direction: column;
  gap: 14px; align-items: center; text-align: center; color: var(--wa-text);
}
.dshwa-card h1 { font-size: 21px; font-weight: 600; margin: 0; }
.dshwa-card p { margin: 0; font-size: 13px; color: var(--wa-text-2); line-height: 1.5; }
.dshwa-card-actions { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; margin-top: 4px; }
.dshwa-qr-frame {
  width: 264px; height: 264px; max-width: 100%; background: #ffffff; border-radius: 12px;
  padding: 10px; display: flex; align-items: center; justify-content: center; position: relative;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.06); flex: 0 0 auto;
}
.dshwa-qr-frame img { width: 100%; height: 100%; object-fit: contain; display: block; }
.dshwa-qr-expired {
  position: absolute; inset: 0; border-radius: 12px; background: rgba(255, 255, 255, 0.9); color: #111b21;
  display: flex; align-items: center; justify-content: center; text-align: center; padding: 20px;
  font-size: 13.5px; font-weight: 600;
}
.dshwa-qr-waiting { display: flex; flex-direction: column; align-items: center; gap: 10px; color: #54656f; font-size: 12px; text-align: center; }
.dshwa-steps { list-style: none; margin: 2px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; width: 100%; text-align: left; }
.dshwa-steps li { display: flex; gap: 10px; align-items: flex-start; font-size: 13px; color: var(--wa-text-2); line-height: 1.45; }
.dshwa-step-n {
  flex: 0 0 auto; width: 22px; height: 22px; border-radius: 50%; background: var(--wa-accent-soft);
  color: var(--wa-step-text); font-size: 12px; font-weight: 700; display: inline-flex;
  align-items: center; justify-content: center; margin-top: 1px;
}
.dshwa-risk {
  width: 100%; text-align: left; border: 1px solid rgba(234, 179, 8, 0.4); border-radius: 10px;
  background: var(--wa-warn-bg); color: var(--wa-warn-text); padding: 11px 13px; font-size: 12px; line-height: 1.5;
}
.dshwa-risk strong { display: block; margin-bottom: 3px; font-size: 13px; }
.dshwa-note { font-size: 12px; color: var(--wa-text-3); line-height: 1.5; }

.dshwa-scrim {
  position: fixed; inset: 0; z-index: 40; background: rgba(0, 0, 0, 0.45);
  display: flex; justify-content: flex-end;
}
.dshwa-sheet {
  width: min(430px, 100%); height: 100%; background: var(--wa-panel); color: var(--wa-text);
  display: flex; flex-direction: column; box-shadow: var(--wa-shadow-lg);
  border-left: 1px solid var(--wa-border);
}
.dshwa-sheet-head {
  display: flex; align-items: center; gap: 10px; padding: 14px 16px 12px;
  border-bottom: 1px solid var(--wa-border); background: var(--wa-panel-2); flex: 0 0 auto;
}
.dshwa-sheet-head h2 { flex: 1 1 auto; margin: 0; font-size: 16.5px; font-weight: 600; }
.dshwa-sheet-body { flex: 1 1 auto; overflow-y: auto; padding: 6px 18px 30px; overscroll-behavior: contain; }
.dshwa-section { margin-top: 18px; }
.dshwa-section h3 {
  font-size: 12px; font-weight: 700; color: var(--wa-text-2); text-transform: uppercase;
  letter-spacing: 0.05em; margin: 0 0 7px;
}
.dshwa-panelbox {
  background: var(--wa-panel-3); border: 1px solid var(--wa-border); border-radius: 10px;
  padding: 11px 13px; font-size: 13px; line-height: 1.5; color: var(--wa-text-2); overflow-wrap: anywhere;
}
.dshwa-kv { display: flex; justify-content: space-between; gap: 14px; font-size: 13px; padding: 3.5px 0; }
.dshwa-kv-k { color: var(--wa-text-2); flex: 0 0 auto; }
.dshwa-kv-v { text-align: right; min-width: 0; overflow-wrap: anywhere; color: var(--wa-text); }
.dshwa-badge {
  display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 999px;
  background: var(--wa-accent-soft); color: var(--wa-badge-text); font-size: 12px; font-weight: 600;
}
.dshwa-badge[data-tone="warn"] { background: var(--wa-warn-bg); color: var(--wa-warn-text); }
.dshwa-badge[data-tone="muted"] { background: var(--wa-panel-2); color: var(--wa-text-2); }
.dshwa-confirm {
  margin-top: 8px; padding: 11px 12px; border-radius: 10px; background: var(--wa-error-bg);
  color: var(--wa-error-text); font-size: 12px; line-height: 1.5;
}
.dshwa-confirm-actions { display: flex; gap: 8px; margin-top: 9px; flex-wrap: wrap; }
.dshwa-sheet-actions { display: flex; flex-direction: column; gap: 8px; margin-top: 18px; }
.dshwa-sheet-actions .dshwa-btn { justify-content: center; }
.dshwa-check { display: flex; gap: 8px; align-items: flex-start; font-size: 12px; color: var(--wa-text-2); margin-top: 8px; }
.dshwa-check input { margin-top: 2px; accent-color: var(--wa-accent); }

.dshwa-lightbox {
  position: fixed; inset: 0; z-index: 60; background: rgba(0, 0, 0, 0.93);
  display: flex; flex-direction: column; color: #f7f9fa;
}
.dshwa-lightbox-bar { display: flex; align-items: center; gap: 10px; padding: 10px 14px; flex: 0 0 auto; }
.dshwa-lightbox-title { flex: 1 1 auto; min-width: 0; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dshwa-lightbox-bar .dshwa-iconbtn { color: #f7f9fa; }
.dshwa-lightbox-bar .dshwa-iconbtn:hover { background: rgba(255, 255, 255, 0.12); }
.dshwa-lightbox-body { flex: 1 1 auto; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 0 16px 24px; }
.dshwa-lightbox-body img, .dshwa-lightbox-body video { max-width: 100%; max-height: 100%; object-fit: contain; }
.dshwa-lightbox-link { color: #53bdeb; font-size: 13px; text-decoration: none; display: inline-flex; align-items: center; gap: 6px; }

.dshwa-toast {
  position: absolute; left: 50%; bottom: 26px; transform: translateX(-50%); z-index: 45;
  background: var(--wa-toast-bg); color: var(--wa-toast-text); padding: 10px 14px; border-radius: 9px;
  font-size: 13px; max-width: min(92%, 540px); box-shadow: var(--wa-shadow-lg);
  display: flex; gap: 10px; align-items: center; overflow-wrap: anywhere;
}
.dshwa-toast[data-kind="error"] { background: #7a0b22; color: #ffe4e8; }
.dshwa-toast button { color: inherit; opacity: 0.8; flex: 0 0 auto; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; border-radius: 6px; }
.dshwa-toast button:hover { opacity: 1; background: rgba(255, 255, 255, 0.12); }

.dshwa-spinner { width: 20px; height: 20px; border-radius: 50%; border: 2.5px solid var(--wa-border); border-top-color: var(--wa-accent); animation: dshwa-spin 0.8s linear infinite; }
.dshwa-spinner[data-size="lg"] { width: 34px; height: 34px; border-width: 3px; }
@keyframes dshwa-spin { to { transform: rotate(360deg); } }
.dshwa-empty { flex: 1 1 auto; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 34px 20px; text-align: center; color: var(--wa-text-2); }
.dshwa-empty-title { font-size: 15px; font-weight: 600; color: var(--wa-text); }
.dshwa-empty-body { font-size: 13px; max-width: 320px; }

@media (max-width: 720px) {
  .dshwa-rail { width: 100%; min-width: 0; border-right: 0; }
  .dshwa[data-mobile-thread="true"] .dshwa-rail { display: none; }
  .dshwa[data-mobile-thread="false"] .dshwa-main { display: none; }
  .dshwa[data-mobile-thread="true"] .dshwa-main { display: flex; }
  .dshwa-back { display: inline-flex; }
  .dshwa-msgs { padding: 10px 10px 6px; }
  .dshwa-bubble-wrap { max-width: 86%; }
  .dshwa-msg[data-media="true"] .dshwa-bubble-wrap { max-width: 78%; }
  .dshwa-composer { padding: 6px 8px 10px; }
  .dshwa-card { padding: 22px 18px; }
  .dshwa-welcome { border-bottom-width: 4px; padding: 24px 18px; }
  .dshwa-welcome-title { font-size: 22px; }
  .dshwa-thread-head { min-height: 54px; padding: 6px 8px; gap: 6px; }
}
@media (min-width: 721px) {
  .dshwa-back { display: none; }
}
@media (max-width: 400px) {
  .dshwa { font-size: 13.5px; }
  .dshwa-thread-title { font-size: 14px; }
  .dshwa-avatar { width: 44px; height: 44px; font-size: 14px; }
  .dshwa-rail-head { padding: 8px 10px; }
  .dshwa-thread-actions .dshwa-iconbtn { width: 34px; height: 34px; }
  .dshwa-composer-hint { display: none; }
}
@media (min-width: 1440px) {
  .dshwa-rail { width: 400px; }
  .dshwa-msgs { padding-left: 8%; padding-right: 8%; }
}
@media (prefers-reduced-motion: reduce) {
  .dshwa *, .dshwa *::before, .dshwa *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
    scroll-behavior: auto !important;
  }
}
`

    function ensureStyleTag() {
      try {
        if (typeof document === 'undefined' || !document.head) return
        if (document.getElementById('dsh-whatsapp-style') !== null) return
        const style = document.createElement('style')
        style.id = 'dsh-whatsapp-style'
        style.textContent = STYLE
        document.head.appendChild(style)
      } catch (error) {
        // Styling must never be able to fail the panel.
      }
    }

    // ── inline icon set (no external assets, currentColor) ─────────────────
    const ICONS = {
      whatsapp: [
        'M20.5 11.6a8.4 8.4 0 0 1-12.3 7.5L3.2 20.8l1.7-4.9A8.4 8.4 0 1 1 20.5 11.6z',
        'M8.9 8.4h1.3l.9 2-1.2 1.1a5.3 5.3 0 0 0 2.5 2.5l1.1-1.3 2 1v1.3c0 .5-.4.9-.9.9-3.7 0-6.6-3-6.6-6.6 0-.5.4-.9.9-.9z',
      ],
      search: ['M21 21l-4.35-4.35', 'M11 18.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15z'],
      back: ['M15 18l-6-6 6-6'],
      close: ['M18 6L6 18', 'M6 6l12 12'],
      phone: ['M21.5 16.9v2.6a2 2 0 0 1-2.2 2 19.7 19.7 0 0 1-8.6-3.1 19.4 19.4 0 0 1-6-6A19.7 19.7 0 0 1 1.6 3.8 2 2 0 0 1 3.6 1.6h2.6a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L7.2 9.4a16 16 0 0 0 6 6l1.2-1.2a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z'],
      'phone-off': ['M21.5 16.9v2.6a2 2 0 0 1-2.2 2 19.7 19.7 0 0 1-8.6-3.1 19.4 19.4 0 0 1-6-6A19.7 19.7 0 0 1 1.6 3.8 2 2 0 0 1 3.6 1.6h2.6a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L7.2 9.4a16 16 0 0 0 6 6l1.2-1.2a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z', 'M2 2l20 20'],
      video: ['M23 7.5l-7 5 7 5v-10z', 'M14.5 5.5H3a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h11.5a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2z'],
      settings: ['M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z', 'M19.1 14.6l1.8 1.4-1.8 3.1-2.2-.7a7.6 7.6 0 0 1-1.6.9l-.4 2.3h-3.6l-.4-2.3a7.6 7.6 0 0 1-1.6-.9l-2.2.7-1.8-3.1 1.8-1.4a7.8 7.8 0 0 1 0-1.9L4.9 11.3 6.7 8.2l2.2.7a7.6 7.6 0 0 1 1.6-.9l.4-2.3h3.6l.4 2.3a7.6 7.6 0 0 1 1.6.9l2.2-.7 1.8 3.1-1.8 1.4a7.8 7.8 0 0 1 0 1.9z'],
      attach: ['M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5'],
      emoji: ['M12 21.5a9.5 9.5 0 1 0 0-19 9.5 9.5 0 0 0 0 19z', 'M8.2 14s1.4 2 3.8 2 3.8-2 3.8-2', 'M9 9.5h.01', 'M15 9.5h.01'],
      send: ['M21.5 2.5L10.5 13.5', 'M21.5 2.5l-6.8 19-4.2-8.9-8.9-4.2 19.9-5.9z'],
      check: ['M20 6.5L9 17.5l-5-5'],
      'check-double': ['M1.5 12.5l4.4 4.4L15.5 7', 'M8.5 16.9l1.3 1.3L20.5 7.5'],
      clock: ['M12 21.5a9.5 9.5 0 1 0 0-19 9.5 9.5 0 0 0 0 19z', 'M12 6.5V12l3.5 2'],
      alert: ['M12 9v4.5', 'M12 17h.01', 'M10.3 3.9L1.9 18.1A2 2 0 0 0 3.6 21h16.8a2 2 0 0 0 1.7-2.9L13.7 3.9a2 2 0 0 0-3.4 0z'],
      info: ['M12 21.5a9.5 9.5 0 1 0 0-19 9.5 9.5 0 0 0 0 19z', 'M12 16.5V11', 'M12 7.5h.01'],
      download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'],
      reply: ['M9.5 17.5L4 12l5.5-5.5', 'M4 12h9.5a5.5 5.5 0 0 1 5.5 5.5v1'],
      copy: ['M9.5 9.5H19a2 2 0 0 1 2 2V19a2 2 0 0 1-2 2h-9.5a2 2 0 0 1-2-2v-7.5a2 2 0 0 1 2-2z', 'M5.5 15.5H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8.5a2 2 0 0 1 2 2v.5'],
      pin: ['M12 17.5V22', 'M9 2.5h6l-1 6 3 3v2H7v-2l3-3-1-6z'],
      muted: ['M18 8.5a6 6 0 0 0-11.6-2', 'M6 8.5c0 7-3 8.5-3 8.5h15', 'M13.7 20.5a2 2 0 0 1-3.4 0', 'M3 3l18 18'],
      group: ['M16.5 20.5v-1.8a4 4 0 0 0-4-4H5.5a4 4 0 0 0-4 4v1.8', 'M9 11.2a3.7 3.7 0 1 0 0-7.4 3.7 3.7 0 0 0 0 7.4z', 'M22.5 20.5v-1.8a4 4 0 0 0-3-3.9', 'M16 3.9a3.7 3.7 0 0 1 0 7.2'],
      image: ['M19 3.5H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-13a2 2 0 0 0-2-2z', 'M8.5 9.8a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6z', 'M21 15.5l-4.5-4.5L5.5 22'],
      file: ['M13.5 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-12l-6-5z', 'M13.5 2.5v6h6'],
      mic: ['M12 1.8a3 3 0 0 0-3 3v7.5a3 3 0 0 0 6 0V4.8a3 3 0 0 0-3-3z', 'M18.5 10v2.3a6.5 6.5 0 0 1-13 0V10', 'M12 18.8V22.5', 'M8.5 22.5h7'],
      location: ['M20.5 10.2c0 6.5-8.5 12.3-8.5 12.3S3.5 16.7 3.5 10.2a8.5 8.5 0 0 1 17 0z', 'M12 13.3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
      contact: ['M20 21.5v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2', 'M12 11.5a3.8 3.8 0 1 0 0-7.6 3.8 3.8 0 0 0 0 7.6z'],
      qr: ['M3 3h7v7H3z', 'M14 3h7v7h-7z', 'M3 14h7v7H3z', 'M14 14h3v3h-3z', 'M18.5 18.5H21V21h-2.5z'],
      lock: ['M12 21.5s7.5-3.7 7.5-9.5V5.5L12 2.5l-7.5 3V12c0 5.8 7.5 9.5 7.5 9.5z'],
      refresh: ['M22 4.5V10h-5.5', 'M2 19.5V14h5.5', 'M4 9.5a8.5 8.5 0 0 1 14-3.4L22 10', 'M20 14.5a8.5 8.5 0 0 1-14 3.4L2 14'],
      logout: ['M9.5 21.5H5a2 2 0 0 1-2-2v-15a2 2 0 0 1 2-2h4.5', 'M16.5 16.5L21 12l-4.5-4.5', 'M21 12H9.5'],
      chevronDown: ['M6 9l6 6 6-6'],
      play: ['M8 5.5l11 6.5-11 6.5v-13z'],
      pinOff: ['M3 3l18 18'],
      dot: ['M12 12h.01'],
    }

    function Icon(props) {
      const name = props && props.name
      const paths = ICONS[name] || ICONS.info
      const size = props && typeof props.size === 'number' ? props.size : 20
      const strokeWidth = props && typeof props.strokeWidth === 'number' ? props.strokeWidth : 1.7
      const children = paths.map((d, index) => h('path', { key: 'p' + index, d: d }))
      return h('svg', {
        'aria-hidden': 'true',
        focusable: 'false',
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: strokeWidth,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        className: props && props.className ? props.className : undefined,
      }, children)
    }

    function Spinner(props) {
      return h('span', {
        className: 'dshwa-spinner',
        'data-size': props && props.size ? props.size : undefined,
        role: 'progressbar',
        'aria-label': 'Loading',
      })
    }

    function Avatar(props) {
      const name = props && props.name ? props.name : ''
      const size = props && props.size ? props.size : undefined
      const isGroup = props && props.isGroup === true
      const seed = props && props.seed ? props.seed : name
      return h('span', {
        className: 'dshwa-avatar',
        'data-size': size,
        style: { background: avatarColor(seed) },
        'aria-hidden': 'true',
      }, isGroup ? h(Icon, { name: 'group', size: 22 }) : initials(name))
    }

    function IconButton(props) {
      const buttonProps = {
        type: 'button',
        className: 'dshwa-iconbtn',
        'data-size': props && props.size === 'sm' ? 'sm' : undefined,
        'aria-label': props && props.label ? props.label : undefined,
        title: props && props.title ? props.title : (props && props.label ? props.label : undefined),
        onClick: props && props.onClick ? props.onClick : undefined,
      }
      if (props && props.testid) buttonProps['data-testid'] = props.testid
      if (props && props.disabled === true) {
        buttonProps.disabled = true
        buttonProps['aria-disabled'] = 'true'
      }
      if (props && props.describedBy) buttonProps['aria-describedby'] = props.describedBy
      if (props && props.pressed !== undefined) buttonProps['aria-pressed'] = props.pressed ? 'true' : 'false'
      return h('button', buttonProps, props && props.children ? props.children : null)
    }

    // ── shared hooks ───────────────────────────────────────────────────────
    function useEscapeKey(active, onEscape) {
      React.useEffect(() => {
        if (!active) return undefined
        const handler = (event) => {
          if (event && event.key === 'Escape') onEscape()
        }
        try { document.addEventListener('keydown', handler) } catch (error) { /* ignore */ }
        return () => {
          try { document.removeEventListener('keydown', handler) } catch (error) { /* ignore */ }
        }
      }, [active, onEscape])
    }

    function useInterval(callback, delay) {
      const savedRef = React.useRef(callback)
      React.useEffect(() => { savedRef.current = callback }, [callback])
      React.useEffect(() => {
        if (delay === null || delay === undefined) return undefined
        const timer = setInterval(() => { savedRef.current() }, delay)
        return () => clearInterval(timer)
      }, [delay])
    }

    // ── screens shown instead of the chat UI ───────────────────────────────
    function CenterScreen(props) {
      return h('div', { className: 'dshwa-center-screen', 'data-testid': props.testid }, props.children)
    }

    function LoadingScreen() {
      return h(CenterScreen, { testid: 'loading-screen' },
        h('div', { className: 'dshwa-card' },
          h('div', { className: 'dshwa-welcome-logo' }, h(Icon, { name: 'whatsapp', size: 42 })),
          h(Spinner, { size: 'lg' }),
          h('h1', null, tx('loading.title')),
          h('p', null, tx('loading.body')),
        ),
      )
    }

    function AuthErrorScreen(props) {
      return h(CenterScreen, { testid: 'auth-error' },
        h('div', { className: 'dshwa-card', role: 'alert' },
          h(Icon, { name: 'lock', size: 34 }),
          h('h1', null, tx('auth.title')),
          h('p', null, tx('auth.body', { status: props.status || 401 })),
          h('div', { className: 'dshwa-card-actions' },
            h('button', { type: 'button', className: 'dshwa-btn', onClick: props.onRetry, 'data-testid': 'auth-retry' }, tx('auth.retry')),
          ),
        ),
      )
    }

    function ServiceErrorScreen(props) {
      return h(CenterScreen, { testid: 'service-error' },
        h('div', { className: 'dshwa-card', role: 'alert' },
          h(Icon, { name: 'alert', size: 34 }),
          h('h1', null, tx('service.title')),
          h('p', null, tx('service.body', { detail: props.detail || 'no response' })),
          props.detail !== '' ? h('p', { className: 'dshwa-note' }, props.detail) : null,
          h('div', { className: 'dshwa-card-actions' },
            h('button', { type: 'button', className: 'dshwa-btn', onClick: props.onRetry, 'data-testid': 'service-retry' }, tx('service.retry')),
            h('button', { type: 'button', className: 'dshwa-btn', 'data-variant': 'ghost', onClick: props.onSettings }, tx('chat.openSettings')),
          ),
        ),
      )
    }

    function StepList() {
      const steps = ['link.step1', 'link.step2', 'link.step3', 'link.step4']
      return h('ol', { className: 'dshwa-steps' }, steps.map((key, index) => (
        h('li', { key: key },
          h('span', { className: 'dshwa-step-n', 'aria-hidden': 'true' }, String(index + 1)),
          h('span', null, tx(key)),
        )
      )))
    }

    function LinkScreen(props) {
      const [expired, setExpired] = React.useState(false)
      React.useEffect(() => {
        setExpired(false)
        if (!props.qr) return undefined
        const timer = setTimeout(() => setExpired(true), QR_TTL_MS)
        return () => clearTimeout(timer)
      }, [props.qr])
      const busy = props.busy === 'link'
      const hasQr = typeof props.qr === 'string' && props.qr !== ''
      const errorMessage = props.error || (props.state && props.state.lastError ? props.state.lastError.message : '')
      const connection = props.state ? props.state.connection : 'idle'
      return h(CenterScreen, { testid: 'link-screen' },
        h('div', { className: 'dshwa-card', 'data-testid': 'link-card' },
          h('div', { className: 'dshwa-welcome-logo' }, h(Icon, { name: 'whatsapp', size: 44 })),
          h('h1', null, tx('link.title')),
          h('p', null, tx('link.subtitle')),
          h('div', { className: 'dshwa-qr-frame' },
            hasQr
              ? h('img', { src: props.qr, alt: tx('link.qrAlt'), 'data-testid': 'qr-image' })
              : h('div', { className: 'dshwa-qr-waiting', 'data-testid': 'qr-placeholder' },
                h(Spinner, null),
                h('span', null, tx('link.waiting')),
              ),
            hasQr && expired
              ? h('div', { className: 'dshwa-qr-expired', role: 'status' }, tx('link.expired'))
              : null,
          ),
          h('p', { className: 'dshwa-note' }, tx('link.expires')),
          h(StepList, null),
          h('div', { className: 'dshwa-risk', 'data-testid': 'risk-notice', role: 'note' },
            h('strong', null, tx('link.riskTitle')),
            tx('link.risk'),
          ),
          h('p', { className: 'dshwa-note' }, tx('link.storage')),
          errorMessage !== ''
            ? h('div', { className: 'dshwa-confirm', role: 'alert' },
              tx('link.error', { message: truncate(errorMessage, 220) }),
            )
            : null,
          h('div', { className: 'dshwa-card-actions' },
            h('button', {
              type: 'button',
              className: 'dshwa-btn',
              'data-testid': 'link-button',
              disabled: busy,
              onClick: props.onStart,
            }, busy ? tx('link.busy') : (hasQr ? tx('link.refresh') : tx('link.start'))),
            (hasQr || connection === 'qr' || connection === 'starting')
              ? h('button', {
                type: 'button',
                className: 'dshwa-btn',
                'data-variant': 'ghost',
                'data-testid': 'cancel-link-button',
                disabled: busy,
                onClick: props.onCancel,
              }, tx('link.cancel'))
              : null,
          ),
          h('p', { className: 'dshwa-note' }, tx('link.sessionNote')),
        ),
      )
    }

    function RelinkScreen(props) {
      const busy = props.busy === 'relink'
      const reason = props.state && props.state.lastError && props.state.lastError.message
        ? props.state.lastError.message
        : (props.state && props.state.connection === 'loggedOut' ? 'logged out' : 'session expired')
      return h(CenterScreen, { testid: 'relink-screen' },
        h('div', { className: 'dshwa-card' },
          h(Icon, { name: 'phone-off', size: 36 }),
          h('h1', null, tx('relink.title')),
          h('p', null, tx('relink.body')),
          h('p', { className: 'dshwa-note' }, tx('relink.reason', { reason: truncate(reason, 200) })),
          h('div', { className: 'dshwa-card-actions' },
            h('button', {
              type: 'button',
              className: 'dshwa-btn',
              'data-testid': 'relink-button',
              disabled: busy,
              onClick: props.onRelink,
            }, busy ? tx('relink.busy') : tx('relink.button')),
            h('button', { type: 'button', className: 'dshwa-btn', 'data-variant': 'ghost', onClick: props.onSettings }, tx('common.settings')),
          ),
        ),
      )
    }

    function ConnectionBanner(props) {
      const state = props.state
      if (!state || state.linked !== true) return null
      if (state.connection === 'online' && state.needsRelink !== true) return null
      let tone = 'info'
      let message = ''
      let showReconnect = false
      let showRelink = false
      showRelink = state.needsRelink === true
      if (state.needsRelink === true) {
        tone = 'error'
        message = tx('relink.body')
      } else if (state.connection === 'offline') {
        tone = 'error'
        message = tx('connection.offline')
        showReconnect = true
        showRelink = true
        if (typeof props.reconnectInMs === 'number') {
          const seconds = Math.max(0, Math.ceil(props.reconnectInMs / 1000))
          message += ' ' + tx('connection.reconnectIn', { seconds: seconds })
        }
      } else if (state.connection === 'error') {
        tone = 'error'
        message = tx('connection.error')
        if (state.lastError && state.lastError.message) message += ' ' + truncate(state.lastError.message, 160)
        showReconnect = true
        showRelink = true
      } else if (state.connection === 'starting' || state.connection === 'connecting' || state.connection === 'idle' || state.connection === 'qr') {
        message = state.connection === 'starting' ? tx('connection.starting') : tx('connection.connecting')
        showReconnect = true
        showRelink = true
      } else {
        return null
      }
      const attempt = state.reconnectAttempt > 0 ? tx('connection.attempt', { n: state.reconnectAttempt }) : ''
      const busy = props.busy === 'reconnect' || props.busy === 'relink'
      return h('div', {
        className: 'dshwa-banner',
        'data-testid': 'connection-banner',
        'data-tone': tone,
        role: 'status',
        'aria-live': 'polite',
        'aria-label': tx('connection.label'),
      },
      h(Icon, { name: state.connection === 'offline' || state.needsRelink ? 'alert' : 'info', size: 17 }),
      h('div', { className: 'dshwa-banner-text' }, message + (attempt !== '' ? ' · ' + attempt : '')),
      h('div', { className: 'dshwa-banner-actions' },
        showReconnect
          ? h('button', {
            type: 'button',
            className: 'dshwa-btn',
            'data-size': 'sm',
            'data-testid': 'reconnect-button',
            disabled: busy,
            onClick: props.onReconnect,
          }, tx('connection.reconnect'))
          : null,
        showRelink
          ? h('button', {
            type: 'button',
            className: 'dshwa-btn',
            'data-variant': 'ghost',
            'data-size': 'sm',
            'data-testid': 'relink-button',
            disabled: busy,
            onClick: props.onRelink,
          }, tx('connection.relink'))
          : null,
      ),
      )
    }

    function IncomingCallBanner(props) {
      const call = props.call
      if (!call) return null
      const busy = props.busy === 'reject-call'
      const kindKey = call.isVideo ? 'call.kindVideo' : 'call.kindVoice'
      const caller = props.callerName || tx('call.unknownCaller')
      return h('div', {
        className: 'dshwa-incoming',
        'data-testid': 'incoming-call',
        role: 'status',
        'aria-live': 'assertive',
      },
      h(Icon, { name: call.isVideo ? 'video' : 'phone', size: 24 }),
      h('div', { className: 'dshwa-incoming-text' },
        h('span', { className: 'dshwa-incoming-title' }, tx('call.incomingTitle', { kind: tx(kindKey) })),
        h('span', { className: 'dshwa-incoming-sub' }, tx('call.caller', { name: caller }) + ' · ' + tx('call.timeout')),
      ),
      h('button', {
        type: 'button',
        className: 'dshwa-btn',
        'data-variant': 'ghost',
        'data-testid': 'answer-call',
        disabled: true,
        'aria-disabled': 'true',
        title: tx('call.answerUnavailable'),
      }, tx('call.answer')),
      h('button', {
        type: 'button',
        className: 'dshwa-btn',
        'data-testid': 'reject-call',
        'aria-label': tx('call.rejectAria'),
        disabled: busy,
        onClick: props.onReject,
      }, tx('call.reject')),
      )
    }

    function Toast(props) {
      if (!props.toast) return null
      return h('div', {
        className: 'dshwa-toast',
        'data-testid': 'toast',
        'data-kind': props.toast.kind || 'info',
        role: 'status',
        'aria-live': 'polite',
      },
      h('span', null, props.toast.text),
      h('button', { type: 'button', 'aria-label': tx('common.dismiss'), onClick: props.onDismiss }, h(Icon, { name: 'close', size: 15 })),
      )
    }

    // ── chat rail (in-page conversation list) ──────────────────────────────
    function lastMessagePreview(chat) {
      const last = chat.lastMessage
      if (!last) return ''
      const kindLabel = last.kind !== 'text' ? tx('msg.' + last.kind) : ''
      const body = last.text !== '' ? last.text : kindLabel
      const text = body !== '' ? body : tx('msg.unknown')
      return last.fromMe === true ? tx('rail.lastFromYou', { text: text }) : text
    }

    function lastKindIconName(kind) {
      if (kind === 'image' || kind === 'sticker') return 'image'
      if (kind === 'video') return 'video'
      if (kind === 'audio') return 'mic'
      if (kind === 'document') return 'file'
      if (kind === 'location') return 'location'
      if (kind === 'contact') return 'contact'
      if (kind === 'call') return 'phone'
      if (kind === 'system') return 'info'
      return null
    }

    function ChatFlags(props) {
      const chat = props.chat
      const kindIcon = chat.lastMessage ? lastKindIconName(chat.lastMessage.kind) : null
      return h(React.Fragment, null,
        kindIcon !== null
          ? h('span', { className: 'dshwa-kindicon', title: chat.lastMessage.kind === 'text' ? undefined : tx('msg.' + chat.lastMessage.kind) }, h(Icon, { name: kindIcon, size: 14 }))
          : null,
        chat.pinned ? h('span', { className: 'dshwa-kindicon', title: tx('rail.pinned') }, h(Icon, { name: 'pin', size: 14 })) : null,
        chat.muted ? h('span', { className: 'dshwa-kindicon', title: tx('rail.muted') }, h(Icon, { name: 'muted', size: 14 })) : null,
        chat.lastMessage && chat.lastMessage.fromMe
          ? h(Receipt, { status: props.lastStatus || 'sent', size: 15 })
          : null,
      )
    }

    function ChatRowView(props) {
      const chat = props.chat
      const unread = chat.unread > 0
      const preview = lastMessagePreview(chat)
      const timeText = formatListTime(chat.timestamp)
      const typing = props.typing === true
      const labelParts = [chat.name]
      if (chat.isGroup) labelParts.push(tx('rail.group'))
      if (unread) labelParts.push(tx('rail.unread', { count: chat.unread }))
      if (chat.muted) labelParts.push(tx('rail.muted'))
      if (chat.pinned) labelParts.push(tx('rail.pinned'))
      labelParts.push(typing ? tx('thread.typing') : preview)
      if (timeText !== '') labelParts.push(timeText)
      return h('button', {
        type: 'button',
        className: 'dshwa-chatrow',
        'data-testid': 'chat-row',
        'data-chat-id': chat.id,
        'data-active': props.active ? 'true' : 'false',
        'data-unread': unread ? 'true' : 'false',
        'data-muted': chat.muted ? 'true' : 'false',
        'aria-label': labelParts.filter(Boolean).join(', '),
        'aria-current': props.active ? 'true' : undefined,
        onClick: () => props.onSelect(chat),
      },
      h(Avatar, { name: chat.name, isGroup: chat.isGroup, seed: chat.id }),
      h('div', { className: 'dshwa-chatrow-body' },
        h('div', { className: 'dshwa-chatrow-top' },
          h('span', { className: 'dshwa-chatrow-name' }, chat.name),
          h('span', { className: 'dshwa-chatrow-time' }, timeText),
        ),
        h('div', { className: 'dshwa-chatrow-bottom' },
          typing
            ? h('span', { className: 'dshwa-chatrow-preview' }, h('em', null, tx('thread.typing')))
            : h('span', { className: 'dshwa-chatrow-preview' }, preview),
          h('span', { className: 'dshwa-chatrow-flags' }, h(ChatFlags, { chat: chat, lastStatus: props.lastStatus })),
          unread
            ? h('span', { className: 'dshwa-unread', 'aria-hidden': 'true' }, chat.unread > 99 ? '99+' : String(chat.unread))
            : null,
        ),
      ),
      )
    }

    function RailEmpty(props) {
      if (props.loading) {
        return h('div', { className: 'dshwa-empty' }, h(Spinner, null), h('span', null, tx('common.loading')))
      }
      if (props.error) {
        return h('div', { className: 'dshwa-empty', role: 'alert' },
          h('span', { className: 'dshwa-empty-title' }, tx('empty.chatsError', { message: truncate(props.error, 200) })),
          h('button', { type: 'button', className: 'dshwa-btn', 'data-size': 'sm', onClick: props.onRetry }, tx('empty.retry')),
        )
      }
      if (props.query) {
        return h('div', { className: 'dshwa-empty' },
          h(Icon, { name: 'search', size: 26 }),
          h('span', { className: 'dshwa-empty-title' }, tx('rail.emptySearch', { query: truncate(props.query, 40) })),
        )
      }
      return h('div', { className: 'dshwa-empty' },
        h(Icon, { name: 'whatsapp', size: 30 }),
        h('span', { className: 'dshwa-empty-title' }, tx('rail.empty')),
        h('span', { className: 'dshwa-empty-body' }, tx('rail.emptyBody')),
      )
    }

    function ChatRail(props) {
      const statusLine = props.statusLine
      const me = props.me
      const polling = props.polling === true
      return h('div', { className: 'dshwa-rail', 'data-testid': 'chat-rail' },
        h('div', { className: 'dshwa-rail-head' },
          h(Avatar, { name: me && me.name ? me.name : 'You', size: 'sm', seed: me && me.id ? me.id : 'me' }),
          h('div', { className: 'dshwa-rail-me' },
            h('span', { className: 'dshwa-name' }, me && me.name ? me.name : 'WhatsApp'),
            h('div', { className: 'dshwa-rail-status-row' },
              h('span', { className: 'dshwa-sub', 'data-testid': 'rail-status' }, statusLine),
              polling
                ? h('span', {
                  className: 'dshwa-live-pill',
                  'data-testid': 'live-mode',
                  title: tx('toast.polling'),
                }, tx('toast.polling'))
                : null,
            ),
          ),
          h(IconButton, { label: tx('rail.refresh'), size: 'sm', onClick: props.onRefresh }, h(Icon, { name: 'refresh', size: 18 })),
          h(IconButton, { label: tx('common.settings'), testid: 'settings-button', onClick: props.onSettings }, h(Icon, { name: 'settings', size: 20 })),
        ),
        h('div', { className: 'dshwa-search' },
          h(Icon, { name: 'search', size: 17 }),
          h('input', {
            type: 'search',
            value: props.search,
            placeholder: tx('rail.searchPlaceholder'),
            'aria-label': tx('rail.searchLabel'),
            'data-testid': 'chat-search',
            onChange: (event) => props.onSearch(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Escape' && props.search !== '') {
                event.preventDefault()
                props.onSearch('')
              }
            },
          }),
        ),
        h('div', {
          className: 'dshwa-chatlist',
          'data-testid': 'chat-list',
          role: 'list',
          'aria-label': tx('common.search'),
        },
        props.chats.length === 0
          ? h(RailEmpty, {
            loading: props.loading,
            error: props.error,
            query: props.search,
            onRetry: props.onRetry,
          })
          : props.chats.map((chat) => h(ChatRowView, {
            key: chat.id,
            chat: chat,
            active: chat.id === props.activeChatId,
            typing: props.typingChatIds ? props.typingChatIds[chat.id] === true : false,
            lastStatus: props.lastStatusByChat ? props.lastStatusByChat[chat.id] : undefined,
            onSelect: props.onSelect,
          })),
        ),
      )
    }

    function WelcomePane(props) {
      return h('div', { className: 'dshwa-welcome', 'data-testid': 'welcome-pane' },
        h('div', { className: 'dshwa-welcome-logo' }, h(Icon, { name: 'whatsapp', size: 62 })),
        h('h1', { className: 'dshwa-welcome-title' }, tx('chat.selectTitle')),
        h('p', { className: 'dshwa-welcome-body' }, tx('chat.selectBody')),
        h('ul', { className: 'dshwa-welcome-list' },
          ['chat.selectBullet1', 'chat.selectBullet2', 'chat.selectBullet3'].map((key) => (
            h('li', { key: key }, h(Icon, { name: 'lock', size: 15 }), h('span', null, tx(key)))
          )),
        ),
        h('button', { type: 'button', className: 'dshwa-btn', 'data-variant': 'ghost', onClick: props.onSettings }, tx('chat.openSettings')),
        h('p', { className: 'dshwa-welcome-foot' },
          props.version ? tx('settings.build') + ' ' + BUNDLE_ID + ' · v' + VERSION : 'v' + VERSION,
        ),
      )
    }

    function CenterPane(props) {
      const chat = props.chat
      const state = props.state
      const messages = props.messages
      const typing = props.typing === true
      const subtitle = typing ? tx('thread.typing') : (chat.isGroup ? tx('thread.groupSub') : tx('thread.directSub'))
      return h('div', { className: 'dshwa-main', 'data-testid': 'thread-pane' },
        h('div', { className: 'dshwa-thread', 'data-pattern': 'true', 'data-testid': 'thread' },
          h('div', { className: 'dshwa-thread-head' },
            h('span', { className: 'dshwa-back' },
              h(IconButton, { label: tx('thread.back'), size: 'sm', testid: 'back-button', onClick: props.onBack }, h(Icon, { name: 'back', size: 21 })),
            ),
            h(Avatar, { name: chat.name, isGroup: chat.isGroup, seed: chat.id, size: 'sm' }),
            h('div', { className: 'dshwa-thread-head-main' },
              h('span', { className: 'dshwa-thread-title', 'data-testid': 'thread-title' }, chat.name),
              h('span', {
                className: 'dshwa-thread-sub',
                'data-typing': typing ? 'true' : 'false',
                'data-testid': 'thread-subtitle',
              }, subtitle),
            ),
            h('div', { className: 'dshwa-thread-actions' },
              h('span', { onClick: props.onCallsUnavailable, title: tx('thread.callsNote') },
                h(IconButton, {
                  label: tx('thread.voiceCall'),
                  testid: 'call-voice',
                  disabled: true,
                  onClick: props.onCallsUnavailable,
                }, h(Icon, { name: 'phone', size: 20 })),
              ),
              h('span', { onClick: props.onCallsUnavailable, title: tx('thread.callsNote') },
                h(IconButton, {
                  label: tx('thread.videoCall'),
                  testid: 'call-video',
                  disabled: true,
                  onClick: props.onCallsUnavailable,
                }, h(Icon, { name: 'video', size: 20 })),
              ),
              h(IconButton, { label: tx('thread.callsInfo'), size: 'sm', testid: 'calls-info', onClick: props.onCallsUnavailable }, h(Icon, { name: 'info', size: 18 })),
              h(IconButton, { label: tx('common.settings'), size: 'sm', onClick: props.onSettings }, h(Icon, { name: 'settings', size: 18 })),
            ),
          ),
          props.callsNoteOpen
            ? h('div', { className: 'dshwa-banner', 'data-tone': 'info', role: 'note', 'data-testid': 'calls-note' },
              h(Icon, { name: 'info', size: 17 }),
              h('div', { className: 'dshwa-banner-text' }, tx('thread.callsNote')),
              h('div', { className: 'dshwa-banner-actions' },
                h('button', { type: 'button', className: 'dshwa-btn', 'data-size': 'sm', onClick: props.onCallsUnavailable }, tx('common.close')),
              ),
            )
            : null,
          h(MessageList, {
            chat: chat,
            messages: messages,
            hasMore: props.hasMore,
            loading: props.loading,
            loadingOlder: props.loadingOlder,
            error: props.error,
            onLoadOlder: props.onLoadOlder,
            onRetry: props.onRetryMessages,
            onReply: props.onReply,
            onCopy: props.onCopy,
            onOpenMedia: props.onOpenMedia,
            onDownload: props.onDownload,
            onRetrySend: props.onRetrySend,
            typing: typing,
            state: state,
          }),
          h(Composer, {
            chatId: chat.id,
            chat: chat,
            replyTo: props.replyTo,
            onCancelReply: props.onCancelReply,
            onSend: props.onSend,
            onSendMedia: props.onSendMedia,
            onTyping: props.onTyping,
          }),
        ),
      )
    }

    // ── message rendering ─────────────────────────────────────────────────
    function Receipt(props) {
      const status = props && props.status ? props.status : 'unknown'
      const size = props && typeof props.size === 'number' ? props.size : 15
      let name = 'clock'
      let label = tx('msg.pending')
      if (status === 'sent') { name = 'check'; label = tx('msg.sent') }
      else if (status === 'delivered') { name = 'check-double'; label = tx('msg.delivered') }
      else if (status === 'read') { name = 'check-double'; label = tx('msg.read') }
      else if (status === 'played') { name = 'check-double'; label = tx('msg.played') }
      else if (status === 'error') { name = 'alert'; label = tx('msg.error') }
      return h('span', {
        className: 'dshwa-receipt',
        'data-status': status,
        'data-testid': 'message-receipt',
        title: label,
        'aria-label': label,
        role: 'img',
      }, h(Icon, { name: name, size: size }))
    }

    function QuotedBlock(props) {
      const quoted = props.quoted
      if (!quoted) return null
      const author = quoted.authorName || tx('common.you')
      return h('div', {
        className: 'dshwa-quoted',
        'data-testid': 'quoted-message',
        title: tx('msg.replyTo', { name: author }),
      },
      h('span', { className: 'dshwa-quoted-author' }, author),
      h('span', { className: 'dshwa-quoted-text' }, quoted.text !== '' ? quoted.text : tx('msg.quotedMissing')),
      )
    }

    function MediaBlock(props) {
      const message = props.message
      const media = message.media
      const kind = message.kind
      const fileName = media && media.fileName ? media.fileName : ''
      const url = mediaUrl(message.chatId, message.id)
      if (kind === 'sticker') {
        const stickerSrc = message.thumbnail || url
        return h('div', { className: 'dshwa-media', 'data-kind': 'sticker' },
          h('img', {
            src: stickerSrc,
            alt: tx('msg.sticker'),
            loading: 'lazy',
            onClick: () => props.onOpenMedia(message),
            onError: (event) => { try { event.currentTarget.style.display = 'none' } catch (error) { /* ignore */ } },
          }),
        )
      }
      if (kind === 'image') {
        const imageSrc = message.thumbnail || url
        return h('div', { className: 'dshwa-media', 'data-kind': 'image' },
          h('img', {
            src: imageSrc,
            alt: tx('msg.photoAlt'),
            loading: 'lazy',
            onClick: () => props.onOpenMedia(message),
            onError: (event) => {
              try {
                if (event.currentTarget.getAttribute('data-fallback') !== '1') {
                  event.currentTarget.setAttribute('data-fallback', '1')
                  event.currentTarget.src = url
                }
              } catch (error) { /* ignore */ }
            },
          }),
        )
      }
      if (kind === 'video') {
        const poster = message.thumbnail || undefined
        return h('div', { className: 'dshwa-media', 'data-kind': 'video' },
          h('video', { src: url, poster: poster, controls: true, preload: 'metadata' }),
          h('button', {
            type: 'button',
            className: 'dshwa-media-play',
            'aria-label': tx('msg.openVideo'),
            onClick: () => props.onOpenMedia(message),
          }, h('span', null, h(Icon, { name: 'play', size: 26 }))),
        )
      }
      if (kind === 'audio') {
        const duration = media && media.seconds ? formatDuration(media.seconds) : ''
        return h('div', { className: 'dshwa-audio' },
          h(Icon, { name: 'mic', size: 20 }),
          h('audio', { src: url, controls: true, preload: 'metadata', 'aria-label': tx('msg.audio') }),
          duration !== '' ? h('span', { className: 'dshwa-note' }, duration) : null,
        )
      }
      if (kind === 'document') {
        const sizeText = media && media.fileLength ? formatBytes(media.fileLength) : ''
        return h('a', {
          className: 'dshwa-filecard',
          href: url,
          download: fileName || true,
          target: '_blank',
          rel: 'noopener noreferrer',
          'data-testid': 'media-document',
          'aria-label': tx('msg.downloadFile', { name: fileName || tx('msg.document') }),
        },
        h(Icon, { name: 'file', size: 26 }),
        h('span', { className: 'dshwa-filecard-body' },
          h('span', { className: 'dshwa-filecard-name' }, fileName || tx('msg.document')),
          h('span', { className: 'dshwa-filecard-meta' }, sizeText || media && media.mimetype ? (sizeText || media.mimetype) : ''),
        ),
        h(Icon, { name: 'download', size: 18 }),
        )
      }
      if (kind === 'location') {
        const location = message.location
        return h('div', { className: 'dshwa-location' },
          h(Icon, { name: 'location', size: 22 }),
          h('div', null,
            h('div', { className: 'dshwa-location-name' }, location && location.name ? location.name : tx('msg.location')),
            location && location.address ? h('div', { className: 'dshwa-location-address' }, location.address) : null,
            location ? h('div', { className: 'dshwa-note' }, tx('msg.locationCoords', { lat: location.lat, lng: location.lng })) : null,
          ),
        )
      }
      if (kind === 'contact') {
        const contact = message.contact
        return h('div', { className: 'dshwa-contactcard' },
          h(Icon, { name: 'contact', size: 24 }),
          h('div', null,
            h('div', { className: 'dshwa-contactcard-name' }, contact && contact.displayName ? contact.displayName : tx('msg.contact')),
            h('div', { className: 'dshwa-contactcard-sub' }, tx('msg.contactCard')),
          ),
        )
      }
      if (kind === 'call') {
        return h('div', { className: 'dshwa-callevent' },
          h(Icon, { name: 'phone', size: 18 }),
          h('span', null, message.text !== '' ? message.text : tx('msg.callEvent')),
        )
      }
      return null
    }

    function MessageBubble(props) {
      const message = props.message
      const isSystem = message.kind === 'system'
      if (isSystem) {
        return h('div', {
          className: 'dshwa-msg',
          'data-system': 'true',
          'data-testid': 'message-bubble',
          'data-message-id': message.id,
        }, h('div', { className: 'dshwa-system-pill' }, message.revoked ? tx('msg.deleted') : (message.text || tx('msg.system'))))
      }
      const hasMedia = message.media !== null && ['image', 'video', 'audio', 'document', 'sticker', 'location', 'contact', 'call'].indexOf(message.kind) !== -1
      const showText = message.text !== '' || (!hasMedia && message.kind !== 'call')
      const canCopy = message.text !== '' && message.revoked !== true
      const canDownload = message.media !== null && message.kind !== 'sticker' && message.revoked !== true
      const actions = h('div', { className: 'dshwa-msg-actions' },
        props.onReply && message.revoked !== true
          ? h(IconButton, { label: tx('common.reply'), size: 'sm', onClick: () => props.onReply(message) }, h(Icon, { name: 'reply', size: 15 }))
          : null,
        canCopy
          ? h(IconButton, { label: tx('common.copy'), size: 'sm', onClick: () => props.onCopy(message) }, h(Icon, { name: 'copy', size: 14 }))
          : null,
        canDownload
          ? h(IconButton, { label: tx('msg.downloadFile', { name: message.media.fileName || tx('msg.document') }), size: 'sm', onClick: () => props.onDownload(message) }, h(Icon, { name: 'download', size: 15 }))
          : null,
        message.status === 'error'
          ? h(IconButton, { label: tx('msg.retry'), size: 'sm', onClick: () => props.onRetrySend(message) }, h(Icon, { name: 'refresh', size: 15 }))
          : null,
      )
      return h('div', {
        className: 'dshwa-msg',
        'data-mine': message.fromMe ? 'true' : 'false',
        'data-media': hasMedia ? 'true' : 'false',
        'data-testid': 'message-bubble',
        'data-message-id': message.id,
        'data-status': message.status,
      },
      h('div', { className: 'dshwa-bubble-wrap' },
        h('div', {
          className: 'dshwa-bubble',
          'data-sticker': message.kind === 'sticker' ? 'true' : undefined,
        },
        h(QuotedBlock, { quoted: message.quoted }),
        hasMedia ? h(MediaBlock, { message: message, onOpenMedia: props.onOpenMedia }) : null,
        message.revoked === true
          ? h('div', { className: 'dshwa-deleted' }, tx('msg.deleted'))
          : (showText
            ? h('div', { className: 'dshwa-bubble-text' }, linkifyText(message.text))
            : null),
        h('div', { className: 'dshwa-bubble-meta' },
          message.edited && message.revoked !== true ? h('span', { className: 'dshwa-edited' }, tx('msg.edited')) : null,
          h('span', null, formatClock(message.timestamp)),
          message.fromMe ? h(Receipt, { status: message.status }) : null,
        ),
        ),
        actions,
      ),
      )
    }

    function groupMessagesByDay(messages) {
      const rows = []
      let lastDay = null
      messages.forEach((message) => {
        const day = dayStart(message.timestamp)
        if (day !== lastDay) {
          lastDay = day
          rows.push({ type: 'day', key: 'day-' + day, timestamp: message.timestamp })
        }
        rows.push({ type: 'message', key: message.id, message: message })
      })
      return rows
    }

    function MessageList(props) {
      const messages = props.messages
      const listRef = React.useRef(null)
      const stickRef = React.useRef(true)
      const prevChatRef = React.useRef(null)
      const prevLengthRef = React.useRef(0)
      const [jumpVisible, setJumpVisible] = React.useState(false)

      const scrollToBottom = React.useCallback((behavior) => {
        const element = listRef.current
        if (!element) return
        try {
          if (typeof element.scrollTo === 'function') {
            element.scrollTo({ top: element.scrollHeight, behavior: behavior || 'auto' })
          } else {
            element.scrollTop = element.scrollHeight
          }
        } catch (error) {
          try { element.scrollTop = element.scrollHeight } catch (inner) { /* ignore */ }
        }
      }, [])

      React.useEffect(() => {
        const chatChanged = prevChatRef.current !== props.chat.id
        prevChatRef.current = props.chat.id
        if (chatChanged) {
          stickRef.current = true
          setJumpVisible(false)
          const timer = setTimeout(() => scrollToBottom('auto'), 0)
          return () => clearTimeout(timer)
        }
        return undefined
      }, [props.chat.id, scrollToBottom])

      React.useEffect(() => {
        const grew = messages.length !== prevLengthRef.current
        prevLengthRef.current = messages.length
        if (!grew) return
        if (stickRef.current) {
          const timer = setTimeout(() => scrollToBottom('auto'), 0)
          return () => clearTimeout(timer)
        }
        setJumpVisible(true)
        return undefined
      }, [messages.length, scrollToBottom])

      const onScroll = React.useCallback(() => {
        const element = listRef.current
        if (!element) return
        const distance = element.scrollHeight - element.scrollTop - element.clientHeight
        const atBottom = distance < 90
        stickRef.current = atBottom
        setJumpVisible(!atBottom)
        if (element.scrollTop < 90 && props.hasMore === true && props.loadingOlder !== true && props.loading !== true) {
          const before = element.scrollHeight
          const previousTop = element.scrollTop
          Promise.resolve(props.onLoadOlder()).then((loaded) => {
            if (loaded === false) return
            setTimeout(() => {
              const list = listRef.current
              if (!list) return
              list.scrollTop = list.scrollHeight - before + previousTop
            }, 0)
          }).catch(() => {})
        }
      }, [props.hasMore, props.loadingOlder, props.loading, props.onLoadOlder])

      const visible = messages.length > MAX_RENDERED_MESSAGES ? messages.slice(-MAX_RENDERED_MESSAGES) : messages
      const rows = groupMessagesByDay(visible)

      let body
      if (props.loading === true && messages.length === 0) {
        body = h('div', { className: 'dshwa-thread-empty' }, h(Spinner, null), h('span', null, tx('common.loading')))
      } else if (props.error && messages.length === 0) {
        body = h('div', { className: 'dshwa-thread-empty', role: 'alert' },
          h('span', { className: 'dshwa-empty-title' }, tx('empty.messagesError', { message: truncate(props.error, 200) })),
          h('button', { type: 'button', className: 'dshwa-btn', 'data-size': 'sm', onClick: props.onRetry }, tx('empty.retry')),
        )
      } else {
        body = rows.map((row) => {
          if (row.type === 'day') {
            return h('div', { className: 'dshwa-day', key: row.key, role: 'separator' }, formatDayLabel(row.timestamp))
          }
          return h(MessageBubble, {
            key: row.key,
            message: row.message,
            onReply: props.onReply,
            onCopy: props.onCopy,
            onOpenMedia: props.onOpenMedia,
            onDownload: props.onDownload,
            onRetrySend: props.onRetrySend,
          })
        })
      }

      return h('div', { className: 'dshwa-msgs', 'data-testid': 'message-list', role: 'log', 'aria-label': tx('thread.messagesLog'), onScroll: onScroll, ref: listRef },
        h('div', { className: 'dshwa-msgs-inner' },
          props.hasMore === true
            ? h('div', { className: 'dshwa-history-loader' },
              h('button', {
                type: 'button',
                className: 'dshwa-btn',
                'data-variant': 'ghost',
                'data-size': 'sm',
                'data-testid': 'load-older',
                disabled: props.loadingOlder === true,
                onClick: () => { props.onLoadOlder() },
              }, props.loadingOlder === true ? tx('thread.loadingOlder') : tx('thread.loadOlder')),
            )
            : null,
          body,
          messages.length === 0 && props.loading !== true && !props.error
            ? h('div', { className: 'dshwa-thread-empty' },
              h(Icon, { name: 'whatsapp', size: 30 }),
              h('span', { className: 'dshwa-thread-empty-title' }, tx('thread.noMessages')),
            )
            : null,
          jumpVisible
            ? h('button', {
              type: 'button',
              className: 'dshwa-jump',
              'data-testid': 'jump-latest',
              onClick: () => { stickRef.current = true; setJumpVisible(false); scrollToBottom('auto') },
            }, h(Icon, { name: 'chevronDown', size: 16 }), tx('thread.jumpLatest'))
            : null,
        ),
      )
    }

    // ── composer ──────────────────────────────────────────────────────────
    const EMOJI = [
      '😀', '😁', '😂', '🤣', '😊', '😍', '😘', '😎',
      '🤔', '😅', '😭', '😡', '👍', '👎', '🙏', '👏',
      '💪', '🎉', '❤️', '🔥', '✅', '❌', '⭐', '☕',
      '🍕', '🎂', '🌹', '☀️', '🌙', '🚀', '💯', '🤝',
    ]

    function EmojiPicker(props) {
      return h('div', {
        className: 'dshwa-emoji',
        'data-testid': 'emoji-picker',
        role: 'dialog',
        'aria-label': tx('composer.emojiLabel'),
      },
      h('div', { className: 'dshwa-emoji-grid' }, EMOJI.map((emoji) => (
        h('button', {
          key: emoji,
          type: 'button',
          'aria-label': emoji,
          onClick: () => props.onPick(emoji),
        }, emoji)
      ))),
      )
    }

    function Composer(props) {
      const [text, setText] = React.useState('')
      const [attachment, setAttachment] = React.useState(null)
      const [sending, setSending] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [emojiOpen, setEmojiOpen] = React.useState(false)
      const [dragOver, setDragOver] = React.useState(false)
      const inputRef = React.useRef(null)
      const fileRef = React.useRef(null)
      const previewRef = React.useRef(null)

      React.useEffect(() => () => {
        if (previewRef.current) {
          try { URL.revokeObjectURL(previewRef.current) } catch (error) { /* ignore */ }
        }
      }, [])

      React.useEffect(() => {
        setText('')
        setAttachment(null)
        setError(null)
        setEmojiOpen(false)
        if (inputRef.current) {
          try { inputRef.current.style.height = '' } catch (error) { /* ignore */ }
        }
      }, [props.chatId])

      const clearAttachment = React.useCallback(() => {
        if (previewRef.current) {
          try { URL.revokeObjectURL(previewRef.current) } catch (error) { /* ignore */ }
          previewRef.current = null
        }
        setAttachment(null)
      }, [])

      const attach = React.useCallback((file) => {
        if (!file) return
        clearAttachment()
        let preview = null
        const type = str(file.type)
        if (type.startsWith('image/') && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
          try {
            preview = URL.createObjectURL(file)
            previewRef.current = preview
          } catch (error) {
            preview = null
          }
        }
        setAttachment({ file: file, name: str(file.name) || 'file', size: num(file.size), type: type, preview: preview })
        setError(null)
      }, [clearAttachment])

      const pickFiles = React.useCallback((fileList) => {
        if (!fileList || fileList.length === 0) return
        attach(fileList[0])
      }, [attach])

      const submit = React.useCallback(async () => {
        if (sending) return
        const attachmentValue = attachment
        const value = text
        if (!attachmentValue && value.trim() === '') return
        setSending(true)
        setError(null)
        try {
          let result
          if (attachmentValue) {
            result = await props.onSendMedia(props.chatId, attachmentValue.file, value)
          } else {
            result = await props.onSend(props.chatId, value, props.replyTo ? props.replyTo.id : null)
          }
          if (result && result.ok === false) {
            setError(tx('composer.uploadError', { message: truncate(result.error || 'send failed', 180) }))
          } else {
            setText('')
            clearAttachment()
            if (props.replyTo) props.onCancelReply()
            if (inputRef.current) {
              try {
                inputRef.current.style.height = ''
                inputRef.current.focus()
              } catch (error) { /* ignore */ }
            }
          }
        } catch (sendError) {
          setError(tx('composer.uploadError', { message: messageOf(sendError) }))
        } finally {
          setSending(false)
        }
      }, [attachment, clearAttachment, props, sending, text])

      const onKeyDown = (event) => {
        if (event.key === 'Escape' && emojiOpen) {
          event.preventDefault()
          setEmojiOpen(false)
          return
        }
        if (event.key === 'Enter' && event.shiftKey !== true) {
          if ((event.nativeEvent && event.nativeEvent.isComposing === true) || event.isComposing === true) return
          event.preventDefault()
          void submit()
        }
      }

      const onTextChange = (event) => {
        const value = event.target.value
        setText(value)
        const element = event.target
        try {
          element.style.height = 'auto'
          element.style.height = Math.min(140, element.scrollHeight) + 'px'
        } catch (error) { /* ignore */ }
        if (props.onTyping && value.trim() !== '') props.onTyping(props.chatId)
      }

      const onPaste = (event) => {
        const clipboard = event.clipboardData || (typeof window !== 'undefined' ? window.clipboardData : null)
        if (!clipboard) return
        const files = clipboard.files
        if (files && files.length > 0) {
          event.preventDefault()
          pickFiles(files)
          return
        }
        const items = clipboard.items
        if (items && items.length > 0) {
          for (let index = 0; index < items.length; index += 1) {
            const item = items[index]
            if (item && item.kind === 'file' && typeof item.getAsFile === 'function') {
              const file = item.getAsFile()
              if (file) {
                event.preventDefault()
                attach(file)
                return
              }
            }
          }
        }
      }

      const onDrop = (event) => {
        event.preventDefault()
        setDragOver(false)
        const files = event.dataTransfer && event.dataTransfer.files
        if (files && files.length > 0) pickFiles(files)
      }

      const hasContent = text.trim() !== '' || attachment !== null
      const replyName = props.replyTo && props.replyTo.authorName ? props.replyTo.authorName : (props.replyTo && props.replyTo.fromMe ? tx('common.you') : (props.chat && props.chat.name ? props.chat.name : ''))

      return h('div', {
        className: 'dshwa-composer',
        onDragOver: (event) => { event.preventDefault(); setDragOver(true) },
        onDragLeave: () => setDragOver(false),
        onDrop: onDrop,
      },
      props.replyTo
        ? h('div', { className: 'dshwa-replybar' },
          h('div', { className: 'dshwa-replybar-body' },
            h('span', { className: 'dshwa-replybar-title' }, tx('composer.replyTo', { name: replyName || tx('msg.quotedMissing') })),
            h('span', { className: 'dshwa-replybar-text' }, props.replyTo.text !== '' ? props.replyTo.text : tx('msg.quotedMissing')),
          ),
          h(IconButton, { label: tx('composer.cancelReply'), size: 'sm', onClick: props.onCancelReply }, h(Icon, { name: 'close', size: 16 })),
        )
        : null,
      attachment
        ? h('div', { className: 'dshwa-attach-chip', 'data-testid': 'attachment-chip' },
          attachment.preview
            ? h('img', { className: 'dshwa-attach-thumb', src: attachment.preview, alt: '' })
            : h(Icon, { name: 'file', size: 24 }),
          h('div', { className: 'dshwa-attach-body' },
            h('span', { className: 'dshwa-attach-name' }, attachment.name),
            h('span', { className: 'dshwa-attach-meta' }, sending ? tx('composer.uploading') : formatBytes(attachment.size)),
          ),
          h(IconButton, { label: tx('composer.removeFile'), size: 'sm', onClick: clearAttachment, disabled: sending }, h(Icon, { name: 'close', size: 16 })),
        )
        : null,
      error
        ? h('div', { className: 'dshwa-composer-error', role: 'alert', 'data-testid': 'composer-error' },
          h('span', null, error),
          h('button', { type: 'button', className: 'dshwa-btn', 'data-size': 'sm', onClick: () => { void submit() } }, tx('composer.retryUpload')),
          h('button', { type: 'button', className: 'dshwa-iconbtn', 'data-size': 'sm', 'aria-label': tx('common.dismiss'), onClick: () => setError(null) }, h(Icon, { name: 'close', size: 15 })),
        )
        : null,
      h('div', { className: 'dshwa-compose-row', 'data-dragover': dragOver ? 'true' : 'false' },
        h(IconButton, { label: tx('composer.emoji'), testid: 'emoji-button', onClick: () => setEmojiOpen((value) => !value), pressed: emojiOpen }, h(Icon, { name: 'emoji', size: 22 })),
        h(IconButton, { label: tx('composer.attach'), testid: 'attach-button', onClick: () => { if (fileRef.current) fileRef.current.click() } }, h(Icon, { name: 'attach', size: 21 })),
        h('input', {
          type: 'file',
          ref: fileRef,
          style: { display: 'none' },
          'data-testid': 'file-input',
          tabIndex: -1,
          'aria-hidden': 'true',
          onChange: (event) => {
            const files = event.target.files
            pickFiles(files)
            try { event.target.value = '' } catch (error) { /* ignore */ }
          },
        }),
        h('textarea', {
          ref: inputRef,
          className: 'dshwa-compose-input',
          rows: 1,
          value: text,
          placeholder: tx('composer.placeholder'),
          'aria-label': tx('composer.aria'),
          'data-testid': 'composer-input',
          onChange: onTextChange,
          onKeyDown: onKeyDown,
          onPaste: onPaste,
        }),
        h('button', {
          type: 'button',
          className: 'dshwa-compose-send',
          'data-testid': 'send-button',
          'aria-label': tx('composer.send'),
          title: tx('composer.send'),
          disabled: sending || !hasContent,
          onClick: () => { void submit() },
        }, sending ? h(Spinner, null) : h(Icon, { name: 'send', size: 20 })),
        emojiOpen
          ? h(EmojiPicker, { onPick: (emoji) => {
            setText((value) => value + emoji)
            if (inputRef.current) {
              try { inputRef.current.focus() } catch (error) { /* ignore */ }
            }
          } })
          : null,
      ),
      h('div', { className: 'dshwa-composer-hint' }, tx('composer.sendHint')),
      )
    }

    // ── settings sheet ────────────────────────────────────────────────────
    function Kv(props) {
      return h('div', { className: 'dshwa-kv' },
        h('span', { className: 'dshwa-kv-k' }, props.label),
        h('span', { className: 'dshwa-kv-v' }, props.value),
      )
    }

    function SettingsSheet(props) {
      const [confirm, setConfirm] = React.useState(null)
      const [wipeMessages, setWipeMessages] = React.useState(true)
      const open = props.open === true
      useEscapeKey(open, () => { if (confirm) setConfirm(null); else props.onClose() })
      React.useEffect(() => {
        if (!open) {
          setConfirm(null)
        }
      }, [open])
      if (!open) return null
      const state = props.state || {}
      const me = state.me || null
      const busy = props.busy
      const anyBusy = typeof busy === 'string' && busy !== ''
      const connectionText = state.connection === 'online'
        ? tx('common.online')
        : (state.connection === 'offline' ? tx('common.offline') : (state.connection === 'connecting' || state.connection === 'starting' ? tx('common.connecting') : str(state.connection)))
      const lastError = state.lastError && state.lastError.message
        ? state.lastError.message
        : tx('settings.noError')
      const storageLabel = state.storage === 'encrypted' ? tx('settings.storageEncrypted') : tx('settings.storageUnknown')
      const phoneOfflineText = state.phoneOfflineModel !== '' ? state.phoneOfflineModel : tx('settings.phoneOfflineFallback')
      return h('div', { className: 'dshwa-scrim', onMouseDown: (event) => { if (event.target === event.currentTarget) props.onClose() } },
        h('div', {
          className: 'dshwa-sheet',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': tx('settings.title'),
          'data-testid': 'settings-sheet',
        },
        h('div', { className: 'dshwa-sheet-head' },
          h(Icon, { name: 'settings', size: 20 }),
          h('h2', null, tx('settings.title')),
          h(IconButton, { label: tx('settings.close'), testid: 'settings-close', onClick: props.onClose }, h(Icon, { name: 'close', size: 20 })),
        ),
        h('div', { className: 'dshwa-sheet-body' },
          h('div', { className: 'dshwa-section' },
            h('h3', null, tx('settings.account')),
            h('div', { className: 'dshwa-panelbox' },
              h(Kv, { label: tx('settings.name'), value: me && me.name ? me.name : '—' }),
              h(Kv, { label: tx('settings.phone'), value: me && me.phone ? me.phone : (me && me.id ? phoneFromJid(me.id) : '—') }),
            ),
          ),
          h('div', { className: 'dshwa-section' },
            h('h3', null, tx('settings.device')),
            h('div', { className: 'dshwa-panelbox' },
              h(Kv, { label: tx('settings.connection'), value: connectionText }),
              h(Kv, { label: tx('settings.linkedAt'), value: formatFull(state.linkedAt) }),
              h(Kv, { label: tx('settings.lastConnected'), value: formatFull(state.lastConnectedAt) }),
              h(Kv, { label: tx('settings.storage'), value: storageLabel }),
              h(Kv, { label: tx('settings.stats'), value: tx('settings.statsDetail', { chats: state.chatCount || 0, messages: state.messageCount || 0 }) }),
            ),
          ),
          h('div', { className: 'dshwa-section' },
            h('h3', null, tx('settings.storage')),
            h('div', { className: 'dshwa-panelbox' },
              h('div', { style: { marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 } },
                h('span', {
                  className: 'dshwa-badge',
                  'data-testid': 'storage-badge',
                  'data-tone': state.storage === 'encrypted' ? undefined : 'warn',
                }, h(Icon, { name: 'lock', size: 13 }), storageLabel),
              ),
              tx('settings.storageDetail'),
            ),
          ),
          h('div', { className: 'dshwa-section' },
            h('h3', null, tx('settings.phoneOffline')),
            h('div', { className: 'dshwa-panelbox' }, phoneOfflineText),
          ),
          h('div', { className: 'dshwa-section' },
            h('h3', null, tx('settings.calls')),
            h('div', { className: 'dshwa-panelbox' }, tx('settings.callsDetail')),
          ),
          h('div', { className: 'dshwa-section' },
            h('h3', null, tx('settings.limitations')),
            h('div', { className: 'dshwa-panelbox' },
              h('ul', { className: 'dshwa-welcome-list' },
                ['settings.limit1', 'settings.limit2', 'settings.limit3', 'settings.limit4'].map((key) => (
                  h('li', { key: key }, h(Icon, { name: 'alert', size: 14 }), h('span', null, tx(key)))
                )),
              ),
            ),
          ),
          h('div', { className: 'dshwa-section' },
            h('h3', null, tx('settings.lastError')),
            h('div', { className: 'dshwa-panelbox' }, truncate(lastError, 240)),
          ),
          h('div', { className: 'dshwa-section' },
            h('h3', null, tx('settings.version')),
            h('div', { className: 'dshwa-panelbox' },
              h(Kv, { label: tx('settings.build'), value: BUNDLE_ID + ' v' + VERSION }),
              h(Kv, { label: tx('settings.api'), value: API }),
            ),
          ),
          h('div', { className: 'dshwa-sheet-actions' },
            h('button', {
              type: 'button',
              className: 'dshwa-btn',
              'data-variant': 'ghost',
              'data-testid': 'settings-reconnect',
              disabled: anyBusy,
              onClick: props.onReconnect,
            }, busy === 'reconnect' ? tx('settings.reconnectBusy') : tx('settings.reconnect')),
            confirm === 'relink'
              ? h('div', { className: 'dshwa-confirm', role: 'alert' },
                tx('settings.relinkConfirm'),
                h('div', { className: 'dshwa-confirm-actions' },
                  h('button', {
                    type: 'button',
                    className: 'dshwa-btn',
                    'data-variant': 'danger',
                    'data-testid': 'settings-relink-confirm',
                    disabled: anyBusy,
                    onClick: () => props.onRelink(),
                  }, busy === 'relink' ? tx('settings.relinkBusy') : tx('settings.relinkYes')),
                  h('button', { type: 'button', className: 'dshwa-btn', 'data-variant': 'ghost', onClick: () => setConfirm(null) }, tx('common.cancel')),
                ),
              )
              : h('button', {
                type: 'button',
                className: 'dshwa-btn',
                'data-variant': 'ghost',
                'data-testid': 'settings-relink',
                disabled: anyBusy,
                onClick: () => setConfirm('relink'),
              }, tx('settings.relink')),
            confirm === 'logout'
              ? h('div', { className: 'dshwa-confirm', role: 'alert' },
                tx('settings.logoutConfirm', { wipe: wipeMessages ? tx('settings.logoutWipe') : '' }),
                h('label', { className: 'dshwa-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: wipeMessages,
                    onChange: (event) => setWipeMessages(event.target.checked),
                  }),
                  h('span', null, tx('settings.logoutWipeLabel')),
                ),
                h('div', { className: 'dshwa-confirm-actions' },
                  h('button', {
                    type: 'button',
                    className: 'dshwa-btn',
                    'data-variant': 'danger',
                    'data-testid': 'settings-logout-confirm',
                    disabled: anyBusy,
                    onClick: () => props.onLogout(wipeMessages),
                  }, busy === 'logout' ? tx('settings.logoutBusy') : tx('settings.logoutYes')),
                  h('button', { type: 'button', className: 'dshwa-btn', 'data-variant': 'ghost', onClick: () => setConfirm(null) }, tx('common.cancel')),
                ),
              )
              : h('button', {
                type: 'button',
                className: 'dshwa-btn',
                'data-variant': 'danger',
                'data-testid': 'settings-logout',
                disabled: anyBusy,
                onClick: () => setConfirm('logout'),
              }, tx('settings.logout')),
          ),
        ),
        ),
      )
    }

    // ── image / video lightbox ────────────────────────────────────────────
    function Lightbox(props) {
      const item = props.item
      useEscapeKey(item !== null, () => props.onClose())
      if (!item) return null
      const message = item
      const url = mediaUrl(message.chatId, message.id)
      const isVideo = message.kind === 'video'
      const title = message.media && message.media.fileName
        ? message.media.fileName
        : (isVideo ? tx('msg.video') : tx('msg.image'))
      return h('div', {
        className: 'dshwa-lightbox',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': isVideo ? tx('msg.openVideo') : tx('msg.openImage'),
        'data-testid': 'lightbox',
      },
      h('div', { className: 'dshwa-lightbox-bar' },
        h('span', { className: 'dshwa-lightbox-title' }, title),
        h('a', {
          className: 'dshwa-lightbox-link',
          href: url,
          download: (message.media && message.media.fileName) || true,
          target: '_blank',
          rel: 'noopener noreferrer',
        }, h(Icon, { name: 'download', size: 18 }), tx('common.download')),
        h(IconButton, { label: tx('common.close'), onClick: props.onClose }, h(Icon, { name: 'close', size: 22 })),
      ),
      h('div', { className: 'dshwa-lightbox-body' },
        isVideo
          ? h('video', { src: url, controls: true, autoPlay: true })
          : h('img', { src: url, alt: title }),
      ),
      )
    }

    // ── host integration points (safe on an empty context) ────────────────
    let layoutService = null

    function requestPanel() {
      const layout = layoutService
      if (!layout || typeof layout.selectPanel !== 'function') return
      try { layout.selectPanel(PANEL_ID) } catch (error) { /* panel may not be registered yet */ }
    }

    function readTheme() {
      try {
        if (typeof document !== 'undefined' && document.documentElement) {
          const root = document.documentElement
          const darkAttr = root.getAttribute('data-ds-dark-theme')
          if (darkAttr !== null) {
            if (darkAttr === '' || darkAttr === 'true' || darkAttr === 'dark' || darkAttr === '1') return 'dark'
            return 'light'
          }
          const themeAttr = root.getAttribute('data-theme') || root.getAttribute('data-dsh-theme') || root.getAttribute('data-color-scheme')
          if (themeAttr === 'dark') return 'dark'
          if (themeAttr === 'light') return 'light'
          if (root.classList && (root.classList.contains('dark') || root.classList.contains('theme-dark'))) return 'dark'
        }
        if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
          const media = window.matchMedia('(prefers-color-scheme: dark)')
          if (media && media.matches === true) return 'dark'
        }
      } catch (error) {
        // Theme detection is best-effort.
      }
      return 'light'
    }

    function resolveMutationObserver() {
      try {
        if (typeof window !== 'undefined' && window && typeof window.MutationObserver === 'function') return window.MutationObserver
      } catch (error) { /* ignore */ }
      try {
        if (typeof MutationObserver !== 'undefined') return MutationObserver
      } catch (error) { /* ignore */ }
      return null
    }

    function resolveEventSource() {
      try {
        if (typeof window !== 'undefined' && window && typeof window.EventSource === 'function') return window.EventSource
      } catch (error) { /* ignore */ }
      try {
        if (typeof EventSource !== 'undefined') return EventSource
      } catch (error) { /* ignore */ }
      return null
    }

    function parseEventPayload(event) {
      if (!event || typeof event.data !== 'string' || event.data === '') return null
      try {
        return JSON.parse(event.data)
      } catch (error) {
        return null
      }
    }

    function listenEvent(source, name, handler) {
      try {
        if (typeof source.addEventListener === 'function') {
          source.addEventListener(name, (event) => { handler(parseEventPayload(event), event) })
          return
        }
      } catch (error) { /* ignore */ }
      try {
        source['on' + name] = (event) => { handler(parseEventPayload(event), event) }
      } catch (error) { /* ignore */ }
    }

    // ── the full-page panel ───────────────────────────────────────────────
    function App() {
      const [theme, setTheme] = React.useState(readTheme)
      const [status, setStatus] = React.useState('loading')
      const [authStatus, setAuthStatus] = React.useState(401)
      const [serviceError, setServiceError] = React.useState('')
      const [state, setState] = React.useState(null)
      const stateRef = React.useRef(null)
      const [qr, setQr] = React.useState(null)
      const [chats, setChats] = React.useState([])
      const chatsRef = React.useRef([])
      const [chatsLoading, setChatsLoading] = React.useState(false)
      const [chatsError, setChatsError] = React.useState(null)
      const [search, setSearch] = React.useState('')
      const searchRef = React.useRef('')
      const [activeChatId, setActiveChatId] = React.useState(null)
      const activeChatRef = React.useRef(null)
      const [messagesByChat, setMessagesByChatState] = React.useState({})
      const messagesRef = React.useRef({})
      const [typingMap, setTypingMap] = React.useState({})
      const typingMapRef = React.useRef({})
      const [typingTick, setTypingTick] = React.useState(0)
      const [incomingCall, setIncomingCall] = React.useState(null)
      const callRef = React.useRef(null)
      const [settingsOpen, setSettingsOpen] = React.useState(false)
      const [lightbox, setLightbox] = React.useState(null)
      const [toast, setToast] = React.useState(null)
      const toastTimerRef = React.useRef(null)
      const [mobileThread, setMobileThread] = React.useState(false)
      const [busy, setBusy] = React.useState('')
      const busyRef = React.useRef(false)
      const [sseMode, setSseMode] = React.useState('connecting')
      const [reconnectDeadline, setReconnectDeadline] = React.useState(null)
      const [clockTick, setClockTick] = React.useState(0)
      const [callsNoteOpen, setCallsNoteOpen] = React.useState(false)
      const [replyTo, setReplyTo] = React.useState(null)
      const mountedRef = React.useRef(true)
      const readSentRef = React.useRef({})
      const lastFetchedQueryRef = React.useRef('')
      const chatsRefreshTimerRef = React.useRef(null)
      const typingSentRef = React.useRef({ last: 0, timer: null })
      const callTimerRef = React.useRef(null)

      // ── housekeeping effects ────────────────────────────────────────────
      React.useEffect(() => {
        ensureStyleTag()
        mountedRef.current = true
        return () => { mountedRef.current = false }
      }, [])

      React.useEffect(() => {
        const update = () => {
          const next = readTheme()
          setTheme((previous) => (previous === next ? previous : next))
        }
        update()
        let media = null
        let removeMedia = null
        try {
          if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
            media = window.matchMedia('(prefers-color-scheme: dark)')
            if (media && typeof media.addEventListener === 'function') {
              media.addEventListener('change', update)
              removeMedia = () => media.removeEventListener('change', update)
            } else if (media && typeof media.addListener === 'function') {
              media.addListener(update)
              removeMedia = () => media.removeListener(update)
            }
          }
        } catch (error) { media = null }
        let observer = null
        try {
          const ObserverCtor = resolveMutationObserver()
          if (ObserverCtor !== null && typeof document !== 'undefined' && document.documentElement) {
            observer = new ObserverCtor(update)
            observer.observe(document.documentElement, {
              attributes: true,
              attributeFilter: ['class', 'data-theme', 'data-ds-dark-theme', 'data-color-scheme'],
            })
          }
        } catch (error) { observer = null }
        return () => {
          try { if (removeMedia) removeMedia() } catch (error) { /* ignore */ }
          try { if (observer) observer.disconnect() } catch (error) { /* ignore */ }
        }
      }, [])

      React.useEffect(() => {
        const timer = setInterval(() => setTypingTick((value) => value + 1), 2000)
        return () => clearInterval(timer)
      }, [])

      React.useEffect(() => {
        if (reconnectDeadline === null) return undefined
        const timer = setInterval(() => setClockTick((value) => value + 1), 1000)
        return () => clearInterval(timer)
      }, [reconnectDeadline])

      React.useEffect(() => () => {
        if (toastTimerRef.current !== null) { clearTimeout(toastTimerRef.current); toastTimerRef.current = null }
        if (chatsRefreshTimerRef.current !== null) { clearTimeout(chatsRefreshTimerRef.current); chatsRefreshTimerRef.current = null }
        if (typingSentRef.current.timer !== null) { clearTimeout(typingSentRef.current.timer); typingSentRef.current.timer = null }
        if (callTimerRef.current !== null) { clearTimeout(callTimerRef.current); callTimerRef.current = null }
      }, [])

      // ── toasts / auth failures ──────────────────────────────────────────
      const showToast = React.useCallback((text, kind) => {
        const value = str(text)
        if (value === '') return
        if (toastTimerRef.current !== null) { clearTimeout(toastTimerRef.current); toastTimerRef.current = null }
        setToast({ text: value, kind: kind || 'info' })
        toastTimerRef.current = setTimeout(() => {
          toastTimerRef.current = null
          if (mountedRef.current) setToast(null)
        }, 6000)
      }, [])

      const failAuth = React.useCallback((statusCode) => {
        setAuthStatus(typeof statusCode === 'number' && statusCode > 0 ? statusCode : 401)
        setStatus('auth')
      }, [])

      // ── message store helpers ───────────────────────────────────────────
      const patchChatEntry = React.useCallback((chatId, updater) => {
        if (!chatId) return
        setMessagesByChatState((previous) => {
          const current = previous[chatId] || { messages: [], hasMore: false, loaded: false, loading: false, loadingOlder: false, error: null }
          const nextEntry = updater(current)
          if (!nextEntry || nextEntry === current) return previous
          const next = Object.assign({}, previous)
          next[chatId] = nextEntry
          messagesRef.current = next
          return next
        })
      }, [])

      const replaceMessage = React.useCallback((chatId, oldId, message) => {
        patchChatEntry(chatId, (entry) => {
          const byId = new Map()
          entry.messages.forEach((item) => {
            if (item.id === oldId) byId.set(message.id, message)
            else byId.set(item.id, item)
          })
          if (!byId.has(message.id)) byId.set(message.id, message)
          const messages = Array.from(byId.values())
          messages.sort(compareMessages)
          return Object.assign({}, entry, { messages: messages })
        })
      }, [patchChatEntry])

      const removeMessage = React.useCallback((chatId, messageId) => {
        patchChatEntry(chatId, (entry) => {
          const messages = entry.messages.filter((item) => item.id !== messageId)
          if (messages.length === entry.messages.length) return entry
          return Object.assign({}, entry, { messages: messages })
        })
      }, [patchChatEntry])

      const upsertMessage = React.useCallback((chatId, message) => {
        patchChatEntry(chatId, (entry) => {
          const index = entry.messages.findIndex((item) => item.id === message.id)
          let messages
          if (index === -1) {
            messages = entry.messages.concat([message])
            messages.sort(compareMessages)
            if (messages.length > MAX_STORED_MESSAGES) messages = messages.slice(messages.length - MAX_STORED_MESSAGES)
          } else {
            messages = entry.messages.slice()
            messages[index] = Object.assign({}, entry.messages[index], message)
          }
          return Object.assign({}, entry, { messages: messages })
        })
      }, [patchChatEntry])

      const updateMessageStatus = React.useCallback((chatId, messageId, messageStatus) => {
        patchChatEntry(chatId, (entry) => {
          const index = entry.messages.findIndex((item) => item.id === messageId)
          if (index === -1) return entry
          const messages = entry.messages.slice()
          messages[index] = Object.assign({}, entry.messages[index], { status: normalizeStatus(messageStatus) })
          return Object.assign({}, entry, { messages: messages })
        })
      }, [patchChatEntry])

      const markRead = React.useCallback((chatId, ids) => {
        if (!chatId || !Array.isArray(ids) || ids.length === 0) return
        const set = readSentRef.current[chatId] || (readSentRef.current[chatId] = new Set())
        const fresh = []
        ids.forEach((id) => {
          if (typeof id !== 'string' || id === '' || set.has(id)) return
          set.add(id)
          fresh.push(id)
        })
        if (set.size > 4000) readSentRef.current[chatId] = new Set(fresh)
        if (fresh.length === 0) return
        apiFetch('/read', { method: 'POST', body: { chat: chatId, ids: fresh } }).catch((error) => {
          if (isAuthError(error)) failAuth(error.status)
        })
      }, [failAuth])

      const collectUnreadIds = (entry) => {
        if (!entry || !Array.isArray(entry.messages)) return []
        return entry.messages
          .filter((message) => message.fromMe !== true && message.status !== 'read' && message.status !== 'played' && message.local !== true)
          .slice(-40)
          .map((message) => message.id)
      }

      // ── network state ───────────────────────────────────────────────────
      const applyServerState = React.useCallback((raw) => {
        const next = normalizeState(raw)
        stateRef.current = next
        setState(next)
        setQr((previous) => (next.qr !== null ? next.qr : (next.connection === 'qr' ? previous : null)))
        if (typeof next.reconnectInMs === 'number') setReconnectDeadline(Date.now() + next.reconnectInMs)
        else setReconnectDeadline(null)
        if (next.linked !== true || next.needsRelink === true || next.connection === 'loggedOut') {
          if (callRef.current !== null) {
            callRef.current = null
            setIncomingCall(null)
          }
        }
        return next
      }, [])

      const refreshChats = React.useCallback(async (query, silent) => {
        const effective = typeof query === 'string' ? query : ''
        lastFetchedQueryRef.current = effective
        if (silent !== true) setChatsLoading(true)
        try {
          const raw = await apiFetch('/chats', effective !== '' ? { params: { q: effective } } : {})
          const list = normalizeChatList(raw)
          chatsRef.current = list
          if (mountedRef.current) {
            setChats(list)
            setChatsError(null)
          }
          return list
        } catch (error) {
          if (isAuthError(error)) failAuth(error.status)
          else if (mountedRef.current) setChatsError(messageOf(error))
          return null
        } finally {
          if (mountedRef.current && silent !== true) setChatsLoading(false)
        }
      }, [failAuth])

      const scheduleChatsRefresh = React.useCallback((delay) => {
        if (chatsRefreshTimerRef.current !== null) return
        chatsRefreshTimerRef.current = setTimeout(() => {
          chatsRefreshTimerRef.current = null
          refreshChats(searchRef.current, true).catch(() => {})
        }, typeof delay === 'number' ? delay : CHATS_DEBOUNCE_MS)
      }, [refreshChats])

      const bootstrap = React.useCallback(async () => {
        setStatus((previous) => (previous === 'ready' ? previous : 'loading'))
        setServiceError('')
        try {
          const raw = await apiFetch('/state')
          if (!mountedRef.current) return
          const next = applyServerState(raw)
          setStatus('ready')
          if (next.linked === true) await refreshChats('', true)
        } catch (error) {
          if (!mountedRef.current) return
          if (isAuthError(error)) failAuth(error.status)
          else {
            setServiceError(messageOf(error))
            setStatus('error')
          }
        }
      }, [applyServerState, failAuth, refreshChats])

      React.useEffect(() => { void bootstrap() }, [bootstrap])

      const loadMessages = React.useCallback(async (chatId, options) => {
        const opts = options || {}
        const before = typeof opts.before === 'string' && opts.before !== '' ? opts.before : null
        const existing = messagesRef.current[chatId]
        if (existing && (existing.loading === true || existing.loadingOlder === true)) return null
        if (existing && existing.loaded === true && before === null && opts.force !== true) return existing
        patchChatEntry(chatId, (entry) => Object.assign({}, entry, {
          loading: before === null,
          loadingOlder: before !== null,
          error: null,
        }))
        try {
          const params = { chat: chatId, limit: 50 }
          if (before !== null) params.before = before
          const raw = await apiFetch('/messages', { params })
          const page = normalizeMessagesResponse(raw)
          const current = messagesRef.current[chatId] || { messages: [] }
          const locals = current.messages.filter((message) => message.local === true)
          const merged = before !== null
            ? mergeMessageLists(current.messages, page.messages)
            : mergeMessageLists(page.messages, locals)
          let messages = merged
          if (before === null && messages.length > MAX_STORED_MESSAGES) messages = messages.slice(messages.length - MAX_STORED_MESSAGES)
          patchChatEntry(chatId, (entry) => Object.assign({}, entry, {
            messages: messages,
            hasMore: page.hasMore,
            loaded: true,
            loading: false,
            loadingOlder: false,
            error: null,
          }))
          return page
        } catch (error) {
          if (isAuthError(error)) failAuth(error.status)
          patchChatEntry(chatId, (entry) => Object.assign({}, entry, {
            loading: false,
            loadingOlder: false,
            loaded: true,
            error: messageOf(error),
          }))
          return null
        }
      }, [failAuth, patchChatEntry])

      const loadOlderMessages = React.useCallback(async (chatId) => {
        const entry = messagesRef.current[chatId]
        if (!entry || entry.hasMore !== true || entry.loading === true || entry.loadingOlder === true) return false
        const oldest = entry.messages.find((message) => message.local !== true)
        if (!oldest) return false
        const before = oldest.timestamp + ':' + oldest.id
        const result = await loadMessages(chatId, { before: before })
        return result !== null
      }, [loadMessages])

      // ── chat selection ──────────────────────────────────────────────────
      const selectChat = React.useCallback((chat) => {
        if (!chat || !chat.id) return
        const chatId = chat.id
        activeChatRef.current = chatId
        setActiveChatId(chatId)
        setMobileThread(true)
        setReplyTo(null)
        setChats((previous) => {
          const next = previous.map((item) => (item.id === chatId && item.unread > 0 ? Object.assign({}, item, { unread: 0 }) : item))
          chatsRef.current = next
          return next
        })
        const cached = messagesRef.current[chatId]
        if (cached && cached.loaded === true) {
          markRead(chatId, collectUnreadIds(cached))
        } else {
          loadMessages(chatId).then((page) => {
            const entry = messagesRef.current[chatId]
            if (entry) markRead(chatId, collectUnreadIds(entry))
          }).catch(() => {})
        }
      }, [loadMessages, markRead])

      const backToChats = React.useCallback(() => {
        setMobileThread(false)
      }, [])

      // ── send / upload ───────────────────────────────────────────────────
      const markChatSent = React.useCallback((chatId, message) => {
        const current = chatsRef.current
        const index = current.findIndex((chat) => chat.id === chatId)
        if (index === -1) return
        const next = current.slice()
        next[index] = Object.assign({}, current[index], {
          lastMessage: {
            id: message.id,
            text: message.text,
            fromMe: true,
            timestamp: message.timestamp,
            kind: message.kind,
          },
          timestamp: Math.max(num(current[index].timestamp), message.timestamp),
        })
        chatsRef.current = next
        setChats(next)
      }, [])

      const sendText = React.useCallback(async (chatId, text, quotedId) => {
        const body = str(text)
        if (body.trim() === '') return { ok: false, error: 'empty message' }
        const localId = nextLocalMessageId()
        const optimistic = normalizeMessage({
          id: localId,
          chatId: chatId,
          fromMe: true,
          timestamp: Date.now(),
          kind: 'text',
          text: body,
          quoted: quotedId ? { id: quotedId, authorName: null, text: '' } : null,
          status: 'pending',
        })
        optimistic.local = true
        patchChatEntry(chatId, (entry) => ({
          messages: entry.messages.concat([optimistic]).sort(compareMessages),
          hasMore: entry.hasMore,
          loaded: true,
          loading: false,
          loadingOlder: false,
          error: null,
        }))
        markChatSent(chatId, optimistic)
        try {
          const payload = { chat: chatId, text: body }
          if (quotedId) payload.quoted = quotedId
          const raw = await apiFetch('/send', { method: 'POST', body: payload })
          const rawMessage = raw && typeof raw === 'object' && raw.message ? raw.message : raw
          const saved = normalizeMessage(Object.assign({}, rawMessage || {}, {
            id: (rawMessage && rawMessage.id) || localId,
            chatId: chatId,
            fromMe: true,
            kind: (rawMessage && rawMessage.kind) || 'text',
            text: (rawMessage && str(rawMessage.text)) || body,
            timestamp: (rawMessage && num(rawMessage.timestamp)) || optimistic.timestamp,
            status: (rawMessage && rawMessage.status) || 'sent',
          }))
          saved.local = false
          if (saved.id !== localId) replaceMessage(chatId, localId, saved)
          else {
            patchChatEntry(chatId, (entry) => {
              const messages = entry.messages.map((item) => (item.id === localId ? Object.assign({}, item, { status: 'sent', local: false }) : item))
              return Object.assign({}, entry, { messages: messages })
            })
          }
          markChatSent(chatId, saved)
          return { ok: true, message: saved }
        } catch (error) {
          removeMessage(chatId, localId)
          if (isAuthError(error)) failAuth(error.status)
          return { ok: false, error: messageOf(error) }
        }
      }, [failAuth, markChatSent, patchChatEntry, removeMessage, replaceMessage])

      const sendMedia = React.useCallback(async (chatId, file, caption) => {
        if (!file) return { ok: false, error: 'no file' }
        const localId = nextLocalMessageId()
        const kind = deriveKindFromFile(file)
        const fileName = str(file.name) || 'file'
        const mimetype = str(file.type) || 'application/octet-stream'
        const optimistic = normalizeMessage({
          id: localId,
          chatId: chatId,
          fromMe: true,
          timestamp: Date.now(),
          kind: kind,
          text: str(caption),
          media: { mimetype: mimetype, fileName: fileName, fileLength: num(file.size), ptt: false, animated: false, hasThumbnail: false },
          status: 'pending',
        })
        optimistic.local = true
        patchChatEntry(chatId, (entry) => ({
          messages: entry.messages.concat([optimistic]).sort(compareMessages),
          hasMore: entry.hasMore,
          loaded: true,
          loading: false,
          loadingOlder: false,
          error: null,
        }))
        markChatSent(chatId, optimistic)
        try {
          const raw = await apiFetch('/send-media', {
            method: 'POST',
            params: { chat: chatId, caption: str(caption) },
            headers: { 'content-type': mimetype, 'x-file-name': encodeURIComponent(fileName) },
            body: file,
            timeoutMs: 120000,
          })
          const rawMessage = raw && typeof raw === 'object' && raw.message ? raw.message : raw
          const saved = normalizeMessage(Object.assign({}, rawMessage || {}, {
            id: (rawMessage && rawMessage.id) || localId,
            chatId: chatId,
            fromMe: true,
            kind: (rawMessage && rawMessage.kind) || kind,
            text: (rawMessage && str(rawMessage.text)) || str(caption),
            timestamp: (rawMessage && num(rawMessage.timestamp)) || optimistic.timestamp,
            status: (rawMessage && rawMessage.status) || 'sent',
            media: (rawMessage && rawMessage.media) || optimistic.media,
          }))
          saved.local = false
          if (saved.id !== localId) replaceMessage(chatId, localId, saved)
          markChatSent(chatId, saved)
          return { ok: true, message: saved }
        } catch (error) {
          removeMessage(chatId, localId)
          if (isAuthError(error)) failAuth(error.status)
          return { ok: false, error: messageOf(error) }
        }
      }, [failAuth, markChatSent, patchChatEntry, removeMessage, replaceMessage])

      const notifyTyping = React.useCallback((chatId) => {
        if (!chatId) return
        const now = Date.now()
        const tracker = typingSentRef.current
        if (now - tracker.last > 2500) {
          tracker.last = now
          apiFetch('/typing', { method: 'POST', body: { chat: chatId, typing: true } }).catch((error) => {
            if (isAuthError(error)) failAuth(error.status)
          })
        }
        if (tracker.timer !== null) clearTimeout(tracker.timer)
        tracker.timer = setTimeout(() => {
          tracker.timer = null
          tracker.last = 0
          apiFetch('/typing', { method: 'POST', body: { chat: chatId, typing: false } }).catch(() => {})
        }, 4000)
      }, [failAuth])

      const copyMessage = React.useCallback((message) => {
        const value = str(message && message.text).slice(0, MAX_COPIED_CHARS)
        const done = (ok) => showToast(ok ? tx('toast.copied') : tx('toast.copyFailed'), ok ? 'info' : 'error')
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(value).then(() => done(true)).catch(() => legacyCopy(value, done))
            return
          }
        } catch (error) { /* fall through */ }
        legacyCopy(value, done)
      }, [showToast])

      const downloadMessage = React.useCallback((message) => {
        if (!message || !message.media) {
          showToast(tx('toast.error', { message: 'no media attached' }), 'error')
          return
        }
        try {
          const anchor = document.createElement('a')
          anchor.href = mediaUrl(message.chatId, message.id)
          anchor.download = message.media.fileName || (message.kind === 'video' ? 'video' : 'media')
          anchor.rel = 'noopener'
          document.body.appendChild(anchor)
          anchor.click()
          document.body.removeChild(anchor)
        } catch (error) {
          showToast(tx('toast.error', { message: messageOf(error) }), 'error')
        }
      }, [showToast])

      const retrySend = React.useCallback((message) => {
        if (!message) return
        if (message.kind === 'text') {
          removeMessage(message.chatId, message.id)
          void sendText(message.chatId, message.text, message.quoted ? message.quoted.id : null)
          return
        }
        showToast(tx('toast.error', { message: 'Attachments cannot be retried automatically; attach the file again.' }), 'error')
      }, [removeMessage, sendText, showToast])

      // ── calls / settings actions ────────────────────────────────────────
      const clearIncomingCall = React.useCallback(() => {
        callRef.current = null
        setIncomingCall(null)
        if (callTimerRef.current !== null) { clearTimeout(callTimerRef.current); callTimerRef.current = null }
      }, [])

      const receiveIncomingCall = React.useCallback((call) => {
        callRef.current = call
        setIncomingCall(call)
        if (callTimerRef.current !== null) clearTimeout(callTimerRef.current)
        callTimerRef.current = setTimeout(() => {
          callTimerRef.current = null
          callRef.current = null
          if (mountedRef.current) setIncomingCall(null)
        }, CALL_TTL_MS)
      }, [])

      const rejectCall = React.useCallback(async () => {
        const call = callRef.current
        if (!call) return
        if (busyRef.current === true) return
        busyRef.current = true
        setBusy('reject-call')
        try {
          await apiFetch('/call/reject', { method: 'POST', body: { id: call.id, from: call.from } })
          showToast(tx('call.rejected'), 'info')
          clearIncomingCall()
        } catch (error) {
          if (isAuthError(error)) failAuth(error.status)
          else showToast(tx('call.rejectError', { message: messageOf(error) }), 'error')
        } finally {
          busyRef.current = false
          setBusy('')
        }
      }, [clearIncomingCall, failAuth, showToast])

      const runAction = React.useCallback(async (name, path, body, successText, onSuccess) => {
        if (busyRef.current === true) return false
        busyRef.current = true
        setBusy(name)
        try {
          await apiFetch(path, { method: 'POST', body: body === undefined ? {} : body })
          if (successText) showToast(successText, 'info')
          if (onSuccess) onSuccess()
          return true
        } catch (error) {
          if (isAuthError(error)) failAuth(error.status)
          else showToast(tx('toast.error', { message: messageOf(error) }), 'error')
          return false
        } finally {
          busyRef.current = false
          if (mountedRef.current) setBusy('')
        }
      }, [failAuth, showToast])

      const startLink = React.useCallback(() => {
        void runAction('link', '/link/start', {}, tx('toast.linkStarted'))
      }, [runAction])

      const cancelLink = React.useCallback(() => {
        void runAction('link', '/link/cancel', {}, tx('toast.linkCancelled'))
      }, [runAction])

      const relinkDevice = React.useCallback(() => {
        void runAction('relink', '/link/relink', {}, tx('toast.relinkStarted'))
      }, [runAction])

      const reconnectNow = React.useCallback(() => {
        showToast(tx('toast.reconnecting'), 'info')
        void runAction('reconnect', '/reconnect', {}, tx('toast.reconnectSent'))
      }, [runAction, showToast])

      const logoutDevice = React.useCallback(async (wipeMessages) => {
        const done = await runAction('logout', '/link/logout', { wipeMessages: wipeMessages === true }, tx('toast.loggedOut'))
        if (done) {
          setSettingsOpen(false)
          setActiveChatId(null)
          activeChatRef.current = null
          setMobileThread(false)
          setChats([])
          chatsRef.current = []
          setMessagesByChatState({})
          messagesRef.current = {}
          setQr(null)
          void bootstrap()
        }
      }, [bootstrap, runAction])

      // ── realtime: SSE with polling fallback ─────────────────────────────
      const applyMessageEvent = React.useCallback((payload) => {
        if (!payload || typeof payload !== 'object') return
        const chatId = str(payload.chatId)
        const message = normalizeMessage(payload.message || payload)
        if (!chatId || !message) return
        message.chatId = chatId
        const entry = messagesRef.current[chatId]
        if (entry !== undefined) upsertMessage(chatId, message)
        const currentChats = chatsRef.current
        const index = currentChats.findIndex((chat) => chat.id === chatId)
        if (index === -1) {
          scheduleChatsRefresh(CHATS_DEBOUNCE_MS)
        } else {
          const chat = currentChats[index]
          const incomingUnread = message.fromMe !== true && activeChatRef.current !== chatId
          const next = currentChats.slice()
          next[index] = Object.assign({}, chat, {
            lastMessage: {
              id: message.id,
              text: message.text,
              fromMe: message.fromMe,
              timestamp: message.timestamp,
              kind: message.kind,
            },
            timestamp: Math.max(num(chat.timestamp), message.timestamp),
            unread: message.fromMe === true ? chat.unread : (incomingUnread ? chat.unread + 1 : 0),
          })
          chatsRef.current = next
          setChats(next)
        }
        if (message.fromMe !== true && activeChatRef.current === chatId) markRead(chatId, [message.id])
        if (message.fromMe !== true && activeChatRef.current === chatId && entry === undefined) scheduleChatsRefresh(CHATS_DEBOUNCE_MS)
      }, [markRead, scheduleChatsRefresh, upsertMessage])

      const applyTypingEvent = React.useCallback((payload) => {
        if (!payload || typeof payload !== 'object') return
        const chatId = str(payload.chatId)
        if (!chatId) return
        const participant = str(payload.participant) || 'participant'
        const active = payload.typing === true
        setTypingMap((previous) => {
          const current = Object.assign({}, previous[chatId] || {})
          if (active) current[participant] = Date.now() + TYPING_TTL_MS
          else delete current[participant]
          const next = Object.assign({}, previous)
          next[chatId] = current
          typingMapRef.current = next
          return next
        })
      }, [])

      const applyCallEvent = React.useCallback((payload) => {
        const raw = payload && typeof payload === 'object' && payload.call ? payload.call : payload
        const call = normalizeCall(raw)
        if (!call) return
        if (isIncomingCallStatus(call.status)) {
          if (callRef.current !== null && callRef.current.id === call.id) return
          receiveIncomingCall(call)
          return
        }
        if (callRef.current !== null && (call.id === '' || callRef.current.id === call.id)) clearIncomingCall()
      }, [clearIncomingCall, receiveIncomingCall])

      const applyErrorEvent = React.useCallback((payload) => {
        const error = payload && typeof payload === 'object' && payload.error ? payload.error : payload
        const message = error && typeof error === 'object' ? str(error.message) : str(error)
        if (message !== '') showToast(tx('toast.error', { message: truncate(message, 200) }), 'error')
      }, [showToast])

      React.useEffect(() => {
        let disposed = false
        let source = null
        let pollTimer = null
        let failures = 0

        const stopPolling = () => {
          if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null }
        }

        const poll = async () => {
          if (disposed) return
          try {
            const raw = await apiFetch('/state')
            if (disposed) return
            const next = applyServerState(raw)
            if (next.linked === true) await refreshChats(searchRef.current, true)
            const chatId = activeChatRef.current
            if (chatId) {
              const entry = messagesRef.current[chatId]
              if (!entry || entry.loaded !== true) await loadMessages(chatId)
            }
          } catch (error) {
            if (isAuthError(error)) { failAuth(error.status); stopPolling() }
          }
        }

        const startPolling = () => {
          if (pollTimer !== null || disposed) return
          setSseMode('polling')
          pollTimer = setInterval(() => { void poll() }, POLL_INTERVAL_MS)
        }

        const EventSourceCtor = resolveEventSource()
        if (!EventSourceCtor) {
          startPolling()
          return () => { disposed = true; stopPolling() }
        }
        try {
          source = new EventSourceCtor(API + '/events')
        } catch (error) {
          source = null
          startPolling()
        }
        if (source !== null) {
          listenEvent(source, 'open', () => { failures = 0; setSseMode('live'); stopPolling() })
          listenEvent(source, 'error', (payload) => {
            if (disposed) return
            // A server-sent `error` frame carries JSON data; a connection
            // failure does not. Only the latter counts toward the fallback.
            if (payload !== null && payload !== undefined) {
              applyErrorEvent(payload)
              return
            }
            failures += 1
            setSseMode('connecting')
            if (failures >= 3) {
              try { source.close() } catch (error) { /* ignore */ }
              source = null
              startPolling()
            }
          })
          listenEvent(source, 'state', (payload) => {
            if (payload) applyServerState(payload)
          })
          listenEvent(source, 'qr', (payload) => {
            const value = payload && typeof payload === 'object' ? payload.qr : payload
            setQr(typeof value === 'string' && value !== '' ? value : null)
          })
          listenEvent(source, 'message', applyMessageEvent)
          listenEvent(source, 'message-status', (payload) => {
            if (!payload || typeof payload !== 'object') return
            const chatId = str(payload.chatId)
            const id = str(payload.id)
            if (!chatId || !id) return
            updateMessageStatus(chatId, id, payload.status)
          })
          listenEvent(source, 'chats', () => scheduleChatsRefresh(300))
          listenEvent(source, 'history', () => scheduleChatsRefresh(300))
          listenEvent(source, 'typing', applyTypingEvent)
          listenEvent(source, 'call', applyCallEvent)
        }
        return () => {
          disposed = true
          stopPolling()
          if (source !== null) {
            try { source.close() } catch (error) { /* ignore */ }
          }
        }
      }, [
        applyCallEvent, applyErrorEvent, applyMessageEvent, applyServerState, applyTypingEvent,
        failAuth, loadMessages, refreshChats, scheduleChatsRefresh, showToast, updateMessageStatus,
      ])

      React.useEffect(() => {
        searchRef.current = search
        if (lastFetchedQueryRef.current === search) return undefined
        const timer = setTimeout(() => {
          void refreshChats(search, true)
        }, SEARCH_DEBOUNCE_MS)
        return () => clearTimeout(timer)
      }, [search, refreshChats])

      // ── derived view state ──────────────────────────────────────────────
      const typingIds = React.useMemo(() => {
        const now = Date.now()
        const ids = {}
        Object.keys(typingMap).forEach((chatId) => {
          const participants = typingMap[chatId] || {}
          const active = Object.keys(participants).some((key) => participants[key] > now)
          if (active) ids[chatId] = true
        })
        return ids
      }, [typingMap, typingTick])

      const visibleChats = React.useMemo(() => {
        const query = search.trim().toLowerCase()
        let list = chats.filter((chat) => chat.archived !== true)
        if (query !== '') {
          list = list.filter((chat) => {
            if (chat.name.toLowerCase().indexOf(query) !== -1) return true
            const last = chat.lastMessage
            return Boolean(last && last.text && last.text.toLowerCase().indexOf(query) !== -1)
          })
        }
        list = list.slice()
        list.sort((left, right) => {
          const pinnedDelta = (right.pinned ? 1 : 0) - (left.pinned ? 1 : 0)
          if (pinnedDelta !== 0) return pinnedDelta
          return right.timestamp - left.timestamp
        })
        return list
      }, [chats, search])

      const activeChat = React.useMemo(() => chats.find((chat) => chat.id === activeChatId) || null, [chats, activeChatId])
      const activeEntry = activeChatId !== null ? messagesByChat[activeChatId] : null
      const activeMessages = activeEntry && Array.isArray(activeEntry.messages) ? activeEntry.messages : []
      const activeTyping = activeChatId !== null && typingIds[activeChatId] === true

      const reconnectInMs = React.useMemo(() => {
        void clockTick
        if (reconnectDeadline === null) return null
        return Math.max(0, reconnectDeadline - Date.now())
      }, [reconnectDeadline, clockTick])

      const incomingCallerName = React.useMemo(() => {
        if (!incomingCall) return ''
        const byChat = chats.find((chat) => chat.id === incomingCall.chatId)
        if (byChat) return byChat.name
        if (incomingCall.from) return phoneFromJid(incomingCall.from)
        return ''
      }, [chats, incomingCall])

      const connectionStatusLine = !state
        ? tx('rail.meConnecting')
        : state.connection === 'online'
          ? tx('rail.meOnline')
          : state.connection === 'offline'
            ? tx('rail.meOffline')
            : state.connection === 'loggedOut'
              ? tx('rail.meOffline')
              : tx('rail.meConnecting')

      const callsUnavailable = React.useCallback(() => {
        setCallsNoteOpen((value) => !value)
      }, [])

      const openSettings = React.useCallback(() => { setSettingsOpen(true) }, [])
      const closeSettings = React.useCallback(() => { setSettingsOpen(false) }, [])
      const dismissToast = React.useCallback(() => { setToast(null) }, [])

      const onReply = React.useCallback((message) => { setReplyTo(message) }, [])
      const cancelReply = React.useCallback(() => { setReplyTo(null) }, [])
      const openMedia = React.useCallback((message) => { setLightbox(message) }, [])
      const closeLightbox = React.useCallback(() => { setLightbox(null) }, [])

      const retryActiveMessages = React.useCallback(() => {
        if (activeChatId !== null) void loadMessages(activeChatId, { force: true })
      }, [activeChatId, loadMessages])

      // ── render ──────────────────────────────────────────────────────────
      let screen
      if (status === 'auth') {
        screen = h(AuthErrorScreen, { status: authStatus, onRetry: () => { void bootstrap() } })
      } else if (state === null) {
        if (status === 'error') {
          screen = h(ServiceErrorScreen, {
            detail: serviceError,
            onRetry: () => { void bootstrap() },
            onSettings: openSettings,
          })
        } else {
          screen = h(LoadingScreen, null)
        }
      } else if (state.linked !== true) {
        screen = h(LinkScreen, {
          state: state,
          qr: qr,
          busy: busy,
          onStart: startLink,
          onCancel: cancelLink,
        })
      } else if (state.needsRelink === true || state.connection === 'loggedOut') {
        screen = h(RelinkScreen, {
          state: state,
          busy: busy,
          onRelink: relinkDevice,
          onSettings: openSettings,
        })
      } else {
        const mainPane = activeChat !== null
          ? h(CenterPane, {
            chat: activeChat,
            state: state,
            messages: activeMessages,
            hasMore: activeEntry ? activeEntry.hasMore === true : false,
            loading: activeEntry ? activeEntry.loading === true : true,
            loadingOlder: activeEntry ? activeEntry.loadingOlder === true : false,
            error: activeEntry ? activeEntry.error : null,
            typing: activeTyping,
            replyTo: replyTo,
            callsNoteOpen: callsNoteOpen,
            onBack: backToChats,
            onSettings: openSettings,
            onCallsUnavailable: callsUnavailable,
            onLoadOlder: () => loadOlderMessages(activeChat.id),
            onRetryMessages: retryActiveMessages,
            onReply: onReply,
            onCancelReply: cancelReply,
            onCopy: copyMessage,
            onOpenMedia: openMedia,
            onDownload: downloadMessage,
            onRetrySend: retrySend,
            onSend: sendText,
            onSendMedia: sendMedia,
            onTyping: notifyTyping,
          })
          : h('div', { className: 'dshwa-main' }, h(WelcomePane, { onSettings: openSettings, version: true }))
        screen = h('div', { className: 'dshwa-app' },
          h(ChatRail, {
            me: state.me,
            statusLine: connectionStatusLine,
            polling: sseMode === 'polling',
            chats: visibleChats,
            search: search,
            loading: chatsLoading === true && chats.length === 0,
            error: chatsError,
            activeChatId: activeChatId,
            typingChatIds: typingIds,
            onSearch: (value) => setSearch(value),
            onSelect: selectChat,
            onSettings: openSettings,
            onRefresh: () => { void refreshChats(search, false) },
            onRetry: () => { void refreshChats(search, false) },
          }),
          mainPane,
        )
      }

      const children = []
      if (incomingCall !== null) {
        children.push(h(IncomingCallBanner, {
          key: 'incoming-call',
          call: incomingCall,
          callerName: incomingCallerName,
          busy: busy,
          onReject: () => { void rejectCall() },
        }))
      }
      const showConnectionBanner = status === 'ready'
        && state !== null
        && state.linked === true
        && state.needsRelink !== true
        && state.connection !== 'loggedOut'
      if (showConnectionBanner) {
        children.push(h(ConnectionBanner, {
          key: 'connection-banner',
          state: state,
          busy: busy,
          reconnectInMs: reconnectInMs,
          onReconnect: reconnectNow,
          onRelink: relinkDevice,
        }))
      }
      children.push(h(React.Fragment, { key: 'screen' }, screen))
      if (settingsOpen) {
        children.push(h(SettingsSheet, {
          key: 'settings',
          open: true,
          state: state,
          busy: busy,
          onClose: closeSettings,
          onLogout: (wipe) => { void logoutDevice(wipe) },
          onRelink: relinkDevice,
          onReconnect: reconnectNow,
        }))
      }
      if (lightbox !== null) {
        children.push(h(Lightbox, { key: 'lightbox', item: lightbox, onClose: closeLightbox }))
      }
      children.push(h(Toast, { key: 'toast', toast: toast, onDismiss: dismissToast }))

      return h('div', {
        className: 'dshwa',
        'data-testid': 'whatsapp-root',
        'data-theme': theme,
        'data-mobile-thread': mobileThread ? 'true' : 'false',
        'data-sse-mode': sseMode,
        lang: 'en',
      }, children)
    }

    // ── left sidebar entry ────────────────────────────────────────────────
    function SidebarEntry(props) {
      const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 18
      return h('span', {
        className: 'dshwa-sidebar-entry',
        'data-testid': 'sidebar-entry',
        'data-active': props && props.active === true ? 'true' : 'false',
        role: 'img',
        'aria-label': tx('entry.aria'),
        title: tx('entry.label'),
        style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'currentColor', lineHeight: 0 },
        onClick: requestPanel,
      }, h(Icon, { name: 'whatsapp', size: size }))
    }

    // ── clipboard fallback ────────────────────────────────────────────────
    function legacyCopy(value, done) {
      try {
        if (typeof document === 'undefined' || !document.body) { done(false); return }
        const area = document.createElement('textarea')
        area.value = value
        area.setAttribute('readonly', 'readonly')
        area.style.position = 'fixed'
        area.style.top = '-1000px'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        let ok = false
        try {
          if (typeof document.execCommand === 'function') ok = document.execCommand('copy') === true
        } catch (error) { ok = false }
        document.body.removeChild(area)
        done(ok)
      } catch (error) {
        done(false)
      }
    }

    // ── plugin registration ───────────────────────────────────────────────
    const SIDEBAR_DEFINITION = {
      name: SLOT_SIDEBAR,
      id: PANEL_ID,
      order: 40,
      label: 'WhatsApp',
      locale: NS,
    }

    const MAIN_DEFINITION = {
      name: SLOT_MAIN,
      key: PANEL_ID,
      locale: NS,
    }

    const REGISTER_SLOTS = function registerSlots(slots) {
      const disposers = []
      try {
        const disposeSidebar = slots.inject(SLOT_SIDEBAR, function () {
          return slots.register(SIDEBAR_DEFINITION, SidebarEntry)
        })
        if (typeof disposeSidebar === 'function') disposers.push(disposeSidebar)
      } catch (error) { /* slot not declared by this host version */ }
      try {
        const disposeMain = slots.inject(SLOT_MAIN, function () {
          return slots.register(MAIN_DEFINITION, App)
        })
        if (typeof disposeMain === 'function') disposers.push(disposeMain)
      } catch (error) { /* slot not declared by this host version */ }
      return function disposeSlots() {
        disposers.forEach((dispose) => {
          try { dispose() } catch (error) { /* ignore */ }
        })
      }
    }

    function setupSlots(ctx) {
      ctx.inject(['slots'], function (scope) {
        try {
          const slots = scope && scope.slots
          if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return
          if (typeof scope.effect === 'function') {
            try {
              scope.effect(function () { return REGISTER_SLOTS(slots) }, 'dsh-whatsapp: slots')
              return
            } catch (error) {
              // Fall through to an unmanaged registration.
            }
          }
          REGISTER_SLOTS(slots)
        } catch (error) {
          // Registration failure must never fail the web boot.
        }
      })
    }

    function setupLocale(ctx) {
      ctx.inject(['locale'], function (scope) {
        try {
          const locale = scope && scope.locale
          if (!locale || typeof locale.register !== 'function') return
          const register = function () {
            try { return locale.register(NS, { en: COPY }) } catch (error) { return undefined }
          }
          if (typeof scope.effect === 'function') {
            try {
              scope.effect(register, 'dsh-whatsapp: locale')
            } catch (error) {
              register()
            }
          } else {
            register()
          }
          if (typeof locale.bind === 'function') {
            try {
              const bound = locale.bind(NS, 'en')
              if (typeof bound === 'function') boundTranslate = bound
            } catch (error) { /* keep the bundle table */ }
          }
        } catch (error) {
          // Locale is optional.
        }
      })
    }

    function setupLayout(ctx) {
      ctx.inject(['layout'], function (scope) {
        try {
          if (scope && scope.layout && typeof scope.layout.selectPanel === 'function') layoutService = scope.layout
        } catch (error) { /* optional */ }
      })
      try {
        if (typeof ctx.get === 'function') {
          const direct = ctx.get('layout')
          if (direct && typeof direct.selectPanel === 'function') layoutService = direct
        }
      } catch (error) {
        // `get` on an undeclared service throws on some cordis versions.
      }
    }

    function apply(ctx) {
      try {
        if (!ctx || typeof ctx.inject !== 'function') return
        setupLocale(ctx)
        setupLayout(ctx)
        setupSlots(ctx)
      } catch (error) {
        // apply() must never take the harness boot down with it.
        try {
          if (ctx && ctx.logger && typeof ctx.logger.warn === 'function') {
            ctx.logger.warn('dsh-whatsapp: client registration failed', messageOf(error))
          }
        } catch (logError) { /* ignore */ }
      }
    }

    module.exports = {
      name: 'dsh-whatsapp',
      inject: ['slots', 'locale', 'layout'],
      apply: apply,
      App: App,
      SidebarEntry: SidebarEntry,
      namespace: NS,
    }
    // No default export: the DSH client loader treats a function default as the
    // plugin entry point and would never call apply(), leaving the row "loading"
    // with no sidebar entry. The plugin object is the module itself.
    return module.exports
  },
})
