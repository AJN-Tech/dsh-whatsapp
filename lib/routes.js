/**
 * HTTP API for dsh-whatsapp (CONTRACT §HTTP routes).
 *
 * All routes live under `/dsh-whatsapp/api` and are registered on the host's
 * `webServer` service as raw Node `(req, res)` handlers. `admit(req, res)` from
 * index.js is the single authentication gate and is called first on every
 * route, including SSE and binary responses.
 *
 * Response conventions (approved by the Lead):
 *   GET  /state    -> the CONTRACT state object, top level
 *   GET  /chats    -> {"chats": ChatSummary[]}
 *   GET  /messages -> {"messages": Message[], "hasMore": boolean}
 *   POST /send, /send-media -> {"message": Message}
 *   everything else -> {"ok": true}
 * Errors are `{"error": string, "code": string}` with stable codes; every
 * response is `Cache-Control: no-store` + `X-Content-Type-Options: nosniff`.
 */
import { API_PREFIX, MAX_JSON_BODY, MAX_UPLOAD_BYTES, clampLimit } from './config.js'
import { decodeCursor, isChatJid, isMessageIdLike, normalizeJid } from './protocol.js'

export const SSE_HEARTBEAT_MS = 20_000
const MAX_READ_IDS = 1000
const MAX_FILENAME_CHARS = 300

const ERROR_STATUS = Object.freeze({
  'bad-request': 400,
  'invalid-json': 400,
  'bad-chat': 400,
  'bad-text': 400,
  'bad-media': 400,
  'bad-call': 400,
  'payload-too-large': 413,
  'method-not-allowed': 405,
  'not-found': 404,
  'not-linked': 409,
  offline: 409,
  disposed: 503,
  unavailable: 503,
  'send-failed': 500,
  'whatsapp-error': 500,
})

function noopLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} }
}

function header(res, name, value) {
  try {
    res.setHeader(name, value)
  } catch {
    /* headers may already be sent */
  }
}

function baseHeaders(res) {
  header(res, 'cache-control', 'no-store')
  header(res, 'x-content-type-options', 'nosniff')
}

function sendJson(res, status, body) {
  if (res.headersSent || res.writableEnded) return
  let text
  try {
    text = JSON.stringify(body)
  } catch {
    text = '{"error":"Internal error","code":"internal"}'
    status = 500
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(text)
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: message ?? code, code })
}

function sendOk(res, body = {}) {
  sendJson(res, 200, { ok: true, ...body })
}

