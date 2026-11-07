/**
 * lib/whatsapp-client.js — reconnect policy, pure helpers, and the connection
 * state machine. No socket and no real timer: `dependencies` is a fake
 * makeWASocket/qrcode/timer seam, exactly the one the module documents.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CONNECTION_ACTIONS,
  WhatsAppClient,
  WhatsAppClientError,
  buildMediaContent,
  classifyDisconnect,
  classifyOutgoingMedia,
  disconnectCode,
  disconnectReasonName,
  mapSocketUser,
  reconnectDelay,
  renderQrDataUrl,
} from '../lib/whatsapp-client.js'
import { RECONNECT_BASE_MS, RECONNECT_MAX_ATTEMPTS, RECONNECT_MAX_MS } from '../lib/config.js'

const JID = '15551234567@s.whatsapp.net'
const GROUP = '120363000000000001@g.us'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, child() { return silentLogger } }

async function flush(turns = 6) {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('disconnectCode reads Boom, statusCode, payload and error codes', () => {
  assert.equal(disconnectCode({ output: { statusCode: 401 } }), 401)
  assert.equal(disconnectCode({ statusCode: 428 }), 428)
  assert.equal(disconnectCode({ output: { payload: { statusCode: 440 } } }), 440)
  assert.equal(disconnectCode({ data: { statusCode: 515 } }), 515)
  assert.equal(disconnectCode({ code: 500 }), 500)
  assert.equal(disconnectCode({ code: 'ECONNRESET' }), null)
  assert.equal(disconnectCode(null), null)
  assert.equal(disconnectCode(new Error('boom')), null)
})

test('classifyDisconnect maps every terminal reason to an action', () => {
  const error = (statusCode) => ({ output: { statusCode } })
  for (const code of [401, 403, 411, 419, 500]) {
    assert.equal(classifyDisconnect(error(code)), CONNECTION_ACTIONS.RELINK, `status ${code}`)
  }
  assert.equal(classifyDisconnect(error(440)), CONNECTION_ACTIONS.STOP)
  assert.equal(classifyDisconnect(error(515)), CONNECTION_ACTIONS.RESTART)
  for (const code of [408, 428, 503, 999]) {
    assert.equal(classifyDisconnect(error(code)), CONNECTION_ACTIONS.RECONNECT, `status ${code}`)
  }
  // Unknown / missing errors are transient, not a relink.
  assert.equal(classifyDisconnect(null), CONNECTION_ACTIONS.RECONNECT)
  assert.equal(classifyDisconnect(new Error('socket hang up')), CONNECTION_ACTIONS.RECONNECT)
})

test('disconnectReasonName gives stable codes for state.lastError', () => {
  assert.equal(disconnectReasonName(401), 'logged-out')
  assert.equal(disconnectReasonName(403), 'forbidden')
  assert.equal(disconnectReasonName(408), 'connection-lost')
  assert.equal(disconnectReasonName(411), 'multidevice-mismatch')
  assert.equal(disconnectReasonName(440), 'connection-replaced')
  assert.equal(disconnectReasonName(500), 'session-invalid')
  assert.equal(disconnectReasonName(515), 'restart-required')
  assert.equal(disconnectReasonName(418), 'disconnect-418')
  assert.equal(disconnectReasonName(undefined), 'connection-closed')
})

test('reconnectDelay is exponential, jittered +/-20% and capped', () => {
  // attempt 1: 1000ms base
  assert.equal(reconnectDelay(1, () => 0), Math.round(RECONNECT_BASE_MS * 0.8))
  assert.equal(reconnectDelay(1, () => 0.5), RECONNECT_BASE_MS)
  assert.equal(reconnectDelay(1, () => 1), Math.round(RECONNECT_BASE_MS * 1.2))
  // attempt 2: 2000ms base
  assert.equal(reconnectDelay(2, () => 0.5), 2000)
  assert.equal(reconnectDelay(3, () => 0.5), 4000)
  // clamped to the max base
  assert.equal(reconnectDelay(20, () => 0.5), RECONNECT_MAX_MS)
  assert.equal(reconnectDelay(20, () => 0), Math.round(RECONNECT_MAX_MS * 0.8))
  assert.equal(reconnectDelay(20, () => 1), Math.round(RECONNECT_MAX_MS * 1.2))
  // defensible inputs
  assert.equal(reconnectDelay(0, () => 0.5), RECONNECT_BASE_MS)
  assert.equal(reconnectDelay(-3, () => 0.5), RECONNECT_BASE_MS)
  assert.equal(reconnectDelay('2', () => 0.5), 2000)
  assert.equal(reconnectDelay(1, () => Number.NaN), RECONNECT_BASE_MS)
  assert.equal(reconnectDelay(1, () => -10), Math.round(RECONNECT_BASE_MS * 0.8))
})

test('classifyOutgoingMedia classifies by mimetype essence', () => {
  assert.equal(classifyOutgoingMedia('image/png'), 'image')
  assert.equal(classifyOutgoingMedia('image/jpeg; charset=binary'), 'image')
  assert.equal(classifyOutgoingMedia('video/mp4'), 'video')
  assert.equal(classifyOutgoingMedia('audio/ogg; codecs=opus'), 'audio')
  assert.equal(classifyOutgoingMedia('application/pdf'), 'document')
  assert.equal(classifyOutgoingMedia('text/plain'), 'document')
  assert.equal(classifyOutgoingMedia(null), 'document')
})

test('buildMediaContent validates the upload and shapes Baileys send content', () => {
  assert.throws(() => buildMediaContent({ buffer: Buffer.alloc(0) }), (error) => {
    assert.equal(error.code, 'bad-media')
    return true
  })
  assert.throws(() => buildMediaContent({ buffer: 'not a buffer' }), (error) => error.code === 'bad-media')

  const image = buildMediaContent({ buffer: Buffer.from([1]), mimetype: 'image/png', caption: ' hi ' })
  assert.deepEqual(Object.keys(image), ['image', 'mimetype', 'caption'])
  assert.equal(image.mimetype, 'image/png')
  assert.equal(image.caption, ' hi ')

  const audio = buildMediaContent({ buffer: Buffer.from([1]), mimetype: 'audio/ogg' })
  assert.equal(audio.ptt, false)
  assert.equal(audio.caption, undefined)

  const doc = buildMediaContent({ buffer: Buffer.from([1]), mimetype: 'application/pdf' })
  assert.equal(doc.fileName, 'file')
  assert.equal(doc.mimetype, 'application/pdf')

  const video = buildMediaContent({ buffer: Buffer.from([1]), mimetype: 'video/mp4' })
  assert.ok(Buffer.isBuffer(video.video))
})

test('renderQrDataUrl validates the payload and renderer output', async () => {
  await assert.rejects(renderQrDataUrl('', { toDataURL: async () => 'x' }), (error) => error.code === 'bad-qr')
  await assert.rejects(renderQrDataUrl('qr-data', {}), (error) => error.code === 'bad-qr')
  await assert.rejects(
    renderQrDataUrl('qr-data', { toDataURL: async () => 'https://not-a-data-url' }),
    (error) => error.code === 'bad-qr',
  )
  const dataUrl = await renderQrDataUrl('qr-data', { toDataURL: async () => 'data:image/png;base64,AAAA' })
  assert.equal(dataUrl, 'data:image/png;base64,AAAA')
})

test('mapSocketUser maps Baileys user to the CONTRACT me shape', () => {
  assert.deepEqual(mapSocketUser({ id: '15551234567:4@s.whatsapp.net', name: ' Me ' }), {
    id: JID,
    name: 'Me',
    phone: '15551234567',
  })
  assert.deepEqual(mapSocketUser({ jid: JID, verifiedName: 'Verified' }), {
    id: JID,
    name: 'Verified',
    phone: '15551234567',
  })
  // No usable name -> phone fallback.
  assert.equal(mapSocketUser({ id: JID }).name, '+15551234567')
  assert.equal(mapSocketUser(null), null)
  assert.equal(mapSocketUser({ id: '' }), null)
})

// ---------------------------------------------------------------------------
// Fakes for the state machine
// ---------------------------------------------------------------------------

function createFakeTimers() {
  let nextId = 1
  const handles = []
  return {
    handles,
    setTimeout(fn, delay) {
      const handle = { id: nextId++, fn, delay, cleared: false }
      handles.push(handle)
      return handle
    },
    clearTimeout(handle) {
      if (handle && typeof handle === 'object') handle.cleared = true
    },
    active() {
      return handles.filter((handle) => handle.cleared === false)
    },
    pending() {
      const active = this.active()
      return active[active.length - 1] ?? null
    },
    async runPending() {
      const handle = this.pending()
      assert.ok(handle, 'expected a scheduled timer')
      handle.cleared = true
      handle.fn()
      await flush()
      return handle
    },
  }
}

function createFakeSocket() {
  const handlers = new Map()
  const sock = {
    ev: {
      on(name, handler) {
        const list = handlers.get(name) ?? []
        list.push(handler)
        handlers.set(name, list)
      },
      off(name, handler) {
        const list = handlers.get(name) ?? []
        handlers.set(name, list.filter((item) => item !== handler))
      },
    },
    user: { id: '15551234567:1@s.whatsapp.net', name: 'Tester' },
    sent: [],
    read: null,
    presence: null,
    rejected: null,
    loggedOut: false,
    ended: false,
    emit(name, payload) {
      for (const handler of [...(handlers.get(name) ?? [])]) handler(payload)
    },
    async sendMessage(jid, content, options) {
      this.sent.push({ jid, content, options })
      return { key: { id: 'sent-1', remoteJid: jid } }
    },
    async readMessages(keys) { this.read = keys },
    async sendPresenceUpdate(presence, jid) { this.presence = { presence, jid } },
    async rejectCall(id, from) { this.rejected = { id, from } },
    async logout() { this.loggedOut = true },
    end() { this.ended = true },
  }
  return sock
}

function createFakeAuth({ linked = true } = {}) {
  return {
    linked,
    state: {},
    loads: 0,
    saves: 0,
    wipes: 0,
    async load() { this.loads += 1; return this.linked },
    async saveCreds() { this.saves += 1 },
    async wipe() { this.wipes += 1; this.linked = false },
  }
}

function createHarness(t, { linked = true, random = () => 0.5, now = () => 1_700_000_000_000 } = {}) {
  const timers = createFakeTimers()
  const sockets = []
  const events = { state: [], errors: [], unlinked: [], open: [], qr: [], close: [] }
  const auth = createFakeAuth({ linked })
  const client = new WhatsAppClient({
    auth,
    logger: silentLogger,
    dependencies: {
      makeWASocket: async () => {
        const sock = createFakeSocket()
        sockets.push(sock)
        return sock
      },
      qrcode: { toDataURL: async () => 'data:image/png;base64,QRQR' },
      now,
      random,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    },
    callbacks: {
      onState: (state) => events.state.push(state),
      onError: (error) => events.errors.push(error),
      onUnlinked: (info) => events.unlinked.push(info),
      onOpen: (info) => events.open.push(info),
      onQR: (qr) => events.qr.push(qr),
      onClose: (info) => events.close.push(info),
    },
  })
  t.after(async () => {
    await client.dispose()
  })
  return { client, auth, sockets, timers, events }
}

/** Open the first fake socket the way Baileys would. */
async function openFirstSocket(harness) {
  await harness.client.beginLink()
  assert.equal(harness.sockets.length, 1, 'beginLink must create one socket (not open a real one)')
  const sock = harness.sockets[0]
  sock.emit('connection.update', { connection: 'open' })
  await flush()
  return sock
}

