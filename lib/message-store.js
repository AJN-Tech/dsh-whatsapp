/**
 * Bounded chat/message cache with encrypted-at-rest persistence.
 *
 * The store holds the already-mapped CONTRACT shapes (see lib/protocol.js), so
 * the rest of the host never has to think about protobuf. It is deliberately
 * boring: two Maps and one sorted array per chat, hard caps from lib/config.js,
 * and a debounced sealed snapshot (`store.enc`) written through the SecretBox.
 *
 * What is persisted: messages' public fields plus the encrypted-media descriptor
 * needed to re-download an attachment after a restart. What is NOT persisted:
 * thumbnail data URLs (they would multiply the profile size by an order of
 * magnitude; they are cheap to re-derive by downloading the real media) and any
 * plaintext — the whole snapshot is sealed by the SecretBox.
 */
import {
  FILES,
  MAX_CHATS,
  MAX_MESSAGES_PER_CHAT,
  MAX_TOTAL_MESSAGES,
  MESSAGE_PAGE_SIZE,
  clampLimit,
} from './config.js'
import {
  betterStatus,
  compareMessages,
  contactDisplayName,
  contentFromMediaSource,
  decodeCursor,
  displayNameForJid,
  encodeCursor,
  isChatJid,
  lastMessagePreview,
  mapContact,
  normalizeJid,
  quoteFromStored,
} from './protocol.js'

const STORE_VERSION = 1
const PERSIST_DEBOUNCE_MS = 750
const PERSIST_MAX_WAIT_MS = 3000
const MAX_CONTACTS = 5000
const MAX_THUMBNAIL_BUDGET_BYTES = 24 * 1024 * 1024

function recordKey(chatId, id) {
  return `${chatId}\u0000${id}`
}

function compareToCursor(message, cursor) {
  if (!cursor) return 0
  if (message.timestamp !== cursor.timestamp) return message.timestamp < cursor.timestamp ? -1 : 1
  if (message.id === cursor.id) return 0
  return message.id < cursor.id ? -1 : 1
}

function sortKey(chat) {
  return [chat.pinned ? 0 : 1, -(chat.timestamp || 0), chat.name || chat.id || '']
}

function compareChats(a, b) {
  const left = sortKey(a)
  const right = sortKey(b)
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] < right[i]) return -1
    if (left[i] > right[i]) return 1
  }
  return 0
}

export class MessageStore {
  #dataDir
  #box
  #logger
  #chats = new Map()
  #messages = new Map()
  #index = new Map()
  #contacts = new Map()
  #aliases = new Map()
  #counts = 0
  #thumbBytes = 0
  #loaded = false
  #disposed = false
  #dirty = false
  #debounce = null
  #maxWait = null
  #chain = Promise.resolve()
  #lastError = null
  #limits