function sendBinary(res, status, { buffer, mimetype, fileName = '', attachment = false }) {
  if (res.headersSent || res.writableEnded) return
  const safeMimetype = typeof mimetype === 'string' && mimetype !== '' ? mimetype : 'application/octet-stream'
  const headers = {
    'content-type': safeMimetype,
    'content-length': String(buffer.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }
  if (attachment) {
    const safeName = sanitizeFileName(fileName)
    headers['content-disposition'] = `attachment; filename="${safeName}"`
  }
  res.writeHead(status, headers)
  res.end(buffer)
}

function sanitizeFileName(fileName) {
  const raw = typeof fileName === 'string' ? fileName : ''
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '_')
    .replace(/["\\]/g, '_')
    .trim()
    .slice(0, MAX_FILENAME_CHARS)
  return cleaned === '' ? 'file' : cleaned
}

function isAttachmentMimetype(mimetype) {
  const essence = String(mimetype ?? '').split(';', 1)[0].trim().toLowerCase()
  return !(essence.startsWith('image/') || essence.startsWith('video/') || essence.startsWith('audio/'))
}

function readUrl(req) {
  try {
    return new URL(String(req.url ?? '/'), 'http://localhost')
  } catch {
    return new URL('/', 'http://localhost')
  }
}

/**
 * Read a bounded request body. Resolves with `{ buffer }` or `{ error }` where
 * error is one of 'too-large' | 'aborted' | 'read-failed'.
 */
function readBody(req, maxBytes) {
  return new Promise((resolve) => {
    const chunks = []
    let total = 0
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      req.off('aborted', onAborted)
      resolve(result)
    }
    const onData = (chunk) => {
      total += chunk.length
      if (total > maxBytes) {
        finish({ error: 'too-large' })
        return
      }
      chunks.push(chunk)
    }
    const onEnd = () => finish({ buffer: Buffer.concat(chunks) })
    const onError = () => finish({ error: 'read-failed' })
    const onAborted = () => finish({ error: 'aborted' })
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('aborted', onAborted)
  })
}

async function readJson(req, res) {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > MAX_JSON_BODY) {
    sendError(res, 413, 'payload-too-large', 'request body is too large')
    return { failed: true }
  }
  const result = await readBody(req, MAX_JSON_BODY)
  if (result.error === 'too-large') {
    sendError(res, 413, 'payload-too-large', 'request body is too large')
    try {
      req.destroy()
    } catch {
      /* ignore */
    }
    return { failed: true }
  }
  if (result.error) {
    sendError(res, 400, 'bad-request', 'request body could not be read')
    return { failed: true }
  }
  if (result.buffer.length === 0) return { body: {} }
  let text
  try {
    text = result.buffer.toString('utf8')
  } catch {
    sendError(res, 400, 'invalid-json', 'request body is not valid UTF-8')
    return { failed: true }
  }
  let body
  try {
    body = JSON.parse(text)
  } catch {
    sendError(res, 400, 'invalid-json', 'request body must be valid JSON')
    return { failed: true }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sendError(res, 400, 'invalid-json', 'request body must be a JSON object')
    return { failed: true }
  }
  return { body }
}

function parseChatParam(value) {
  const normalized = normalizeJid(typeof value === 'string' ? value : '')
  if (normalized === '' || !isChatJid(normalized)) return null
  return normalized
}

function parseMessageId(value) {
  return isMessageIdLike(value) ? value : null
}

function parseBefore(value) {
  if (value === null || value === '') return { cursor: null }
  const cursor = decodeCursor(value)
  if (!cursor) return null
  return { cursor: value }
}

function decodeFileName(headerValue) {
  if (typeof headerValue !== 'string' || headerValue === '') return ''
  try {
    return decodeURIComponent(headerValue)
  } catch {
    return headerValue
  }
}

function sanitizeCaption(value, max = 65536) {
  if (typeof value !== 'string') return ''
  return value.slice(0, max)
}

/**
 * Register every CONTRACT route.
 *
 * @param {{service: object, admit: Function, logger?: object, webServer?: object, apiPrefix?: string}} options
 * @returns {Function[]} disposer functions (the caller wraps them in ctx.effect)
 */