async function emitClose(sock, statusCode) {
  sock.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode } } } })
  await flush()
}

// ---------------------------------------------------------------------------
// Lifecycle / state machine
// ---------------------------------------------------------------------------

test('start() stays idle without credentials and never opens a socket', async (t) => {
  const harness = createHarness(t, { linked: false })
  await harness.client.start()
  assert.equal(harness.sockets.length, 0)
  assert.equal(harness.client.state.connection, 'idle')
  assert.equal(harness.client.linked, false)
})

test('start() connects when credentials exist and open() publishes online state', async (t) => {
  const harness = createHarness(t, { linked: true })
  await harness.client.start()
  assert.equal(harness.sockets.length, 1)
  const sock = harness.sockets[0]
  sock.emit('connection.update', { connection: 'open' })
  await flush()

  const state = harness.client.state
  assert.equal(state.connection, 'online')
  assert.equal(state.linked, true)
  assert.equal(state.me.id, JID)
  assert.equal(state.me.phone, '15551234567')
  assert.equal(state.lastConnectedAt, 1_700_000_000_000)
  assert.equal(state.needsRelink, false)
  assert.equal(harness.auth.saves, 1, 'opening must persist credentials')
  assert.equal(harness.events.open.length, 1)
})

test('a QR event publishes a PNG data URL and the qr state', async (t) => {
  const harness = createHarness(t, { linked: false })
  await harness.client.beginLink()
  const sock = harness.sockets[0]
  sock.emit('connection.update', { qr: '2@abc,def,ghi' })
  await flush()
  assert.equal(harness.client.state.connection, 'qr')
  assert.equal(harness.client.state.qr, 'data:image/png;base64,QRQR')
  assert.deepEqual(harness.events.qr, ['data:image/png;base64,QRQR'])
})