  constructor({ dataDir, box = null, logger = null, limits = {} } = {}) {
    this.#dataDir = dataDir ?? ''
    this.#box = box
    this.#logger = logger ?? { info() {}, warn() {}, error() {}, debug() {} }
    this.#limits = {
      maxChats: limits.maxChats ?? MAX_CHATS,
      maxMessagesPerChat: limits.maxMessagesPerChat ?? MAX_MESSAGES_PER_CHAT,
      maxTotalMessages: limits.maxTotalMessages ?? MAX_TOTAL_MESSAGES,
      maxContacts: limits.maxContacts ?? MAX_CONTACTS,
      maxThumbnailBudget: limits.maxThumbnailBudget ?? MAX_THUMBNAIL_BUDGET_BYTES,
    }
  }

  get loaded() {
    return this.#loaded
  }

  get lastError() {
    return this.#lastError
  }

  get messageCount() {
    return this.#counts
  }

  get chatCount() {
    return this.#chats.size
  }

  get storageEncrypted() {
    return this.#box !== null
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async load() {
    if (this.#loaded) return
    if (this.#box === null) {
      this.#loaded = true
      return
    }
    let bytes = null
    try {
      bytes = await this.#box.openFile(FILES.store)
    } catch (error) {
      this.#note(error, 'could not open the encrypted message cache; starting empty')
      this.#loaded = true
      return
    }
    if (bytes === null) {
      this.#loaded = true
      return
    }
    try {
      const snapshot = JSON.parse(bytes.toString('utf8'))
      this.#restore(snapshot)
    } catch (error) {
      this.#note(error, 'stored message cache is unreadable; starting empty')
    }
    this.#loaded = true
  }

  #restore(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || snapshot.v !== STORE_VERSION) return
    const chats = Array.isArray(snapshot.chats) ? snapshot.chats : []
    for (const chat of chats) {
      if (!chat || typeof chat !== 'object') continue
      const id = normalizeJid(chat.id ?? '')
      if (!isChatJid(id)) continue
      this.#chats.set(id, {
        id,
        name: typeof chat.name === 'string' && chat.name !== '' ? chat.name : displayNameForJid(id),
        isGroup: chat.isGroup === true,
        unread: Number.isFinite(chat.unread) && chat.unread > 0 ? Math.floor(chat.unread) : 0,
        pinned: chat.pinned === true,
        muted: chat.muted === true,
        archived: chat.archived === true,
        timestamp: Number.isFinite(chat.timestamp) && chat.timestamp > 0 ? Math.floor(chat.timestamp) : 0,
        lastMessage: chat.lastMessage && typeof chat.lastMessage === 'object' ? lastMessagePreview(chat.lastMessage) : null,
      })
    }
    const contacts = Array.isArray(snapshot.contacts) ? snapshot.contacts : []
    for (const contact of contacts) {
      if (!contact || typeof contact !== 'object') continue
      this.#rememberContact(contact, false)
    }
    const messages = snapshot.messages && typeof snapshot.messages === 'object' ? snapshot.messages : {}
    for (const [rawChatId, records] of Object.entries(messages)) {
      const chatId = normalizeJid(rawChatId)
      if (!isChatJid(chatId) || !Array.isArray(records)) continue
      const list = []
      for (const record of records) {
        const message = record?.m
        const mediaSource = record?.r && typeof record.r === 'object' ? record.r : null
        if (!message || typeof message !== 'object') continue
        const id = typeof message.id === 'string' ? message.id : ''
        if (id === '') continue
        const stored = {
          ...message,
          id,
          chatId,
          thumbnail: typeof message.thumbnail === 'string' ? message.thumbnail : null,
        }
        if (list.length >= this.#limits.maxMessagesPerChat) break
        const storedRecord = { message: stored, mediaSource }
        list.push(storedRecord)
        this.#index.set(recordKey(chatId, id), storedRecord)
        this.#counts += 1
        if (stored.thumbnail) this.#thumbBytes += stored.thumbnail.length
      }
      list.sort((a, b) => compareMessages(a.message, b.message))
      if (list.length > 0) this.#messages.set(chatId, list)
    }
    for (const [chatId] of this.#messages) {
      if (!this.#chats.has(chatId)) this.#ensureChat(chatId, {})
    }
    this.#trim()
  }

  async flush() {
    this.#clearTimers()
    if (!this.#dirty) {
      try {
        await this.#chain
      } catch {
        /* already noted */
      }
      return
    }
    this.#dirty = false
    const snapshot = this.#snapshot()
    await this.#enqueue(async () => {
      if (this.#box === null) return
      await this.#box.sealFile(FILES.store, JSON.stringify(snapshot))
    })
  }

  async wipe() {
    this.#clearTimers()
    this.#dirty = false
    this.#chats.clear()
    this.#messages.clear()
    this.#index.clear()
    this.#contacts.clear()
    this.#aliases.clear()
    this.#counts = 0
    this.#thumbBytes = 0
    // Wait for an in-flight write before deleting, or that write would recreate
    // the file with the pre-wipe snapshot after the delete.
    try {
      await this.#chain
    } catch {
      /* an earlier write failed and already noted it */
    }
    if (this.#box !== null) {
      try {
        await this.#box.deleteFile(FILES.store)
      } catch (error) {
        this.#note(error, 'could not delete the stored message cache')
      }
    }
  }

  /** Stop timers and flush synchronously-ordered work. Idempotent. */
  async dispose() {
    if (this.#disposed) return
    this.#disposed = true
    try {
      await this.flush()
    } catch {
      /* flush notes its own errors */
    }
    this.#clearTimers()
  }

  #snapshot() {
    const chats = [...this.#chats.values()].map((chat) => ({
      ...chat,
      lastMessage: chat.lastMessage ? { ...chat.lastMessage } : null,
    }))
    const messages = {}
    for (const [chatId, list] of this.#messages) {
      messages[chatId] = list.map((record) => ({
        // Thumbnails are memory-only; they can be re-derived from the media.
        m: { ...record.message, thumbnail: null },
        r: record.mediaSource,
      }))
    }
    const contacts = [...this.#contacts.values()].map((contact) => ({ ...contact }))
    return { v: STORE_VERSION, savedAt: Date.now(), chats, messages, contacts }
  }

  #clearTimers() {
    if (this.#debounce !== null) {
      clearTimeout(this.#debounce)
      this.#debounce = null
    }
    if (this.#maxWait !== null) {
      clearTimeout(this.#maxWait)
      this.#maxWait = null
    }
  }

  #markDirty() {
    if (this.#box === null || this.#disposed) return
    this.#dirty = true
    if (this.#debounce === null) {
      this.#debounce = setTimeout(() => {
        this.#debounce = null
        void this.flush().catch(() => {})
      }, PERSIST_DEBOUNCE_MS)
      this.#debounce.unref?.()
    }
    if (this.#maxWait === null) {
      this.#maxWait = setTimeout(() => {
        this.#maxWait = null
        void this.flush().catch(() => {})
      }, PERSIST_MAX_WAIT_MS)
      this.#maxWait.unref?.()
    }
  }

  #enqueue(run) {
    const next = this.#chain.then(run, run)
    this.#chain = next.catch(() => {})
    return next
  }

  #note(error, message) {
    this.#lastError = error ?? null
    this.#logger.warn?.(`[whatsapp] ${message}`, {
      code: error?.code,
      message: String(error?.message ?? error ?? '').slice(0, 200),
    })
  }

  // -------------------------------------------------------------------------
  // Contacts
  // -------------------------------------------------------------------------

  #rememberContact(contact, markDirty = true) {
    const mapped = mapContact(contact)
    if (mapped.id === '') return null
    const normalized = { ...mapped, id: mapped.id }
    const existing = this.#contacts.get(mapped.id)
    if (existing) {
      // Keep the map insertion order stable so the bound drops the oldest entry.
      this.#contacts.set(mapped.id, { ...existing, ...normalized })
    } else {
      this.#contacts.set(mapped.id, normalized)
      if (this.#contacts.size > this.#limits.maxContacts) {
        const oldest = this.#contacts.keys().next().value
        if (oldest !== undefined) this.#contacts.delete(oldest)
      }
    }
    if (mapped.lid !== '') this.#aliases.set(mapped.lid, mapped.id)
    if (mapped.phoneNumber !== '') this.#aliases.set(`${mapped.phoneNumber}@s.whatsapp.net`, mapped.id)
    if (markDirty) {
      this.#refreshChatNames()
      this.#markDirty()
    }
    return normalized
  }

  ingestContacts(list) {
    if (!Array.isArray(list)) return { changed: false }
    let changed = false
    for (const contact of list) {
      if (this.#rememberContact(contact)) changed = true
    }
    return { changed }
  }

  resolveContact(jid) {
    const normalized = normalizeJid(jid)
    if (normalized === '') return null
    const direct = this.#contacts.get(normalized)
    if (direct) return direct
    const alias = this.#aliases.get(normalized)
    if (alias) return this.#contacts.get(alias) ?? null
    return null
  }

  resolveName(jid) {
    const contact = this.resolveContact(jid)
    if (!contact) return null
    const name = contactDisplayName(contact)
    return name === '' ? null : name
  }

  #refreshChatNames() {
    for (const [chatId, chat] of this.#chats) {
      if (chat.isGroup) continue
      const name = this.resolveName(chatId)
      if (name && name !== chat.name) {
        chat.name = name
        this.#markDirty()
      }
    }
  }

  // -------------------------------------------------------------------------
  // Chats
  // -------------------------------------------------------------------------

  #ensureChat(chatId, { name, isGroup, timestamp } = {}) {
    let chat = this.#chats.get(chatId)
    if (!chat) {
      const resolved = this.resolveName(chatId)
      chat = {
        id: chatId,
        name: name || resolved || displayNameForJid(chatId),
        isGroup: isGroup === true || chatId.endsWith('@g.us'),
        unread: 0,
        pinned: false,
        muted: false,
        archived: false,
        timestamp: Number.isFinite(timestamp) && timestamp > 0 ? Math.floor(timestamp) : 0,
        lastMessage: null,
      }
      this.#chats.set(chatId, chat)
      this.#trimChats()
      this.#markDirty()
    } else {
      if (name && (chat.name === displayNameForJid(chatId) || chat.name === '')) chat.name = name
      if (Number.isFinite(timestamp) && timestamp > (chat.timestamp || 0)) chat.timestamp = Math.floor(timestamp)
    }
    return chat
  }

  /**
   * Apply ChatSummary-shaped partials (from chats.upsert/update or history).
   * Missing fields keep their previous value.
   */
  ingestChats(list) {
    if (!Array.isArray(list)) return { changed: false }
    let changed = false
    for (const partial of list) {
      const chatId = normalizeJid(partial?.id ?? '')
      if (!isChatJid(chatId)) continue
      const exists = this.#chats.has(chatId)
      const chat = this.#ensureChat(chatId, {
        name: typeof partial.name === 'string' && partial.name !== '' ? partial.name : undefined,
        isGroup: partial.isGroup,
        timestamp: partial.timestamp,
      })
      if (!exists) changed = true
      if (typeof partial.name === 'string' && partial.name !== '' && partial.name !== chat.name) {
        chat.name = partial.name
        changed = true
      }
      if (Number.isFinite(partial.unread) && partial.unread >= 0 && Math.floor(partial.unread) !== chat.unread) {
        chat.unread = Math.floor(partial.unread)
        changed = true
      }
      if (Number.isFinite(partial.timestamp) && partial.timestamp > (chat.timestamp || 0)) {
        chat.timestamp = Math.floor(partial.timestamp)
        changed = true
      }
      for (const field of ['pinned', 'muted', 'archived']) {
        if (typeof partial[field] === 'boolean' && partial[field] !== chat[field]) {
          chat[field] = partial[field]
          changed = true
        }
      }
      if (partial.lastMessage && typeof partial.lastMessage === 'object') {
        chat.lastMessage = lastMessagePreview(partial.lastMessage)
        changed = true
      }
    }
    if (changed) this.#markDirty()
    return { changed }
  }

  setChatName(chatId, name) {
    const chat = this.#chats.get(normalizeJid(chatId))
    if (!chat || typeof name !== 'string' || name === '' || chat.name === name) return { changed: false }
    chat.name = name
    this.#markDirty()
    return { changed: true }
  }

  deleteChats(ids) {
    if (!Array.isArray(ids)) return { changed: false }
    let changed = false
    for (const raw of ids) {
      const chatId = normalizeJid(raw)
      if (this.#chats.delete(chatId)) changed = true
      this.#dropChatMessages(chatId)
    }
    if (changed) this.#markDirty()
    return { changed }
  }

  #dropChatMessages(chatId) {
    const list = this.#messages.get(chatId)
    if (!list) return
    for (const record of list) {
      this.#index.delete(recordKey(chatId, record.message.id))
      if (record.message.thumbnail) this.#thumbBytes -= record.message.thumbnail.length
    }
    this.#counts -= list.length
    this.#messages.delete(chatId)
    if (this.#thumbBytes < 0) this.#thumbBytes = 0
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  #insertMessage(record) {
    const chatId = record.message.chatId
    let list = this.#messages.get(chatId)
    if (!list) {
      list = []
      this.#messages.set(chatId, list)
    }
    if (list.length === 0 || compareMessages(list[list.length - 1].message, record.message) <= 0) {
      list.push(record)
    } else {
      let low = 0
      let high = list.length
      while (low < high) {
        const middle = (low + high) >> 1
        if (compareMessages(list[middle].message, record.message) <= 0) low = middle + 1
        else high = middle
      }
      list.splice(low, 0, record)
    }
    this.#index.set(recordKey(chatId, record.message.id), record)
    this.#counts += 1
    if (record.message.thumbnail) this.#thumbBytes += record.message.thumbnail.length
    if (list.length > this.#limits.maxMessagesPerChat) {
      const removed = list.splice(0, list.length - this.#limits.maxMessagesPerChat)
      for (const old of removed) this.#forget(old)
    }
    this.#trim()
  }

  #forget(record) {
    const chatId = record?.message?.chatId
    const id = record?.message?.id
    if (chatId && id) this.#index.delete(recordKey(chatId, id))
    this.#counts -= 1
    if (record?.message?.thumbnail) {
      this.#thumbBytes -= record.message.thumbnail.length
      if (this.#thumbBytes < 0) this.#thumbBytes = 0
    }
  }

  #trim() {
    while (this.#counts > this.#limits.maxTotalMessages) {
      let oldestChatId = null
      let oldestTs = Infinity
      for (const [chatId, list] of this.#messages) {
        if (list.length === 0) continue
        const ts = list[0].message.timestamp ?? 0
        if (ts < oldestTs) {
          oldestTs = ts
          oldestChatId = chatId
        }
      }
      if (oldestChatId === null) break
      const list = this.#messages.get(oldestChatId)
      const removed = list.shift()
      this.#forget(removed)
      if (list.length === 0) this.#messages.delete(oldestChatId)
    }
    this.#trimChats()
    this.#trimThumbnails()
    const chatIds = new Set(this.#messages.keys())
    for (const chatId of chatIds) {
      if (!this.#chats.has(chatId)) this.#ensureChat(chatId, {})
    }
  }

  #trimChats() {
    if (this.#chats.size <= this.#limits.maxChats) return
    const ordered = [...this.#chats.values()].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
    let overflow = this.#chats.size - this.#limits.maxChats
    for (const chat of ordered) {
      if (overflow <= 0) break
      this.#chats.delete(chat.id)
      this.#dropChatMessages(chat.id)
      overflow -= 1
    }
  }

  #trimThumbnails() {
    if (this.#thumbBytes <= this.#limits.maxThumbnailBudget) return
    const chatOrder = [...this.#chats.values()].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
    for (const chat of chatOrder) {
      if (this.#thumbBytes <= this.#limits.maxThumbnailBudget) break
      const list = this.#messages.get(chat.id)
      if (!list) continue
      for (const record of list) {
        if (this.#thumbBytes <= this.#limits.maxThumbnailBudget) break
        if (record.message.thumbnail) {
          this.#thumbBytes -= record.message.thumbnail.length
          record.message.thumbnail = null
        }
      }
    }
    if (this.#thumbBytes < 0) this.#thumbBytes = 0
  }

  /**
   * Insert or merge one mapped message.
   *
   * @param {object} message CONTRACT Message
   * @param {{ mediaSource?: object|null, unread?: boolean|null, silent?: boolean, name?: string }} [options]
   * @returns {{ message: object, created: boolean, changed: boolean }}
   */
  upsertMessage(message, options = {}) {
    if (!message || typeof message !== 'object') return { message: null, created: false, changed: false }
    const chatId = normalizeJid(message.chatId ?? '')
    const id = typeof message.id === 'string' ? message.id : ''
    if (id === '' || !isChatJid(chatId)) return { message: null, created: false, changed: false }
    const storedInput = {
      ...message,
      chatId,
      id,
      thumbnail: typeof message.thumbnail === 'string' ? message.thumbnail : null,
    }
    const key = recordKey(chatId, id)
    const existing = this.#index.get(key)
    if (existing) {
      const changed = this.#mergeMessage(existing, storedInput, options.mediaSource ?? null)
      if (changed) this.#markDirty()
      return { message: { ...existing.message }, created: false, changed }
    }
    const chat = this.#ensureChat(chatId, {
      name: options.name,
      isGroup: message.author !== null || chatId.endsWith('@g.us'),
      timestamp: storedInput.timestamp,
    })
    const record = { message: storedInput, mediaSource: options.mediaSource ?? null }
    this.#insertMessage(record)
    chat.lastMessage = lastMessagePreview(storedInput)
    if (storedInput.timestamp > (chat.timestamp || 0)) chat.timestamp = storedInput.timestamp
    const unread = options.unread
    const shouldCount = unread === true || (unread !== false && options.silent !== true && !storedInput.fromMe && !storedInput.revoked)
    if (shouldCount) chat.unread += 1
    this.#markDirty()
    return { message: { ...storedInput }, created: true, changed: true }
  }

  #mergeMessage(existing, incoming, mediaSource = null) {
    let changed = false
    const target = existing.message
    if (incoming.text && incoming.text !== target.text) {
      target.text = incoming.text
      changed = true
    }
    if (incoming.revoked && !target.revoked) {
      target.revoked = true
      changed = true
    }
    if (incoming.edited && !target.edited) {
      target.edited = true
      changed = true
    }
    if (incoming.kind && incoming.kind !== 'unknown' && incoming.kind !== target.kind) {
      target.kind = incoming.kind
      changed = true
    }
    const status = betterStatus(target.status, incoming.status)
    if (status !== target.status) {
      target.status = status
      changed = true
    }
    if (incoming.quoted && !target.quoted) {
      target.quoted = incoming.quoted
      changed = true
    }
    if (incoming.media && !target.media) {
      target.media = incoming.media
      changed = true
    }
    if (incoming.thumbnail && incoming.thumbnail !== target.thumbnail) {
      if (target.thumbnail) this.#thumbBytes -= target.thumbnail.length
      target.thumbnail = incoming.thumbnail
      this.#thumbBytes += incoming.thumbnail.length
      changed = true
    }
    if (incoming.location && !target.location) {
      target.location = incoming.location
      changed = true
    }
    if (incoming.contact && !target.contact) {
      target.contact = incoming.contact
      changed = true
    }
    if (mediaSource && !existing.mediaSource) {
      existing.mediaSource = mediaSource
      changed = true
    }
    return changed
  }

  updateStatus(chatId, id, status) {
    const record = this.#findRecord(chatId, id)
    if (!record) return { changed: false, message: null }
    const next = betterStatus(record.message.status, status)
    if (next === record.message.status) return { changed: false, message: { ...record.message } }
    record.message.status = next
    this.#markDirty()
    return { changed: true, message: { ...record.message } }
  }

  revokeMessage(chatId, id) {
    const record = this.#findRecord(chatId, id)
    if (!record || record.message.revoked) return { changed: false, message: record ? { ...record.message } : null }
    record.message.revoked = true
    this.#markDirty()
    return { changed: true, message: { ...record.message } }
  }

  markRead(chatId, ids = null) {
    const chat = this.#chats.get(normalizeJid(chatId))
    if (!chat) return { changed: false }
    let changed = false
    if (Array.isArray(ids) && ids.length > 0) {
      // The receipts themselves are sent by the client; the store only keeps
      // the unread counter honest for the chat list.
      const seen = new Set(ids)
      if (seen.size > 0) changed = true
    }
    if (chat.unread !== 0) {
      chat.unread = 0
      changed = true
    }
    if (changed) this.#markDirty()
    return { changed }
  }

  deleteMessages(chatId, ids) {
    const normalized = normalizeJid(chatId)
    const list = this.#messages.get(normalized)
    if (!list || !Array.isArray(ids) || ids.length === 0) return { changed: false }
    const remove = new Set(ids)
    let changed = false
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (remove.has(list[i].message.id)) {
        const [record] = list.splice(i, 1)
        this.#forget(record)
        const chat = this.#chats.get(normalized)
        if (chat && chat.lastMessage?.id === record.message.id) {
          chat.lastMessage = list.length > 0 ? lastMessagePreview(list[list.length - 1].message) : null
          chat.timestamp = chat.lastMessage ? chat.lastMessage.timestamp : 0
        }
        changed = true
      }
    }
    if (changed) this.#markDirty()
    return { changed }
  }

  /** Bulk history landing: contacts first (so names resolve), then chats, then messages. */
  ingestHistory({ chats = [], contacts = [], messages = [] } = {}) {
    let contactsChanged = false
    if (Array.isArray(contacts)) {
      for (const contact of contacts) {
        if (this.#rememberContact(contact)) contactsChanged = true
      }
    }
    const chatResult = this.ingestChats(chats)
    let added = 0
    let changed = 0
    if (Array.isArray(messages)) {
      for (const entry of messages) {
        const message = entry?.message ?? entry
        const mediaSource = entry?.mediaSource ?? null
        if (!message) continue
        const result = this.upsertMessage(message, { mediaSource, silent: true, unread: false })
        if (result.created) added += 1
        else if (result.changed) changed += 1
      }
    }
    return { added, changed, chatsChanged: chatResult.changed || contactsChanged, contactsChanged }
  }

  #findRecord(chatId, id) {
    const normalized = normalizeJid(chatId)
    if (typeof id !== 'string') return null
    return this.#index.get(recordKey(normalized, id)) ?? null
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  getChat(chatId) {
    const chat = this.#chats.get(normalizeJid(chatId))
    return chat ? { ...chat } : null
  }

  listChats(query = '') {
    const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
    const result = []
    for (const chat of this.#chats.values()) {
      if (needle !== '') {
        const haystack = `${chat.name} ${chat.id}`.toLowerCase()
        if (!haystack.includes(needle)) continue
      }
      result.push({
        id: chat.id,
        name: chat.name,
        isGroup: chat.isGroup,
        unread: chat.unread,
        pinned: chat.pinned,
        muted: chat.muted,
        archived: chat.archived,
        timestamp: chat.timestamp,
        lastMessage: chat.lastMessage ? { ...chat.lastMessage } : null,
      })
    }
    result.sort(compareChats)
    return result
  }

  /**
   * One page of messages, chronological (oldest first). `before` is an opaque
   * cursor; it returns the messages older than that cursor.
   */
  getMessages(chatId, { before = null, limit = MESSAGE_PAGE_SIZE } = {}) {
    const list = this.#messages.get(normalizeJid(chatId)) ?? []
    const pageSize = clampLimit(limit, MESSAGE_PAGE_SIZE, 200)
    const cursor = typeof before === 'string' && before !== '' ? decodeCursor(before) : null
    let end = list.length
    if (cursor) {
      let low = 0
      let high = list.length
      while (low < high) {
        const middle = (low + high) >> 1
        if (compareToCursor(list[middle].message, cursor) < 0) low = middle + 1
        else high = middle
      }
      end = low
    }
    const start = Math.max(0, end - pageSize)
    const messages = []
    for (let i = start; i < end; i += 1) messages.push({ ...list[i].message })
    return { messages, hasMore: start > 0 }
  }

  /** True only when the message exists in that exact chat (media route guard). */
  hasMessage(chatId, id) {
    const normalized = normalizeJid(chatId)
    if (!isChatJid(normalized) || typeof id !== 'string' || id === '') return false
    return this.#index.has(recordKey(normalized, id))
  }

  getMessage(chatId, id) {
    const record = this.#findRecord(chatId, id)
    return record ? { ...record.message } : null
  }

  /** Last message in a chat, with the encrypted media descriptor when present. */
  getMessageRecord(chatId, id) {
    const record = this.#findRecord(chatId, id)
    if (!record) return null
    return { message: { ...record.message }, mediaSource: record.mediaSource ?? null }
  }

  getQuote(chatId, id) {
    const record = this.getMessageRecord(chatId, id)
    if (!record) return null
    return quoteFromStored(record.message, record.mediaSource)
  }

  /** Baileys `getMessage` hook: reconstruct content for retry/resend support. */
  getMessageContent({ remoteJid, id } = {}) {
    const record = this.getMessageRecord(remoteJid, id)
    if (!record) return undefined
    const mediaContent = contentFromMediaSource(record.mediaSource)
    if (mediaContent) return mediaContent
    if (typeof record.message.text === 'string' && record.message.text !== '') {
      return { extendedTextMessage: { text: record.message.text } }
    }
    return undefined
  }
}

export function createMessageStore(options) {
  return new MessageStore(options)
}

export { encodeCursor }
