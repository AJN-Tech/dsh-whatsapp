/**
 * Byte-bounded LRU cache for downloaded media, in memory only.
 *
 * Nothing here is ever written to disk: downloaded photo/video/document bytes
 * stay in RAM until evicted, and the persisted chat cache only keeps the
 * encrypted-media descriptor (URL + media key) needed to download again. That
 * keeps the promise in CONTRACT.md: all local state at rest is encrypted.
 */
import { downloadMediaMessage } from '@whiskeysockets/baileys'

/** 64 MiB total; a personal chat cache should not pin gigabytes of video. */
export const DEFAULT_MAX_CACHE_BYTES = 64 * 1024 * 1024
/** A single attachment above this is returned but never retained. */
export const DEFAULT_MAX_ENTRY_BYTES = 24 * 1024 * 1024
export const DEFAULT_MAX_ENTRIES = 128
const DOWNLOAD_TIMEOUT_MS = 120_000

export class MediaCache {
  #maxBytes
  #maxEntryBytes
  #maxEntries
  #logger
  #entries = new Map()
  #bytes = 0

  constructor({
    maxBytes = DEFAULT_MAX_CACHE_BYTES,
    maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES,
    maxEntries = DEFAULT_MAX_ENTRIES,
    logger = null,
  } = {}) {
    this.#maxBytes = Math.max(1, maxBytes)
    this.#maxEntryBytes = Math.max(1, maxEntryBytes)
    this.#maxEntries = Math.max(1, maxEntries)
    this.#logger = logger ?? { warn() {} }
  }

  get size() {
    return this.#entries.size
  }

  get bytes() {
    return this.#bytes
  }

  get(key) {
    if (typeof key !== 'string' || key === '') return null
    const entry = this.#entries.get(key)
    if (!entry) return null
    // Refresh LRU position.
    this.#entries.delete(key)
    this.#entries.set(key, entry)
    return entry.value
  }

  has(key) {
    return typeof key === 'string' && this.#entries.has(key)
  }

  set(key, value) {
    if (typeof key !== 'string' || key === '') return false
    if (!value || !Buffer.isBuffer(value.buffer) || value.buffer.length === 0) return false
    const size = value.buffer.length
    this.delete(key)
    if (size > this.#maxEntryBytes) return false
    this.#entries.set(key, { value, size })
    this.#bytes += size
    this.#evict()
    return true
  }

  delete(key) {
    const entry = this.#entries.get(key)
    if (!entry) return false
    this.#entries.delete(key)
    this.#bytes -= entry.size
    if (this.#bytes < 0) this.#bytes = 0
    return true
  }

  clear() {
    this.#entries.clear()
    this.#bytes = 0
  }

  #evict() {
    while ((this.#bytes > this.#maxBytes || this.#entries.size > this.#maxEntries) && this.#entries.size > 0) {
      const oldest = this.#entries.keys().next().value
      if (oldest === undefined) break
      this.delete(oldest)
    }
  }

  /**
   * Download (or reuse) the media of a Baileys WAMessage.
   *
   * @param {object} message Baileys WAMessage
   * @param {{ key?: string, sock?: object, logger?: object, mimetype?: string, fileName?: string, timeoutMs?: number, download?: Function }} [options]
   * @returns {Promise<{buffer: Buffer, mimetype: string, fileName: string}|null>}
   */
  async read(message, options = {}) {
    const cacheKey = typeof options.key === 'string' && options.key !== '' ? options.key : null
    if (cacheKey) {
      const hit = this.get(cacheKey)
      if (hit) return hit
    }
    if (!message || typeof message !== 'object') return null
    const download = typeof options.download === 'function' ? options.download : downloadMediaMessage
    const logger = options.logger ?? this.#logger
    let buffer
    try {
      const requestOptions = {}
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        requestOptions.signal = AbortSignal.timeout(options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS)
      }
      buffer = await download(message, 'buffer', requestOptions, {
        // Media that the phone has rotated out can be re-requested once.
        reuploadRequest: typeof options.sock?.updateMediaMessage === 'function'
          ? (stale) => options.sock.updateMediaMessage(stale)
          : undefined,
        logger,
      })
    } catch (error) {
      logger.warn?.('[whatsapp] media download failed', {
        code: error?.output?.statusCode ?? error?.statusCode ?? error?.code,
        message: String(error?.message ?? error ?? '').slice(0, 200),
      })
      return null
    }
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null
    const value = {
      buffer,
      mimetype: typeof options.mimetype === 'string' && options.mimetype !== '' ? options.mimetype : 'application/octet-stream',
      fileName: typeof options.fileName === 'string' ? options.fileName : '',
    }
    if (cacheKey) this.set(cacheKey, value)
    return value
  }
}

export function createMediaCache(options) {
  return new MediaCache(options)
}