test('loggedOut (401) wipes credentials and requires a fresh link', async (t) => {
  const harness = createHarness(t)
  const sock = await openFirstSocket(harness)
  await emitClose(sock, 401)

  const state = harness.client.state
  assert.equal(state.connection, 'loggedOut')
  assert.equal(state.linked, false)
  assert.equal(state.needsRelink, true)
  assert.equal(state.qr, null)
  assert.equal(state.reconnectInMs, null)
  assert.equal(state.lastError.code, 'logged-out')
  assert.equal(harness.auth.wipes, 1, 'an expired session must wipe the sealed credentials')
  assert.equal(harness.timers.active().length, 0, 'a logged-out session must not retry')
  assert.equal(harness.events.unlinked.length, 1)
  assert.equal(harness.events.unlinked[0].code, 'logged-out')
})

test('forbidden (403) also relinks and wipes', async (t) => {
  const harness = createHarness(t)
  const sock = await openFirstSocket(harness)
  await emitClose(sock, 403)
  assert.equal(harness.client.state.connection, 'loggedOut')
  assert.equal(harness.client.state.needsRelink, true)
  assert.equal(harness.auth.wipes, 1)
})

test('connectionReplaced (440) stops instead of retrying', async (t) => {
  const harness = createHarness(t)
  const sock = await openFirstSocket(harness)
  await emitClose(sock, 440)

  const state = harness.client.state
  assert.equal(state.connection, 'offline')
  assert.equal(state.reconnectInMs, null)
  assert.equal(state.lastError.code, 'connection-replaced')
  assert.equal(harness.timers.active().length, 0, 'a replaced session must not fight the other device')
  assert.equal(harness.auth.wipes, 0)
  assert.equal(harness.events.errors.length, 1)
})

