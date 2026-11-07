/**
 * lib/protocol.js — pure Baileys -> CONTRACT.md mapping.
 *
 * No network, no socket, no Baileys import: every input below is a plain object
 * shaped like a WAMessage / Chat / Contact, exactly what the mapping sees.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MESSAGE_KINDS,
  STUB_TYPE,
  PROTOCOL_TYPE,
  betterStatus,
  compareMessages,
  contactOfContent,
  decodeCursor,
  displayNameForJid,
  encodeCursor,
  getContentType,
  isBeforeCursor,
  isChatJid,
  isGroupJid,
  isUserJid,
  kindOfContent,
  lastMessagePreview,
  locationOfContent,
  mapCall,
  mapChat,
  mapContact,
  mapMessage,
  mediaMetadata,
  mediaSourceOf,
  contentFromMediaSource,
  normalizeJid,
  phoneFromJid,
  quoteFromStored,
  sanitizeText,
  statusFromRaw,
  statusFromReceipt,
  textOfContent,
  toFiniteNumber,
  unixSecondsToMs,
  unwrapContent,
} from '../lib/protocol.js'

const JID = '15551234567@s.whatsapp.net'
const GROUP = '120363000000000001@g.us'

function raw(overrides = {}) {
  return {
    key: { id: 'msg-1', remoteJid: JID, fromMe: false },
    message: { conversation: 'hello' },
    messageTimestamp: 1_700_000_000,
    ...overrides,
  }
}

/** Assert the shared Message skeleton for a mapping result. */
function assertMessageShape(message) {
  for (const key of [
    'id', 'chatId', 'fromMe', 'author', 'authorName', 'timestamp', 'kind', 'text',
    'quoted', 'media', 'thumbnail', 'location', 'contact', 'status', 'revoked', 'edited',
  ]) {
    assert.ok(key in message, `Message is missing "${key}"`)
  }
  assert.ok(MESSAGE_KINDS.includes(message.kind), `unknown kind ${message.kind}`)
}

// ---------------------------------------------------------------------------
// Generic content kinds
// ---------------------------------------------------------------------------

test('maps a plain text conversation', () => {
  const message = mapMessage(raw())
  assertMessageShape(message)
  assert.equal(message.kind, 'text')
  assert.equal(message.text, 'hello')
  assert.equal(message.chatId, JID)
  assert.equal(message.id, 'msg-1')
  assert.equal(message.fromMe, false)
  assert.equal(message.author, null)
  assert.equal(message.authorName, null)
  assert.equal(message.timestamp, 1_700_000_000_000)
  assert.equal(message.quoted, null)
  assert.equal(message.media, null)
  assert.equal(message.thumbnail, null)
  assert.equal(message.location, null)
  assert.equal(message.contact, null)
  assert.equal(message.status, 'unknown')
  assert.equal(message.revoked, false)
  assert.equal(message.edited, false)
})

test('maps extended text and keeps fromMe / defaultStatus options', () => {
  const message = mapMessage(
    raw({ key: { id: 'm2', remoteJid: JID, fromMe: true }, message: { extendedTextMessage: { text: 'reply text' } } }),
    { defaultStatus: 'sent' },
  )
  assert.equal(message.kind, 'text')
  assert.equal(message.text, 'reply text')
  assert.equal(message.fromMe, true)
  assert.equal(message.status, 'sent')
})

test('maps an image message with caption, metadata and thumbnail', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
  const message = mapMessage(raw({
    message: {
      imageMessage: {
        mimetype: 'image/jpeg',
        caption: 'a photo',
        fileLength: 2048,
        width: 1024,
        height: 768,
        jpegThumbnail: jpeg,
      },
    },
    status: 3,
  }))
  assertMessageShape(message)
  assert.equal(message.kind, 'image')
  assert.equal(message.text, 'a photo')
  assert.equal(message.media.mimetype, 'image/jpeg')
  assert.equal(message.media.fileLength, 2048)
  assert.equal(message.media.width, 1024)
  assert.equal(message.media.height, 768)
  assert.equal(message.media.ptt, false)
  assert.equal(message.media.hasThumbnail, true)
  assert.ok(message.thumbnail.startsWith('data:image/jpeg;base64,'))
  assert.equal(message.status, 'delivered')
})

