/**
 * The host-side facade described in CONTRACT.md (`lib/service.js`).
 *
 * It composes the three working parts — message store, media cache, Baileys
 * client — and owns the one state snapshot plus the event stream the HTTP layer
 * and SSE clients consume. Callbacks from the client are translated here into
 * stored messages and CONTRACT events; the client itself never emits SSE.
 */
import { FILES, PHONE_OFFLINE_MODEL } from './config.js'
import { createAuthStore } from './auth-store.js'
import { createMediaCache } from './media-cache.js'
import { createMessageStore } from './message-store.js'
import {
  contentFromMediaSource,
  isChatJid,
  isGroupJid,
  isStatusJid,
  mapCall,
  mapChatUpdate,
  mapMessage,
  mediaSourceOf,
  normalizeJid,
  statusFromRaw,
  statusFromReceipt,
  STUB_TYPE,
} from './protocol.js'
import { createWhatsAppClient, WhatsAppClientError } from './whatsapp-client.js'

const MAX_TEXT_CHARS = 65536
const MAX_READ_IDS = 1000
const MAX_ID_CHARS = 256

export class WhatsAppServiceError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'WhatsAppServiceError'
    this.code = code
  }
}

function noopLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} }
}

function fail(code, message) {
  return new WhatsAppServiceError(code, message)
}

function isId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS && !/[\s\u0000-\u001f]/.test(value)
}

function copyMe(me) {
  return me ? { id: me.id, name: me.name, phone: me.phone } : null
}

function copyError(error) {
  return error ? { code: error.code, message: error.message, at: error.at } : null
}

