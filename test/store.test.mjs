/**
 * lib/message-store.js — bounded in-memory cache with encrypted persistence.
 *
 * Real SecretBox files under .test-tmp (no network); Baileys is never touched.
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { openSecretBox } from '../lib/crypto.js'
import { MessageStore, createMessageStore } from '../lib/message-store.js'
import { encodeCursor } from '../lib/protocol.js'

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP_ROOT = path.join(PLUGIN_DIR, '.test-tmp', 'store')

// File-level cleanup: per-test t.after hooks close stores after the directory
// hook already ran, so the whole per-file root is removed once at the end.
after(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true })
})

let seq = 0

async function makeTempDir(t, prefix = 'store-') {
  await fs.mkdir(TMP_ROOT, { recursive: true })
  const dir = path.join(TMP_ROOT, `${prefix}${process.pid}-${seq++}-${Date.now()}`)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })
  return dir
}

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, child() { return silentLogger } }
const JID = '15551234567@s.whatsapp.net'
const JID2 = '15559876543@s.whatsapp.net'
const GROUP = '120363000000000001@g.us'

async function exists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

function message(overrides = {}) {
  return {
    id: 'm1',
    chatId: JID,
    fromMe: false,
    author: null,
    authorName: null,
    timestamp: 1000,
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

/** A store without persistence (pure in-memory): fast for mapping/logic tests. */
function memoryStore(t, limits) {
  const store = createMessageStore({ dataDir: '', box: null, logger: silentLogger, limits })
  t.after(() => store.dispose())
  return store
}

async function openPersistentStore(t, dir, limits) {
  const box = await openSecretBox({ dataDir: dir })
  const store = new MessageStore({ dataDir: dir, box, logger: silentLogger, limits })
  t.after(async () => {
    await store.dispose().catch(() => {})
    box.close()
  })
  await store.load()
  return { store, box }
}

// ---------------------------------------------------------------------------
// Lifecycle / persistence
// ---------------------------------------------------------------------------

test('load() is safe with no box and reports unencrypted storage', async (t) => {
  const store = memoryStore(t)
  assert.equal(store.storageEncrypted, false)
  await store.load()
  assert.equal(store.loaded, true)
  assert.equal(store.chatCount, 0)
  assert.equal(store.messageCount, 0)
  // Second load is a no-op.
  await store.load()
})

test('the store file is encrypted on disk and reloads after a restart', async (t) => {
  const dir = await makeTempDir(t)
  const first = await openPersistentStore(t, dir)
  assert.equal(first.store.storageEncrypted, true)

  const body = 'TOP-SECRET-BODY-9f3a'
  const chatName = 'Secret Chat Name 9f3a'
  first.store.ingestContacts([{ id: JID, name: chatName }])
  first.store.ingestChats([{ id: JID, name: chatName, unread: 2, timestamp: 5000 }])
  first.store.upsertMessage(message({ id: 'sec-1', text: body, timestamp: 5000 }), { unread: false })
  await first.store.flush()

  const storeFile = path.join(dir, 'store.enc')
  assert.equal(await exists(storeFile), true)
  const raw = await fs.readFile(storeFile)
  assert.ok(raw.toString('utf8').startsWith('DSHWA1\n'), 'store.enc must be a sealed envelope')
  assert.equal(raw.includes(Buffer.from(body)), false, 'message body must not appear in plaintext')
  assert.equal(raw.includes(Buffer.from(chatName)), false, 'chat name must not appear in plaintext')

  // A second store over the same key is a process restart.
  const box2 = await openSecretBox({ dataDir: dir })
  const second = new MessageStore({ dataDir: dir, box: box2, logger: silentLogger })
  t.after(async () => {
    await second.dispose().catch(() => {})
    box2.close()
  })
  await second.load()
  assert.equal(second.chatCount, 1)
  assert.equal(second.messageCount, 1)
  const chats = second.listChats()
  assert.equal(chats[0].name, chatName)
  assert.equal(chats[0].unread, 2)
  const page = second.getMessages(JID)
  assert.equal(page.messages.length, 1)
  assert.equal(page.messages[0].text, body)
  // Thumbnails are memory-only and are not resurrected.
  assert.equal(page.messages[0].thumbnail, null)
  // Contacts come back too.
  assert.equal(second.resolveName(JID), chatName)
})

