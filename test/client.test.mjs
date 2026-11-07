/**
 * client.js — the browser bundle, mounted the way the host mounts it.
 *
 * Uses `dsh-plugin-toolkit/testkit` (jsdom + real React), a stubbed global
 * fetch and a fake global EventSource: no HTTP request, no real SSE stream.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { loadBundle, mountClient } from 'dsh-plugin-toolkit/testkit'

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_FILE = path.join(PLUGIN_DIR, 'client.js')
const requireFromPlugin = createRequire(path.join(PLUGIN_DIR, 'noop.js'))

const JID = '15551234567@s.whatsapp.net'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function baseState(overrides = {}) {
  return {
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
    messageCount: 1,
    chatCount: 1,
    storage: 'encrypted',
    ...overrides,
  }
}

function chatSummary(overrides = {}) {
  return {
    id: JID,
    name: 'Bob',
    isGroup: false,
    unread: 2,
    pinned: false,
    muted: false,
    archived: false,
    timestamp: 1_700_000_000_000,
    lastMessage: { id: 'm1', text: 'hello', fromMe: false, timestamp: 1_700_000_000_000, kind: 'text' },
    ...overrides,
  }
}

function messageFixture(overrides = {}) {
  return {
    id: 'm1',
    chatId: JID,
    fromMe: false,
    author: null,
    authorName: null,
    timestamp: 1_700_000_000_000,
    kind: 'text',
    text: 'hello from Bob',
    quoted: null,
    media: null,
    thumbnail: null,
    location: null,
    contact: null,
    status: 'read',
    revoked: false,
    edited: false,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// fetch / EventSource fakes
// ---------------------------------------------------------------------------

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => data,
    text: async () => JSON.stringify(data),
  }
}

function createFetchStub(routes = {}) {
  const calls = []
  const stub = async (input, init = {}) => {
    const url = new URL(String(input), 'http://localhost')
    const method = String(init.method || 'GET').toUpperCase()
    const path = url.pathname
    calls.push({
      method,
      path,
      url: String(input),
      query: Object.fromEntries(url.searchParams),
      body: init.body,
      headers: init.headers || {},
    })
    const handler = routes[`${method} ${path}`] ?? routes[`${method} *`] ?? routes['*']
    if (handler === undefined) return jsonResponse({ error: 'Not found' }, 404)
    const produced = await (typeof handler === 'function' ? handler(url, init) : handler)
    // Handlers may hand back a full Response-shaped object, or just JSON data.
    if (produced && typeof produced === 'object' && typeof produced.status === 'number' && typeof produced.json === 'function') {
      return produced
    }
    return jsonResponse(produced)
  }
  stub.calls = calls
  return stub
}

class FakeEventSource {
  static instances = []
  constructor(url) {
    this.url = String(url)
    this.listeners = new Map()
    this.closed = false
    FakeEventSource.instances.push(this)
  }
  addEventListener(name, handler) {
    const list = this.listeners.get(name) ?? []
    list.push(handler)
    this.listeners.set(name, list)
  }
  removeEventListener(name, handler) {
    const list = this.listeners.get(name) ?? []
    this.listeners.set(name, list.filter((item) => item !== handler))
  }
  close() { this.closed = true }
  emit(name, payload) {
    const event = { data: payload === undefined ? '' : JSON.stringify(payload) }
    for (const handler of [...(this.listeners.get(name) ?? [])]) handler(event)
  }
}

let previousEventSource

function installEventSource() {
  previousEventSource = globalThis.EventSource
  globalThis.EventSource = FakeEventSource
  FakeEventSource.instances = []
}

function restoreEventSource() {
  if (previousEventSource === undefined) delete globalThis.EventSource
  else globalThis.EventSource = previousEventSource
}

// ---------------------------------------------------------------------------
// Mount helpers
// ---------------------------------------------------------------------------

const quiet = () => new Promise((resolve) => setTimeout(resolve, 5))

async function settle(app) {
  const act = app.react.act ?? ((run) => run())
  await act(async () => {
    await quiet()
  })
}

async function waitUntil(app, predicate, timeoutMs = 1500) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if ((await predicate()) === true) return
    await settle(app)
  }
  throw new Error('timed out waiting for a condition')
}

async function waitFor(app, selector, predicate = () => true, timeoutMs = 1500) {
  const start = Date.now()
  let last = null
  while (Date.now() - start < timeoutMs) {
    last = app.query(selector)
    if (last !== null && predicate(last) === true) return last
    await settle(app)
  }
  throw new Error(`timed out waiting for ${selector}\n${app.html().slice(-1500)}`)
}

async function mountApp(t, {
  state = baseState(),
  chats = [],
  messages = { messages: [], hasMore: false },
  extraRoutes = {},
  chatResponses = {},
} = {}) {
  installEventSource()
  const stub = createFetchStub({
    'GET /dsh-whatsapp/api/state': state,
    'GET /dsh-whatsapp/api/chats': { chats },
    'GET /dsh-whatsapp/api/messages': (url) => chatResponses[url.searchParams.get('chat')] ?? messages,
    'POST /dsh-whatsapp/api/send': (url, init) => {
      const body = JSON.parse(init.body)
      return jsonResponse({
        message: messageFixture({
          id: 'srv-1',
          chatId: body.chat,
          fromMe: true,
          text: body.text,
          status: 'sent',
          timestamp: 1_700_000_002_000,
        }),
      })
    },
    'POST /dsh-whatsapp/api/typing': { ok: true },
    'POST /dsh-whatsapp/api/read': { ok: true },
    'POST /dsh-whatsapp/api/link/start': { ok: true },
    'POST /dsh-whatsapp/api/link/cancel': { ok: true },
    'POST /dsh-whatsapp/api/link/relink': { ok: true },
    'POST /dsh-whatsapp/api/reconnect': { ok: true },
    'POST /dsh-whatsapp/api/call/reject': { ok: true },
    ...extraRoutes,
  })

  let mounted
  try {
    mounted = await mountClient({
      file: CLIENT_FILE,
      slot: 'main',
      resolveFrom: PLUGIN_DIR,
      copy: {},
      fetch: stub,
    })
  } catch (error) {
    restoreEventSource()
    throw error
  }
  t.after(async () => {
    try {
      await mounted.unmount()
    } finally {
      restoreEventSource()
    }
  })
  const act = mounted.react.act ?? ((run) => run())
  const app = {
    ...mounted,
    calls: stub.calls,
    stub,
    source: FakeEventSource.instances.at(-1) ?? null,
    sources: FakeEventSource.instances,
    act,
  }
  await waitFor(app, '[data-testid="whatsapp-root"]')
  return app
}

async function typeInto(app, selector, value) {
  const element = app.must(selector)
  const window = app.window
  const prototype = element.tagName.toLowerCase() === 'textarea'
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  await app.act(async () => {
    setter.call(element, value)
    element.dispatchEvent(new window.Event('input', { bubbles: true }))
    await quiet()
  })
  return element
}

async function emitSource(app, name, payload) {
  assert.ok(app.source, 'the app should have opened an EventSource for /events')
  await app.act(async () => {
    app.source.emit(name, payload)
    await quiet()
  })
}

async function openFirstChat(app) {
  await waitFor(app, '[data-testid="chat-row"]')
  await app.click('[data-testid="chat-row"]')
  return waitFor(app, '[data-testid="thread-title"]')
}

// ---------------------------------------------------------------------------
// Bundle contract
// ---------------------------------------------------------------------------

test('the bundle exports apply + inject and apply never throws on an empty context', () => {
  const window = {}
  const exported = loadBundle(CLIENT_FILE, {
    require: (name) => requireFromPlugin(name),
    window,
  })
  assert.equal(typeof exported.apply, 'function')
  assert.ok(Array.isArray(exported.inject), 'exports.inject must be an array')
  assert.ok(exported.inject.includes('slots'))
  // The DSH client loader treats a function default export as the plugin entry
  // point. A default here meant apply() was never called and the sidebar row
  // sat at "loading" forever.
  assert.equal(Object.prototype.hasOwnProperty.call(exported, 'default'), false,
    'client.js must not export a default; the loader would use it instead of apply()')
  assert.equal(exported.name, 'dsh-whatsapp')

  for (const context of [{}, null, undefined, { logger: { warn() {} } }, {
    inject() { throw new Error('service missing') },
    logger: { warn() {} },
  }]) {
    assert.doesNotThrow(() => exported.apply(context), `apply(${JSON.stringify(context)}) threw`)
  }
})

test('apply registers the sidebar entry and the main panel, and binds locale', async (t) => {
  const app = await mountApp(t, { state: baseState(), chats: [chatSummary()] })

  const sidebar = app.host.slot('sidebar.panellist')
  const main = app.host.slot('main')
  assert.ok(sidebar, 'sidebar.panellist slot must be registered')
  assert.ok(main, 'main slot must be registered')
  assert.equal(sidebar.definition.id, 'dsh-whatsapp')
  assert.equal(sidebar.definition.order, 40)
  assert.equal(sidebar.definition.label, 'WhatsApp')
  assert.equal(typeof sidebar.component, 'function')
  assert.equal(main.definition.key, 'dsh-whatsapp')

  const locale = app.host.registrations.locales.find((entry) => entry.namespace === 'dsh-whatsapp')
  assert.ok(locale, 'the dsh-whatsapp locale dictionary must be registered')
  assert.equal(locale.languages?.en?.['entry.label'], 'WhatsApp')
  // The sidebar icon component is registered lazily through slots.inject.
  assert.ok(app.host.injected.some((names) => names.includes('slots')))
})

// ---------------------------------------------------------------------------
// Link screen
// ---------------------------------------------------------------------------

test('an unlinked client shows the QR link screen with instructions and risk notice', async (t) => {
  const qrData = 'data:image/png;base64,AAAA'
  const app = await mountApp(t, {
    state: baseState({ linked: false, connection: 'qr', qr: qrData, me: null }),
  })

  app.must('[data-testid="link-screen"]')
  const qr = app.must('[data-testid="qr-image"]')
  assert.equal(qr.getAttribute('src'), qrData)
  const risk = app.must('[data-testid="risk-notice"]')
  assert.match(risk.textContent, /not affiliated/i)
  assert.match(risk.textContent, /banned|limited/i)
  // Four-step linking instructions.
  const screenText = app.must('[data-testid="link-screen"]').textContent
  assert.match(screenText, /Linked devices/)
  assert.match(screenText, /Link a device/)

  await app.click('[data-testid="link-button"]')
  await waitFor(app, '[data-testid="toast"]')
  assert.ok(app.calls.some((call) => call.method === 'POST' && call.path.endsWith('/link/start')),
    `expected POST /link/start, got ${app.calls.map((call) => `${call.method} ${call.path}`).join(', ')}`)
})

test('a client needs re-linking shows the relink screen', async (t) => {
  const app = await mountApp(t, {
    state: baseState({ connection: 'loggedOut', linked: true, needsRelink: true }),
  })
  app.must('[data-testid="relink-screen"]')
  await app.click('[data-testid="relink-button"]')
  await waitFor(app, '[data-testid="toast"]')
  assert.ok(app.calls.some((call) => call.method === 'POST' && call.path.endsWith('/link/relink')))
})

// ---------------------------------------------------------------------------
// Chat list + thread
// ---------------------------------------------------------------------------

test('the chat list renders chats and clicking one opens the thread', async (t) => {
  const app = await mountApp(t, {
    state: baseState(),
    chats: [chatSummary()],
    messages: { messages: [messageFixture()], hasMore: false },
  })

  const rows = app.queryAll('[data-testid="chat-row"]')
  assert.equal(rows.length, 1)
  assert.match(rows[0].textContent, /Bob/)
  // The rail shows the unread badge.
  assert.match(app.must('[data-testid="chat-list"]').textContent, /2/)

  await app.click('[data-testid="chat-row"]')
  const title = await waitFor(app, '[data-testid="thread-title"]')
  assert.equal(title.textContent, 'Bob')
  const list = await waitFor(app, '[data-testid="message-list"]', (element) => element.textContent.includes('hello from Bob'))
  assert.match(list.textContent, /hello from Bob/)
  assert.ok(app.calls.some((call) => call.path.endsWith('/messages') && call.query.chat === JID))
  // The composer is available for the open chat.
  app.must('[data-testid="composer-input"]')
  app.must('[data-testid="send-button"]')
})

test('the composer sends POST /send on click and on Enter', async (t) => {
  const app = await mountApp(t, {
    state: baseState(),
    chats: [chatSummary()],
    messages: { messages: [messageFixture()], hasMore: false },
  })
  await openFirstChat(app)

  await typeInto(app, '[data-testid="composer-input"]', 'clicked hello')
  await app.click('[data-testid="send-button"]')
  await waitFor(app, '[data-testid="message-list"]', (element) => element.textContent.includes('clicked hello'))

  const firstSend = app.calls.find((call) => call.method === 'POST' && call.path.endsWith('/send'))
  assert.ok(firstSend, 'expected a POST /send')
  assert.deepEqual(JSON.parse(firstSend.body), { chat: JID, text: 'clicked hello' })

  await typeInto(app, '[data-testid="composer-input"]', 'enter hello')
  await app.press('[data-testid="composer-input"]', 'Enter')
  await waitFor(app, '[data-testid="message-list"]', (element) => element.textContent.includes('enter hello'))
  const sends = app.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/send'))
  assert.equal(sends.length, 2)
  assert.deepEqual(JSON.parse(sends[1].body), { chat: JID, text: 'enter hello' })
  // Cleaning up the composer after send means the input is empty again.
  assert.equal(app.must('[data-testid="composer-input"]').value, '')
})

test('settings opens from the rail and closes again', async (t) => {
  const app = await mountApp(t, { state: baseState(), chats: [chatSummary()] })
  await app.click('[data-testid="settings-button"]')
  const sheet = await waitFor(app, '[data-testid="settings-sheet"]')
  assert.match(sheet.textContent, /Me/)
  assert.match(sheet.textContent, /encrypted/i)
  app.must('[data-testid="storage-badge"]')
  app.must('[data-testid="settings-logout"]')
  app.must('[data-testid="settings-relink"]')
  await app.click('[data-testid="settings-close"]')
  await waitFor(app, '[data-testid="settings-sheet"]', () => false, 200).catch(() => {})
  assert.equal(app.query('[data-testid="settings-sheet"]'), null)
})

test('call buttons are disabled and explain why calls are unavailable', async (t) => {
  const app = await mountApp(t, {
    state: baseState(),
    chats: [chatSummary()],
    messages: { messages: [messageFixture()], hasMore: false },
  })
  await openFirstChat(app)

  for (const testid of ['call-voice', 'call-video']) {
    const button = app.must(`[data-testid="${testid}"]`)
    assert.equal(button.disabled, true, `${testid} must be disabled`)
    assert.equal(button.getAttribute('aria-disabled'), 'true')
  }
  assert.equal(app.query('[data-testid="calls-note"]'), null)
  await app.click('[data-testid="calls-info"]')
  const note = await waitFor(app, '[data-testid="calls-note"]')
  assert.match(note.textContent, /cannot carry call audio or video/i)
  assert.match(note.textContent, /not possible/i)
})

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

test('an offline connection shows the banner with working reconnect', async (t) => {
  const app = await mountApp(t, {
    state: baseState({
      connection: 'offline',
      reconnectInMs: 4000,
      reconnectAttempt: 2,
      lastError: { code: 'connection-lost', message: 'socket closed', at: 1_700_000_000_000 },
    }),
    chats: [],
  })
  const banner = await waitFor(app, '[data-testid="connection-banner"]')
  assert.match(banner.textContent, /offline/i)
  assert.match(banner.textContent, /Attempt 2/i)
  await app.click('[data-testid="reconnect-button"]')
  await waitFor(app, '[data-testid="toast"]')
  assert.ok(app.calls.some((call) => call.method === 'POST' && call.path.endsWith('/reconnect')))
})

test('an SSE state frame updates the screen without a refetch', async (t) => {
  const app = await mountApp(t, { state: baseState(), chats: [] })
  assert.ok(app.source)
  assert.match(app.source.url, /\/dsh-whatsapp\/api\/events$/)
  await waitFor(app, '[data-testid="welcome-pane"]')

  await emitSource(app, 'state', { type: 'state', state: baseState({ connection: 'offline', reconnectInMs: null }) })
  await waitFor(app, '[data-testid="connection-banner"]')
})

test('an incoming call frame shows the call banner and reject posts /call/reject', async (t) => {
  const app = await mountApp(t, { state: baseState(), chats: [chatSummary()] })
  await emitSource(app, 'call', {
    type: 'call',
    call: { id: 'call-1', from: JID, chatId: JID, isVideo: true, date: 1_700_000_000_000, status: 'offer' },
  })
  const banner = await waitFor(app, '[data-testid="incoming-call"]')
  assert.match(banner.textContent, /call/i)
  // Answering is impossible and must say so.
  const answer = app.must('[data-testid="answer-call"]')
  assert.equal(answer.disabled, true)
  assert.match(answer.getAttribute('title') ?? '', /not be answered|available/i)

  await app.click('[data-testid="reject-call"]')
  await waitUntil(app, () => app.calls.some((call) => call.method === 'POST' && call.path.endsWith('/call/reject')))
  const call = app.calls.find((entry) => entry.method === 'POST' && entry.path.endsWith('/call/reject'))
  assert.deepEqual(JSON.parse(call.body), { id: 'call-1', from: JID })
})

// ---------------------------------------------------------------------------
// Error states
// ---------------------------------------------------------------------------

test('a 401 from the API shows the not-authenticated screen instead of a blank page', async (t) => {
  installEventSource()
  const stub = createFetchStub({
    'GET /dsh-whatsapp/api/state': () => jsonResponse({ error: 'Unauthorized' }, 401),
  })
  let mounted
  try {
    mounted = await mountClient({
      file: CLIENT_FILE,
      slot: 'main',
      resolveFrom: PLUGIN_DIR,
      copy: {},
      fetch: stub,
    })
  } catch (error) {
    restoreEventSource()
    throw error
  }
  t.after(async () => {
    try { await mounted.unmount() } finally { restoreEventSource() }
  })
  const app = { ...mounted, calls: stub.calls, stub, act: mounted.react.act }
  const screen = await waitFor(app, '[data-testid="auth-error"]')
  assert.match(screen.textContent, /not signed in|401/i)
  app.must('[data-testid="auth-retry"]')
})

test('without EventSource the client falls back to polling', async (t) => {
  installEventSource()
  delete globalThis.EventSource
  const stub = createFetchStub({
    'GET /dsh-whatsapp/api/state': baseState(),
    'GET /dsh-whatsapp/api/chats': { chats: [] },
  })
  let mounted
  try {
    mounted = await mountClient({
      file: CLIENT_FILE,
      slot: 'main',
      resolveFrom: PLUGIN_DIR,
      copy: {},
      fetch: stub,
    })
  } catch (error) {
    restoreEventSource()
    throw error
  }
  t.after(async () => {
    try { await mounted.unmount() } finally { restoreEventSource() }
  })
  const app = { ...mounted, calls: stub.calls, stub, act: mounted.react.act, source: null, query: mounted.query, queryAll: mounted.queryAll, must: mounted.must, html: mounted.html }
  await waitFor(app, '[data-testid="whatsapp-root"]')
  await waitFor(app, '[data-testid="live-mode"]', (element) => element.textContent.includes('polling'))
  // No EventSource was constructed.
  assert.equal(FakeEventSource.instances.length, 0)
})
