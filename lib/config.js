/**
 * Fixed facts for dsh-whatsapp. No secret material, no network, no imports from
 * the host: this module is safe to unit-test in isolation.
 */
import os from 'node:os'
import path from 'node:path'

export const PLUGIN_ID = 'dsh-whatsapp'
export const API_PREFIX = '/dsh-whatsapp/api'
export const CLIENT_SLOT = PLUGIN_ID

/** JSON control endpoints are tiny; attachments have their own raw-body route. */
export const MAX_JSON_BODY = 64 * 1024
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024

/** Bounded cache: a personal account should not grow the profile without limit. */
export const MAX_MESSAGES_PER_CHAT = 1000
export const MAX_TOTAL_MESSAGES = 20000
export const MESSAGE_PAGE_SIZE = 50
export const MAX_CHATS = 2000

/** Reconnect backoff: 1s, 2s, 4s ... capped at 30s with +/-20% jitter. */
export const RECONNECT_BASE_MS = 1000
export const RECONNECT_MAX_MS = 30000
export const RECONNECT_MAX_ATTEMPTS = 12

/** When the primary phone has been offline longer than this, WhatsApp may ask
 *  for the phone again; the UI explains the model instead of pretending. */
export const PHONE_OFFLINE_MODEL =
  'A linked device keeps working while the phone is off, but WhatsApp expects the ' +
  'device to have been linked recently. Devices not used for about 14 days are ' +
  'unlinked and must be linked again.'

/** Media thumbnails are embedded in messages; cap the decoded size we accept. */
export const MAX_THUMBNAIL_BYTES = 512 * 1024
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024
export const AVATAR_CACHE_TTL_MS = 30 * 60 * 1000

/** Local storage file names, all inside a private data directory. */
export const FILES = Object.freeze({
  key: 'key.bin',
  salt: 'salt.bin',
  creds: 'creds.enc',
  keys: 'keys.enc',
  store: 'store.enc',
  link: 'device.json',
})

export const FILE_AAD = Object.freeze({
  creds: 'creds.enc',
  keys: 'keys.enc',
  store: 'store.enc',
  link: 'device.json',
})

/** `$DSH_HOME` is set by the desktop app; otherwise use the documented ~/.dsh. */
export function resolveDataDir(env = process.env) {
  if (typeof env.DSH_WHATSAPP_DATA_DIR === 'string' && env.DSH_WHATSAPP_DATA_DIR.trim() !== '') {
    return path.resolve(env.DSH_WHATSAPP_DATA_DIR)
  }
  const home = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== ''
    ? path.resolve(env.DSH_HOME)
    : path.join(os.homedir(), '.dsh')
  return path.join(home, 'whatsapp')
}

export function passphraseFromEnv(env = process.env) {
  const value = env.DSH_WHATSAPP_PASSPHRASE
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function fileIn(dataDir, name) {
  return path.join(dataDir, name)
}

export function clampLimit(value, fallback = MESSAGE_PAGE_SIZE, max = 200) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(max, Math.max(1, Math.floor(n)))
}