test('dispose() flushes pending state; wipe() deletes the sealed file and in-memory data', async (t) => {
  const dir = await makeTempDir(t)
  const box = await openSecretBox({ dataDir: dir })
  const store = new MessageStore({ dataDir: dir, box, logger: silentLogger })
  await store.load()
  store.ingestChats([{ id: JID, name: 'Bob', timestamp: 1000 }])
  store.upsertMessage(message({ id: 'w1' }))
  // No explicit flush: dispose must persist.
  await store.dispose()
  assert.equal(await exists(path.join(dir, 'store.enc')), true)

  const store2 = new MessageStore({ dataDir: dir, box, logger: silentLogger })
  await store2.load()
  assert.equal(store2.chatCount, 1)
  assert.equal(store2.messageCount, 1)

  await store2.wipe()
  assert.equal(store2.chatCount, 0)
  assert.equal(store2.messageCount, 0)
  assert.equal(await exists(path.join(dir, 'store.enc')), false)
  assert.equal(store2.listChats().length, 0)
  // dispose() is idempotent after wipe.
  await store2.dispose()
  box.close()
})

test('a corrupt store file starts empty instead of throwing', async (t) => {
  const dir = await makeTempDir(t)
  const box = await openSecretBox({ dataDir: dir })
  const bogus = box.seal('store.enc', 'not a snapshot')
  await fs.writeFile(path.join(dir, 'store.enc'), bogus)
  const store = new MessageStore({ dataDir: dir, box, logger: silentLogger })
  t.after(async () => {
    await store.dispose().catch(() => {})
    box.close()
  })
  await store.load()
  assert.equal(store.chatCount, 0)
  assert.equal(store.messageCount, 0)
  assert.ok(store.lastError instanceof Error)
})

// ---------------------------------------------------------------------------
// History / chats / contacts ingest
// ---------------------------------------------------------------------------

test('ingestHistory applies contacts, chats and messages, and counts what changed', async (t) => {
  const store = memoryStore(t)
  const result = store.ingestHistory({
    contacts: [{ id: JID, notify: 'Bobby' }],
    chats: [{ id: JID, timestamp: 2000 }],
    messages: [
      { message: message({ id: 'h1', timestamp: 1000, text: 'first' }) },
      { message: message({ id: 'h2', timestamp: 2000, text: 'second', fromMe: true }) },
    ],
  })
  assert.deepEqual(result, { added: 2, changed: 0, chatsChanged: true, contactsChanged: true })

  const chat = store.getChat(JID)
  // The contact name resolves because contacts are ingested before chats.
  assert.equal(chat.name, 'Bobby')
  assert.equal(chat.timestamp, 2000)
  assert.equal(chat.lastMessage.id, 'h2')
  assert.equal(chat.unread, 0, 'bulk history must not create unread badges')
  assert.deepEqual(store.getMessages(JID).messages.map((item) => item.id), ['h1', 'h2'])

  // Ingesting the same history again adds nothing.
  const again = store.ingestHistory({
    contacts: [{ id: JID, notify: 'Bobby' }],
    chats: [{ id: JID, timestamp: 2000 }],
    messages: [{ message: message({ id: 'h1', timestamp: 1000, text: 'first' }) }],
  })
  assert.equal(again.added, 0)
  assert.equal(again.changed, 0)
})

test('ingestChats merges partials and keeps missing fields', async (t) => {
  const store = memoryStore(t)
  store.ingestChats([{ id: JID, name: 'Bob', unread: 1, pinned: false, timestamp: 1000 }])
  const { changed } = store.ingestChats([
    { id: JID, unread: 5, pinned: true, archived: true, timestamp: 1500 },
    { id: GROUP, isGroup: true, name: 'Team', timestamp: 900 },
    // Non-chat jids are ignored.
    { id: 'status@broadcast' },
    { id: 'not-a-jid' },
  ])
  assert.equal(changed, true)
  const bob = store.getChat(JID)
  assert.equal(bob.name, 'Bob')
  assert.equal(bob.unread, 5)
  assert.equal(bob.pinned, true)
  assert.equal(bob.archived, true)
  assert.equal(bob.timestamp, 1500)
  const team = store.getChat(GROUP)
  assert.equal(team.isGroup, true)
  assert.equal(team.name, 'Team')
  assert.equal(store.listChats().length, 2)
})