test('maps a video message (seconds/width/height/animated) and its thumbnail', () => {
  const message = mapMessage(raw({
    message: {
      videoMessage: {
        mimetype: 'video/mp4',
        seconds: 12,
        width: 720,
        height: 1280,
        gifPlayback: true,
        jpegThumbnail: new Uint8Array([1, 2, 3]),
      },
    },
  }))
  assert.equal(message.kind, 'video')
  assert.equal(message.media.seconds, 12)
  assert.equal(message.media.width, 720)
  assert.equal(message.media.height, 1280)
  assert.equal(message.media.animated, true)
  assert.ok(message.thumbnail.startsWith('data:image/jpeg;base64,'))
})

test('maps voice notes and audio, including the ptt flag', () => {
  const voice = mapMessage(raw({ message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: 4 } } }))
  assert.equal(voice.kind, 'audio')
  assert.equal(voice.text, 'Voice message')
  assert.equal(voice.media.ptt, true)
  assert.equal(voice.media.seconds, 4)
  // Audio has no inline preview.
  assert.equal(voice.thumbnail, null)

  const audio = mapMessage(raw({ message: { audioMessage: { mimetype: 'audio/mpeg', ptt: false } } }))
  assert.equal(audio.text, 'Audio message')
  assert.equal(audio.media.ptt, false)
})

test('maps a document with file name and caption', () => {
  const message = mapMessage(raw({
    message: {
      documentMessage: {
        mimetype: 'application/pdf',
        fileName: 'invoice.pdf',
        fileLength: 4096,
        caption: 'your invoice',
        jpegThumbnail: Buffer.from([9, 9]),
      },
    },
  }))
  assert.equal(message.kind, 'document')
  assert.equal(message.text, 'your invoice')
  assert.equal(message.media.fileName, 'invoice.pdf')
  assert.equal(message.media.fileLength, 4096)
  assert.equal(message.media.mimetype, 'application/pdf')
  assert.ok(message.thumbnail.startsWith('data:image/jpeg;base64,'))
})

test('maps stickers (animated and static), with no JPEG thumbnail', () => {
  const animated = mapMessage(raw({ message: { stickerMessage: { mimetype: 'image/webp', isAnimated: true } } }))
  assert.equal(animated.kind, 'sticker')
  assert.equal(animated.text, 'Animated sticker')
  assert.equal(animated.media.animated, true)
  assert.equal(animated.thumbnail, null)

  const still = mapMessage(raw({ message: { stickerMessage: { mimetype: 'image/webp' } } }))
  assert.equal(still.kind, 'sticker')
  assert.equal(still.text, 'Sticker')
  assert.equal(still.media.animated, false)
})

test('maps locations to the structured location object', () => {
  const message = mapMessage(raw({
    message: {
      locationMessage: {
        degreesLatitude: 51.5,
        degreesLongitude: -0.12,
        name: 'Office',
        address: '1 Main St',
      },
    },
  }))
  assert.equal(message.kind, 'location')
  assert.deepEqual(message.location, { lat: 51.5, lng: -0.12, name: 'Office', address: '1 Main St' })
  assert.equal(message.text, 'Office')
  assert.equal(message.media, null)
  // A location without coordinates is not a usable location object.
  const broken = mapMessage(raw({ message: { locationMessage: { name: 'Nowhere' } } }))
  assert.equal(broken.kind, 'location')
  assert.equal(broken.location, null)
})

