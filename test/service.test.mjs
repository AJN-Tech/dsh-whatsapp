/**
 * lib/service.js — the host facade over the store, media cache and client.
 *
 * The Baileys client is constructed with fake dependencies (no socket, no
 * network); this test covers the CONTRACT facade behaviour that the routes test
 * necessarily fakes: state() shape, store queries, the encrypted-media chat
 * guard, subscribe/unsubscribe and dispose.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createWhatsAppService } from '../lib/service.js'
import { PHONE_OFFLINE_MODEL } from '../lib/config.js'

const JID = '15551234567@s.whatsapp.net'
const JID2 = '15559876543@s.whatsapp.net'
const GROUP = '120363000000000001@g.us'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, child() { return silentLogger } }

function fakeAuth() {
  return {
    linked: false,
    state: { creds: { registered: false } },
    async load() { return this.linked },
    async saveCreds() {},
    async wipe() { this.linked = false },
  }
}

function message(overrides = {}) {
  return {
    id: 'm1',
    chatId: JID,
    fromMe: false,
    author: null,
    authorName: null,
    timestamp: 1_000,
    kind: 'text',
    text: 'hello',
    quoted: null,
    media: null,
    thumbnail: null,
    location: null,
    contact: null,
    status: 'sent',
    revoked: false,
    edited: false,
    ...overrides,
  }
}

function createService(t, { downloadMediaMessage } = {}) {
  const service = createWhatsAppService({
    dataDir: '',
    logger: silentLogger,
    auth: fakeAuth(),
    dependencies: {
      makeWASocket: async () => {
        throw new Error('tests must not open a real WhatsApp socket')
      },
      downloadMediaMessage: downloadMediaMessage ?? (async () => Buffer.from([1, 2, 3])),
    },
  })
  t.after(async () => {
    await service.dispose().catch(() => {})
  })
  return service
}

// ---------------------------------------------------------------------------
// state()
// ---------------------------------------------------------------------------

test('state() exposes the full CONTRACT snapshot and never leaks mutable state', async (t) => {
  const service = createService(t)
  await service.ready()

  const state = service.state()
  for (const key of [
    'linked', 'connection', 'qr', 'me', 'linkedAt', 'lastConnectedAt', 'reconnectInMs',
    'reconnectAttempt', 'lastError', 'needsRelink', 'phoneOfflineModel', 'callsSupported',
    'messageCount', 'chatCount', 'storage',
  ]) {
    assert.ok(key in state, `state() is missing ${key}`)
  }
  assert.equal(state.linked, false)
  assert.equal(state.connection, 'idle')
  assert.equal(state.qr, null)
  assert.equal(state.me, null)
  assert.equal(state.needsRelink, false)
  assert.equal(state.callsSupported, false)
  assert.equal(state.storage, 'encrypted')
  assert.equal(state.phoneOfflineModel, PHONE_OFFLINE_MODEL)
  assert.equal(state.messageCount, 0)
  assert.equal(state.chatCount, 0)

  // A fresh object each call: mutating one must not affect the service.
  const second = service.state()
  assert.notEqual(second, state)
  second.linked = true
  assert.equal(service.state().linked, false)
})

// ---------------------------------------------------------------------------
// Store-backed queries
// ---------------------------------------------------------------------------

test('listChats/getMessages read through the encrypted message store', async (t) => {
  const service = createService(t)
  await service.ready()
  service.store.ingestHistory({
    chats: [{ id: JID, name: 'Bob', timestamp: 2_000 }, { id: GROUP, name: 'Team', timestamp: 1_000 }],
    contacts: [{ id: JID, name: 'Bob' }],
    messages: [
      { message: message({ id: 'm1', timestamp: 1_000, text: 'first' }) },
      { message: message({ id: 'm2', timestamp: 2_000, text: 'second', fromMe: true }) },
    ],
  })

  const chats = service.listChats()
  assert.equal(chats.length, 2)
  assert.equal(service.listChats('bob').length, 1)
  const page = service.getMessages(JID, { limit: 10 })
  assert.deepEqual(page.messages.map((item) => item.id), ['m1', 'm2'])
  assert.equal(page.hasMore, false)

  // Invalid jids return an empty page instead of throwing.
  assert.deepEqual(service.getMessages('not-a-jid'), { messages: [], hasMore: false })
  assert.equal(service.state().messageCount, 2)
  assert.equal(service.state().chatCount, 2)
})

// ---------------------------------------------------------------------------
// Media guard: only an existing message in the requested chat
// ---------------------------------------------------------------------------

test('getMedia serves media only for a message that exists in that exact chat', async (t) => {
  let downloads = 0
  const service = createService(t, {
    downloadMediaMessage: async () => {
      downloads += 1
      return Buffer.from([9, 8, 7])
    },
  })
  await service.ready()

  const mediaSource = {
    type: 'imageMessage',
    mimetype: 'image/jpeg',
    mediaKey: Buffer.from([1, 2]).toString('base64'),
  }
  service.store.upsertMessage(
    message({
      id: 'img-1',
      kind: 'image',
      text: '',
      media: {
        mimetype: 'image/jpeg', fileName: 'photo.jpg', fileLength: 3, seconds: null,
        width: null, height: null, ptt: false, animated: false, hasThumbnail: false,
      },
    }),
    { mediaSource },
  )

  const media = await service.getMedia(JID, 'img-1')
  assert.ok(media)
  assert.deepEqual(media.buffer, Buffer.from([9, 8, 7]))
  assert.equal(media.mimetype, 'image/jpeg')
  assert.equal(media.fileName, 'photo.jpg')
  assert.equal(downloads, 1)

  // The cache answers the second call without downloading again.
  const cached = await service.getMedia(JID, 'img-1')
  assert.deepEqual(cached.buffer, Buffer.from([9, 8, 7]))
  assert.equal(downloads, 1)

  // Wrong chat, unknown message, invalid ids and non-media messages are null.
  assert.equal(await service.getMedia(JID2, 'img-1'), null)
  assert.equal(await service.getMedia(JID, 'missing'), null)
  assert.equal(await service.getMedia('nope', 'img-1'), null)
  assert.equal(await service.getMedia(JID, 'bad/id'), null)

  service.store.upsertMessage(message({ id: 'text-1', kind: 'text', text: 'no media' }))
  assert.equal(await service.getMedia(JID, 'text-1'), null)
})

test('a failed media download is reported as null, not thrown', async (t) => {
  const service = createService(t, {
    downloadMediaMessage: async () => {
      throw new Error('download failed')
    },
  })
  await service.ready()
  service.store.upsertMessage(
    message({ id: 'img-2', kind: 'image', text: '' }),
    { mediaSource: { type: 'imageMessage', mimetype: 'image/jpeg' } },
  )
  assert.equal(await service.getMedia(JID, 'img-2'), null)
})

// ---------------------------------------------------------------------------
// Events / lifecycle
// ---------------------------------------------------------------------------

test('subscribe() broadcasts state changes and unsubscribe stops them', async (t) => {
  const service = createService(t)
  await service.ready()

  const events = []
  const unsubscribe = service.subscribe((event) => events.push(event))
  assert.equal(typeof unsubscribe, 'function')

  service.store.ingestChats([{ id: JID, name: 'Bob', timestamp: 1_000 }])
  await service.logout({ wipeMessages: true })
  assert.ok(events.some((event) => event.type === 'state' && event.state.linked === false))
  assert.equal(service.state().linked, false)
  assert.equal(service.store.chatCount, 0, 'logout(wipeMessages:true) must wipe the cached chats')

  unsubscribe()
  events.length = 0
  await service.logout({ wipeMessages: false })
  assert.deepEqual(events, [])

  // Non-function listeners are tolerated.
  assert.equal(typeof service.subscribe(null), 'function')
})

test('dispose() is idempotent and locks the service afterwards', async (t) => {
  const service = createService(t)
  await service.ready()
  await service.dispose()
  await service.dispose()
  await assert.rejects(service.beginLink(), (error) => {
    assert.equal(error.name, 'WhatsAppServiceError')
    assert.equal(error.code, 'disposed')
    return true
  })
  // Queries remain safe after dispose.
  assert.deepEqual(service.listChats(), [])
  assert.deepEqual(service.getMessages(JID), { messages: [], hasMore: false })
})

test('sending validates the chat/text and reports offline with stable codes', async (t) => {
  const service = createService(t)
  await service.ready()
  await assert.rejects(service.sendText('not-a-jid', 'hi'), (error) => error.code === 'bad-request')
  await assert.rejects(service.sendText(JID, '   '), (error) => error.code === 'bad-request')
  await assert.rejects(service.sendText(JID, 'x'.repeat(70_000)), (error) => error.code === 'bad-request')
  await assert.rejects(service.sendText(JID, 'hi'), (error) => error.code === 'offline')
  await assert.rejects(service.sendMedia(JID, { buffer: Buffer.alloc(0) }), (error) => error.code === 'bad-request')
  await assert.rejects(service.sendMedia(JID, { buffer: Buffer.from([1]) }), (error) => error.code === 'offline')
})