test('contacts resolve names, LID aliases and rename existing chats', async (t) => {
  const store = memoryStore(t)
  store.ingestChats([{ id: JID, timestamp: 1000 }])
  assert.equal(store.getChat(JID).name, '+15551234567')

  store.ingestContacts([
    { id: JID, lid: '88888888@lid', phoneNumber: JID, notify: 'Alice' },
  ])
  assert.equal(store.resolveName(JID), 'Alice')
  // Both the LID and the phone-number jid are aliases for the same contact.
  assert.equal(store.resolveName('88888888@lid'), 'Alice')
  // The existing chat was renamed in place.
  assert.equal(store.getChat(JID).name, 'Alice')
  assert.equal(store.resolveContact(JID).phoneNumber, '15551234567')
  assert.equal(store.resolveName('15550000000@s.whatsapp.net'), null)
})

test('contacts are bounded: the oldest record is dropped, not the newest', async (t) => {
  const store = memoryStore(t, { maxContacts: 2 })
  store.ingestContacts([
    { id: '11111111111@s.whatsapp.net', name: 'First' },
    { id: '22222222222@s.whatsapp.net', name: 'Second' },
    { id: '33333333333@s.whatsapp.net', name: 'Third' },
  ])
  assert.equal(store.resolveName('11111111111@s.whatsapp.net'), null)
  assert.equal(store.resolveName('22222222222@s.whatsapp.net'), 'Second')
  assert.equal(store.resolveName('33333333333@s.whatsapp.net'), 'Third')
})

// ---------------------------------------------------------------------------
// Message upsert / ordering / status
// ---------------------------------------------------------------------------

test('upserts are kept in chronological order regardless of insert order', async (t) => {
  const store = memoryStore(t)
  store.upsertMessage(message({ id: 'c', timestamp: 3000, text: 'third' }))
  store.upsertMessage(message({ id: 'a', timestamp: 1000, text: 'first' }))
  store.upsertMessage(message({ id: 'b', timestamp: 2000, text: 'second' }))
  assert.deepEqual(store.getMessages(JID).messages.map((item) => item.id), ['a', 'b', 'c'])
  assert.equal(store.messageCount, 3)

  // Equal timestamps tie-break on id.
  store.upsertMessage(message({ id: 'd2', timestamp: 4000 }))
  store.upsertMessage(message({ id: 'd1', timestamp: 4000 }))
  assert.deepEqual(store.getMessages(JID).messages.map((item) => item.id), ['a', 'b', 'c', 'd1', 'd2'])
})

test('upsert merges updates without duplicating or downgrading', async (t) => {
  const store = memoryStore(t)
  const created = store.upsertMessage(message({ id: 'u1', status: 'sent', text: 'draft' }))
  assert.equal(created.created, true)

  const advanced = store.upsertMessage(message({ id: 'u1', status: 'read' }))
  assert.equal(advanced.created, false)
  assert.equal(advanced.changed, true)
  assert.equal(store.getMessage(JID, 'u1').status, 'read')

  // A stale receipt never downgrades the stored status.
  store.upsertMessage(message({ id: 'u1', status: 'pending' }))
  assert.equal(store.getMessage(JID, 'u1').status, 'read')

  // Text edit and thumbnail land on the same record.
  store.upsertMessage(message({ id: 'u1', status: 'read', text: 'edited', edited: true }))
  const merged = store.getMessage(JID, 'u1')
  assert.equal(merged.text, 'edited')
  assert.equal(merged.edited, true)
  assert.equal(store.messageCount, 1)

  // Updating a status that is already current reports "not changed".
  const noop = store.upsertMessage(message({ id: 'u1', status: 'read', text: 'edited', edited: true }))
  assert.equal(noop.changed, false)
})

test('updateStatus/revokeMessage move forward and mark the store dirty', async (t) => {
  const store = memoryStore(t)
  store.upsertMessage(message({ id: 's1', status: 'sent' }))
  assert.equal(store.updateStatus(JID, 's1', 'delivered').changed, true)
  assert.equal(store.getMessage(JID, 's1').status, 'delivered')
  assert.equal(store.updateStatus(JID, 's1', 'sent').changed, false)
  assert.equal(store.updateStatus(JID, 'missing', 'read').changed, false)

  assert.equal(store.revokeMessage(JID, 's1').changed, true)
  assert.equal(store.getMessage(JID, 's1').revoked, true)
  assert.equal(store.revokeMessage(JID, 's1').changed, false)
  assert.equal(store.revokeMessage(JID, 'missing').changed, false)
})