test('restartRequired (515) reconnects immediately (bounded restarts)', async (t) => {
  const harness = createHarness(t)
  let sock = await openFirstSocket(harness)

  for (let restart = 1; restart <= 3; restart += 1) {
    await emitClose(sock, 515)
    assert.equal(harness.client.state.connection, 'offline')
    assert.equal(harness.client.state.reconnectInMs, 0, `restart ${restart} should be immediate`)
    assert.equal(harness.client.state.reconnectAttempt, 0)
    await harness.timers.runPending()
    assert.equal(harness.sockets.length, restart + 1)
    sock = harness.sockets[restart]
  }

  // The fourth 515 falls back into normal retry/backoff instead of looping forever.
  await emitClose(sock, 515)
  assert.equal(harness.client.state.reconnectAttempt, 1)
  assert.equal(harness.client.state.reconnectInMs, RECONNECT_BASE_MS)
})

test('connectionClosed (428) retries with exponential backoff and max attempts', async (t) => {
  const harness = createHarness(t, { random: () => 0.5 })
  let sock = await openFirstSocket(harness)

  const delays = []
  for (let attempt = 1; attempt <= RECONNECT_MAX_ATTEMPTS; attempt += 1) {
    await emitClose(sock, 428)
    assert.equal(harness.client.state.connection, 'offline')
    assert.equal(harness.client.state.reconnectAttempt, attempt)
    const expected = attempt === 1 ? RECONNECT_BASE_MS : Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (attempt - 1))
    assert.ok(harness.client.state.reconnectInMs <= expected * 1.2, `attempt ${attempt} delay ${harness.client.state.reconnectInMs}`)
    assert.ok(harness.client.state.reconnectInMs >= expected * 0.8, `attempt ${attempt} delay ${harness.client.state.reconnectInMs}`)
    delays.push(harness.client.state.reconnectInMs)

    await harness.timers.runPending()
    assert.equal(harness.sockets.length, attempt + 1, `attempt ${attempt} should open a new socket`)
    sock = harness.sockets[attempt]
  }
  // Backoff is non-decreasing and ends near the cap.
  for (let i = 1; i < delays.length; i += 1) assert.ok(delays[i] >= delays[i - 1], `delay ${i} regressed`)
  assert.equal(delays.at(-1), RECONNECT_MAX_MS)

  // One more failure exceeds the cap: give up with an error state, no timer.
  await emitClose(sock, 428)
  assert.equal(harness.client.state.connection, 'error')
  assert.equal(harness.client.state.reconnectAttempt, RECONNECT_MAX_ATTEMPTS + 1)
  assert.equal(harness.client.state.lastError.code, 'reconnect-failed')
  assert.equal(harness.timers.active().length, 0)
})

