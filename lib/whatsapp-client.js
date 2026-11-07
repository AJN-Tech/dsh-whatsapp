/**
 * Baileys linked-device lifecycle for dsh-whatsapp.
 *
 * This layer owns exactly one thing: the socket. It turns Baileys' event emitter
 * into plain callbacks, renders the linking QR to a PNG data URL, and implements
 * the connection state machine (QR -> online -> offline -> backoff -> needs
 * re-link). Message mapping, stores, persistence and HTTP live elsewhere.
 *
 * Two invariants matter for the rest of the plugin:
 *  - no real network activity happens here until `start()`/`beginLink()` and
 *    tests can replace `makeWASocket`/`qrcode`/timers via `dependencies`;
 *  - the state machine's decisions are pure exported functions
 *    (`classifyDisconnect`, `reconnectDelay`, ...) so they are testable without
 *    any socket at all.
 */
import QRCode from 'qrcode'
import { baileys } from './baileys.js'
import {
  AVATAR_CACHE_TTL_MS,
  MAX_AVATAR_BYTES,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_ATTEMPTS,
  RECONNECT_MAX_MS,
} from './config.js'
import { createLogger } from './logger.js'
import { createMediaCache } from './media-cache.js'
import { isChatJid, normalizeJid, phoneFromJid } from './protocol.js'

export class WhatsAppClientError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'WhatsAppClientError'
    this.code = code
  }
}

/** Actions a closed connection can lead to. */
export const CONNECTION_ACTIONS = Object.freeze({
  RELINK: 'relink',
  STOP: 'stop',
  RESTART: 'restart',
  RECONNECT: 'reconnect',
})

const MAX_TEXT_CHARS = 65536
const MAX_MEDIA_IDS = 1000
const AVATAR_TIMEOUT_MS = 15000
const MAX_AVATAR_ENTRIES = 200
const QR_WIDTH = 320

const CALLBACK_NAMES = Object.freeze([
  'onState',
  'onQR',
  'onOpen',
  'onClose',
  'onUnlinked',
  'onError',
  'onMessagesUpsert',
  'onMessagesUpdate',
  'onMessagesDelete',
  'onMessagesReaction',
  'onMessagesMediaUpdate',
  'onReceipts',
  'onPresence',
  'onCall',
  'onChatsUpsert',
  'onChatsUpdate',
  'onChatsDelete',
  'onContactsUpsert',
  'onContactsUpdate',
  'onHistorySet',
  'onHistoryStatus',
  'onGroupsUpsert',
  'onGroupsUpdate',
  'onCredsSaved',
  'onAnyEvent',
])

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests: no socket required)
// ---------------------------------------------------------------------------

/** Numeric WebSocket/HTTP close code carried by a Boom or Error, or null. */
export function disconnectCode(error) {
  const candidates = [
    error?.output?.statusCode,
    error?.statusCode,
    error?.output?.payload?.statusCode,
    error?.data?.statusCode,
  ]
  for (const value of candidates) {
    const n = Number(value)
    if (Number.isFinite(n) && n > 0) return n
  }
  if (typeof error?.code === 'number' && Number.isFinite(error.code)) return error.code
  return null
}

/** Readable, stable name for a disconnect code (used in state.lastError.code). */
export function disconnectReasonName(statusCode) {
  switch (Number(statusCode)) {
    case 401:
      return 'logged-out'
    case 403:
      return 'forbidden'
    case 408:
      return 'connection-lost'
    case 411:
      return 'multidevice-mismatch'
    case 428:
      return 'connection-closed'
    case 440:
      return 'connection-replaced'
    case 500:
      return 'session-invalid'
    case 503:
      return 'service-unavailable'
    case 515:
      return 'restart-required'
    default:
      return Number.isFinite(Number(statusCode)) && Number(statusCode) > 0
        ? `disconnect-${Number(statusCode)}`
        : 'connection-closed'
  }
}

/**
 * Decide what a closed connection means.
 *
 * @param {unknown} error the `lastDisconnect.error` from Baileys (usually a Boom)
 * @returns {'relink'|'stop'|'restart'|'reconnect'}
 */
