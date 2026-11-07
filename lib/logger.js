/**
 * A tiny pino-compatible logger for Baileys.
 *
 * Baileys expects a pino-shaped logger (`trace`/`debug`/`info`/`warn`/`error`/
 * `fatal` plus `child`). The host's own logger (passed to the service from
 * `index.js`) only offers `info`/`warn`/`error`, so this adapter maps one onto
 * the other and keeps the WhatsApp protocol layer quiet by default.
 *
 * Rules kept here so they cannot be forgotten at each call site:
 *  - the level comes from `DSH_WHATSAPP_LOG_LEVEL` (`silent` by default, because
 *    a chat client must not spray protocol internals into the host log);
 *  - only the message string and a small, shallow detail object are forwarded;
 *    no arguments are ever inspected for credentials and no QR payload/media
 *    bytes are formatted (callers must not pass them, and Baileys' node dumps
 *    are dropped by the shallow summarizer);
 *  - logging can never throw: a broken host logger must not break the socket.
 */

export const LEVELS = Object.freeze({
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: 100,
})

/** Max characters forwarded for any log line. Keeps accidental payload dumps short. */
const MAX_MESSAGE_CHARS = 1000
/** Max keys/serialized characters in a detail object attached to a log line. */
const MAX_DETAIL_CHARS = 500
const MAX_DETAIL_KEYS = 12

export function levelValue(level) {
  if (typeof level === 'number' && Number.isFinite(level)) return level
  const key = String(level ?? 'silent').trim().toLowerCase()
  return LEVELS[key] ?? LEVELS.silent
}

export function levelFromEnv(env = process.env, fallback = 'silent') {
  const raw = env?.DSH_WHATSAPP_LOG_LEVEL
  if (typeof raw !== 'string' || raw.trim() === '') return fallback
  const key = raw.trim().toLowerCase()
  return key in LEVELS ? key : fallback
}

/**
 * Turn whatever a pino call site passes into a safe `{ message, detail }`.
 * pino allows `logger.info(obj, msg)`, `logger.info(msg, ...args)` and
 * `logger.info(msg)`; Baileys uses all three shapes. Objects are summarized,
 * never passed through wholesale.
 */
export function formatLogArgs(args) {
  let message = ''
  let detail
  const rest = []
  for (const value of args) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      rest.push(value)
    } else if (value !== null && typeof value === 'object' && detail === undefined && !Array.isArray(value)) {
      detail = value
    }
  }
  const firstString = rest.findIndex((value) => typeof value === 'string')
  if (firstString >= 0) {
    message = rest
      .slice(firstString)
      .map((value) => String(value))
      .join(' ')
    const leadingNumbers = rest.slice(0, firstString).map((value) => String(value))
    if (leadingNumbers.length > 0) message = `${leadingNumbers.join(' ')} ${message}`
  } else {
    message = rest.map((value) => String(value)).join(' ')
  }
  if (message === '' && detail !== undefined) message = 'event'
  return { message: message.slice(0, MAX_MESSAGE_CHARS), detail: summarizeDetail(detail) }
}

/** Shallow, bounded summary so a pino object argument cannot leak a whole stanza. */
export function summarizeDetail(detail) {
  if (detail === undefined || detail === null) return undefined
  if (typeof detail !== 'object') return String(detail).slice(0, MAX_DETAIL_CHARS)
  if (detail instanceof Error) {
    return {
      name: String(detail.name ?? 'Error').slice(0, 60),
      code: detail.code === undefined ? undefined : String(detail.code).slice(0, 60),
      message: String(detail.message ?? '').slice(0, 200),
    }
  }
  const out = {}
  let keys = 0
  for (const [key, value] of Object.entries(detail)) {
    if (keys >= MAX_DETAIL_KEYS) break
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      out[key] = typeof value === 'string' ? value.slice(0, 80) : value
      keys += 1
      continue
    }
    if (Array.isArray(value)) {
      out[key] = value.length
      keys += 1
      continue
    }
    if (value && typeof value === 'object') {
      out[key] = '[object]'
      keys += 1
    }
  }
  let serialized
  try {
    serialized = JSON.stringify(out)
  } catch {
    return undefined
  }
  if (typeof serialized !== 'string') return undefined
  return serialized.length > MAX_DETAIL_CHARS
    ? { truncated: serialized.slice(0, MAX_DETAIL_CHARS) }
    : out
}

function safeWrite(write, message, detail) {
  try {
    if (detail === undefined) write(message)
    else write(message, detail)
  } catch {
    // A broken host logger must never make the socket throw.
  }
}

/**
 * Create the pino-compatible logger.
 *
 * @param {{ logger?: {info?: Function, warn?: Function, error?: Function}, level?: string, prefix?: string, source?: object }} [options]
 */
export function createLogger(options = {}) {
  const prefix = typeof options.prefix === 'string' ? options.prefix : '[whatsapp]'
  const source = options.source ?? {}
  const threshold = levelValue(options.level ?? levelFromEnv())
  const write = (level, args) => {
    const { message, detail } = formatLogArgs(args)
    const text = `${prefix} ${message}`.slice(0, MAX_MESSAGE_CHARS)
    // `fatal` has no host method; treat it as an error.
    const hostMethod = level === 'fatal' ? 'error' : level
    const host = source.logger
    if (host && typeof host[hostMethod] === 'function') {
      safeWrite(host[hostMethod].bind(host), text, detail)
      return
    }
    // Fall back to console only for warnings/errors while no host logger exists.
    if (level === 'error' || level === 'fatal') safeWrite(console.error.bind(console), text, detail)
    else if (level === 'warn') safeWrite(console.warn.bind(console), text, detail)
  }
  const logger = {
    level: options.level ?? levelFromEnv(),
    isLevelEnabled(level) {
      return levelValue(level) >= threshold
    },
    trace(...args) {
      if (threshold <= LEVELS.trace) write('trace', args)
    },
    debug(...args) {
      if (threshold <= LEVELS.debug) write('debug', args)
    },
    info(...args) {
      if (threshold <= LEVELS.info) write('info', args)
    },
    warn(...args) {
      if (threshold <= LEVELS.warn) write('warn', args)
    },
    error(...args) {
      if (threshold <= LEVELS.error) write('error', args)
    },
    fatal(...args) {
      if (threshold <= LEVELS.fatal) write('fatal', args)
    },
    /** pino's `child(bindings)`; bindings are reduced to a short prefix. */
    child(bindings) {
      let suffix = ''
      if (bindings && typeof bindings === 'object') {
        const parts = []
        for (const [key, value] of Object.entries(bindings)) {
          if (parts.length >= 3) break
          if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
            parts.push(`${key}=${String(value).slice(0, 40)}`)
          }
        }
        if (parts.length > 0) suffix = ` ${parts.join(' ')}`
      }
      return createLogger({ logger: source.logger, level: options.level, prefix: `${prefix}${suffix}`, source })
    },
  }
  return logger
}

/** A logger that discards everything (used by stores in tests and by `dispose`). */
export function silentLogger() {
  return createLogger({ level: 'silent' })
}

export default createLogger