test('an unknown close error is transient and keeps the state honest', async (t) => {
  const harness = createHarness(t)
  const sock = await openFirstSocket(harness)
  sock.emit('connection.update', { connection: 'close', lastDisconnect: { error: new Error('socket hang up') } })
  await flush()
  assert.equal(harness.client.state.connection, 'offline')
  assert.equal(harness.client.state.lastError.code, 'connection-lost')
  assert.equal(harness.client.state.reconnectAttempt, 1)
  assert.ok(harness.client.state.reconnectInMs > 0)
})

test('dispose() cancels a scheduled reconnect and ignores later events', async (t) => {
  const harness = createHarness(t)
  const sock = await openFirstSocket(harness)
  await emitClose(sock, 428)
  const timer = harness.timers.pending()
  assert.ok(timer)

  await harness.client.dispose()
  assert.equal(timer.cleared, true, 'dispose must cancel the reconnect timer')
  // The socket closed before dispose, so dispose cannot end it again; a live
  // socket teardown is covered by the next test.
  assert.equal(sock.ended, false)
  assert.equal(harness.client.state.connection, 'offline')
  // Events arriving after dispose are ignored instead of resurrecting the socket.
  sock.emit('connection.update', { connection: 'open' })
  await flush()
  assert.equal(harness.client.state.connection, 'offline')
  // dispose is idempotent.
  await harness.client.dispose()
})

test('dispose() while online ends the live socket', async (t) => {
  const harness = createHarness(t)
  const sock = await openFirstSocket(harness)
  assert.equal(harness.client.state.connection, 'online')
  await harness.client.dispose()
  assert.equal(sock.ended, true, 'dispose must end a live socket')
  // dispose keeps the last published state, which is fine: the service is going
  // away and the socket is definitely gone.
})

test('logout() ends the socket and wipes credentials', async (t) => {
  const harness = createHarness(t)
  const sock = await openFirstSocket(harness)
  await harness.client.logout()
  assert.equal(sock.loggedOut, true)
  assert.equal(sock.ended, true)
  assert.equal(harness.auth.wipes, 1)
  assert.equal(harness.client.state.connection, 'idle')
  assert.equal(harness.client.state.linked, false)
  assert.equal(harness.client.state.qr, null)
})

test('cancelLink() wipes a half-open pairing', async (t) => {
  const harness = createHarness(t, { linked: false })
  await harness.client.beginLink()
  assert.equal(harness.sockets.length, 1)
  await harness.client.cancelLink()
  assert.equal(harness.auth.wipes, 1)
  assert.equal(harness.client.state.connection, 'idle')
  assert.equal(harness.client.state.linked, false)
})

test('relink() wipes then opens a fresh linking socket', async (t) => {
  const harness = createHarness(t)
  await harness.client.relink()
  assert.equal(harness.auth.wipes, 1)
  assert.equal(harness.sockets.length, 1)
  assert.equal(harness.client.state.connection, 'connecting')
})

// ---------------------------------------------------------------------------
// Sending (guarded by online state)
// ---------------------------------------------------------------------------