test('unread counts only incoming, non-silent, non-revoked new messages', async (t) => {
  const store = memoryStore(t)
  store.upsertMessage(message({ id: 'n1', fromMe: false }))
  store.upsertMessage(message({ id: 'n2', fromMe: true }))
  store.upsertMessage(message({ id: 'n3', fromMe: false, revoked: true }))
  store.upsertMessage(message({ id: 'n4', fromMe: false }), { silent: true })
  store.upsertMessage(message({ id: 'n5', fromMe: true }), { unread: true })
  store.upsertMessage(message({ id: 'n6', fromMe: false }), { unread: false })
  assert.equal(store.getChat(JID).unread, 2)

  // Updating an existing message must not count again.
  store.upsertMessage(message({ id: 'n1', fromMe: false, status: 'read' }))
  assert.equal(store.getChat(JID).unread, 2)

  assert.equal(store.markRead(JID).changed, true)
  assert.equal(store.getChat(JID).unread, 0)
  assert.equal(store.markRead('15550000000@s.whatsapp.net').changed, false)
  assert.equal(store.markRead(JID).changed, false)
})

test('lastMessage preview follows the newest upsert and message deletion', async (t) => {
  const store = memoryStore(t)
  store.upsertMessage(message({ id: 'l1', timestamp: 1000, text: 'one' }))
  store.upsertMessage(message({ id: 'l2', timestamp: 2000, text: 'two', fromMe: true }))
  assert.deepEqual(store.getChat(JID).lastMessage, {
    id: 'l2', text: 'two', fromMe: true, timestamp: 2000, kind: 'text',
  })

  assert.equal(store.deleteMessages(JID, ['l2']).changed, true)
  assert.equal(store.getChat(JID).lastMessage.id, 'l1')
  assert.equal(store.getChat(JID).timestamp, 1000)
  assert.equal(store.deleteMessages(JID, ['l1']).changed, true)
  assert.equal(store.getChat(JID).lastMessage, null)
  assert.equal(store.deleteMessages(JID, ['l1']).changed, false)
})

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

test('pagination walks older pages via the before cursor', async (t) => {
  const store = memoryStore(t)
  for (let i = 0; i < 10; i += 1) {
    store.upsertMessage(message({ id: `p${i}`, timestamp: 1000 + i, text: `m${i}` }))
  }

  const first = store.getMessages(JID, { limit: 3 })
  assert.deepEqual(first.messages.map((item) => item.id), ['p7', 'p8', 'p9'])
  assert.equal(first.hasMore, true)

  const second = store.getMessages(JID, {
    limit: 3,
    before: encodeCursor(first.messages[0].timestamp, first.messages[0].id),
  })
  assert.deepEqual(second.messages.map((item) => item.id), ['p4', 'p5', 'p6'])
  assert.equal(second.hasMore, true)

  const third = store.getMessages(JID, {
    limit: 3,
    before: encodeCursor(second.messages[0].timestamp, second.messages[0].id),
  })
  assert.deepEqual(third.messages.map((item) => item.id), ['p1', 'p2', 'p3'])

  const last = store.getMessages(JID, {
    limit: 3,
    before: encodeCursor(third.messages[0].timestamp, third.messages[0].id),
  })
  assert.deepEqual(last.messages.map((item) => item.id), ['p0'])
  assert.equal(last.hasMore, false)

  // A cursor at/below the oldest message returns an empty page, not the newest one.
  const empty = store.getMessages(JID, { limit: 3, before: encodeCursor(1000, 'p0') })
  assert.deepEqual(empty.messages, [])
  assert.equal(empty.hasMore, false)
})

test('limit is clamped and a garbage cursor is ignored', async (t) => {
  const store = memoryStore(t)
  for (let i = 0; i < 250; i += 1) store.upsertMessage(message({ id: `q${i}`, timestamp: 1000 + i }))
  const page = store.getMessages(JID, { limit: 9999 })
  assert.equal(page.messages.length, 200)
  assert.equal(page.messages[199].id, 'q249')

  const fallback = store.getMessages(JID, { limit: -5, before: 'not-a-cursor' })
  assert.equal(fallback.messages.length, 50)
  assert.equal(fallback.messages[49].id, 'q249')

  // Unknown chat -> empty page.
  assert.deepEqual(store.getMessages('15550000000@s.whatsapp.net'), { messages: [], hasMore: false })
})

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