test('maps contact cards, single and array', () => {
  const card = mapMessage(raw({
    message: { contactMessage: { displayName: 'Alice', vcard: 'BEGIN:VCARD\nFN:Alice\nEND:VCARD' } },
  }))
  assert.equal(card.kind, 'contact')
  assert.equal(card.contact.displayName, 'Alice')
  assert.match(card.contact.vcard, /^BEGIN:VCARD/)
  assert.equal(card.text, 'Alice')

  const array = mapMessage(raw({
    message: {
      contactsArrayMessage: {
        displayName: 'Team',
        contacts: [
          { displayName: 'Bob', vcard: 'BEGIN:VCARD\nFN:Bob\nEND:VCARD' },
          { displayName: 'Carol', vcard: 'BEGIN:VCARD\nFN:Carol\nEND:VCARD' },
        ],
      },
    },
  }))
  assert.equal(array.kind, 'contact')
  assert.equal(array.contact.displayName, 'Team')
  assert.match(array.contact.vcard, /FN:Bob/)
  assert.equal(array.text, 'Team')
})

// ---------------------------------------------------------------------------
// Protocol / revocation / system / calls
// ---------------------------------------------------------------------------

test('maps a revoked message to a system line', () => {
  const revoked = mapMessage(raw({
    message: { protocolMessage: { type: PROTOCOL_TYPE.REVOKE, key: { id: 'target-1', remoteJid: JID } } },
  }))
  assert.equal(revoked.revoked, true)
  assert.equal(revoked.kind, 'system')
  assert.equal(revoked.text, 'This message was deleted')

  // Revocation also arrives as a message stub (history sync).
  const stub = mapMessage(raw({ message: {}, messageStubType: STUB_TYPE.REVOKE }))
  assert.equal(stub.revoked, true)
  assert.equal(stub.kind, 'system')
  assert.equal(stub.text, 'This message was deleted')
})

test('maps an edited message and marks edited', () => {
  const direct = mapMessage(raw({
    message: {
      protocolMessage: {
        type: PROTOCOL_TYPE.MESSAGE_EDIT,
        editedMessage: { conversation: 'new text' },
      },
    },
  }))
  assert.equal(direct.edited, true)
  assert.equal(direct.text, 'new text')

  const wrapper = mapMessage(raw({
    message: { editedMessage: { message: { extendedTextMessage: { text: 'edited via wrapper' } } } },
  }))
  assert.equal(wrapper.edited, true)
  assert.equal(wrapper.kind, 'text')
  assert.equal(wrapper.text, 'edited via wrapper')
})

test('maps missed-call stubs to kind call with an explanation', () => {
  const voice = mapMessage(raw({ message: {}, messageStubType: STUB_TYPE.CALL_MISSED_VOICE }))
  assert.equal(voice.kind, 'call')
  assert.equal(voice.text, 'Missed voice call')

  const video = mapMessage(raw({ message: {}, messageStubType: STUB_TYPE.CALL_MISSED_VIDEO }))
  assert.equal(video.kind, 'call')
  assert.equal(video.text, 'Missed video call')

  // proto.Message.call content is recognised too (getContentType handles it).
  const live = mapMessage(raw({ message: { call: { callKey: 'abc' } } }))
  assert.equal(live.kind, 'call')
  assert.equal(live.text, 'Call')
})

test('maps group system stubs to readable system lines', () => {
  const created = mapMessage(raw({ message: {}, messageStubType: STUB_TYPE.GROUP_CREATE, messageStubParameters: ['Alice'] }))
  assert.equal(created.kind, 'system')
  assert.equal(created.text, 'Alice created the group')

  const subject = mapMessage(raw({ message: {}, messageStubType: STUB_TYPE.GROUP_CHANGE_SUBJECT, messageStubParameters: ['New name'] }))
  assert.equal(subject.kind, 'system')
  assert.equal(subject.text, 'Group subject changed to "New name"')

  const left = mapMessage(raw({ message: {}, messageStubType: STUB_TYPE.GROUP_PARTICIPANT_LEAVE, messageStubParameters: ['Bob'] }))
  assert.equal(left.text, 'Bob left the group')
  assert.equal(left.kind, 'system')
})