export function classifyDisconnect(error) {
  switch (disconnectCode(error)) {
    case 401: // loggedOut
    case 403: // forbidden
    case 411: // multideviceMismatch
    case 419: // unauthorized (legacy)
    case 500: // badSession
      return CONNECTION_ACTIONS.RELINK
    case 440: // connectionReplaced
      return CONNECTION_ACTIONS.STOP
    case 515: // restartRequired
      return CONNECTION_ACTIONS.RESTART
    default:
      return CONNECTION_ACTIONS.RECONNECT
  }
}

/**
 * Exponential backoff with +/-20% jitter, capped at RECONNECT_MAX_MS (so the
 * result is in [0.8*cap, 1.2*cap] once the cap engages).
 *
 * @param {number} attempt 1-based attempt number
 * @param {() => number} random injectable PRNG in [0, 1) (for tests)
 */
export function reconnectDelay(attempt, random = Math.random) {
  const n = Math.max(1, Math.floor(Number(attempt) || 1))
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(n - 1, 30))
  let sample = typeof random === 'function' ? Number(random()) : Number(random)
  if (!Number.isFinite(sample)) sample = 0.5
  sample = Math.min(1, Math.max(0, sample))
  return Math.round(base * (0.8 + 0.4 * sample))
}

/** CONTRACT media kind for an outgoing mimetype. */
export function classifyOutgoingMedia(mimetype) {
  const essence = String(mimetype ?? '').split(';', 1)[0].trim().toLowerCase()
  if (essence.startsWith('image/')) return 'image'
  if (essence.startsWith('video/')) return 'video'
  if (essence.startsWith('audio/')) return 'audio'
  return 'document'
}

/**
 * Build Baileys' send content for an uploaded file.
 *
 * @param {{buffer: Buffer, fileName?: string, mimetype?: string, caption?: string}} media
 */
export function buildMediaContent(media) {
  const buffer = media?.buffer
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new WhatsAppClientError('bad-media', 'media buffer is empty or not a Buffer')
  }
  const mimetype = typeof media.mimetype === 'string' && media.mimetype.trim() !== ''
    ? media.mimetype.trim().slice(0, 200)
    : 'application/octet-stream'
  const caption = typeof media.caption === 'string' ? media.caption.slice(0, MAX_TEXT_CHARS) : ''
  const fileName = typeof media.fileName === 'string' ? media.fileName.trim().slice(0, 300) : ''
  const kind = classifyOutgoingMedia(mimetype)
  if (kind === 'image') return { image: buffer, mimetype, caption: caption || undefined }
  if (kind === 'video') return { video: buffer, mimetype, caption: caption || undefined }
  if (kind === 'audio') {
    return {
      audio: buffer,
      mimetype,
      ptt: false,
      ...(caption !== '' ? { caption } : {}),
    }
  }
  return {
    document: buffer,
    mimetype,
    fileName: fileName || 'file',
    ...(caption !== '' ? { caption } : {}),
  }
}

/** Render a Baileys QR string as a PNG data URL. Injectable generator for tests. */
export async function renderQrDataUrl(qr, qrcode = QRCode) {
  if (typeof qr !== 'string' || qr === '') throw new WhatsAppClientError('bad-qr', 'QR payload is empty')
  const toDataURL = qrcode?.toDataURL
  if (typeof toDataURL !== 'function') throw new WhatsAppClientError('bad-qr', 'QR renderer is unavailable')
  const dataUrl = await toDataURL(qr, {
    type: 'image/png',
    margin: 1,
    width: QR_WIDTH,
    errorCorrectionLevel: 'M',
  })
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
    throw new WhatsAppClientError('bad-qr', 'QR renderer returned an unexpected payload')
  }
  return dataUrl
}

/** Baileys `sock.user` -> CONTRACT `me`. */
export function mapSocketUser(user) {
  if (!user || typeof user !== 'object') return null
  const id = normalizeJid(user.id ?? user.jid ?? '')
  if (id === '') return null
  const phone = phoneFromJid(id) || (typeof user.phoneNumber === 'string' ? phoneFromJid(normalizeJid(user.phoneNumber)) : '')
  const rawName = typeof user.name === 'string' && user.name.trim() !== ''
    ? user.name.trim()
    : (typeof user.verifiedName === 'string' ? user.verifiedName.trim() : '')
  return {
    id,
    name: rawName.slice(0, 200) || (phone !== '' ? `+${phone}` : id),
    phone,
  }
}