test('sending is rejected while offline and accepted when online', async (t) => {
  const harness = createHarness(t)
  await harness.client.start()
  await assert.rejects(harness.client.sendText(JID, 'hi'), (error) => error.code === 'offline')
  await assert.rejects(harness.client.sendMedia(JID, { buffer: Buffer.from([1]) }), (error) => error.code === 'offline')

  const sock = harness.sockets[0]
  sock.emit('connection.update', { connection: 'open' })
  await flush()
  const result = await harness.client.sendText(JID, 'hi')
  assert.equal(result.key.id, 'sent-1')
  assert.deepEqual(sock.sent[0], { jid: JID, content: { text: 'hi', linkPreview: null }, options: {} })

  // Quoted send passes Baileys the quoted WAMessage.
  await harness.client.sendText(JID, 'reply', { key: { id: 'orig' } })
  assert.deepEqual(sock.sent[1].options, { quoted: { key: { id: 'orig' } } })

  await harness.client.sendRead(JID, ['a', 'b', ''])
  assert.deepEqual(sock.read, [
    { remoteJid: JID, id: 'a', fromMe: false },
    { remoteJid: JID, id: 'b', fromMe: false },
  ])
  await harness.client.sendTyping(JID, true)
  assert.deepEqual(sock.presence, { presence: 'composing', jid: JID })
  await harness.client.rejectCall('call-1', '15550000001:2@s.whatsapp.net')
  assert.deepEqual(sock.rejected, { id: 'call-1', from: '15550000001@s.whatsapp.net' })
})

test('send validation: chat id, empty text, empty media, call arguments', async (t) => {
  const harness = createHarness(t)
  const sock = await openFirstSocket(harness)

  await assert.rejects(harness.client.sendText('not-a-jid', 'hi'), (error) => error.code === 'bad-chat')
  await assert.rejects(harness.client.sendText(JID, '   '), (error) => error.code === 'bad-text')
  await assert.rejects(harness.client.sendText(JID, 'x'.repeat(70000)), (error) => error.code === 'text-too-long')
  await assert.rejects(harness.client.sendMedia(JID, { buffer: Buffer.alloc(0) }), (error) => error.code === 'bad-media')
  await assert.rejects(harness.client.rejectCall('', JID), (error) => error.code === 'bad-call')
  await assert.rejects(harness.client.rejectCall('id', 'nope'), (error) => error.code === 'bad-call')
  await assert.rejects(harness.client.sendText(GROUP, ''), (error) => error.code === 'bad-text')
  assert.equal(sock.sent.length, 0)
})

test('a socket without rejectCall reports calls as unsupported', async (t) => {
  const harness = createHarness(t)
  const sock = await openFirstSocket(harness)
  sock.rejectCall = undefined
  await assert.rejects(harness.client.rejectCall('call-1', JID), (error) => error.code === 'calls-unsupported')
})

test('sendMedia classifies the upload and passes the media content', async (t) => {
  const harness = createHarness(t)
  const sock = await openFirstSocket(harness)
  await harness.client.sendMedia(JID, { buffer: Buffer.from([1, 2]), mimetype: 'image/png', caption: 'cap' })
  assert.equal(sock.sent[0].content.image.length, 2)
  assert.equal(sock.sent[0].content.mimetype, 'image/png')
  assert.equal(sock.sent[0].content.caption, 'cap')
  assert.ok(sock.sent[0].content.image instanceof Buffer || sock.sent[0].content.image.length === 2)
})

test('a makeWASocket failure schedules a retry instead of throwing', async (t) => {
  const timers = createFakeTimers()
  const auth = createFakeAuth({ linked: true })
  const errors = []
  const states = []
  let attempts = 0
  const client = new WhatsAppClient({
    auth,
    logger: silentLogger,
    dependencies: {
      makeWASocket: async () => {
        attempts += 1
        throw new Error('cannot connect')
      },
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      random: () => 0.5,
    },
    callbacks: { onError: (error) => errors.push(error), onState: (state) => states.push(state) },
  })
  t.after(async () => client.dispose())

  await client.start()
  await flush()
  assert.equal(attempts, 1)
  assert.equal(client.state.connection, 'offline')
  assert.equal(client.state.reconnectInMs, RECONNECT_BASE_MS)
  // The connect error is reported once as connect-failed and once through the
  // reconnect scheduler (which calls a code-less failure connection-lost).
  assert.equal(errors[0].code, 'connect-failed')
  assert.equal(errors.at(-1).code, 'connection-lost')
  assert.equal(states.at(-1).connection, 'offline')
})