test('per-chat cap drops the oldest messages', async (t) => {
  const store = memoryStore(t, { maxMessagesPerChat: 3 })
  for (let i = 0; i < 6; i += 1) store.upsertMessage(message({ id: `c${i}`, timestamp: 1000 + i }))
  assert.deepEqual(store.getMessages(JID, { limit: 10 }).messages.map((item) => item.id), ['c3', 'c4', 'c5'])
  assert.equal(store.messageCount, 3)
  assert.ok(store.getChat(JID).lastMessage.id === 'c5')
})

test('total cap trims the globally oldest message first', async (t) => {
  const store = memoryStore(t, { maxMessagesPerChat: 100, maxTotalMessages: 4 })
  store.upsertMessage(message({ chatId: JID, id: 'a1', timestamp: 1000 }))
  store.upsertMessage(message({ chatId: JID, id: 'a2', timestamp: 2000 }))
  store.upsertMessage(message({ chatId: JID, id: 'a3', timestamp: 3000 }))
  store.upsertMessage(message({ chatId: JID2, id: 'b1', timestamp: 4000 }))
  store.upsertMessage(message({ chatId: JID2, id: 'b2', timestamp: 5000 }))
  store.upsertMessage(message({ chatId: JID2, id: 'b3', timestamp: 6000 }))

  assert.equal(store.messageCount, 4)
  assert.deepEqual(store.getMessages(JID).messages.map((item) => item.id), ['a3'])
  assert.deepEqual(store.getMessages(JID2).messages.map((item) => item.id), ['b1', 'b2', 'b3'])
})

test('chat cap drops the least recently active chats and their messages', async (t) => {
  const store = memoryStore(t, { maxChats: 2, maxMessagesPerChat: 100 })
  store.ingestChats([
    { id: JID, name: 'Old', timestamp: 1000 },
    { id: JID2, name: 'Middle', timestamp: 2000 },
    { id: GROUP, name: 'New', timestamp: 3000 },
  ])
  store.upsertMessage(message({ chatId: JID, id: 'old-1', timestamp: 1000 }))
  assert.equal(store.getChat(JID), null)
  assert.equal(store.getChat(JID2).name, 'Middle')
  assert.equal(store.getChat(GROUP).name, 'New')
  assert.deepEqual(store.getMessages(JID).messages, [])
})

test('the thumbnail budget is enforced in memory', async (t) => {
  const store = memoryStore(t, { maxThumbnailBudget: 100 })
  const thumbnail = `data:image/jpeg;base64,${'A'.repeat(80)}`
  store.upsertMessage(message({ id: 't1', timestamp: 1000 }))
  store.upsertMessage(message({ id: 't2', timestamp: 2000, thumbnail }))
  store.upsertMessage(message({ id: 't3', timestamp: 3000, thumbnail }))
  // Budget exceeded -> the oldest chat's thumbnails are dropped from memory.
  const messages = store.getMessages(JID, { limit: 10 }).messages
  assert.equal(messages.find((item) => item.id === 't1').thumbnail, null)
  const remaining = messages.filter((item) => item.thumbnail !== null).length
  assert.ok(remaining <= 1, `expected at most one retained thumbnail, got ${remaining}`)
})

// ---------------------------------------------------------------------------
// Queries / guards
// ---------------------------------------------------------------------------

test('listChats sorts pinned first then by recency and filters by name/id', async (t) => {
  const store = memoryStore(t)
  store.ingestChats([
    { id: JID, name: 'Bob', timestamp: 1000 },
    { id: JID2, name: 'Alice', timestamp: 3000 },
    { id: GROUP, name: 'Team', timestamp: 2000, pinned: true },
  ])
  const all = store.listChats()
  assert.deepEqual(all.map((chat) => chat.id), [GROUP, JID2, JID])
  assert.deepEqual(store.listChats('ali').map((chat) => chat.id), [JID2])
  assert.deepEqual(store.listChats('team').map((chat) => chat.id), [GROUP])
  assert.deepEqual(store.listChats('1555123').map((chat) => chat.id), [JID])
  assert.deepEqual(store.listChats('nothing-here'), [])
  // Each chat is a CONTRACT ChatSummary shape.
  for (const key of ['id', 'name', 'isGroup', 'unread', 'pinned', 'muted', 'archived', 'timestamp', 'lastMessage']) {
    assert.ok(key in all[0], `ChatSummary is missing ${key}`)
  }
})

