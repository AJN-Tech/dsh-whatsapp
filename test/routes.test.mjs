/**
 * lib/routes.js — HTTP API handlers over a fake webServer and a fake service.
 *
 * Every handler is a plain `(req, res)` function, so the route table is invoked
 * directly with Node-shaped fakes: no HTTP server, no socket, no network.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { registerRoutes, SSE_HEARTBEAT_MS } from '../lib/routes.js'
import { API_PREFIX, MAX_JSON_BODY, MAX_UPLOAD_BYTES } from '../lib/config.js'

const JID = '15551234567@s.whatsapp.net'
const GROUP = '120363000000000001@g.us'
const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, child() { return silentLogger } }

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function createFakeWebServer() {
  const routes = []
  const service = {
    routes,
    register({ kind, path, handler }) {
      const entry = { kind, path, handler }
      routes.push(entry)
      return () => {
        const index = routes.indexOf(entry)
        if (index >= 0) routes.splice(index, 1)
      }
    },
    /** The host's own dispatch contract: exact/prefix match, else no route. */
    dispatch(method, path) {
      const entry = routes.find((route) =>
        (route.kind === 'exact' ? route.path === path : path.startsWith(route.path)))
      if (!entry) return null
      return { ...entry, method }
    },
    find(path) {
      return routes.find((route) => route.path === path) ?? null
    },
  }
  return service
}

function createReq({ method = 'GET', url = '/', headers = {}, chunks = null } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = headers
  req.socket = { remoteAddress: '127.0.0.1' }
  req.destroy = () => {
    req.destroyed = true
  }
  if (chunks !== null) {
    process.nextTick(() => {
      for (const chunk of chunks) req.emit('data', Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      req.emit('end')
    })
  }
  return req
}

function createRes() {
  const res = new EventEmitter()
  res.statusCode = 0
  res.statusHeaders = {}
  res.headersSent = false
  res.writableEnded = false
  res.chunks = []
  res.setHeader = (name, value) => {
    res.statusHeaders[String(name).toLowerCase()] = value
  }
  res.writeHead = (status, headers = {}) => {
    res.statusCode = status
    for (const [name, value] of Object.entries(headers)) res.statusHeaders[name.toLowerCase()] = value
    res.headersSent = true
    return res
  }
  res.write = (chunk) => {
    res.headersSent = true
    res.chunks.push(String(chunk))
    return true
  }
  res.end = (chunk) => {
    if (chunk !== undefined && chunk !== null) res.chunks.push(String(chunk))
    res.headersSent = true
    res.writableEnded = true
    res.emit('close')
    return res
  }
  Object.defineProperty(res, 'body', { get: () => res.chunks.join('') })
  res.json = () => JSON.parse(res.body)
  return res
}

function createFakeService(overrides = {}) {
  const listeners = []
  const counters = {
    ready: 0, unsubscribed: 0, listChats: [], getMessages: [], sendText: [], sendMedia: [],
    sendRead: [], sendTyping: [], getMedia: [], getAvatar: [], rejectCall: [],
    beginLink: 0, cancelLink: 0, logout: [], relink: 0, reconnect: 0,
  }
  const state = {
    linked: true,
    connection: 'online',
    qr: null,
    me: { id: JID, name: 'Me', phone: '15551234567' },
    linkedAt: 1_700_000_000_000,
    lastConnectedAt: 1_700_000_001_000,
    reconnectInMs: null,
    reconnectAttempt: 0,
    lastError: null,
    needsRelink: false,
    phoneOfflineModel: 'model text',
    callsSupported: false,
    messageCount: 2,
    chatCount: 1,
    storage: 'encrypted',
  }
  const service = {
    state: () => ({ ...state }),
    async ready() { counters.ready += 1 },
    listChats(query) {
      counters.listChats.push(query)
      return [{ id: JID, name: 'Bob', isGroup: false, unread: 0, pinned: false, muted: false, archived: false, timestamp: 1, lastMessage: null }]
    },
    getMessages(chatId, options) {
      counters.getMessages.push({ chatId, ...options })
      return { messages: [{ id: 'm1', chatId, kind: 'text', text: 'hi' }], hasMore: false }
    },
    async sendText(chatId, text, quoted) {
      counters.sendText.push({ chatId, text, quoted })
      return { id: 'sent-1', chatId, text, kind: 'text' }
    },
    async sendMedia(chatId, media) {
      counters.sendMedia.push({ chatId, ...media })
      return { id: 'media-1', chatId, kind: 'image' }
    },
    async sendRead(chatId, ids) { counters.sendRead.push({ chatId, ids }) },
    async sendTyping(chatId, typing) { counters.sendTyping.push({ chatId, typing }) },
    async getMedia(chatId, id) {
      counters.getMedia.push({ chatId, id })
      if (typeof overrides.mediaResult === 'function') return overrides.mediaResult(chatId, id)
      return { buffer: Buffer.from([1, 2, 3]), mimetype: 'image/jpeg', fileName: 'photo.jpg' }
    },
    async getAvatar(jid) {
      counters.getAvatar.push(jid)
      if (typeof overrides.avatarResult === 'function') return overrides.avatarResult(jid)
      return { buffer: Buffer.from([9, 9]), mimetype: 'image/png' }
    },
    async rejectCall(id, from) { counters.rejectCall.push({ id, from }) },
    subscribe(listener) {
      listeners.push(listener)
      return () => { counters.unsubscribed += 1 }
    },
    async beginLink() { counters.beginLink += 1 },
    async cancelLink() { counters.cancelLink += 1 },
    async logout(options) { counters.logout.push(options) },
    async relink() { counters.relink += 1 },
    async reconnect() { counters.reconnect += 1 },
    _counters: counters,
    _listeners: listeners,
  }
  // Per-test overrides (e.g. a failing sendText) replace the default method.
  for (const [name, value] of Object.entries(overrides)) {
    if (name === 'mediaResult' || name === 'avatarResult') continue
    service[name] = value
  }
  return service
}

function createHarness(t, { overrides = {}, admit } = {}) {
  const webServer = createFakeWebServer()
  const service = createFakeService(overrides)
  const admitCalls = []
  const admitFn = admit ?? ((req) => {
    admitCalls.push(req.url)
    return true
  })
  const disposers = registerRoutes({ service, admit: admitFn, webServer, logger: silentLogger })
  t.after(() => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* ignore */ }
    }
  })
  return { webServer, service, disposers, admitCalls }
}