test('unwraps ephemeral, view-once and document-with-caption wrappers', () => {
  const ephemeral = mapMessage(raw({ message: { ephemeralMessage: { message: { conversation: 'secret' } } } }))
  assert.equal(ephemeral.kind, 'text')
  assert.equal(ephemeral.text, 'secret')

  const viewOnce = mapMessage(raw({ message: { viewOnceMessageV2: { message: { imageMessage: { mimetype: 'image/jpeg', caption: 'once' } } } } }))
  assert.equal(viewOnce.kind, 'image')
  assert.equal(viewOnce.text, 'once')

  const withCaption = mapMessage(raw({ message: { documentWithCaptionMessage: { message: { documentMessage: { mimetype: 'text/plain', fileName: 'a.txt', caption: 'docs' } } } } }))
  assert.equal(withCaption.kind, 'document')
  assert.equal(withCaption.text, 'docs')
  assert.equal(withCaption.media.fileName, 'a.txt')
})

// ---------------------------------------------------------------------------
// Quoted messages and group authorship
// ---------------------------------------------------------------------------

test('maps a quoted message, resolving the quoted author name', () => {
  const resolveName = (jid) => (jid === '15550000001@s.whatsapp.net' ? 'Quoted Alice' : null)
  const message = mapMessage(
    raw({
      message: {
        extendedTextMessage: {
          text: 'replying',
          contextInfo: {
            stanzaId: 'orig-42',
            participant: '15550000001:3@s.whatsapp.net',
            quotedMessage: { conversation: 'the original' },
          },
        },
      },
    }),
    { resolveName },
  )
  assert.deepEqual(message.quoted, {
    id: 'orig-42',
    authorName: 'Quoted Alice',
    text: 'the original',
  })
})

test('quotes media messages through their caption and tolerates missing context', () => {
  const message = mapMessage(raw({
    message: {
      imageMessage: {
        mimetype: 'image/jpeg',
        caption: 'photo caption',
        contextInfo: {
          stanzaId: 'orig-media',
          participant: '15550000002@s.whatsapp.net',
          quotedMessage: { imageMessage: { mimetype: 'image/jpeg', caption: 'quoted image' } },
        },
      },
    },
  }))
  assert.equal(message.quoted.id, 'orig-media')
  assert.equal(message.quoted.text, 'quoted image')
  assert.equal(message.quoted.authorName, null)

  const noQuoted = mapMessage(raw())
  assert.equal(noQuoted.quoted, null)
})

test('maps group messages with a normalized participant author and name', () => {
  const resolveName = (jid) => (jid === '15550000003@s.whatsapp.net' ? 'Carol' : null)
  const message = mapMessage(
    raw({
      key: { id: 'g1', remoteJid: GROUP, fromMe: false, participant: '15550000003:7@s.whatsapp.net' },
      message: { conversation: 'in the group' },
    }),
    { resolveName },
  )
  assert.equal(message.chatId, GROUP)
  assert.equal(message.author, '15550000003@s.whatsapp.net')
  assert.equal(message.authorName, 'Carol')

  // 1:1 messages have no author.
  const direct = mapMessage(raw())
  assert.equal(direct.author, null)
  // An explicit chatId option wins over key.remoteJid (history sync shape).
  const history = mapMessage(raw(), { chatId: '15559999999@s.whatsapp.net' })
  assert.equal(history.chatId, '15559999999@s.whatsapp.net')
})

// ---------------------------------------------------------------------------
// Unknown types and hardening
// ---------------------------------------------------------------------------

test('unknown / empty content falls back to kind unknown with empty text', () => {
  const unknownType = mapMessage(raw({ message: { futureMessageType: { foo: 'bar' } } }))
  assert.equal(unknownType.kind, 'unknown')
  assert.equal(unknownType.text, '')
  assert.equal(unknownType.media, null)

  const empty = mapMessage(raw({ message: {} }))
  assert.equal(empty.kind, 'unknown')
  assert.equal(empty.text, '')

  assert.equal(mapMessage(null).kind, 'unknown')
  assert.equal(mapMessage(undefined).id, '')
  // Status remains a contract value even for an empty mapping.
  assert.equal(mapMessage(null).status, 'unknown')
})