test('hasMessage is scoped to one chat (media-route guard)', async (t) => {
  const store = memoryStore(t)
  store.upsertMessage(message({ chatId: JID, id: 'scoped-1' }))
  assert.equal(store.hasMessage(JID, 'scoped-1'), true)
  assert.equal(store.hasMessage(JID2, 'scoped-1'), false)
  assert.equal(store.hasMessage(JID, 'unknown'), false)
  assert.equal(store.hasMessage(JID, ''), false)
  assert.equal(store.hasMessage('status@broadcast', 'scoped-1'), false)
  assert.equal(store.getMessage(JID2, 'scoped-1'), null)
})

test('getQuote / getMessageContent reconstruct reply and media content', async (t) => {
  const store = memoryStore(t)
  store.upsertMessage(message({ id: 'text-1', text: 'quote me', fromMe: true }))
  const quote = store.getQuote(JID, 'text-1')
  assert.equal(quote.key.id, 'text-1')
  assert.equal(quote.message.extendedTextMessage.text, 'quote me')
  assert.equal(store.getQuote(JID, 'missing'), null)

  assert.deepEqual(store.getMessageContent({ remoteJid: JID, id: 'text-1' }), {
    extendedTextMessage: { text: 'quote me' },
  })
  assert.equal(store.getMessageContent({ remoteJid: JID, id: 'missing' }), undefined)

  const mediaSource = {
    type: 'imageMessage',
    mimetype: 'image/jpeg',
    mediaKey: Buffer.from([1, 2, 3]).toString('base64'),
  }
  store.upsertMessage(message({ id: 'img-1', kind: 'image', text: '' }), { mediaSource })
  const content = store.getMessageContent({ remoteJid: JID, id: 'img-1' })
  assert.ok(content.imageMessage)
  assert.deepEqual(Buffer.from(content.imageMessage.mediaKey), Buffer.from([1, 2, 3]))
  const record = store.getMessageRecord(JID, 'img-1')
  assert.equal(record.mediaSource.type, 'imageMessage')
  assert.equal(store.getMessageRecord(JID, 'missing'), null)
})

test('deleteChats removes the chat and its messages', async (t) => {
  const store = memoryStore(t)
  store.ingestChats([{ id: JID, timestamp: 1000 }, { id: JID2, timestamp: 2000 }])
  store.upsertMessage(message({ chatId: JID, id: 'd-1' }))
  store.upsertMessage(message({ chatId: JID2, id: 'd-2' }))
  assert.equal(store.deleteChats([JID]).changed, true)
  assert.equal(store.getChat(JID), null)
  assert.equal(store.hasMessage(JID, 'd-1'), false)
  assert.equal(store.hasMessage(JID2, 'd-2'), true)
  assert.equal(store.deleteChats([JID]).changed, false)
})


test('E2E notice stubs never become the chat-list preview', (t) => {
  const store = memoryStore(t)
  store.ingestChats([{ id: JID, timestamp: 1 }])
  store.upsertMessage(message({
    id: 'notice-1',
    kind: 'system',
    text: 'Messages are end-to-end encrypted',
    timestamp: 5000,
  }))
  assert.equal(store.getChat(JID).lastMessage, null)
  store.upsertMessage(message({ id: 'real-1', text: 'actual message', timestamp: 6000 }))
  store.upsertMessage(message({
    id: 'notice-2',
    kind: 'system',
    text: 'Messages are end-to-end encrypted',
    timestamp: 7000,
  }))
  assert.equal(store.getChat(JID).lastMessage.text, 'actual message')
})

test('a learned LID->phone pair resolves the contact name under both ids', (t) => {
  const store = memoryStore(t)
  const LID = '999999999999999@lid'
  store.ingestContacts([{ id: JID, name: 'Bob' }])
  store.ingestChats([{ id: LID, name: LID, timestamp: 1000 }])
  assert.equal(store.recordLidPhone(LID, JID), true)
  assert.equal(store.resolveName(LID), 'Bob')
  assert.equal(store.resolvePhone(LID), JID.split('@')[0])
})