async function invoke(webServer, path, {
  method = 'GET',
  headers = {},
  url = null,
  body = null,
  json = undefined,
  chunks = null,
  req: reqOverride = null,
} = {}) {
  const route = webServer.find(path)
  assert.ok(route, `no route registered for ${path}`)
  const req = reqOverride ?? createReq({
    method,
    url: url ?? `${path}`,
    headers,
    // POST handlers always read a body, so feed them at least an empty one.
    chunks: chunks !== null ? chunks : (json !== undefined ? [JSON.stringify(json)] : (body !== null ? [body] : (method === 'POST' ? [] : null))),
  })
  const res = createRes()
  await route.handler(req, res)
  return { req, res, status: res.statusCode, route }
}

function bodyJson(res) {
  return JSON.parse(res.body)
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const EXPECTED_ROUTES = [
  '/state', '/chats', '/messages', '/events',
  '/link/start', '/link/cancel', '/link/logout', '/link/relink', '/reconnect',
  '/send', '/send-media', '/read', '/typing',
  '/media', '/avatar', '/call/reject',
]

test('registers every CONTRACT route exactly once under the API prefix', (t) => {
  const harness = createHarness(t)
  assert.equal(harness.webServer.routes.length, EXPECTED_ROUTES.length)
  for (const suffix of EXPECTED_ROUTES) {
    const route = harness.webServer.find(`${API_PREFIX}${suffix}`)
    assert.ok(route, `missing route ${suffix}`)
    assert.equal(route.kind, 'exact')
    assert.equal(typeof route.handler, 'function')
  }
  // No wildcard/catch-all route: unknown paths stay the host's 404.
  assert.equal(harness.webServer.routes.every((route) => route.kind === 'exact'), true)
  assert.equal(harness.webServer.dispatch('GET', `${API_PREFIX}/nope`), null)
  // Disposers remove every registered route and are idempotent.
  assert.equal(harness.disposers.length, EXPECTED_ROUTES.length + 1)
  for (const dispose of harness.disposers) dispose()
  assert.equal(harness.webServer.routes.length, 0)
})

test('missing webServer/service/admit makes the registrar a safe no-op', () => {
  const webServer = createFakeWebServer()
  const admit = () => true
  // No admit callback.
  assert.deepEqual(registerRoutes({ service: { state: () => ({}) }, webServer, logger: silentLogger }), [])
  // No service.
  assert.deepEqual(registerRoutes({ service: null, admit, webServer, logger: silentLogger }), [])
  // No webServer.
  assert.deepEqual(registerRoutes({ service: {}, admit, webServer: null, logger: silentLogger }), [])
  assert.equal(webServer.routes.length, 0)
})

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

test('every route calls admit first and stops when rejected', async (t) => {
  const harness = createHarness(t, {
    admit: (req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{"error":"Unauthorized"}')
      return false
    },
  })
  for (const route of harness.webServer.routes) {
    const req = createReq({ method: 'GET', url: route.path })
    const res = createRes()
    await route.handler(req, res)
    assert.equal(res.statusCode, 401, `${route.path} must be rejected by admit`)
    assert.equal(res.writableEnded, true)
  }
  // No service method was reached.
  const service = harness.service
  assert.equal(service._counters.ready, 0)
  assert.equal(service._counters.sendText.length, 0)
  assert.equal(service._counters.beginLink, 0)
})

test('a throwing admit becomes a 403 instead of a crash', async (t) => {
  const harness = createHarness(t, {
    admit: () => { throw Object.assign(new Error('boom'), { code: 'admission-failed' }) },
  })
  const { res } = await invoke(harness.webServer, `${API_PREFIX}/state`)
  assert.equal(res.statusCode, 403)
  assert.equal(bodyJson(res).code, 'admission-failed')
})

// ---------------------------------------------------------------------------
// JSON body limits / parsing
// ---------------------------------------------------------------------------

test('declared and streamed JSON bodies above 64 KiB are rejected with 413', async (t) => {
  const harness = createHarness(t)
  const path = `${API_PREFIX}/send`

  const declared = await invoke(harness.webServer, path, {
    method: 'POST',
    json: { chat: JID, text: 'hi' },
    headers: { 'content-length': String(MAX_JSON_BODY + 1) },
  })
  assert.equal(declared.status, 413)
  assert.equal(bodyJson(declared.res).code, 'payload-too-large')

  const streamed = await invoke(harness.webServer, path, {
    method: 'POST',
    chunks: ['x'.repeat(MAX_JSON_BODY + 1)],
  })
  assert.equal(streamed.status, 413)
  assert.equal(bodyJson(streamed.res).code, 'payload-too-large')

  assert.equal(harness.service._counters.sendText.length, 0)
})

test('invalid JSON and non-object JSON bodies are rejected with 400', async (t) => {
  const harness = createHarness(t)
  const path = `${API_PREFIX}/send`
  for (const body of ['not json', '[]', '"string"']) {
    const { res, status } = await invoke(harness.webServer, path, { method: 'POST', chunks: [body] })
    assert.equal(status, 400, body)
    assert.equal(bodyJson(res).code, 'invalid-json')
  }
})

// ---------------------------------------------------------------------------
// Read routes
// ---------------------------------------------------------------------------

test('GET /state returns the state object at the top level with safety headers', async (t) => {
  const harness = createHarness(t)
  const { res, status } = await invoke(harness.webServer, `${API_PREFIX}/state`)
  assert.equal(status, 200)
  const body = bodyJson(res)
  assert.equal(body.linked, true)
  assert.equal(body.connection, 'online')
  assert.equal(body.callsSupported, false)
  assert.equal(res.statusHeaders['cache-control'], 'no-store')
  assert.equal(res.statusHeaders['x-content-type-options'], 'nosniff')
  assert.equal(res.statusHeaders['content-type'], 'application/json; charset=utf-8')
})

test('GET /chats passes the bounded query and returns {chats}', async (t) => {
  const harness = createHarness(t)
  const { res } = await invoke(harness.webServer, `${API_PREFIX}/chats`, {
    url: `${API_PREFIX}/chats?q=Bob`,
  })
  assert.deepEqual(harness.service._counters.listChats, ['Bob'])
  assert.equal(Array.isArray(bodyJson(res).chats), true)
  assert.equal(harness.service._counters.ready, 1)

  const longQuery = 'x'.repeat(500)
  await invoke(harness.webServer, `${API_PREFIX}/chats`, { url: `${API_PREFIX}/chats?q=${longQuery}` })
  assert.equal(harness.service._counters.listChats.at(-1).length, 200)
})

test('GET /messages validates chat and cursor and passes clamped limit', async (t) => {
  const harness = createHarness(t)
  const path = `${API_PREFIX}/messages`
  const cursor = '1700000000000:msg-1'

  const ok = await invoke(harness.webServer, path, { url: `${path}?chat=${encodeURIComponent(JID)}&before=${encodeURIComponent(cursor)}&limit=3` })
  assert.equal(ok.status, 200)
  assert.deepEqual(harness.service._counters.getMessages.at(-1), { chatId: JID, before: cursor, limit: 3 })
  assert.equal(Array.isArray(bodyJson(ok.res).messages), true)
  assert.equal(bodyJson(ok.res).hasMore, false)

  const noChat = await invoke(harness.webServer, path, { url: `${path}?chat=nope` })
  assert.equal(noChat.status, 400)
  const badCursor = await invoke(harness.webServer, path, { url: `${path}?chat=${encodeURIComponent(JID)}&before=garbage` })
  assert.equal(badCursor.status, 400)

  const defaults = await invoke(harness.webServer, path, { url: `${path}?chat=${encodeURIComponent(JID)}&limit=nope` })
  assert.equal(defaults.status, 200)
  assert.equal(harness.service._counters.getMessages.at(-1).limit, 50)
})

// ---------------------------------------------------------------------------
// POST routes
// ---------------------------------------------------------------------------

test('POST /send validates and sends text with an optional quote', async (t) => {
  const harness = createHarness(t)
  const path = `${API_PREFIX}/send`

  const ok = await invoke(harness.webServer, path, {
    method: 'POST',
    json: { chat: '15551234567:2@s.whatsapp.net', text: 'hello', quoted: 'orig-42' },
  })
  assert.equal(ok.status, 200)
  assert.deepEqual(harness.service._counters.sendText.at(-1), { chatId: JID, text: 'hello', quoted: 'orig-42' })
  assert.equal(bodyJson(ok.res).message.id, 'sent-1')
  assert.equal(ok.res.statusHeaders['cache-control'], 'no-store')

  for (const [patch, code] of [
    [{ chat: 'not-a-jid', text: 'hi' }, 'bad-request'],
    [{ chat: JID, text: '' }, 'bad-request'],
    [{ chat: JID, text: '   ' }, 'bad-request'],
    [{ chat: JID, text: 42 }, 'bad-request'],
    [{ chat: JID, text: 'hi', quoted: 'bad/id' }, 'bad-request'],
  ]) {
    const result = await invoke(harness.webServer, path, { method: 'POST', json: patch })
    assert.equal(result.status, 400, JSON.stringify(patch))
    assert.equal(bodyJson(result.res).code, code)
  }
  assert.equal(harness.service._counters.sendText.length, 1)
})

test('POST /send-media accepts a raw body with URI-encoded file name and caption', async (t) => {
  const harness = createHarness(t)
  const path = `${API_PREFIX}/send-media`
  const url = `${path}?chat=${encodeURIComponent(JID)}&caption=${encodeURIComponent('a caption')}`

  const result = await invoke(harness.webServer, path, {
    method: 'POST',
    url,
    headers: { 'content-type': 'image/png; charset=binary', 'x-file-name': 'my%20photo.png' },
    chunks: [Buffer.from([1, 2, 3, 4])],
  })
  assert.equal(result.status, 200)
  const sent = harness.service._counters.sendMedia.at(-1)
  assert.deepEqual(sent.buffer, Buffer.from([1, 2, 3, 4]))
  assert.equal(sent.fileName, 'my photo.png')
  assert.equal(sent.mimetype, 'image/png')
  assert.equal(sent.caption, 'a caption')
  assert.equal(bodyJson(result.res).message.id, 'media-1')

  // A path-ish file name cannot escape the attachment name.
  const sanitized = await invoke(harness.webServer, path, {
    method: 'POST',
    url: `${path}?chat=${encodeURIComponent(JID)}`,
    headers: { 'content-type': 'application/octet-stream', 'x-file-name': '../evil%2Fname.bin' },
    chunks: [Buffer.from([7])],
  })
  assert.equal(sanitized.status, 200)
  const name = harness.service._counters.sendMedia.at(-1).fileName
  assert.equal(name.includes('/'), false)
  assert.equal(name.includes('\\'), false)

  const empty = await invoke(harness.webServer, path, {
    method: 'POST',
    url: `${path}?chat=${encodeURIComponent(JID)}`,
    chunks: [],
  })
  assert.equal(empty.status, 400)
  const badChat = await invoke(harness.webServer, path, { method: 'POST', url: `${path}?chat=nope`, chunks: ['x'] })
  assert.equal(badChat.status, 400)
})

test('POST /send-media rejects an over-large declared upload without reading it', async (t) => {
  const harness = createHarness(t)
  const path = `${API_PREFIX}/send-media`
  const result = await invoke(harness.webServer, path, {
    method: 'POST',
    url: `${path}?chat=${encodeURIComponent(JID)}`,
    headers: { 'content-length': String(MAX_UPLOAD_BYTES + 1) },
    chunks: ['x'],
  })
  assert.equal(result.status, 413)
  assert.equal(bodyJson(result.res).code, 'payload-too-large')
})

test('POST /read validates ids and forwards read receipts', async (t) => {
  const harness = createHarness(t)
  const path = `${API_PREFIX}/read`
  const ok = await invoke(harness.webServer, path, {
    method: 'POST',
    json: { chat: JID, ids: ['m1', 'm2'] },
  })
  assert.equal(ok.status, 200)
  assert.deepEqual(harness.service._counters.sendRead.at(-1), { chatId: JID, ids: ['m1', 'm2'] })
  assert.equal(bodyJson(ok.res).ok, true)

  for (const body of [
    { chat: JID, ids: 'm1' },
    { chat: JID, ids: [42] },
    { chat: JID, ids: ['bad/id'] },
    { chat: 'nope', ids: ['m1'] },
  ]) {
    const result = await invoke(harness.webServer, path, { method: 'POST', json: body })
    assert.equal(result.status, 400, JSON.stringify(body))
  }
  assert.equal(harness.service._counters.sendRead.length, 1)
})

test('POST /typing validates the chat and boolean and forwards presence', async (t) => {
  const harness = createHarness(t)
  const path = `${API_PREFIX}/typing`
  const ok = await invoke(harness.webServer, path, { method: 'POST', json: { chat: JID, typing: true } })
  assert.equal(ok.status, 200)
  assert.deepEqual(harness.service._counters.sendTyping.at(-1), { chatId: JID, typing: true })
  const bad = await invoke(harness.webServer, path, { method: 'POST', json: { chat: JID, typing: 'yes' } })
  assert.equal(bad.status, 400)
  const badChat = await invoke(harness.webServer, path, { method: 'POST', json: { chat: 'nope', typing: true } })
  assert.equal(badChat.status, 400)
})

test('POST /call/reject validates and forwards the call id + caller', async (t) => {
  const harness = createHarness(t)
  const path = `${API_PREFIX}/call/reject`
  const ok = await invoke(harness.webServer, path, {
    method: 'POST',
    json: { id: 'call-1', from: '15550000001:3@s.whatsapp.net' },
  })
  assert.equal(ok.status, 200)
  assert.deepEqual(harness.service._counters.rejectCall.at(-1), { id: 'call-1', from: '15550000001@s.whatsapp.net' })
  assert.equal(bodyJson(ok.res).ok, true)

  for (const body of [{ from: JID }, { id: '', from: JID }, { id: 'call-1', from: 'nope' }, { id: 'x'.repeat(300), from: JID }]) {
    const result = await invoke(harness.webServer, path, { method: 'POST', json: body })
    assert.equal(result.status, 400, JSON.stringify(body))
  }
})

test('link lifecycle routes call the service and return {ok:true}', async (t) => {
  const harness = createHarness(t)
  const calls = harness.service._counters

  await invoke(harness.webServer, `${API_PREFIX}/link/start`, { method: 'POST' })
  assert.equal(calls.beginLink, 1)
  await invoke(harness.webServer, `${API_PREFIX}/link/cancel`, { method: 'POST' })
  assert.equal(calls.cancelLink, 1)
  await invoke(harness.webServer, `${API_PREFIX}/reconnect`, { method: 'POST' })
  assert.equal(calls.reconnect, 1)
  await invoke(harness.webServer, `${API_PREFIX}/link/relink`, { method: 'POST' })
  assert.equal(calls.relink, 1)

  // logout defaults to wiping messages...
  const first = await invoke(harness.webServer, `${API_PREFIX}/link/logout`, { method: 'POST' })
  assert.equal(first.status, 200)
  assert.deepEqual(calls.logout.at(-1), { wipeMessages: true })
  // ...and honours an explicit false.
  const second = await invoke(harness.webServer, `${API_PREFIX}/link/logout`, {
    method: 'POST',
    json: { wipeMessages: false },
  })
  assert.equal(second.status, 200)
  assert.deepEqual(calls.logout.at(-1), { wipeMessages: false })
  assert.equal(bodyJson(second.res).ok, true)
})

// ---------------------------------------------------------------------------
// Binary routes
// ---------------------------------------------------------------------------

test('GET /media serves image bytes inline and documents as attachments', async (t) => {
  const harness = createHarness(t)
  const path = `${API_PREFIX}/media`
  const query = `?chat=${encodeURIComponent(JID)}&id=${encodeURIComponent('msg-1')}`

  const image = await invoke(harness.webServer, path, { url: `${path}${query}` })
  assert.equal(image.status, 200)
  assert.equal(image.res.statusHeaders['content-type'], 'image/jpeg')
  assert.equal(image.res.statusHeaders['content-length'], '3')
  assert.equal(image.res.statusHeaders['content-disposition'], undefined)
  assert.equal(image.res.statusHeaders['cache-control'], 'no-store')
  assert.deepEqual(Buffer.from(image.res.chunks.join(''), 'binary').subarray(0, 3), Buffer.from([1, 2, 3]))

  const documentHarness = createHarness(t, {
    overrides: { mediaResult: () => ({ buffer: Buffer.from([5]), mimetype: 'application/pdf', fileName: 'report "final".pdf' }) },
  })
  const doc = await invoke(documentHarness.webServer, path, { url: `${path}${query}` })
  assert.equal(doc.status, 200)
  assert.equal(doc.res.statusHeaders['content-type'], 'application/pdf')
  assert.match(doc.res.statusHeaders['content-disposition'], /^attachment; filename="report _final_.pdf"$/)

  const missingHarness = createHarness(t, { overrides: { mediaResult: () => null } })
  const missing = await invoke(missingHarness.webServer, path, { url: `${path}${query}` })
  assert.equal(missing.status, 404)
  assert.equal(bodyJson(missing.res).code, 'not-found')

  const badChat = await invoke(harness.webServer, path, { url: `${path}?chat=nope&id=msg-1` })
  assert.equal(badChat.status, 400)
  const badId = await invoke(harness.webServer, path, { url: `${path}?chat=${encodeURIComponent(JID)}&id=bad%2Fid` })
  assert.equal(badId.status, 400)
  // The media route asks the service scoped to the requested chat.
  assert.equal(harness.service._counters.getMedia.at(-1).chatId, JID)
})

test('GET /avatar serves image bytes and 404s when unavailable', async (t) => {
  const harness = createHarness(t)
  const path = `${API_PREFIX}/avatar`
  const ok = await invoke(harness.webServer, path, { url: `${path}?jid=${encodeURIComponent(JID)}` })
  assert.equal(ok.status, 200)
  assert.equal(ok.res.statusHeaders['content-type'], 'image/png')
  assert.equal(ok.res.statusHeaders['content-disposition'], undefined)

  const missingHarness = createHarness(t, { overrides: { avatarResult: () => null } })
  const missing = await invoke(missingHarness.webServer, path, { url: `${path}?jid=${encodeURIComponent(JID)}` })
  assert.equal(missing.status, 404)
  const emptyHarness = createHarness(t, { overrides: { avatarResult: () => ({ buffer: Buffer.alloc(0), mimetype: 'image/png' }) } })
  const empty = await invoke(emptyHarness.webServer, path, { url: `${path}?jid=${encodeURIComponent(JID)}` })
  assert.equal(empty.status, 404)
  const bad = await invoke(harness.webServer, path, { url: `${path}?jid=nope` })
  assert.equal(bad.status, 400)
})

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

test('GET /events streams the initial state, forwards events and unsubscribes on close', async (t) => {
  const harness = createHarness(t)
  const route = harness.webServer.find(`${API_PREFIX}/events`)
  const req = createReq({ method: 'GET', url: `${API_PREFIX}/events` })
  const res = createRes()

  await route.handler(req, res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.statusHeaders['content-type'], 'text/event-stream; charset=utf-8')
  assert.equal(res.statusHeaders['cache-control'], 'no-store')
  assert.equal(res.statusHeaders['x-content-type-options'], 'nosniff')
  assert.equal(res.statusHeaders.connection, 'keep-alive')
  // Initial frame is exactly `event: state` + the state snapshot.
  const frames = res.body.split('\n\n').filter((frame) => frame !== '')
  assert.ok(frames[0].startsWith('event: state\ndata: '))
  const initial = JSON.parse(frames[0].slice('event: state\ndata: '.length))
  assert.equal(initial.type, 'state')
  assert.equal(initial.state.connection, 'online')
  assert.equal(harness.service._listeners.length, 1)

  // A service event becomes an SSE frame.
  harness.service._listeners[0]({ type: 'chats' })
  assert.ok(res.body.includes('event: chats\ndata: {"type":"chats"}'))
  harness.service._listeners[0]({ type: 'message', chatId: JID, message: { id: 'm1' } })
  assert.ok(res.body.includes('event: message\ndata: {"type":"message"'))

  // Closing the request cleans up the subscription and ends the stream.
  req.emit('close')
  assert.equal(harness.service._counters.unsubscribed, 1)
  assert.equal(res.writableEnded, true)
  // Cleanup is idempotent (close fires once more from res.end()).
  req.emit('close')
  assert.equal(harness.service._counters.unsubscribed, 1)
  assert.equal(SSE_HEARTBEAT_MS, 20_000)
})

test('a route disposer closes live SSE streams', async (t) => {
  const harness = createHarness(t)
  const route = harness.webServer.find(`${API_PREFIX}/events`)
  const req = createReq({ method: 'GET', url: `${API_PREFIX}/events` })
  const res = createRes()
  await route.handler(req, res)
  assert.equal(harness.service._listeners.length, 1)

  // The last registered disposer is the SSE cleanup.
  harness.disposers.at(-1)()
  assert.equal(harness.service._counters.unsubscribed, 1)
  assert.equal(res.writableEnded, true)
})

// ---------------------------------------------------------------------------
// Errors / methods
// ---------------------------------------------------------------------------

test('wrong method yields 405 with an Allow header', async (t) => {
  const harness = createHarness(t)
  const route = harness.webServer.find(`${API_PREFIX}/state`)
  const req = createReq({ method: 'POST', url: `${API_PREFIX}/state` })
  const res = createRes()
  await route.handler(req, res)
  assert.equal(res.statusCode, 405)
  assert.equal(res.statusHeaders.allow, 'GET')
  assert.equal(bodyJson(res).code, 'method-not-allowed')
})

test('service errors map onto stable HTTP status codes', async (t) => {
  const badText = createHarness(t, {
    overrides: { sendText: async () => { throw Object.assign(new Error('text is bad'), { code: 'bad-text' }) } },
  })
  const bad = await invoke(badText.webServer, `${API_PREFIX}/send`, { method: 'POST', json: { chat: JID, text: 'x' } })
  assert.equal(bad.status, 400)
  assert.equal(bodyJson(bad.res).code, 'bad-text')

  const offline = createHarness(t, {
    overrides: { sendText: async () => { throw Object.assign(new Error('not connected'), { code: 'offline' }) } },
  })
  const off = await invoke(offline.webServer, `${API_PREFIX}/send`, { method: 'POST', json: { chat: JID, text: 'x' } })
  assert.equal(off.status, 409)
  assert.equal(bodyJson(off.res).code, 'offline')

  const unknown = createHarness(t, {
    overrides: { sendText: async () => { throw new Error('unexpected internal detail') } },
  })
  const internal = await invoke(unknown.webServer, `${API_PREFIX}/send`, { method: 'POST', json: { chat: JID, text: 'x' } })
  assert.equal(internal.status, 500)
  assert.equal(bodyJson(internal.res).code, 'internal')
  // A 500 must not leak the internal message.
  assert.equal(internal.res.body.includes('unexpected internal detail'), false)
})

test('a service without a state() function reports 503 unavailable', async (t) => {
  const webServer = createFakeWebServer()
  const brokenService = { listChats: () => [] }
  const disposers = registerRoutes({ service: brokenService, admit: () => true, webServer, logger: silentLogger })
  t.after(() => disposers.forEach((dispose) => dispose()))
  const route = webServer.find(`${API_PREFIX}/state`)
  const req = createReq({ method: 'GET', url: `${API_PREFIX}/state` })
  const res = createRes()
  await route.handler(req, res)
  assert.equal(res.statusCode, 503)
  assert.equal(bodyJson(res).code, 'unavailable')
})