test('control characters are stripped from text, never HTML-escaped', () => {
  const message = mapMessage(raw({ message: { conversation: 'a\u0000b\u0007c\u001bd <b>tag</b>' } }))
  assert.equal(message.text, 'abcd <b>tag</b>')
  assert.equal(sanitizeText('x'.repeat(10), 5), 'xxxxx')
  assert.equal(sanitizeText(42), '')
})

test('media metadata defaults are applied per kind', () => {
  assert.equal(mediaMetadata({ imageMessage: {} }).mimetype, 'image/jpeg')
  assert.equal(mediaMetadata({ videoMessage: {} }).mimetype, 'video/mp4')
  assert.equal(mediaMetadata({ audioMessage: {} }).mimetype, 'audio/ogg')
  assert.equal(mediaMetadata({ documentMessage: {} }).mimetype, 'application/octet-stream')
  assert.equal(mediaMetadata({ stickerMessage: {} }).mimetype, 'image/webp')
  assert.equal(mediaMetadata({ conversation: 'x' }), null)
  assert.equal(mediaMetadata(null), null)
  assert.equal(mediaMetadata({ imageMessage: { jpegThumbnail: Buffer.alloc(0) } }).hasThumbnail, true)
  // Media that WhatsApp no longer serves (or a placeholder with only a hash)
  // must be marked non-downloadable so the UI does not request a 404 forever.
  assert.equal(mediaMetadata({ imageMessage: { directPath: '/v/a' } }).downloadable, true)
  assert.equal(mediaMetadata({ imageMessage: { url: 'https://mmg.whatsapp.net/a' } }).downloadable, true)
  assert.equal(mediaMetadata({ videoMessage: { fileSha256: Buffer.from([1]) } }).downloadable, false)
})

test('oversized thumbnails are dropped instead of inflated', () => {
  const huge = Buffer.alloc(600 * 1024)
  // MAX_THUMBNAIL_BYTES is 512 KiB from config.
  assert.equal(mapMessage(raw({ message: { imageMessage: { jpegThumbnail: huge } } })).thumbnail, null)
})

// ---------------------------------------------------------------------------
// Cursor roundtrip and ordering
// ---------------------------------------------------------------------------

test('cursor roundtrips timestamp:id and rejects malformed values', () => {
  const cursor = encodeCursor(1_700_000_000_123, '3EB0ABCD-1234')
  assert.equal(cursor, '1700000000123:3EB0ABCD-1234')
  assert.deepEqual(decodeCursor(cursor), { timestamp: 1_700_000_000_123, id: '3EB0ABCD-1234' })

  // Colons in ids cannot survive encoding, so decode cannot be confused.
  assert.equal(encodeCursor(5, 'a:b'), '5:ab')
  assert.equal(decodeCursor('5:a:b'), null)

  for (const bad of [null, undefined, '', '   ', 'nope', '123:', ':id', '-1:id', '1.5:id', '1:bad/id', 'x'.repeat(301)]) {
    assert.equal(decodeCursor(bad), null, `expected ${JSON.stringify(bad)} to be rejected`)
  }
})

test('isBeforeCursor follows timestamp then id, and compareMessages is stable', () => {
  const cursor = { timestamp: 1000, id: 'm' }
  assert.equal(isBeforeCursor({ timestamp: 999, id: 'z' }, cursor), true)
  assert.equal(isBeforeCursor({ timestamp: 1000, id: 'a' }, cursor), true)
  assert.equal(isBeforeCursor({ timestamp: 1000, id: 'm' }, cursor), false)
  assert.equal(isBeforeCursor({ timestamp: 1000, id: 'z' }, cursor), false)
  assert.equal(isBeforeCursor({ timestamp: 1001, id: 'a' }, cursor), false)
  assert.equal(isBeforeCursor({ timestamp: 1, id: 'a' }, null), false)

  assert.ok(compareMessages({ timestamp: 1, id: 'b' }, { timestamp: 2, id: 'a' }) < 0)
  assert.ok(compareMessages({ timestamp: 2, id: 'a' }, { timestamp: 2, id: 'b' }) < 0)
  assert.equal(compareMessages({ timestamp: 2, id: 'a' }, { timestamp: 2, id: 'a' }), 0)
})

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

