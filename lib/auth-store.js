/**
 * Baileys authentication state, persisted encrypted.
 *
 * Baileys' own `useMultiFileAuthState` writes plaintext JSON files and its own
 * documentation calls it unsuitable for production. This store keeps the same
 * SignalKeyStore contract but persists two sealed files:
 *
 *   creds.enc  — the device credentials (identity, noise, signed pre-key, ...)
 *   keys.enc   — every Signal session / pre-key / sender-key / app-state key
 *
 * Credentials are written immediately (`creds.update`); key sets are debounced
 * and force-flushed on dispose. A crash can lose the last few hundred ms of
 * ratchet state, never the device credentials. If the device credentials are
 * lost or corrupted the account stays safe: WhatsApp simply asks for a re-link.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { baileys } from './baileys.js'

const KEY_DEBOUNCE_MS = 75
const KEY_MAX_WAIT_MS = 1000

function emptyKeys() {
  return new Map()
}

function toPlainKeys(map) {
  const out = {}
  for (const [type, entries] of map) {
    if (entries.size === 0) continue
    const values = {}
    for (const [id, value] of entries) values[id] = value
    out[type] = values
  }
  return out
}

function fromPlainKeys(value) {
  const map = emptyKeys()
  if (!value || typeof value !== 'object') return map
  for (const [type, entries] of Object.entries(value)) {
    if (!entries || typeof entries !== 'object') continue
    const inner = new Map()
    for (const [id, item] of Object.entries(entries)) inner.set(id, item)
    if (inner.size > 0) map.set(type, inner)
  }
  return map
}

export class AuthStore {
  #dataDir
  #box
  #logger
  #raw
  #keys = emptyKeys()
  #creds = null
  #linked = false
  #loaded = false
  #disposed = false
  #chain = Promise.resolve()
  #dirty = false
  #debounce = null
  #maxWait = null
  #lastError = null

  constructor({ dataDir, box, logger }) {
    if (!box) throw new Error('AuthStore requires a SecretBox')
    this.#dataDir = dataDir
    this.#box = box
    this.#logger = logger ?? { info() {}, warn() {}, error() {}, debug() {}, trace() {}, child() { return this } }
    this.state = null
  }

  get linked() {
    return this.#linked
  }

  get lastError() {
    return this.#lastError
  }

  /**
   * Load sealed state. Returns true when a registered device is present.
   * An unregistered half-pairing is discarded: it cannot be resumed anyway and
   * keeping it would make the next link attempt reuse stale keys.
   */
  async load() {
    if (this.#loaded) return this.#linked
    const { BufferJSON, initAuthCreds, makeCacheableSignalKeyStore } = baileys()
    const credsBytes = await this.#box.openFile('creds.enc')
    let creds = initAuthCreds()
    let haveRegistered = false
    if (credsBytes !== null) {
      try {
        creds = JSON.parse(credsBytes.toString('utf8'), BufferJSON.reviver)
        haveRegistered = Boolean(creds && creds.registered === true)
      } catch (error) {
        this.#logger.warn?.('[whatsapp] stored credentials are unreadable; treating device as unlinked', { code: error?.code })
        creds = initAuthCreds()
      }
    }
    if (!haveRegistered) {
      // Incomplete or absent pairing: start clean.
      creds = initAuthCreds()
      try {
        await this.#box.deleteFile('creds.enc')
        await this.#box.deleteFile('keys.enc')
      } catch { /* deletion is best effort */ }
      this.#linked = false
    } else {
      this.#linked = true
    }

    if (haveRegistered) {
      try {
        const keysBytes = await this.#box.openFile('keys.enc')
        if (keysBytes !== null) {
          const parsed = JSON.parse(keysBytes.toString('utf8'), BufferJSON.reviver)
          this.#keys = fromPlainKeys(parsed)
        }
      } catch (error) {
        this.#logger.warn?.('[whatsapp] stored Signal keys are unreadable; sessions will be re-established', { code: error?.code })
        this.#keys = emptyKeys()
      }
    }

    this.#creds = creds
    this.#raw = {
      get: async (type, ids) => {
        const result = {}
        const entries = this.#keys.get(type)
        if (!entries) return result
        for (const id of ids) {
          if (entries.has(id)) result[id] = entries.get(id)
        }
        return result
      },
      set: async (data) => {
        for (const [type, values] of Object.entries(data ?? {})) {
          if (!values) continue
          let entries = this.#keys.get(type)
          for (const [id, value] of Object.entries(values)) {
            if (value === null || value === undefined) {
              entries?.delete(id)
              continue
            }
            if (!entries) {
              entries = new Map()
              this.#keys.set(type, entries)
            }
            entries.set(id, value)
          }
          if (entries && entries.size === 0) this.#keys.delete(type)
        }
        this.#scheduleKeys()
      },
      clear: async () => {
        this.#keys = emptyKeys()
        this.#scheduleKeys()
      },
    }
    this.state = {
      creds: this.#creds,
      keys: makeCacheableSignalKeyStore(this.#raw, this.#logger),
    }
    this.#loaded = true
    return this.#linked
  }

  /** Called from the `creds.update` event. */
  async saveCreds() {
    if (this.#disposed || this.#creds === null) return
    await this.#enqueue(async () => {
      const json = JSON.stringify(this.#creds, baileys().BufferJSON.replacer)
      await this.#box.sealFile('creds.enc', json)
      if (this.#creds.registered === true) this.#linked = true
    })
  }

  #scheduleKeys() {
    if (this.#disposed) return
    this.#dirty = true
    if (this.#debounce === null) {
      this.#debounce = setTimeout(() => {
        this.#debounce = null
        void this.flush().catch((error) => this.#note(error))
      }, KEY_DEBOUNCE_MS)
    }
    if (this.#maxWait === null) {
      this.#maxWait = setTimeout(() => {
        this.#maxWait = null
        void this.flush().catch((error) => this.#note(error))
      }, KEY_MAX_WAIT_MS)
    }
  }

  async flush() {
    if (this.#debounce !== null) {
      clearTimeout(this.#debounce)
      this.#debounce = null
    }
    if (this.#maxWait !== null) {
      clearTimeout(this.#maxWait)
      this.#maxWait = null
    }
    if (!this.#dirty) {
      await this.#chain
      return
    }
    this.#dirty = false
    await this.#enqueue(async () => {
      const json = JSON.stringify(toPlainKeys(this.#keys), baileys().BufferJSON.replacer)
      await this.#box.sealFile('keys.enc', json)
    })
  }

  async #enqueue(run) {
    const next = this.#chain.then(run, run)
    this.#chain = next.catch(() => {})
    return next
  }

  #note(error) {
    this.#lastError = error
    this.#logger.warn?.('[whatsapp] failed to persist encrypted state', {
      code: error?.code,
      message: String(error?.message ?? error).slice(0, 200),
    })
  }

  /** True when sealed credentials exist; does not decrypt or load Baileys. */
  async hasStoredCredentials() {
    try {
      await fs.access(path.join(this.#dataDir, 'creds.enc'))
      return true
    } catch {
      return false
    }
  }

  /** Remove the current device and return to an unlinked state. */
  async wipe() {
    this.#disposed = false
    const { initAuthCreds, makeCacheableSignalKeyStore } = baileys()
    if (this.#debounce !== null) {
      clearTimeout(this.#debounce)
      this.#debounce = null
    }
    if (this.#maxWait !== null) {
      clearTimeout(this.#maxWait)
      this.#maxWait = null
    }
    this.#dirty = false
    this.#keys = emptyKeys()
    this.#creds = initAuthCreds()
    this.#linked = false
    this.state = {
      creds: this.#creds,
      keys: makeCacheableSignalKeyStore(this.#raw, this.#logger),
    }
    await this.#enqueue(async () => {
      await this.#box.deleteFile('creds.enc')
      await this.#box.deleteFile('keys.enc')
    })
  }

  async close() {
    if (this.#disposed) return
    try {
      await this.flush()
      // Never re-create creds.enc after a wipe: only a registered device has
      // anything worth persisting, and a half-pairing is deliberately discarded.
      if (this.#linked && this.#creds?.registered === true) await this.saveCreds()
    } catch (error) {
      this.#note(error)
    }
    this.#disposed = true
    if (this.#debounce !== null) {
      clearTimeout(this.#debounce)
      this.#debounce = null
    }
    if (this.#maxWait !== null) {
      clearTimeout(this.#maxWait)
      this.#maxWait = null
    }
    this.#keys = emptyKeys()
    this.#creds = null
    this.#linked = false
    this.state = null
  }
}

export function createAuthStore(options) {
  return new AuthStore(options)
}