export function registerRoutes(options = {}) {
  const { service, admit, webServer } = options
  const logger = options.logger ?? noopLogger()
  const apiPrefix = typeof options.apiPrefix === 'string' && options.apiPrefix !== '' ? options.apiPrefix : API_PREFIX

  if (typeof admit !== 'function') {
    logger.error?.('[whatsapp] registerRoutes requires the admit() callback; API not registered')
    return []
  }
  if (!webServer || typeof webServer.register !== 'function') {
    logger.error?.('[whatsapp] webServer service is unavailable; API not registered')
    return []
  }
  if (!service) {
    logger.error?.('[whatsapp] registerRoutes requires the WhatsApp service; API not registered')
    return []
  }

  const disposers = []
  const sseClients = new Set()

  const register = (kind, path, handler) => {
    const dispose = webServer.register({ kind, path: `${apiPrefix}${path}`, handler })
    if (typeof dispose === 'function') disposers.push(dispose)
  }

  /** Every route: admit -> method -> handler -> stable error mapping. */
  const route = (method, handler) => async (req, res) => {
    baseHeaders(res)
    let admitted = false
    try {
      admitted = admit(req, res) !== false
    } catch (error) {
      logger.warn?.('[whatsapp] admission check failed', { code: error?.code })
      if (!res.headersSent) sendError(res, 403, 'admission-failed', 'Forbidden')
      return
    }
    if (!admitted || res.headersSent || res.writableEnded) return
    if (req.method !== method) {
      if (!res.headersSent) {
        header(res, 'allow', method)
        sendError(res, 405, 'method-not-allowed', `use ${method}`)
      }
      return
    }
    try {
      await handler(req, res)
    } catch (error) {
      handleError(res, error)
    }
  }

  const handleError = (res, error) => {
    const code = typeof error?.code === 'string' && error.code !== '' ? error.code : 'internal'
    const status = ERROR_STATUS[code] ?? 500
    if (status >= 500) {
      logger.warn?.('[whatsapp] API request failed', {
        code,
        message: String(error?.message ?? error ?? '').slice(0, 200),
      })
      if (!res.headersSent) sendError(res, status, code, 'WhatsApp request failed')
      return
    }
    if (!res.headersSent) sendError(res, status, code, typeof error?.message === 'string' ? error.message : code)
  }

  const requireService = (res) => {
    if (service && typeof service.state === 'function') return true
    sendError(res, 503, 'unavailable', 'WhatsApp service is unavailable')
    return false
  }

  // GET /state -------------------------------------------------------------
  register('exact', '/state', route('GET', async (req, res) => {
    if (!requireService(res)) return
    await service.ready?.()
    sendJson(res, 200, service.state())
  }))

  // GET /chats?q= ----------------------------------------------------------
  register('exact', '/chats', route('GET', async (req, res) => {
    if (!requireService(res)) return
    await service.ready?.()
    const url = readUrl(req)
    const query = url.searchParams.get('q') ?? ''
    sendJson(res, 200, { chats: service.listChats(query.slice(0, 200)) })
  }))

  // GET /messages?chat=&before=&limit= ------------------------------------
  register('exact', '/messages', route('GET', async (req, res) => {
    if (!requireService(res)) return
    await service.ready?.()
    const url = readUrl(req)
    const chat = parseChatParam(url.searchParams.get('chat'))
    if (chat === null) {
      sendError(res, 400, 'bad-request', 'chat must be a valid WhatsApp conversation id')
      return
    }
    const before = parseBefore(url.searchParams.get('before'))
    if (before === null) {
      sendError(res, 400, 'bad-request', 'before must be a valid message cursor')
      return
    }
    const limit = clampLimit(url.searchParams.get('limit'), 50, 200)
    sendJson(res, 200, service.getMessages(chat, { before: before.cursor, limit }))
  }))

  // GET /events (SSE) ------------------------------------------------------
  register('exact', '/events', route('GET', async (req, res) => {
    if (!requireService(res)) return
    await service.ready?.()
    if (res.headersSent) return
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-content-type-options': 'nosniff',
      'x-accel-buffering': 'no',
    })
    const writeEvent = (event) => {
      if (res.writableEnded) return
      try {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      } catch {
        /* the connection is gone; cleanup runs on close */
      }
    }
    try {
      res.write(`event: state\ndata: ${JSON.stringify({ type: 'state', state: service.state() })}\n\n`)
    } catch {
      /* client left immediately */
    }
    const unsubscribe = typeof service.subscribe === 'function' ? service.subscribe(writeEvent) : () => {}
    const heartbeat = setInterval(() => {
      if (res.writableEnded) return
      try {
        res.write(': ping\n\n')
      } catch {
        /* ignore */
      }
    }, SSE_HEARTBEAT_MS)
    heartbeat.unref?.()
    let cleaned = false
    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      clearInterval(heartbeat)
      try {
        unsubscribe()
      } catch {
        /* ignore */
      }
      sseClients.delete(cleanup)
      try {
        res.end()
      } catch {
        /* ignore */
      }
    }
    sseClients.add(cleanup)
    req.on?.('close', cleanup)
    res.on?.('close', cleanup)
  }))

  // POST /link/start ------------------------------------------------------
  register('exact', '/link/start', route('POST', async (req, res) => {
    if (!requireService(res)) return
    await service.beginLink()
    sendOk(res)
  }))

  // POST /link/cancel -----------------------------------------------------
  register('exact', '/link/cancel', route('POST', async (req, res) => {
    if (!requireService(res)) return
    await service.cancelLink()
    sendOk(res)
  }))

  // POST /link/logout { wipeMessages?: boolean } --------------------------
  register('exact', '/link/logout', route('POST', async (req, res) => {
    if (!requireService(res)) return
    const parsed = await readJson(req, res)
    if (parsed.failed) return
    const wipeMessages = parsed.body.wipeMessages === undefined ? true : parsed.body.wipeMessages === true
    await service.logout({ wipeMessages })
    sendOk(res)
  }))

  // POST /link/relink -----------------------------------------------------
  register('exact', '/link/relink', route('POST', async (req, res) => {
    if (!requireService(res)) return
    await service.relink()
    sendOk(res)
  }))

  // POST /reconnect -------------------------------------------------------
  register('exact', '/reconnect', route('POST', async (req, res) => {
    if (!requireService(res)) return
    await service.reconnect()
    sendOk(res)
  }))

  // POST /send { chat, text, quoted? } -----------------------------------
  register('exact', '/send', route('POST', async (req, res) => {
    if (!requireService(res)) return
    const parsed = await readJson(req, res)
    if (parsed.failed) return
    const body = parsed.body
    const chat = parseChatParam(body.chat)
    if (chat === null) {
      sendError(res, 400, 'bad-request', 'chat must be a valid WhatsApp conversation id')
      return
    }
    if (typeof body.text !== 'string' || body.text.trim() === '') {
      sendError(res, 400, 'bad-request', 'text is required')
      return
    }
    const quoted = body.quoted === undefined || body.quoted === null ? null : String(body.quoted)
    if (quoted !== null && !isMessageIdLike(quoted)) {
      sendError(res, 400, 'bad-request', 'quoted must be a message id')
      return
    }
    const message = await service.sendText(chat, body.text, quoted)
    sendJson(res, 200, { message })
  }))

  // POST /send-media?chat=&caption= (raw body) ---------------------------
  register('exact', '/send-media', route('POST', async (req, res) => {
    if (!requireService(res)) return
    const url = readUrl(req)
    const chat = parseChatParam(url.searchParams.get('chat'))
    if (chat === null) {
      sendError(res, 400, 'bad-request', 'chat must be a valid WhatsApp conversation id')
      return
    }
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
      sendError(res, 413, 'payload-too-large', 'upload is too large')
      return
    }
    const body = await readBody(req, MAX_UPLOAD_BYTES)
    if (body.error === 'too-large') {
      sendError(res, 413, 'payload-too-large', 'upload is too large')
      try {
        req.destroy()
      } catch {
        /* ignore */
      }
      return
    }
    if (body.error) {
      sendError(res, 400, 'bad-request', 'upload could not be read')
      return
    }
    if (body.buffer.length === 0) {
      sendError(res, 400, 'bad-request', 'upload body is empty')
      return
    }
    const rawMimetype = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : ''
    const mimetype = rawMimetype.split(';', 1)[0].trim().slice(0, 200) || 'application/octet-stream'
    const fileName = sanitizeFileName(decodeFileName(req.headers['x-file-name']))
    const caption = sanitizeCaption(url.searchParams.get('caption') ?? '')
    const message = await service.sendMedia(chat, {
      buffer: body.buffer,
      fileName,
      mimetype,
      caption,
    })
    sendJson(res, 200, { message })
  }))

  // POST /read { chat, ids } ---------------------------------------------
  register('exact', '/read', route('POST', async (req, res) => {
    if (!requireService(res)) return
    const parsed = await readJson(req, res)
    if (parsed.failed) return
    const chat = parseChatParam(parsed.body.chat)
    if (chat === null) {
      sendError(res, 400, 'bad-request', 'chat must be a valid WhatsApp conversation id')
      return
    }
    const ids = parsed.body.ids
    if (!Array.isArray(ids)) {
      sendError(res, 400, 'bad-request', 'ids must be an array of message ids')
      return
    }
    const validIds = []
    for (const id of ids.slice(0, MAX_READ_IDS)) {
      if (!isMessageIdLike(id)) {
        sendError(res, 400, 'bad-request', 'ids must be an array of message ids')
        return
      }
      validIds.push(id)
    }
    await service.sendRead(chat, validIds)
    sendOk(res)
  }))

  // POST /typing { chat, typing } ----------------------------------------
  register('exact', '/typing', route('POST', async (req, res) => {
    if (!requireService(res)) return
    const parsed = await readJson(req, res)
    if (parsed.failed) return
    const chat = parseChatParam(parsed.body.chat)
    if (chat === null) {
      sendError(res, 400, 'bad-request', 'chat must be a valid WhatsApp conversation id')
      return
    }
    if (typeof parsed.body.typing !== 'boolean') {
      sendError(res, 400, 'bad-request', 'typing must be a boolean')
      return
    }
    await service.sendTyping(chat, parsed.body.typing)
    sendOk(res)
  }))

  // GET /media?chat=&id= (binary) ----------------------------------------
  register('exact', '/media', route('GET', async (req, res) => {
    if (!requireService(res)) return
    const url = readUrl(req)
    const chat = parseChatParam(url.searchParams.get('chat'))
    if (chat === null) {
      sendError(res, 400, 'bad-request', 'chat must be a valid WhatsApp conversation id')
      return
    }
    const id = parseMessageId(url.searchParams.get('id'))
    if (id === null) {
      sendError(res, 400, 'bad-request', 'id must be a message id')
      return
    }
    const media = await service.getMedia(chat, id)
    if (!media) {
      sendError(res, 404, 'not-found', 'media is not available')
      return
    }
    sendBinary(res, 200, {
      buffer: media.buffer,
      mimetype: media.mimetype,
      fileName: media.fileName,
      attachment: isAttachmentMimetype(media.mimetype),
    })
  }))

  // GET /avatar?jid= (binary image or 404) --------------------------------
  register('exact', '/avatar', route('GET', async (req, res) => {
    if (!requireService(res)) return
    const url = readUrl(req)
    const jid = parseChatParam(url.searchParams.get('jid'))
    if (jid === null) {
      sendError(res, 400, 'bad-request', 'jid must be a valid WhatsApp jid')
      return
    }
    const avatar = await service.getAvatar(jid)
    if (!avatar || !Buffer.isBuffer(avatar.buffer) || avatar.buffer.length === 0) {
      sendError(res, 404, 'not-found', 'avatar is not available')
      return
    }
    sendBinary(res, 200, {
      buffer: avatar.buffer,
      mimetype: avatar.mimetype || 'image/jpeg',
      attachment: false,
    })
  }))

  // POST /call/reject { id, from } ---------------------------------------
  register('exact', '/call/reject', route('POST', async (req, res) => {
    if (!requireService(res)) return
    const parsed = await readJson(req, res)
    if (parsed.failed) return
    const callId = parsed.body.id
    if (typeof callId !== 'string' || callId === '' || callId.length > 256) {
      sendError(res, 400, 'bad-request', 'id must be a call id')
      return
    }
    const from = parseChatParam(parsed.body.from)
    if (from === null) {
      sendError(res, 400, 'bad-request', 'from must be a valid WhatsApp jid')
      return
    }
    await service.rejectCall(callId, from)
    sendOk(res)
  }))

  // Close every live SSE stream when the plugin is disposed.
  disposers.push(() => {
    for (const cleanup of [...sseClients]) {
      try {
        cleanup()
      } catch {
        /* ignore */
      }
    }
    sseClients.clear()
  })

  return disposers
}

export default registerRoutes