test('maps raw status enums and never downgrades a status', () => {
  assert.equal(statusFromRaw(0), 'error')
  assert.equal(statusFromRaw(1), 'pending')
  assert.equal(statusFromRaw(2), 'sent')
  assert.equal(statusFromRaw(3), 'delivered')
  assert.equal(statusFromRaw(4), 'read')
  assert.equal(statusFromRaw(5), 'played')
  assert.equal(statusFromRaw(99), 'unknown')
  assert.equal(statusFromRaw(null), 'unknown')

  assert.equal(betterStatus('sent', 'delivered'), 'delivered')
  assert.equal(betterStatus('read', 'sent'), 'read')
  assert.equal(betterStatus('error', 'read'), 'error')
  assert.equal(betterStatus('unknown', 'sent'), 'sent')
  assert.equal(betterStatus('sent', 'bogus'), 'sent')

  assert.equal(statusFromReceipt({ playedTimestamp: 1 }), 'played')
  assert.equal(statusFromReceipt({ readTimestamp: 1 }), 'read')
  assert.equal(statusFromReceipt({ receiptTimestamp: 1 }), 'delivered')
  assert.equal(statusFromReceipt(null), 'delivered')
})

// ---------------------------------------------------------------------------
// Chats, contacts, calls, jids
// ---------------------------------------------------------------------------

test('maps chats with unread/pin/mute/archive and a last-message preview', () => {
  const now = 1_700_000_500_000
  const chat = mapChat(
    {
      id: JID,
      name: 'Bob',
      unreadCount: 4,
      conversationTimestamp: 1_700_000_000,
      pinned: true,
      archived: true,
      muteEndTime: 1_700_001_000,
    },
    {
      now,
      lastMessage: { id: 'x1', text: 'hi', fromMe: true, timestamp: 1_700_000_010_000, kind: 'text' },
    },
  )
  assert.equal(chat.id, JID)
  assert.equal(chat.name, 'Bob')
  assert.equal(chat.isGroup, false)
  assert.equal(chat.unread, 4)
  assert.equal(chat.pinned, true)
  assert.equal(chat.archived, true)
  assert.equal(chat.muted, true)
  assert.equal(chat.timestamp, 1_700_000_000_000)
  assert.deepEqual(chat.lastMessage, {
    id: 'x1',
    text: 'hi',
    fromMe: true,
    timestamp: 1_700_000_010_000,
    kind: 'text',
  })

  const pastMute = mapChat({ id: JID, muteEndTime: 1 }, { now })
  assert.equal(pastMute.muted, false)
  assert.equal(pastMute.lastMessage, null)

  // Missing name falls back to a display name derived from the jid.
  const unnamed = mapChat({ id: JID }, {})
  assert.equal(unnamed.name, '+15551234567')
})

test('group chats are recognised and named via resolveName', () => {
  const chat = mapChat({ id: GROUP }, { resolveName: () => 'Team chat' })
  assert.equal(chat.isGroup, true)
  assert.equal(chat.name, 'Team chat')
})

test('maps contacts to the compact persisted record', () => {
  const contact = mapContact({
    id: '15551234567:2@s.whatsapp.net',
    lid: '999@lid',
    name: 'Bobby',
    notify: 'Bob',
    verifiedName: 'Bob Inc',
    username: 'bob',
    phoneNumber: '15551234567@s.whatsapp.net',
  })
  assert.equal(contact.id, JID)
  assert.equal(contact.lid, '999@lid')
  assert.equal(contact.phoneNumber, '15551234567')
  assert.equal(contact.name, 'Bobby')
  assert.equal(contact.notify, 'Bob')
  assert.equal(contact.verifiedName, 'Bob Inc')
  assert.equal(contact.username, 'bob')
})