export class WhatsAppService {
  #dataDir
  #logger
  #box
  #auth
  #ownsAuth
  #deps
  #apiPrefix
  #store
  #mediaCache
  #client
  #subscribers = new Set()
  #ready
  #disposed = false
  #state = {
    linked: false,
    connection: 'idle',
    qr: null,
    me: null,
    lastConnectedAt: null,
    linkedAt: null,
    reconnectInMs: null,
    reconnectAttempt: 0,
    lastError: null,
    needsRelink: false,
  }

  constructor(options = {}) {
    this.#dataDir = options.dataDir ?? ''
    this.#logger = options.logger ?? noopLogger()
    this.#box = options.box ?? null
    this.#deps = options.dependencies ?? {}
    this.#apiPrefix = options.apiPrefix ?? null
    this.#ownsAuth = !options.auth
    this.#auth = options.auth ?? createAuthStore({ dataDir: this.#dataDir, box: this.#box, logger: this.#logger })
    this.#store = createMessageStore({
      dataDir: this.#dataDir,
      box: this.#box,
      logger: this.#logger,
      limits: this.#deps.storeLimits ?? {},
    })
    this.#mediaCache = createMediaCache({ logger: this.#logger, ...(this.#deps.mediaCacheOptions ?? {}) })
    this.#client = createWhatsAppClient({
      auth: this.#auth,
      logger: this.#logger,
      dependencies: this.#deps,
      callbacks: this.#buildCallbacks(),
      getMessage: (key) => this.#store.getMessageContent(key),
      mediaCache: this.#mediaCache,
      logLevel: this.#deps.logLevel,
    })
    this.#ready = this.#initialize()
    // Never let initialization rejection become an unhandled rejection: start()
    // and ready() surface it, and the state snapshot carries lastError.
    this.#ready.catch(() => {})
  }

  get apiPrefix() {
    return this.#apiPrefix
  }

  get client() {
    return this.#client
  }

  get store() {
    return this.#store
  }

  get mediaCache() {
    return this.#mediaCache
  }

  /** Extra (non-CONTRACT) hook the route layer awaits before sync queries. */
  async ready() {
    await this.#ready
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async #initialize() {
    try {
      await this.#store.load()
    } catch (error) {
      this.#noteInitError(error, 'message cache')
    }
    await this.#loadLinkMetadata()
    if (this.#auth.linked === true) {
      this.#state.linked = true
      if (this.#state.me === null) {
        const credsMe = this.#auth.state?.creds?.me
        if (credsMe && typeof credsMe === 'object' && typeof credsMe.id === 'string') {
          this.#state.me = {
            id: normalizeJid(credsMe.id),
            name: typeof credsMe.name === 'string' && credsMe.name !== '' ? credsMe.name : normalizeJid(credsMe.id),
            phone: '',
          }
          const match = /^(\d+)/.exec(this.#state.me.id)
          if (match) {
            this.#state.me.phone = match[1]
            if (this.#state.me.name === this.#state.me.id) this.#state.me.name = `+${match[1]}`
          }
        }
      }
    }
    if (this.#state.linkedAt === null && this.#state.linked) this.#state.linkedAt = Date.now()
    this.#emitState()
  }

  async #loadLinkMetadata() {
    if (this.#box === null) return
    let bytes = null
    try {
      bytes = await this.#box.openFile(FILES.link)
    } catch (error) {
      // A corrupt/rotated-but-unsealed metadata file must never block startup.
      this.#logger.warn?.('[whatsapp] linked-device metadata is unreadable; ignoring it', { code: error?.code })
      return
    }
    if (bytes === null) return
    try {
      const meta = JSON.parse(bytes.toString('utf8'))
      if (!meta || typeof meta !== 'object') return
      if (meta.me && typeof meta.me === 'object' && typeof meta.me.id === 'string') {
        this.#state.me = {
          id: normalizeJid(meta.me.id),
          name: typeof meta.me.name === 'string' ? meta.me.name.slice(0, 200) : normalizeJid(meta.me.id),
          phone: typeof meta.me.phone === 'string' ? meta.me.phone.slice(0, 32) : '',
        }
      }
      if (Number.isFinite(meta.linkedAt) && meta.linkedAt > 0) this.#state.linkedAt = Math.floor(meta.linkedAt)
    } catch (error) {
      this.#logger.warn?.('[whatsapp] linked-device metadata is malformed; ignoring it', { code: error?.code })
    }
  }

  async #saveLinkMetadata(me) {
    if (this.#box === null || !me) return
    try {
      await this.#box.sealFile(FILES.link, JSON.stringify({
        v: 1,
        me: copyMe(me),
        linkedAt: this.#state.linkedAt,
        savedAt: Date.now(),
      }))
    } catch (error) {
      this.#logger.warn?.('[whatsapp] could not persist linked-device metadata', { code: error?.code })
    }
  }

  async #clearLinkMetadata() {
    if (this.#box === null) return
    try {
      await this.#box.deleteFile(FILES.link)
    } catch (error) {
      this.#logger.warn?.('[whatsapp] could not remove linked-device metadata', { code: error?.code })
    }
  }

  #noteInitError(error, what) {
    this.#logger.warn?.(`[whatsapp] failed to load ${what}`, {
      code: error?.code,
      message: String(error?.message ?? error ?? '').slice(0, 200),
    })
    this.#state.lastError = { code: error?.code ?? 'init-failed', message: `failed to load ${what}`, at: Date.now() }
  }

  /** Auto-connect when credentials exist. CONTRACT: nothing happens until linked. */
  async start() {
    await this.ready()
    if (this.#disposed) return
    if (this.#auth.linked === true) {
      try {
        await this.#client.start()
      } catch (error) {
        this.#onClientError(this.#errorInfo(error, 'connect-failed'))
      }
      return
    }
    this.#emitState()
  }

  async beginLink() {
    await this.ready()
    if (this.#disposed) throw fail('disposed', 'service is disposed')
    await this.#client.beginLink()
  }

  async cancelLink() {
    await this.ready()
    if (this.#disposed) return
    await this.#client.cancelLink()
    this.#state.qr = null
    this.#state.connection = 'idle'
    this.#state.me = null
    this.#state.linked = false
    this.#state.linkedAt = null
    this.#state.reconnectInMs = null
    this.#state.reconnectAttempt = 0
    this.#state.lastError = null
    this.#state.needsRelink = false
    this.#emitState()
  }

  async logout({ wipeMessages = true } = {}) {
    await this.ready()
    if (this.#disposed) return
    await this.#client.logout()
    if (wipeMessages === true) {
      try {
        await this.#store.wipe()
      } catch (error) {
        this.#logger.warn?.('[whatsapp] could not wipe the cached chats', { code: error?.code })
      }
    }
    this.#state = {
      linked: false,
      connection: 'idle',
      qr: null,
      me: null,
      lastConnectedAt: null,
      linkedAt: null,
      reconnectInMs: null,
      reconnectAttempt: 0,
      lastError: null,
      needsRelink: false,
    }
    await this.#clearLinkMetadata()
    this.#emitState()
  }

  async relink() {
    await this.ready()
    if (this.#disposed) throw fail('disposed', 'service is disposed')
    // A fresh link can be a different WhatsApp account. Keeping the previous
    // account's cached chats would expose them to the next account linked to
    // this device, so re-linking wipes the local cache as well.
    try {
      await this.#store.wipe()
    } catch (error) {
      this.#logger.warn?.('[whatsapp] could not wipe the cached chats before re-link', { code: error?.code })
    }
    await this.#clearLinkMetadata()
    this.#state.me = null
    this.#state.linked = false
    this.#state.linkedAt = null
    this.#state.needsRelink = false
    this.#emitState()
    await this.#client.relink()
  }

  async reconnect() {
    await this.ready()
    if (this.#disposed) return
    await this.#client.reconnect()
  }

  /** Idempotent teardown: subscribers, customer client, store flush, owned auth. */
  async dispose() {
    if (this.#disposed) return
    this.#disposed = true
    this.#subscribers.clear()
    try {
      await this.#client.dispose()
    } catch (error) {
      this.#logger.warn?.('[whatsapp] client dispose failed', { code: error?.code })
    }
    try {
      await this.#store.dispose()
    } catch (error) {
      this.#logger.warn?.('[whatsapp] message store dispose failed', { code: error?.code })
    }
    this.#mediaCache.clear()
    if (this.#ownsAuth) {
      try {
        await this.#auth.close()
      } catch (error) {
        this.#logger.warn?.('[whatsapp] auth store close failed', { code: error?.code })
      }
    }
  }

  // -------------------------------------------------------------------------
  // State / events
  // -------------------------------------------------------------------------

  /** CONTRACT `state()`. Always returns a fresh plain object. */
  state() {
    const linked = this.#state.linked === true || this.#auth.linked === true
    return {
      linked,
      connection: this.#state.connection,
      qr: this.#state.connection === 'qr' ? this.#state.qr : null,
      // Stale link metadata must never surface as a "connected identity" while
      // the device is unlinked (e.g. credentials were removed out of band).
      me: linked ? copyMe(this.#state.me) : null,
      linkedAt: linked ? this.#state.linkedAt : null,
      lastConnectedAt: this.#state.lastConnectedAt,
      reconnectInMs: this.#state.reconnectInMs,
      reconnectAttempt: this.#state.reconnectAttempt,
      lastError: copyError(this.#state.lastError),
      needsRelink: this.#state.needsRelink === true,
      phoneOfflineModel: PHONE_OFFLINE_MODEL,
      callsSupported: false,
      messageCount: this.#store.messageCount,
      chatCount: this.#store.chatCount,
      storage: 'encrypted',
    }
  }

  /** Subscribe to CONTRACT events. Returns an unsubscribe function. */
  subscribe(listener) {
    if (typeof listener !== 'function') return () => {}
    this.#subscribers.add(listener)
    return () => {
      this.#subscribers.delete(listener)
    }
  }

  #broadcast(event) {
    if (this.#subscribers.size === 0) return
    for (const listener of [...this.#subscribers]) {
      try {
        listener(event)
      } catch (error) {
        this.#logger.warn?.('[whatsapp] event listener failed', { code: error?.code })
      }
    }
  }

  #emitState() {
    this.#broadcast({ type: 'state', state: this.state() })
  }

  // -------------------------------------------------------------------------
  // Client callbacks
  // -------------------------------------------------------------------------

  #buildCallbacks() {
    return {
      onState: (state) => this.#onClientState(state),
      onQR: () => {
        // The QR data URL is part of the state snapshot; #onClientState emits
        // the dedicated `qr` event exactly once per change.
      },
      onOpen: (info) => {
        void this.#onClientOpen(info)
      },
      onClose: () => {},
      onUnlinked: (info) => {
        void this.#onClientUnlinked(info)
      },
      onError: (error) => this.#onClientError(error),
      onMessagesUpsert: (payload) => {
        this.#onMessagesUpsert(payload)
      },
      onMessagesUpdate: (updates) => {
        this.#onMessagesUpdate(updates)
      },
      onMessagesDelete: (payload) => {
        this.#onMessagesDelete(payload)
      },
      onReceipts: (updates) => {
        this.#onReceipts(updates)
      },
      onPresence: (payload) => {
        this.#onPresence(payload)
      },
      onCall: (calls) => {
        this.#onCall(calls)
      },
      onChatsUpsert: (chats) => {
        this.#onChats(chats)
      },
      onChatsUpdate: (chats) => {
        this.#onChats(chats)
      },
      onChatsDelete: (ids) => {
        const result = this.#store.deleteChats(ids)
        if (result.changed) this.#broadcast({ type: 'chats' })
      },
      onContactsUpsert: (contacts) => {
        this.#onContacts(contacts)
      },
      onContactsUpdate: (contacts) => {
        this.#onContacts(contacts)
      },
      onHistorySet: (payload) => {
        this.#onHistorySet(payload)
      },
      onHistoryStatus: (payload) => {
        if (payload && payload.status === 'complete') this.#broadcast({ type: 'history' })
      },
      onGroupsUpsert: (groups) => {
        this.#onGroups(groups)
      },
      onGroupsUpdate: (groups) => {
        this.#onGroups(groups)
      },
      onMessagesReaction: () => {},
      onMessagesMediaUpdate: () => {},
      onCredsSaved: () => {},
    }
  }

  #onClientState(clientState) {
    if (!clientState || typeof clientState !== 'object' || this.#disposed) return
    const previousQr = this.#state.qr
    const fields = [
      'connection',
      'reconnectInMs',
      'reconnectAttempt',
      'lastError',
      'needsRelink',
      'lastConnectedAt',
    ]
    for (const field of fields) {
      if (Object.prototype.hasOwnProperty.call(clientState, field)) this.#state[field] = clientState[field]
    }
    if (Object.prototype.hasOwnProperty.call(clientState, 'qr')) {
      this.#state.qr = clientState.qr ?? null
    }
    if (Object.prototype.hasOwnProperty.call(clientState, 'me')) {
      this.#state.me = copyMe(clientState.me)
    }
    if (Object.prototype.hasOwnProperty.call(clientState, 'linked')) {
      this.#state.linked = clientState.linked === true || this.#auth.linked === true
    }
    this.#emitState()
    if (previousQr !== this.#state.qr) {
      this.#broadcast({ type: 'qr', qr: this.#state.connection === 'qr' ? this.#state.qr : null })
    }
  }

  async #onClientOpen(info) {
    if (this.#disposed) return
    const now = Date.now()
    this.#state.linked = true
    if (info?.me) this.#state.me = copyMe(info.me)
    if (this.#state.linkedAt === null || info?.isNewLogin === true) this.#state.linkedAt = now
    this.#state.needsRelink = false
    this.#state.lastError = null
    await this.#saveLinkMetadata(this.#state.me)
    if (this.#disposed) return
    this.#emitState()
  }

  async #onClientUnlinked(info) {
    if (this.#disposed) return
    this.#state.linked = false
    this.#state.me = null
    this.#state.linkedAt = null
    this.#state.needsRelink = true
    this.#state.lastError = {
      code: info?.code ?? 'logged-out',
      message: info?.message ?? 'this device was unlinked',
      at: info?.at ?? Date.now(),
    }
    // The next account linked here must never inherit this account's cached
    // chats. WhatsApp already revoked the session, so the cache has no owner
    // that can be verified against the next link.
    try {
      await this.#store.wipe()
    } catch (error) {
      this.#logger.warn?.('[whatsapp] could not wipe the cached chats after unlink', { code: error?.code })
    }
    await this.#clearLinkMetadata()
    if (this.#disposed) return
    this.#emitState()
  }

  #onClientError(error) {
    if (this.#disposed) return
    const info = {
      code: typeof error?.code === 'string' ? error.code.slice(0, 60) : 'whatsapp-error',
      message: String(error?.message ?? 'WhatsApp error').slice(0, 300),
      at: Number.isFinite(error?.at) ? error.at : Date.now(),
    }
    this.#state.lastError = info
    this.#broadcast({ type: 'error', error: info })
    this.#emitState()
  }

  #errorInfo(error, fallbackCode) {
    if (error instanceof WhatsAppClientError || error instanceof WhatsAppServiceError) {
      return { code: error.code || fallbackCode, message: error.message, at: Date.now() }
    }
    return {
      code: typeof error?.code === 'string' ? error.code.slice(0, 60) : fallbackCode,
      message: String(error?.message ?? 'WhatsApp error').slice(0, 300),
      at: Date.now(),
    }
  }

  // -------------------------------------------------------------------------
  // Incoming messages / chats / contacts
  // -------------------------------------------------------------------------

  #toRecord(waMessage) {
    if (!waMessage || typeof waMessage !== 'object') return null
    const chatId = normalizeJid(waMessage.key?.remoteJid ?? '')
    if (!isChatJid(chatId)) return null
    const message = mapMessage(waMessage, {
      chatId,
      resolveName: (jid) => this.#store.resolveName(jid),
      defaultStatus: 'unknown',
    })
    if (!isMessageId(message.id)) return null
    return { message, mediaSource: mediaSourceOf(waMessage) }
  }

  #onMessagesUpsert(payload) {
    if (this.#disposed || !payload || !Array.isArray(payload.messages)) return
    const notify = payload.type === 'notify'
    let chatsChanged = false
    for (const waMessage of payload.messages) {
      const chatId = normalizeJid(waMessage?.key?.remoteJid ?? '')
      if (!isChatJid(chatId) || isStatusJid(chatId)) continue
      const record = this.#toRecord(waMessage)
      if (!record) continue
      const nameHint = typeof waMessage.pushName === 'string' && waMessage.pushName.trim() !== ''
        ? waMessage.pushName.trim().slice(0, 200)
        : undefined
      const result = this.#store.upsertMessage(record.message, {
        mediaSource: record.mediaSource,
        unread: notify,
        silent: !notify,
        name: nameHint,
      })
      if (!result.message) continue
      chatsChanged = true
      if (result.created || result.changed) {
        this.#broadcast({ type: 'message', chatId: result.message.chatId, message: result.message })
      }
    }
    if (chatsChanged) this.#broadcast({ type: 'chats' })
  }

  #onMessagesUpdate(updates) {
    if (this.#disposed || !Array.isArray(updates)) return
    let chatsChanged = false
    for (const item of updates) {
      const chatId = normalizeJid(item?.key?.remoteJid ?? '')
      const id = item?.key?.id
      if (!isChatJid(chatId) || !isMessageId(id)) continue
      const patch = item.update && typeof item.update === 'object' ? item.update : {}
      if (patch.messageStubType === STUB_TYPE.REVOKE) {
        const result = this.#store.revokeMessage(chatId, id)
        if (result.changed && result.message) {
          this.#broadcast({ type: 'message', chatId, message: result.message })
          chatsChanged = true
        }
      } else if (patch.message && typeof patch.message === 'object') {
        const existing = this.#store.getMessage(chatId, id)
        const record = this.#toRecord({
          key: item.key,
          message: patch.message,
          messageTimestamp: patch.messageTimestamp
            ?? (existing ? Math.floor(existing.timestamp / 1000) : undefined),
        })
        if (record) {
          const result = this.#store.upsertMessage(record.message, {
            mediaSource: record.mediaSource,
            unread: false,
            silent: true,
          })
          if (result.message && (result.created || result.changed)) {
            this.#broadcast({ type: 'message', chatId, message: result.message })
            chatsChanged = true
          }
        }
      }
      if (patch.status !== undefined && patch.status !== null) {
        const status = statusFromRaw(patch.status)
        const result = this.#store.updateStatus(chatId, id, status)
        if (result.changed && result.message) {
          this.#broadcast({ type: 'message-status', chatId, id, status: result.message.status })
        }
      }
    }
    if (chatsChanged) this.#broadcast({ type: 'chats' })
  }

  #onMessagesDelete(payload) {
    if (this.#disposed || !payload) return
    if (Array.isArray(payload.keys)) {
      const byChat = new Map()
      for (const key of payload.keys) {
        const chatId = normalizeJid(key?.remoteJid ?? '')
        if (!isChatJid(chatId) || !isMessageId(key?.id)) continue
        if (!byChat.has(chatId)) byChat.set(chatId, [])
        byChat.get(chatId).push(key.id)
      }
      let changed = false
      for (const [chatId, ids] of byChat) {
        const result = this.#store.deleteMessages(chatId, ids)
        changed = changed || result.changed
      }
      if (changed) this.#broadcast({ type: 'chats' })
    } else if (payload.jid && payload.all === true) {
      const chatId = normalizeJid(payload.jid)
      if (isChatJid(chatId)) {
        const result = this.#store.deleteChats([chatId])
        if (result.changed) this.#broadcast({ type: 'chats' })
      }
    }
  }

  #onReceipts(updates) {
    if (this.#disposed || !Array.isArray(updates)) return
    for (const item of updates) {
      const chatId = normalizeJid(item?.key?.remoteJid ?? '')
      const id = item?.key?.id
      if (!isChatJid(chatId) || !isMessageId(id)) continue
      const status = statusFromReceipt(item.receipt)
      const result = this.#store.updateStatus(chatId, id, status)
      if (result.changed && result.message) {
        this.#broadcast({ type: 'message-status', chatId, id, status: result.message.status })
      }
    }
  }

  #onPresence(payload) {
    if (this.#disposed || !payload) return
    const chatId = normalizeJid(payload.id ?? '')
    if (!isChatJid(chatId)) return
    const presences = payload.presences && typeof payload.presences === 'object' ? payload.presences : {}
    let typing = false
    let participant = null
    for (const [jid, data] of Object.entries(presences)) {
      const presence = data?.lastKnownPresence
      if (presence === 'composing' || presence === 'recording') {
        typing = true
        participant = normalizeJid(jid)
        break
      }
    }
    this.#broadcast({
      type: 'typing',
      chatId,
      typing,
      participant: typing ? participant : null,
    })
  }

  #onCall(calls) {
    if (this.#disposed || !Array.isArray(calls)) return
    for (const call of calls) {
      const mapped = mapCall(call)
      if (!isChatJid(mapped.chatId)) continue
      this.#broadcast({ type: 'call', call: mapped })
    }
  }

  #onChats(chats) {
    if (this.#disposed || !Array.isArray(chats)) return
    const now = Date.now()
    const partials = []
    for (const chat of chats) {
      const partial = mapChatUpdate(chat, { now })
      if (partial) partials.push(partial)
    }
    const result = this.#store.ingestChats(partials)
    if (result.changed) this.#broadcast({ type: 'chats' })
  }

  #onContacts(contacts) {
    if (this.#disposed || !Array.isArray(contacts)) return
    const result = this.#store.ingestContacts(contacts)
    if (result.changed) this.#broadcast({ type: 'chats' })
  }

  #onGroups(groups) {
    if (this.#disposed || !Array.isArray(groups)) return
    let changed = false
    for (const group of groups) {
      const id = normalizeJid(group?.id ?? '')
      if (!isGroupJid(id)) continue
      const subject = typeof group.subject === 'string' ? group.subject.trim().slice(0, 200) : ''
      if (subject !== '' && this.#store.setChatName(id, subject).changed) changed = true
    }
    if (changed) this.#broadcast({ type: 'chats' })
  }

  #onHistorySet(payload) {
    if (this.#disposed || !payload || typeof payload !== 'object') return
    const contacts = Array.isArray(payload.contacts) ? payload.contacts : []
    const chats = Array.isArray(payload.chats) ? payload.chats : []
    const rawMessages = Array.isArray(payload.messages) ? payload.messages : []
    const mappedChats = []
    const now = Date.now()
    for (const chat of chats) {
      const partial = mapChatUpdate(chat, { now })
      if (partial) mappedChats.push(partial)
    }
    const messages = []
    for (const waMessage of rawMessages) {
      const record = this.#toRecord(waMessage)
      if (record) messages.push(record)
    }
    const result = this.#store.ingestHistory({ chats: mappedChats, contacts, messages })
    this.#broadcast({ type: 'history' })
    if (result.chatsChanged || result.added > 0 || result.changed > 0) this.#broadcast({ type: 'chats' })
  }

  // -------------------------------------------------------------------------
  // Queries (sync, per CONTRACT)
  // -------------------------------------------------------------------------

  listChats(query = '') {
    return this.#store.listChats(query)
  }

  getMessages(chatId, { before = null, limit = 50 } = {}) {
    const normalized = normalizeJid(chatId)
    if (!isChatJid(normalized)) return { messages: [], hasMore: false }
    return this.#store.getMessages(normalized, { before, limit })
  }

  // -------------------------------------------------------------------------
  // Outgoing
  // -------------------------------------------------------------------------

  async sendText(chatId, text, quotedMessageId = null) {
    await this.ready()
    if (this.#disposed) throw fail('disposed', 'service is disposed')
    const normalized = this.#validateChat(chatId)
    const body = typeof text === 'string' ? text : ''
    if (body.trim() === '') throw fail('bad-request', 'text is required')
    if (body.length > MAX_TEXT_CHARS) throw fail('bad-request', 'text is too long')
    this.#requireOnline()
    const quoted = isMessageId(quotedMessageId) ? this.#store.getQuote(normalized, quotedMessageId) : null
    let waMessage
    try {
      waMessage = await this.#client.sendText(normalized, body, quoted)
    } catch (error) {
      throw this.#sendFailure(error)
    }
    return this.#storeSentMessage(waMessage, normalized, { fallbackText: body, fallbackKind: 'text' })
  }

  async sendMedia(chatId, media = {}) {
    await this.ready()
    if (this.#disposed) throw fail('disposed', 'service is disposed')
    const normalized = this.#validateChat(chatId)
    if (!Buffer.isBuffer(media.buffer) || media.buffer.length === 0) {
      throw fail('bad-request', 'media buffer is required')
    }
    this.#requireOnline()
    let waMessage
    try {
      waMessage = await this.#client.sendMedia(normalized, media)
    } catch (error) {
      throw this.#sendFailure(error)
    }
    return this.#storeSentMessage(waMessage, normalized, {
      fallbackText: typeof media.caption === 'string' ? media.caption : '',
      fallbackKind: 'document',
    })
  }

  #storeSentMessage(waMessage, chatId, { fallbackText = '', fallbackKind = 'unknown' } = {}) {
    let record = waMessage ? this.#toRecord(waMessage) : null
    if (!record) {
      record = {
        message: {
          id: '',
          chatId,
          fromMe: true,
          author: null,
          authorName: null,
          timestamp: Date.now(),
          kind: fallbackKind,
          text: fallbackText,
          quoted: null,
          media: null,
          thumbnail: null,
          location: null,
          contact: null,
          status: 'sent',
          revoked: false,
          edited: false,
        },
        mediaSource: null,
      }
    }
    const message = record.message
    if (message.status === 'unknown' || message.status === 'pending') message.status = 'sent'
    const result = this.#store.upsertMessage(message, {
      mediaSource: record.mediaSource,
      unread: false,
      silent: true,
    })
    if (!result.message) throw fail('send-failed', 'could not store the sent message')
    this.#broadcast({ type: 'message', chatId: result.message.chatId, message: result.message })
    this.#broadcast({ type: 'chats' })
    return result.message
  }

  #sendFailure(error) {
    if (error instanceof WhatsAppClientError) return fail(error.code, error.message)
    return fail('send-failed', 'WhatsApp could not send the message')
  }

  async sendRead(chatId, messageIds) {
    await this.ready()
    if (this.#disposed) return
    const normalized = this.#validateChat(chatId)
    const ids = Array.isArray(messageIds)
      ? messageIds.filter((id) => isMessageId(id)).slice(0, MAX_READ_IDS)
      : []
    this.#store.markRead(normalized, ids)
    this.#broadcast({ type: 'chats' })
    if (ids.length > 0 && this.#client.online) {
      try {
        await this.#client.sendRead(normalized, ids)
      } catch (error) {
        this.#logger.warn?.('[whatsapp] read receipt failed', { code: error?.code })
      }
    }
  }

  async sendTyping(chatId, typing) {
    await this.ready()
    if (this.#disposed) return
    const normalized = this.#validateChat(chatId)
    await this.#client.sendTyping(normalized, typing === true)
  }

  async getMedia(chatId, messageId) {
    await this.ready()
    if (this.#disposed) return null
    const normalized = normalizeJid(chatId)
    if (!isChatJid(normalized) || !isMessageId(messageId)) return null
    const record = this.#store.getMessageRecord(normalized, messageId)
    if (!record) return null
    const content = contentFromMediaSource(record.mediaSource)
    if (!content) return null
    const waMessage = {
      key: { remoteJid: normalized, id: messageId, fromMe: record.message.fromMe === true },
      message: content,
      messageTimestamp: Math.max(0, Math.floor((record.message.timestamp ?? 0) / 1000)),
    }
    const cached = await this.#client.downloadMedia(waMessage, {
      key: `${normalized}:${messageId}`,
      mimetype: record.message.media?.mimetype ?? record.mediaSource?.mimetype ?? '',
      fileName: record.message.media?.fileName ?? record.mediaSource?.fileName ?? '',
    })
    if (!cached) return null
    return {
      buffer: cached.buffer,
      mimetype: cached.mimetype || record.message.media?.mimetype || record.mediaSource?.mimetype || 'application/octet-stream',
      fileName: cached.fileName || record.message.media?.fileName || record.mediaSource?.fileName || '',
    }
  }

  async getAvatar(jid) {
    await this.ready()
    if (this.#disposed) return null
    const normalized = normalizeJid(jid)
    if (normalized === '' || !(isChatJid(normalized))) return null
    return this.#client.getAvatar(normalized)
  }

  async rejectCall(callId, from) {
    await this.ready()
    if (this.#disposed) throw fail('disposed', 'service is disposed')
    if (!isId(callId)) throw fail('bad-request', 'call id is required')
    const fromJid = normalizeJid(from)
    if (fromJid === '' || !isChatJid(fromJid)) throw fail('bad-request', 'caller jid is invalid')
    this.#requireOnline()
    try {
      await this.#client.rejectCall(callId, fromJid)
    } catch (error) {
      throw this.#sendFailure(error)
    }
  }

  // -------------------------------------------------------------------------
  // Validation helpers
  // -------------------------------------------------------------------------

  #requireOnline() {
    if (!this.#client.online) throw fail('offline', 'WhatsApp is not connected')
  }

  #validateChat(chatId) {
    const normalized = normalizeJid(chatId)
    if (normalized === '' || !isChatJid(normalized)) {
      throw fail('bad-request', 'chat is not a valid WhatsApp conversation id')
    }
    return normalized
  }
}

function isMessageId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS && !/[\s\u0000-\u001f]/.test(value)
}

export function createWhatsAppService(options) {
  return new WhatsAppService(options)
}

export default createWhatsAppService