function safeErrorMessage(error) {
  const message = String(error?.message ?? error ?? '').trim()
  return message === '' ? 'connection closed' : message.slice(0, 300)
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class WhatsAppClient {
  #auth
  #logger
  #baileysLogger
  #callbacks = {}
  #deps
  #mediaCache
  #options
  #disposed = false
  #sock = null
  #attached = null
  #listeners = []
  #qrToken = 0
  #reconnectTimer = null
  #retryAttempt = 0
  #restartAttempts = 0
  #linking = false
  #loggingOut = false
  #avatarCache = new Map()
  #state = {
    connection: 'idle',
    qr: null,
    me: null,
    linked: false,
    lastConnectedAt: null,
    reconnectInMs: null,
    reconnectAttempt: 0,
    lastError: null,
    needsRelink: false,
  }

  constructor(options = {}) {
    if (!options.auth) throw new WhatsAppClientError('no-auth', 'WhatsAppClient requires an AuthStore')
    this.#auth = options.auth
    this.#logger = options.logger ?? { info() {}, warn() {}, error() {}, debug() {} }
    this.#options = options
    const level = options.logLevel ?? (typeof options.logger?.level === 'string' ? options.logger.level : undefined)
    this.#baileysLogger = createLogger({ logger: options.logger, level, prefix: '[whatsapp]' }).child({ class: 'baileys' })
    const deps = options.dependencies ?? {}
    this.#deps = {
      makeWASocket: deps.makeWASocket ?? ((config) => baileys().makeWASocket(config)),
      downloadMediaMessage: deps.downloadMediaMessage ?? ((message, type, options, ctx) => baileys().downloadMediaMessage(message, type, options, ctx)),
      qrcode: deps.qrcode ?? QRCode,
      fetch: deps.fetch ?? globalThis.fetch,
      Browsers: deps.Browsers ?? null,
      now: deps.now ?? Date.now,
      random: deps.random ?? Math.random,
      setTimeout: deps.setTimeout ?? setTimeout,
      clearTimeout: deps.clearTimeout ?? clearTimeout,
    }
    for (const name of CALLBACK_NAMES) {
      if (typeof options.callbacks?.[name] === 'function') this.#callbacks[name] = options.callbacks[name]
    }
    this.#mediaCache = options.mediaCache ?? createMediaCache({ logger: this.#logger })
  }

  get state() {
    return { ...this.#state }
  }

  get connection() {
    return this.#state.connection
  }

  get online() {
    return this.#state.connection === 'online'
  }

  get linked() {
    return this.#state.linked || this.#auth.linked === true
  }

  get mediaCache() {
    return this.#mediaCache
  }

  // -------------------------------------------------------------------------
  // Lifecycle API
  // -------------------------------------------------------------------------

  /** Auto-connect when credentials exist; otherwise stay idle. */
  async start() {
    if (this.#disposed) return
    await this.#ensureAuth()
    if (this.#auth.linked) {
      if (this.#state.connection !== 'online') await this.connect('start')
      return
    }
    this.#publishState({ connection: 'idle', qr: null })
  }

  /** Open a socket whose QR arrives through `onQR`/`onState`. */
  async beginLink() {
    if (this.#disposed) throw new WhatsAppClientError('disposed', 'client is disposed')
    await this.#ensureAuth()
    this.#linking = true
    this.#retryAttempt = 0
    this.#restartAttempts = 0
    await this.#teardown()
    this.#publishState({ connection: 'starting', qr: null, me: null, reconnectInMs: null, reconnectAttempt: 0, lastError: null, needsRelink: false })
    await this.connect('link')
  }

  /** Close a half-open linking socket and discard the unregistered credentials. */
  async cancelLink() {
    if (this.#disposed) return
    this.#linking = false
    this.#retryAttempt = 0
    this.#restartAttempts = 0
    await this.#teardown()
    try {
      await this.#auth.wipe()
    } catch (error) {
      this.#logger.warn?.('[whatsapp] failed to wipe half-open credentials', { code: error?.code })
    }
    this.#publishState({
      connection: 'idle',
      qr: null,
      me: null,
      linked: false,
      lastConnectedAt: null,
      reconnectInMs: null,
      reconnectAttempt: 0,
      lastError: null,
      needsRelink: false,
    })
  }

  /** User-initiated logout: tell the server when possible, then wipe credentials. */
  async logout() {
    if (this.#disposed) return
    this.#loggingOut = true
    this.#linking = false
    this.#clearReconnect()
    const sock = this.#sock
    if (sock && typeof sock.logout === 'function') {
      let timer = null
      try {
        const timeout = new Promise((resolve) => {
          timer = this.#deps.setTimeout(resolve, 5000)
        })
        await Promise.race([Promise.resolve(sock.logout()), timeout])
      } catch (error) {
        this.#logger.warn?.('[whatsapp] server logout failed; wiping local state anyway', { code: error?.code })
      } finally {
        if (timer !== null) {
          try {
            this.#deps.clearTimeout(timer)
          } catch {
            /* ignore */
          }
        }
      }
    }
    await this.#teardown()
    try {
      await this.#auth.wipe()
    } catch (error) {
      this.#logger.warn?.('[whatsapp] failed to wipe credentials on logout', { code: error?.code })
    }
    this.#loggingOut = false
    this.#retryAttempt = 0
    this.#restartAttempts = 0
    this.#publishState({
      connection: 'idle',
      qr: null,
      me: null,
      linked: false,
      lastConnectedAt: null,
      reconnectInMs: null,
      reconnectAttempt: 0,
      lastError: null,
      needsRelink: false,
    })
  }

  /** Wipe credentials and immediately open a fresh linking socket. */
  async relink() {
    if (this.#disposed) throw new WhatsAppClientError('disposed', 'client is disposed')
    this.#loggingOut = false
    this.#clearReconnect()
    this.#retryAttempt = 0
    this.#restartAttempts = 0
    await this.#teardown()
    try {
      await this.#auth.wipe()
    } catch (error) {
      this.#logger.warn?.('[whatsapp] failed to wipe credentials before re-link', { code: error?.code })
    }
    await this.beginLink()
  }

  /** Manual reconnect (keeps credentials, resets the backoff counter). */
  async reconnect() {
    if (this.#disposed) return
    this.#clearReconnect()
    this.#retryAttempt = 0
    this.#restartAttempts = 0
    await this.#teardown()
    if (!this.#auth.linked && !this.#state.linked) {
      await this.beginLink()
      return
    }
    this.#linking = false
    await this.connect('manual')
  }

  /** Idempotent shutdown: timers, listeners, socket and caches. */
  async dispose() {
    if (this.#disposed) return
    this.#disposed = true
    this.#clearReconnect()
    const sock = this.#sock
    this.#sock = null
    this.#detachAll()
    this.#qrToken += 1
    if (sock) {
      try {
        const ended = sock.end?.(undefined)
        if (ended && typeof ended.catch === 'function') ended.catch(() => {})
      } catch {
        /* socket teardown is best effort */
      }
    }
    this.#mediaCache.clear()
    this.#avatarCache.clear()
    this.#callbacks = {}
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  /**
   * @param {string} chatId
   * @param {string} text
   * @param {object|null} quotedWaMessage minimal WAMessage built by protocol.quoteFromStored
   */
  async sendText(chatId, text, quotedWaMessage = null) {
    const jid = this.#requireChatJid(chatId)
    if (typeof text !== 'string' || text.trim() === '') {
      throw new WhatsAppClientError('bad-text', 'message text is required')
    }
    if (text.length > MAX_TEXT_CHARS) {
      throw new WhatsAppClientError('text-too-long', 'message text is too long')
    }
    const sock = this.#requireOnline()
    const options = quotedWaMessage ? { quoted: quotedWaMessage } : {}
    const result = await sock.sendMessage(jid, { text }, options)
    if (!result) throw new WhatsAppClientError('send-failed', 'WhatsApp did not acknowledge the message')
    return result
  }

  /** @param {{buffer: Buffer, fileName?: string, mimetype?: string, caption?: string}} media */
  async sendMedia(chatId, media) {
    const jid = this.#requireChatJid(chatId)
    const content = buildMediaContent(media)
    const sock = this.#requireOnline()
    const result = await sock.sendMessage(jid, content)
    if (!result) throw new WhatsAppClientError('send-failed', 'WhatsApp did not acknowledge the message')
    return result
  }

  async sendRead(chatId, messageIds) {
    const jid = this.#requireChatJid(chatId)
    if (!Array.isArray(messageIds)) return
    const keys = messageIds
      .slice(0, MAX_MEDIA_IDS)
      .filter((id) => typeof id === 'string' && id !== '')
      .map((id) => ({ remoteJid: jid, id, fromMe: false }))
    if (keys.length === 0) return
    const sock = this.#requireOnline()
    await sock.readMessages(keys)
  }

  async sendTyping(chatId, typing) {
    const jid = this.#requireChatJid(chatId)
    if (!this.online) return
    const sock = this.#sock
    if (!sock || typeof sock.sendPresenceUpdate !== 'function') return
    try {
      await sock.sendPresenceUpdate(typing ? 'composing' : 'paused', jid)
    } catch (error) {
      this.#reportError(error, 'typing-failed')
    }
  }

  async rejectCall(callId, from) {
    if (typeof callId !== 'string' || callId === '' || callId.length > 256) {
      throw new WhatsAppClientError('bad-call', 'call id is required')
    }
    const fromJid = normalizeJid(from ?? '')
    if (fromJid === '' || !fromJid.includes('@')) {
      throw new WhatsAppClientError('bad-call', 'caller jid is required')
    }
    const sock = this.#requireOnline()
    if (typeof sock.rejectCall !== 'function') {
      throw new WhatsAppClientError('calls-unsupported', 'this WhatsApp session cannot reject calls')
    }
    await sock.rejectCall(callId, fromJid)
  }

  /** Download and cache a Baileys WAMessage's attachment. */
  async downloadMedia(waMessage, { key = null, mimetype = '', fileName = '' } = {}) {
    if (!waMessage || typeof waMessage !== 'object') return null
    return this.#mediaCache.read(waMessage, {
      key: key ?? undefined,
      sock: this.#sock,
      logger: this.#logger,
      mimetype,
      fileName,
      download: this.#deps.downloadMediaMessage,
    })
  }

  /** Profile picture at `image` size, bounded and TTL-cached; null when unavailable. */
  async getAvatar(jid) {
    const normalized = normalizeJid(jid)
    if (normalized === '') return null
    const now = this.#deps.now()
    const cached = this.#avatarCache.get(normalized)
    if (cached && now - cached.at < (cached.ttl ?? AVATAR_CACHE_TTL_MS)) return cached.value
    let value = null
    const sock = this.#sock
    // Without a socket there is nothing to ask; do not cache a negative answer.
    if (!sock || typeof sock.profilePictureUrl !== 'function') return null
    try {
      if (typeof sock.profilePictureUrl === 'function') {
        const url = await sock.profilePictureUrl(normalized, 'image')
        if (typeof url === 'string' && url !== '') {
          const fetchImpl = this.#deps.fetch
          if (typeof fetchImpl === 'function') {
            const init = {}
            if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
              init.signal = AbortSignal.timeout(AVATAR_TIMEOUT_MS)
            }
            const response = await fetchImpl(url, init)
            if (response && response.ok === true) {
              const buffer = Buffer.from(await response.arrayBuffer())
              if (buffer.length > 0 && buffer.length <= MAX_AVATAR_BYTES) {
                const contentType = typeof response.headers?.get === 'function' ? response.headers.get('content-type') : ''
                value = {
                  buffer,
                  mimetype: (typeof contentType === 'string' ? contentType.split(';', 1)[0] : '') || 'image/jpeg',
                }
              }
            }
          }
        }
      }
    } catch (error) {
      // "no profile picture" is a normal answer, not an error worth surfacing.
      this.#logger.debug?.('[whatsapp] avatar unavailable', { code: error?.output?.statusCode ?? error?.code })
    }
    if (this.#avatarCache.size >= MAX_AVATAR_ENTRIES) {
      const oldest = this.#avatarCache.keys().next().value
      if (oldest !== undefined) this.#avatarCache.delete(oldest)
    }
    this.#avatarCache.set(normalized, { value, at: now, ttl: value ? AVATAR_CACHE_TTL_MS : 5 * 60 * 1000 })
    return value
  }

  // -------------------------------------------------------------------------
  // Socket plumbing
  // -------------------------------------------------------------------------

  async #ensureAuth() {
    if (this.#auth.state) return
    await this.#auth.load()
  }

  #socketConfig() {
    let Browsers = this.#deps.Browsers
    if (!Browsers) {
      try { Browsers = baileys().Browsers } catch { Browsers = null }
    }
    return {
      auth: this.#auth.state,
      logger: this.#baileysLogger,
      printQRInTerminal: false,
      browser: Browsers?.ubuntu ? Browsers.ubuntu('Chrome') : ['DeepSeek Harness', 'Chrome', '1.0.0'],
      // Behave like WhatsApp Web: only mark online while this tab is actually
      // using the socket, and never ask for the full (huge) history download.
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      emitOwnEvents: false,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      defaultQueryTimeoutMs: 60000,
      getMessage: async (key) => {
        const getMessage = this.#options.getMessage
        if (typeof getMessage !== 'function') return undefined
        try {
          return await getMessage(key)
        } catch {
          return undefined
        }
      },
      cachedGroupMetadata: async () => undefined,
    }
  }

  async connect(_reason = 'manual') {
    if (this.#disposed) return
    this.#clearReconnect()
    await this.#teardown()
    await this.#ensureAuth()
    this.#publishState({
      connection: 'connecting',
      qr: null,
      reconnectInMs: null,
      reconnectAttempt: this.#retryAttempt,
    })
    let sock
    try {
      sock = await this.#deps.makeWASocket(this.#socketConfig())
    } catch (error) {
      this.#reportError(error, 'connect-failed')
      this.#scheduleReconnect(CONNECTION_ACTIONS.RECONNECT, error)
      return
    }
    if (!sock || this.#disposed) {
      try {
        sock?.end?.(undefined)
      } catch {
        /* nothing to clean up */
      }
      return
    }
    this.#sock = sock
    this.#attach(sock)
  }

  #attach(sock) {
    this.#attached = sock
    const bind = (eventName, callbackName) => {
      const handler = (payload) => {
        this.#call('onAnyEvent', eventName, payload)
        if (callbackName !== null) this.#call(callbackName, payload)
      }
      try {
        sock.ev?.on?.(eventName, handler)
        this.#listeners.push({ eventName, handler })
      } catch (error) {
        this.#reportError(error, 'listener-failed')
      }
    }
    const connectionHandler = (update) => {
      this.#call('onAnyEvent', 'connection.update', update)
      this.#onConnectionUpdate(update, sock)
    }
    sock.ev.on('connection.update', connectionHandler)
    this.#listeners.push({ eventName: 'connection.update', handler: connectionHandler })

    const credsHandler = () => {
      this.#call('onAnyEvent', 'creds.update')
      const saved = this.#auth.saveCreds()
      Promise.resolve(saved)
        .then(() => this.#call('onCredsSaved'))
        .catch((error) => this.#reportError(error, 'creds-save-failed'))
    }
    sock.ev.on('creds.update', credsHandler)
    this.#listeners.push({ eventName: 'creds.update', handler: credsHandler })
    bind('messaging-history.set', 'onHistorySet')
    bind('messaging-history.status', 'onHistoryStatus')
    bind('chats.upsert', 'onChatsUpsert')
    bind('chats.update', 'onChatsUpdate')
    bind('chats.delete', 'onChatsDelete')
    bind('contacts.upsert', 'onContactsUpsert')
    bind('contacts.update', 'onContactsUpdate')
    bind('messages.upsert', 'onMessagesUpsert')
    bind('messages.update', 'onMessagesUpdate')
    bind('messages.delete', 'onMessagesDelete')
    bind('messages.reaction', 'onMessagesReaction')
    bind('messages.media-update', 'onMessagesMediaUpdate')
    bind('message-receipt.update', 'onReceipts')
    bind('presence.update', 'onPresence')
    bind('call', 'onCall')
    bind('groups.upsert', 'onGroupsUpsert')
    bind('groups.update', 'onGroupsUpdate')
    // Events that are forwarded through onAnyEvent only; the host has no UI for
    // them yet, but wiring them keeps the callback surface complete.
    for (const name of [
      'group-participants.update',
      'group.join-request',
      'group.member-tag.update',
      'lid-mapping.update',
      'settings.update',
      'blocklist.set',
      'blocklist.update',
      'labels.edit',
      'labels.association',
      'chats.lock',
      'message-capping.update',
      'newsletter.reaction',
      'newsletter.view',
      'newsletter-participants.update',
      'newsletter-settings.update',
    ]) {
      bind(name, null)
    }
  }

  #detachAll() {
    const sock = this.#attached
    this.#attached = null
    for (const { eventName, handler } of this.#listeners) {
      try {
        sock?.ev?.off?.(eventName, handler)
      } catch {
        /* best effort */
      }
    }
    this.#listeners = []
  }

  async #teardown() {
    this.#clearReconnect()
    const sock = this.#sock
    this.#sock = null
    this.#detachAll()
    this.#qrToken += 1
    if (!sock) return
    try {
      const ended = sock.end?.(undefined)
      if (ended && typeof ended.catch === 'function') ended.catch(() => {})
    } catch {
      /* ignoring is correct: the socket is being discarded */
    }
  }

  #clearReconnect() {
    if (this.#reconnectTimer !== null) {
      try {
        this.#deps.clearTimeout(this.#reconnectTimer)
      } catch {
        /* ignore */
      }
      this.#reconnectTimer = null
    }
  }

  #onConnectionUpdate(update, sock) {
    if (!update || typeof update !== 'object' || this.#disposed) return
    if (typeof update.qr === 'string' && update.qr !== '') {
      void this.#handleQr(update.qr, sock)
    }
    if (update.connection === 'connecting') {
      if (this.#state.connection !== 'qr') this.#publishState({ connection: 'connecting' })
      return
    }
    if (update.connection === 'open') {
      void this.#handleOpen(update, sock)
      return
    }
    if (update.connection === 'close') {
      void this.#handleClose(update.lastDisconnect?.error, sock)
    }
  }

  async #handleQr(qr, sock) {
    const token = ++this.#qrToken
    try {
      const dataUrl = await renderQrDataUrl(qr, this.#deps.qrcode)
      if (this.#disposed || token !== this.#qrToken || this.#sock !== sock) return
      this.#publishState({ connection: 'qr', qr: dataUrl, lastError: null })
      this.#call('onQR', dataUrl)
    } catch (error) {
      this.#reportError(error, 'qr-render-failed')
    }
  }

  async #handleOpen(update, sock) {
    if (this.#disposed || this.#sock !== sock) return
    this.#retryAttempt = 0
    this.#restartAttempts = 0
    this.#linking = false
    const me = mapSocketUser(sock.user) ?? this.#state.me
    const now = this.#deps.now()
    try {
      await this.#auth.saveCreds()
    } catch (error) {
      this.#logger.warn?.('[whatsapp] could not persist updated credentials', { code: error?.code })
    }
    this.#publishState({
      connection: 'online',
      qr: null,
      me,
      linked: true,
      lastConnectedAt: now,
      reconnectInMs: null,
      reconnectAttempt: 0,
      lastError: null,
      needsRelink: false,
    })
    this.#call('onOpen', {
      me,
      isNewLogin: update.isNewLogin === true,
      receivedPendingNotifications: update.receivedPendingNotifications === true,
    })
  }

  async #handleClose(error, sock) {
    if (this.#sock !== sock) return
    this.#sock = null
    this.#detachAll()
    this.#qrToken += 1
    if (this.#disposed) return
    const statusCode = disconnectCode(error)
    const action = classifyDisconnect(error)
    const message = safeErrorMessage(error)
    const info = { action, statusCode, code: disconnectReasonName(statusCode), message }
    this.#call('onClose', info)
    if (this.#loggingOut) return
    const now = this.#deps.now()
    if (action === CONNECTION_ACTIONS.RELINK) {
      this.#clearReconnect()
      this.#linking = false
      this.#retryAttempt = 0
      try {
        await this.#auth.wipe()
      } catch (wipeError) {
        this.#logger.warn?.('[whatsapp] failed to wipe credentials after unlink', { code: wipeError?.code })
      }
      const lastError = { code: info.code, message, at: now }
      this.#publishState({
        connection: 'loggedOut',
        qr: null,
        me: null,
        linked: false,
        reconnectInMs: null,
        reconnectAttempt: 0,
        lastError,
        needsRelink: true,
      })
      this.#call('onUnlinked', { code: info.code, message, at: now })
      return
    }
    if (action === CONNECTION_ACTIONS.STOP) {
      this.#clearReconnect()
      const lastError = { code: 'connection-replaced', message, at: now }
      this.#publishState({
        connection: 'offline',
        qr: null,
        reconnectInMs: null,
        reconnectAttempt: 0,
        lastError,
        needsRelink: false,
      })
      this.#call('onError', lastError)
      return
    }
    this.#scheduleReconnect(action, error)
  }

  #scheduleReconnect(action, error) {
    this.#clearReconnect()
    const now = this.#deps.now()
    let delay
    if (action === CONNECTION_ACTIONS.RESTART && this.#restartAttempts < 3) {
      this.#restartAttempts += 1
      delay = 0
    } else {
      this.#retryAttempt += 1
      if (this.#retryAttempt > RECONNECT_MAX_ATTEMPTS) {
        const lastError = {
          code: 'reconnect-failed',
          message: 'giving up after repeated connection failures',
          at: now,
        }
        this.#publishState({
          connection: 'error',
          qr: null,
          reconnectInMs: null,
          reconnectAttempt: this.#retryAttempt,
          lastError,
          needsRelink: false,
        })
        this.#call('onError', lastError)
        return
      }
      delay = reconnectDelay(this.#retryAttempt, this.#deps.random)
    }
    const statusCode = disconnectCode(error)
    const lastError = statusCode === null
      ? { code: 'connection-lost', message: safeErrorMessage(error), at: now }
      : { code: disconnectReasonName(statusCode), message: safeErrorMessage(error), at: now }
    this.#publishState({
      connection: 'offline',
      qr: null,
      reconnectInMs: delay,
      reconnectAttempt: this.#retryAttempt,
      lastError,
      needsRelink: false,
    })
    this.#call('onError', lastError)
    this.#reconnectTimer = this.#deps.setTimeout(() => {
      this.#reconnectTimer = null
      if (this.#disposed) return
      this.#publishState({ reconnectInMs: null })
      void this.connect('reconnect').catch((connectError) => {
        this.#reportError(connectError, 'reconnect-failed')
        this.#scheduleReconnect(CONNECTION_ACTIONS.RECONNECT, connectError)
      })
    }, delay)
    this.#reconnectTimer?.unref?.()
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  #publishState(partial) {
    this.#state = { ...this.#state, ...partial }
    this.#call('onState', { ...this.#state })
  }

  #call(name, ...args) {
    const callback = this.#callbacks[name]
    if (typeof callback !== 'function') return
    try {
      const result = callback(...args)
      if (result && typeof result.then === 'function') {
        result.catch((error) => this.#reportCallbackError(name, error))
      }
    } catch (error) {
      this.#reportCallbackError(name, error)
    }
  }

  #reportCallbackError(name, error) {
    this.#logger.warn?.('[whatsapp] event callback failed', {
      callback: name,
      code: error?.code,
      message: safeErrorMessage(error),
    })
  }

  #reportError(error, fallbackCode = 'whatsapp-error') {
    const message = safeErrorMessage(error)
    const rawCode = error?.output?.statusCode ?? error?.statusCode ?? error?.code
    const code = rawCode === undefined || rawCode === null
      ? fallbackCode
      : (typeof rawCode === 'string' ? rawCode.slice(0, 60) : disconnectReasonName(rawCode))
    const info = { code, message, at: this.#deps.now() }
    this.#logger.warn?.('[whatsapp] client error', { code: info.code, message: info.message })
    this.#call('onError', info)
  }

  #requireChatJid(chatId) {
    const normalized = normalizeJid(chatId)
    if (normalized === '' || !isChatJid(normalized)) {
      throw new WhatsAppClientError('bad-chat', 'chat is not a valid WhatsApp conversation id')
    }
    return normalized
  }

  #requireOnline() {
    if (this.#disposed) throw new WhatsAppClientError('disposed', 'client is disposed')
    const sock = this.#sock
    if (!sock || !this.online) throw new WhatsAppClientError('offline', 'WhatsApp is not connected')
    return sock
  }
}

export function createWhatsAppClient(options) {
  return new WhatsAppClient(options)
}