test('maps call events', () => {
  const date = new Date('2026-01-02T03:04:05.000Z')
  const call = mapCall({ id: 'call-1', from: '15551234567:2@s.whatsapp.net', isVideo: true, date, status: 'offer' })
  assert.deepEqual(call, {
    id: 'call-1',
    from: JID,
    chatId: JID,
    isVideo: true,
    date: date.getTime(),
    status: 'offer',
  })
  const unknown = mapCall(null)
  assert.equal(unknown.id, '')
  assert.equal(unknown.isVideo, false)
  assert.equal(unknown.status, 'unknown')
  assert.equal(typeof unknown.date, 'number')
})

test('jid helpers normalize device suffixes and classify servers', () => {
  assert.equal(normalizeJid('15551234567:4@s.whatsapp.net'), JID)
  assert.equal(normalizeJid('15551234567@c.us'), JID)
  assert.equal(normalizeJid(' 15551234567@s.whatsapp.net '), JID)
  assert.equal(normalizeJid(''), '')
  assert.equal(normalizeJid(null), '')
  assert.equal(normalizeJid(GROUP), GROUP)
  // Device suffix is kept for group participant-style jids only where it belongs.
  assert.equal(normalizeJid('123:4@g.us'), '123:4@g.us')

  assert.equal(isGroupJid(GROUP), true)
  assert.equal(isGroupJid(JID), false)
  assert.equal(isUserJid(JID), true)
  assert.equal(isUserJid(GROUP), false)
  assert.equal(isChatJid(GROUP), true)
  assert.equal(isChatJid('status@broadcast'), false)
  assert.equal(isChatJid('123@broadcast'), false)

  assert.equal(phoneFromJid('15551234567:4@s.whatsapp.net'), '15551234567')
  assert.equal(displayNameForJid(JID), '+15551234567')
  assert.equal(displayNameForJid(JID, 'Bob'), 'Bob')
})

test('phoneFromJid/displayNameForJid treat group and LID jids as non-phone (regression)', () => {
  // Regression: phoneFromJid's contract comment says "empty for groups/LIDs";
  // the first implementation only checked that the user part was digits, so
  // groups/LIDs rendered as "+120363..." / "+999" phone numbers.
  assert.equal(phoneFromJid(GROUP), '')
  assert.equal(phoneFromJid('999@lid'), '')
  assert.equal(displayNameForJid('999@lid'), '999@lid')
})

// ---------------------------------------------------------------------------
// Media sources and quotes (round-trip through the store)
// ---------------------------------------------------------------------------

test('mediaSourceOf/contentFromMediaSource roundtrip Buffers as base64', () => {
  const rawMessage = raw({
    message: {
      imageMessage: {
        mimetype: 'image/jpeg',
        mediaKey: Buffer.from([1, 2, 3, 4]),
        fileSha256: Buffer.from([5, 6]),
        directPath: '/v/t62',
        url: 'https://example.invalid/t62',
      },
    },
  })
  const source = mediaSourceOf(rawMessage)
  assert.equal(source.type, 'imageMessage')
  assert.equal(source.mimetype, 'image/jpeg')
  assert.equal(source.mediaKey, Buffer.from([1, 2, 3, 4]).toString('base64'))
  assert.equal(source.fileSha256, Buffer.from([5, 6]).toString('base64'))
  assert.equal(source.directPath, '/v/t62')
  assert.equal(mediaSourceOf(raw()), null)
  assert.equal(mediaSourceOf(raw({ message: { conversation: 'x' } })), null)

  const rebuilt = contentFromMediaSource(source)
  assert.ok(rebuilt.imageMessage)
  assert.deepEqual(Buffer.from(rebuilt.imageMessage.mediaKey), Buffer.from([1, 2, 3, 4]))
  assert.deepEqual(Buffer.from(rebuilt.imageMessage.fileSha256), Buffer.from([5, 6]))
  assert.equal(contentFromMediaSource({ type: 'nope' }), null)
  assert.equal(contentFromMediaSource(null), null)
})

test('quoteFromStored builds a WAMessage for a text or media quote', () => {
  const textQuote = quoteFromStored({
    id: 'msg-9',
    chatId: JID,
    fromMe: true,
    text: 'the reply target',
    timestamp: 1_700_000_000_000,
    authorName: 'Me',
  })
  assert.equal(textQuote.key.remoteJid, JID)
  assert.equal(textQuote.key.id, 'msg-9')
  assert.equal(textQuote.key.fromMe, true)
  assert.equal(textQuote.message.extendedTextMessage.text, 'the reply target')
  assert.equal(textQuote.messageTimestamp, 1_700_000_000)
  assert.equal(textQuote.pushName, 'Me')

  const mediaQuote = quoteFromStored(
    { id: 'img-1', chatId: JID, fromMe: false, text: '', timestamp: 1_700_000_001_000 },
    { type: 'imageMessage', mimetype: 'image/jpeg', mediaKey: Buffer.from([7]).toString('base64') },
  )
  assert.ok(mediaQuote.message.imageMessage)
  assert.equal(mediaQuote.key.fromMe, false)

  assert.equal(quoteFromStored(null), null)
  assert.equal(quoteFromStored({ id: 5 }), null)
})

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

test('content type / text helpers agree on the contract vocabulary', () => {
  assert.equal(getContentType({ conversation: 'x' }), 'conversation')
  assert.equal(getContentType({ imageMessage: {} }), 'imageMessage')
  assert.equal(getContentType({}), null)
  assert.equal(getContentType(null), null)

  assert.equal(kindOfContent({ conversation: 'x' }), 'text')
  assert.equal(kindOfContent({ extendedTextMessage: { text: 'x' } }), 'text')
  assert.equal(kindOfContent({ liveLocationMessage: {} }), 'location')
  assert.equal(kindOfContent({ contactsArrayMessage: {} }), 'contact')
  assert.equal(kindOfContent({ protocolMessage: {} }), 'system')
  assert.equal(kindOfContent({}), 'unknown')

  assert.equal(textOfContent({ extendedTextMessage: { text: 'x' } }), 'x')
  assert.equal(textOfContent({ conversation: 'plain' }), 'plain')
  assert.equal(textOfContent({}), '')
  assert.equal(unwrapContent({ ephemeralMessage: { message: { conversation: 'e' } } }).content.conversation, 'e')
})

test('number helpers accept protobuf Longs, dates, bigints and strings', () => {
  assert.equal(toFiniteNumber(42), 42)
  assert.equal(toFiniteNumber('42'), 42)
  assert.equal(toFiniteNumber(42n), 42)
  assert.equal(toFiniteNumber(new Date(1000)), 1000)
  assert.equal(toFiniteNumber({ low: 1, high: 0 }), 1)
  assert.equal(toFiniteNumber({ toNumber: () => 7 }), 7)
  assert.equal(toFiniteNumber(Number.NaN), null)
  assert.equal(toFiniteNumber(undefined), null)

  assert.equal(unixSecondsToMs(1_700_000_000), 1_700_000_000_000)
  // Already-millisecond values are not multiplied again.
  assert.equal(unixSecondsToMs(1_700_000_000_000), 1_700_000_000_000)
  assert.equal(unixSecondsToMs(0), null)
  assert.equal(unixSecondsToMs(null), null)
})

test('lastMessagePreview is a bounded summary', () => {
  const preview = lastMessagePreview({
    id: 'm',
    text: 'x'.repeat(500),
    fromMe: false,
    timestamp: 5,
    kind: 'text',
  })
  assert.equal(preview.id, 'm')
  assert.equal(preview.text.length, 200)
  assert.equal(preview.fromMe, false)
  assert.equal(preview.timestamp, 5)
  assert.equal(preview.kind, 'text')
  assert.equal(lastMessagePreview(null), null)
  assert.equal(lastMessagePreview({ kind: 'bogus' }).kind, 'unknown')
})

test('locationOfContent / contactOfContent are null for non-matching content', () => {
  assert.equal(locationOfContent({ conversation: 'x' }), null)
  assert.equal(locationOfContent(null), null)
  assert.equal(contactOfContent({ conversation: 'x' }), null)
  assert.equal(contactOfContent({ contactsArrayMessage: { contacts: [] } }), null)
})
