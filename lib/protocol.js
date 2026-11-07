/**
 * Pure mapping helpers between Baileys' protobuf shapes and the wire types in
 * CONTRACT.md. Nothing here imports WiFi, opens a socket, or touches the disk:
 * every function is deterministic given its arguments, which is what the test
 * suite exercises.
 *
 * Shapes produced here are the *only* thing the HTTP API and the client see:
 * Message (CONTRACT §Message) and ChatSummary (CONTRACT §ChatSummary).
 */
import { MAX_THUMBNAIL_BYTES } from './config.js'

/** Fixed kind vocabulary from CONTRACT.md. */
export const MESSAGE_KINDS = Object.freeze([
  'text',
  'image',
  'video',
  'audio',
  'document',
  'sticker',
  'location',
  'contact',
  'call',
  'system',
  'unknown',
])

/** WAMessageStatus values, kept local so this module has no heavy imports. */
export const WA_STATUS = Object.freeze({
  ERROR: 0,
  PENDING: 1,
  SERVER_ACK: 2,
  DELIVERY_ACK: 3,
  READ: 4,
  PLAYED: 5,
})

/** proto.WebMessageInfo.StubType values used by the mapping below. */
export const STUB_TYPE = Object.freeze({
  UNKNOWN: 0,
  REVOKE: 1,
  CIPHERTEXT: 2,
  GROUP_CREATE: 20,
  GROUP_CHANGE_SUBJECT: 21,
  GROUP_CHANGE_ICON: 22,
  GROUP_CHANGE_INVITE_LINK: 23,
  GROUP_CHANGE_DESCRIPTION: 24,
  GROUP_CHANGE_RESTRICT: 25,
  GROUP_CHANGE_ANNOUNCE: 26,
  GROUP_PARTICIPANT_ADD: 27,
  GROUP_PARTICIPANT_REMOVE: 28,
  GROUP_PARTICIPANT_PROMOTE: 29,
  GROUP_PARTICIPANT_DEMOTE: 30,
  GROUP_PARTICIPANT_INVITE: 31,
  GROUP_PARTICIPANT_LEAVE: 32,
  GROUP_PARTICIPANT_CHANGE_NUMBER: 33,
  BROADCAST_CREATE: 34,
  BROADCAST_ADD: 35,
  BROADCAST_REMOVE: 36,
  GENERIC_NOTIFICATION: 37,
  E2E_IDENTITY_CHANGED: 38,
  E2E_ENCRYPTED: 39,
  CALL_MISSED_VOICE: 40,
  CALL_MISSED_VIDEO: 41,
  INDIVIDUAL_CHANGE_NUMBER: 42,
  GROUP_DELETE: 43,
  GROUP_ANNOUNCE_MODE_MESSAGE_BOUNCE: 44,
  CALL_MISSED_GROUP_VOICE: 45,
  CALL_MISSED_GROUP_VIDEO: 46,
  CHANGE_EPHEMERAL_SETTING: 72,
  E2E_DEVICE_CHANGED: 73,
})

/** proto.Message.ProtocolMessage.Type values used here. */
export const PROTOCOL_TYPE = Object.freeze({
  REVOKE: 0,
  MESSAGE_EDIT: 14,
})

const MEDIA_CONTENT_TYPES = Object.freeze({
  imageMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  stickerMessage: 'sticker',
})

const DEFAULT_MIMETYPES = Object.freeze({
  imageMessage: 'image/jpeg',
  videoMessage: 'video/mp4',
  audioMessage: 'audio/ogg',
  documentMessage: 'application/octet-stream',
  stickerMessage: 'image/webp',
})

const SYSTEM_STUB_TYPES = new Set([
  STUB_TYPE.GROUP_CREATE,
  STUB_TYPE.GROUP_CHANGE_SUBJECT,
  STUB_TYPE.GROUP_CHANGE_ICON,
  STUB_TYPE.GROUP_CHANGE_INVITE_LINK,
  STUB_TYPE.GROUP_CHANGE_DESCRIPTION,
  STUB_TYPE.GROUP_CHANGE_RESTRICT,
  STUB_TYPE.GROUP_CHANGE_ANNOUNCE,
  STUB_TYPE.GROUP_PARTICIPANT_ADD,
  STUB_TYPE.GROUP_PARTICIPANT_REMOVE,
  STUB_TYPE.GROUP_PARTICIPANT_PROMOTE,
  STUB_TYPE.GROUP_PARTICIPANT_DEMOTE,
  STUB_TYPE.GROUP_PARTICIPANT_INVITE,
  STUB_TYPE.GROUP_PARTICIPANT_LEAVE,
  STUB_TYPE.GROUP_PARTICIPANT_CHANGE_NUMBER,
  STUB_TYPE.BROADCAST_CREATE,
  STUB_TYPE.BROADCAST_ADD,
  STUB_TYPE.BROADCAST_REMOVE,
  STUB_TYPE.GENERIC_NOTIFICATION,
  STUB_TYPE.E2E_IDENTITY_CHANGED,
  STUB_TYPE.E2E_ENCRYPTED,
  STUB_TYPE.INDIVIDUAL_CHANGE_NUMBER,
  STUB_TYPE.GROUP_DELETE,
  STUB_TYPE.GROUP_ANNOUNCE_MODE_MESSAGE_BOUNCE,
  STUB_TYPE.CHANGE_EPHEMERAL_SETTING,
  STUB_TYPE.E2E_DEVICE_CHANGED,
])

const MISSED_CALL_STUBS = new Set([
  STUB_TYPE.CALL_MISSED_VOICE,
  STUB_TYPE.CALL_MISSED_VIDEO,
  STUB_TYPE.CALL_MISSED_GROUP_VOICE,
  STUB_TYPE.CALL_MISSED_GROUP_VIDEO,
])

const MESSAGE_ID_PATTERN = /^[A-Za-z0-9._+=-]{1,512}$/
const CURSOR_TIMESTAMP_PATTERN = /^\d{1,16}$/

// ---------------------------------------------------------------------------
// Small value helpers
// ---------------------------------------------------------------------------

/** protobuf Long / bigint / Date / number -> finite number (null when not finite). */
export function toFiniteNumber(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  if (typeof value === 'string') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  if (value instanceof Date) {
    const n = value.getTime()
    return Number.isFinite(n) ? n : null
  }
  if (typeof value === 'object') {
    // protobufjs Long: {low, high, unsigned}
    if ('low' in value && 'high' in value) {
      const low = Number(value.low) >>> 0
      const high = Number(value.high) >>> 0
      const n = high * 0x100000000 + low
      return Number.isFinite(n) ? n : null
    }
    if (typeof value.toNumber === 'function') {
      try {
        const n = value.toNumber()
        return Number.isFinite(n) ? n : null
      } catch {
        return null
      }
    }
  }
  return null
}

/** WhatsApp timestamps are Unix seconds; contract timestamps are ms epoch. */
export function unixSecondsToMs(value) {
  const n = toFiniteNumber(value)
  if (n === null || n <= 0) return null
  // Some history payloads already carry milliseconds; accept both.
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n)
}

function clampInteger(value, fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = toFiniteNumber(value)
  if (n === null) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

function boolOr(value, fallback = false) {
  if (value === null || value === undefined) return fallback
  return value === true
}

/** Strip control characters, cap length; never HTML-escape (the client escapes). */
export function sanitizeText(value, max = 65536) {
  if (typeof value !== 'string') return ''
  const stripped = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  return stripped.length > max ? stripped.slice(0, max) : stripped
}

function safeString(value, max = 1024) {
  return typeof value === 'string' ? sanitizeText(value, max) : ''
}

function base64Of(value) {
  if (value === null || value === undefined) return null
  try {
    if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
    if (typeof value === 'string') return value
    if (Array.isArray(value)) return Buffer.from(Uint8Array.from(value)).toString('base64')
  } catch {
    return null
  }
  return null
}

function bytesOf(base64) {
  if (typeof base64 !== 'string' || base64 === '') return null
  try {
    const buffer = Buffer.from(base64, 'base64')
    return buffer.length > 0 ? buffer : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// JID helpers
// ---------------------------------------------------------------------------

/** Remove the device suffix (`123:4@s.whatsapp.net` -> `123@s.whatsapp.net`). */
export function normalizeJid(jid) {
  if (typeof jid !== 'string') return ''
  const trimmed = jid.trim()
  if (trimmed === '') return ''
  const at = trimmed.indexOf('@')
  if (at <= 0) return trimmed
  const user = trimmed.slice(0, at)
  const server = trimmed.slice(at + 1).toLowerCase()
  const userJidServers = new Set(['s.whatsapp.net', 'c.us', 'lid'])
  const bareUser = userJidServers.has(server) ? user.split(':')[0] : user
  const normalizedServer = server === 'c.us' ? 's.whatsapp.net' : server
  return `${bareUser}@${normalizedServer}`
}

export function isGroupJid(jid) {
  return typeof jid === 'string' && normalizeJid(jid).endsWith('@g.us')
}

export function isStatusJid(jid) {
  return normalizeJid(jid) === 'status@broadcast'
}

export function isBroadcastJid(jid) {
  return typeof jid === 'string' && normalizeJid(jid).endsWith('@broadcast')
}

export function isNewsletterJid(jid) {
  return typeof jid === 'string' && normalizeJid(jid).endsWith('@newsletter')
}

export function isLidJid(jid) {
  return normalizeJid(jid).endsWith('@lid')
}

/** Individual person jid (phone or LID); groups/broadcasts are not chats here. */
export function isUserJid(jid) {
  const normalized = normalizeJid(jid)
  return normalized.endsWith('@s.whatsapp.net') || normalized.endsWith('@lid')
}

/** Chats we cache: 1:1 conversations and groups (status/broadcast/newsletter skipped). */
export function isChatJid(jid) {
  return isUserJid(jid) || isGroupJid(jid)
}

/** Digits of a phone jid; empty for groups, status/broadcast and LID jids. */
export function phoneFromJid(jid) {
  const normalized = normalizeJid(jid)
  if (!isUserJid(normalized) || isLidJid(normalized)) return ''
  const at = normalized.indexOf('@')
  if (at <= 0) return ''
  const user = normalized.slice(0, at)
  return /^\d+$/.test(user) ? user : ''
}

/** A safe display fallback: contact name, else phone digits, else the raw id. */
export function displayNameForJid(jid, name = '') {
  const preferred = safeString(name, 200).trim()
  if (preferred !== '') return preferred
  const phone = phoneFromJid(jid)
  if (phone !== '') return `+${phone}`
  return normalizeJid(jid)
}

// ---------------------------------------------------------------------------
// Content normalization / classification
// ---------------------------------------------------------------------------

function futureProofInner(content) {
  return (
    content?.ephemeralMessage ||
    content?.viewOnceMessage ||
    content?.documentWithCaptionMessage ||
    content?.viewOnceMessageV2 ||
    content?.viewOnceMessageV2Extension ||
    content?.associatedChildMessage ||
    content?.groupStatusMessage ||
    content?.groupStatusMessageV2 ||
    content?.editedMessage
  )
}

/**
 * Unwrap ephemeral/view-once/edited/device-sent wrappers (same rules as
 * Baileys' `normalizeMessageContent`), reporting whether the message was an
 * edit or a view-once which the UI may want to hint at.
 */
export function unwrapContent(content) {
  let current = content
  let edited = false
  let viewOnce = false
  // A direct MESSAGE_EDIT protocol message carries the new content too.
  if (current?.protocolMessage?.type === PROTOCOL_TYPE.MESSAGE_EDIT && current.protocolMessage.editedMessage) {
    current = current.protocolMessage.editedMessage
    edited = true
  }
  for (let i = 0; i < 5; i += 1) {
    const inner = futureProofInner(current)
    if (!inner || !inner.message) break
    if (current.editedMessage === inner) edited = true
    if (
      current.viewOnceMessage === inner ||
      current.viewOnceMessageV2 === inner ||
      current.viewOnceMessageV2Extension === inner
    ) {
      viewOnce = true
    }
    current = inner.message
  }
  return { content: current, edited, viewOnce }
}

/** Baileys' `getContentType` equivalent. */
export function getContentType(content) {
  if (!content || typeof content !== 'object') return null
  const key = Object.keys(content).find(
    (candidate) =>
      (candidate === 'conversation' || candidate === 'call' || candidate.includes('Message')) &&
      candidate !== 'senderKeyDistributionMessage',
  )
  return key ?? null
}

/** The text/label carried by a content object, if any. */
export function textOfContent(content) {
  if (!content || typeof content !== 'object') return ''
  const type = getContentType(content)
  if (!type) return ''
  const value = content[type]
  if (!value || typeof value !== 'object') {
    return type === 'conversation' && typeof value === 'string' ? sanitizeText(value) : ''
  }
  switch (type) {
    case 'conversation':
      return sanitizeText(content.conversation)
    case 'extendedTextMessage':
      return sanitizeText(value.text ?? value.matchedText ?? '')
    case 'imageMessage':
    case 'videoMessage':
    case 'documentMessage':
      return sanitizeText(value.caption ?? '')
    case 'audioMessage':
      return value.ptt === true ? 'Voice message' : 'Audio message'
    case 'stickerMessage':
      return value.isAnimated === true ? 'Animated sticker' : 'Sticker'
    case 'locationMessage':
      return safeString(value.name ?? value.address ?? '', 300) || 'Location'
    case 'liveLocationMessage':
      return 'Live location'
    case 'contactMessage':
      return safeString(value.displayName ?? '', 200) || 'Contact'
    case 'contactsArrayMessage': {
      const count = Array.isArray(value.contacts) ? value.contacts.length : 0
      const name = safeString(value.displayName ?? '', 200)
      if (name !== '') return name
      return count > 1 ? `${count} contacts` : 'Contact'
    }
    case 'call':
      return 'Call'
    case 'protocolMessage':
      if (value.type === PROTOCOL_TYPE.REVOKE) return 'This message was deleted'
      return ''
    case 'buttonsMessage':
      return safeString(value.contentText ?? value.headerText ?? '', 500)
    case 'templateMessage':
      return safeString(value.hydratedTemplate?.hydratedContentText ?? '', 500)
    case 'listMessage':
      return safeString(value.title ?? '', 500)
    case 'pollCreationMessage':
      return safeString(value.name ?? '', 500)
    case 'eventMessage':
      return safeString(value.name ?? '', 500)
    case 'groupInviteMessage':
      return 'Group invite'
    default:
      return ''
  }
}

/** Map the raw content type string to a CONTRACT kind. */
export function kindOfContent(content) {
  const type = getContentType(content)
  if (!type) return 'unknown'
  if (type === 'conversation' || type === 'extendedTextMessage') return 'text'
  const mediaKind = MEDIA_CONTENT_TYPES[type]
  if (mediaKind) return mediaKind
  if (type === 'locationMessage' || type === 'liveLocationMessage') return 'location'
  if (type === 'contactMessage' || type === 'contactsArrayMessage') return 'contact'
  if (type === 'call') return 'call'
  if (type === 'protocolMessage') return 'system'
  if (type === 'messageContextInfo' || type === 'senderKeyDistributionMessage') return 'unknown'
  return 'unknown'
}

/** Derive a human label for a missed-call/system stub, never HTML. */
export function textOfStub(stubType, parameters = []) {
  const params = Array.isArray(parameters) ? parameters.filter((value) => typeof value === 'string') : []
  const first = safeString(params[0] ?? '', 200)
  switch (stubType) {
    case STUB_TYPE.REVOKE:
      return 'This message was deleted'
    case STUB_TYPE.CALL_MISSED_VOICE:
      return 'Missed voice call'
    case STUB_TYPE.CALL_MISSED_VIDEO:
      return 'Missed video call'
    case STUB_TYPE.CALL_MISSED_GROUP_VOICE:
      return 'Missed group voice call'
    case STUB_TYPE.CALL_MISSED_GROUP_VIDEO:
      return 'Missed group video call'
    case STUB_TYPE.GROUP_CREATE:
      return first !== '' ? `${first} created the group` : 'Group created'
    case STUB_TYPE.GROUP_CHANGE_SUBJECT:
      return first !== '' ? `Group subject changed to "${first}"` : 'Group subject changed'
    case STUB_TYPE.GROUP_CHANGE_ICON:
      return 'Group icon changed'
    case STUB_TYPE.GROUP_CHANGE_DESCRIPTION:
      return 'Group description changed'
    case STUB_TYPE.GROUP_CHANGE_INVITE_LINK:
      return 'Group invite link changed'
    case STUB_TYPE.GROUP_CHANGE_RESTRICT:
      return 'Group info settings changed'
    case STUB_TYPE.GROUP_CHANGE_ANNOUNCE:
      return 'Group message permissions changed'
    case STUB_TYPE.GROUP_PARTICIPANT_ADD:
      return first !== '' ? `${first} joined the group` : 'Participant added'
    case STUB_TYPE.GROUP_PARTICIPANT_REMOVE:
      return first !== '' ? `${first} was removed` : 'Participant removed'
    case STUB_TYPE.GROUP_PARTICIPANT_PROMOTE:
      return first !== '' ? `${first} was promoted to admin` : 'Participant promoted'
    case STUB_TYPE.GROUP_PARTICIPANT_DEMOTE:
      return first !== '' ? `${first} was dismissed as admin` : 'Participant demoted'
    case STUB_TYPE.GROUP_PARTICIPANT_INVITE:
      return first !== '' ? `${first} was invited` : 'Participant invited'
    case STUB_TYPE.GROUP_PARTICIPANT_LEAVE:
      return first !== '' ? `${first} left the group` : 'Participant left'
    case STUB_TYPE.GROUP_PARTICIPANT_CHANGE_NUMBER:
      return 'Participant changed their phone number'
    case STUB_TYPE.GROUP_DELETE:
      return 'Group deleted'
    case STUB_TYPE.BROADCAST_CREATE:
      return 'Broadcast list created'
    case STUB_TYPE.BROADCAST_ADD:
      return 'Added to broadcast list'
    case STUB_TYPE.BROADCAST_REMOVE:
      return 'Removed from broadcast list'
    case STUB_TYPE.GENERIC_NOTIFICATION:
      return first !== '' ? first : 'Notification'
    case STUB_TYPE.E2E_IDENTITY_CHANGED:
      return 'Security code changed'
    case STUB_TYPE.E2E_ENCRYPTED:
      return 'Messages are end-to-end encrypted'
    case STUB_TYPE.E2E_DEVICE_CHANGED:
      return 'A linked device was added or removed'
    case STUB_TYPE.INDIVIDUAL_CHANGE_NUMBER:
      return 'Contact changed their phone number'
    case STUB_TYPE.CHANGE_EPHEMERAL_SETTING:
      return first !== '' ? `Disappearing messages set to ${first}` : 'Disappearing messages changed'
    case STUB_TYPE.CIPHERTEXT:
      return 'Waiting for this message'
    case STUB_TYPE.UNKNOWN:
      return ''
    default:
      return ''
  }
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

const STATUS_RANK = Object.freeze({
  unknown: 0,
  pending: 1,
  sent: 2,
  delivered: 3,
  read: 4,
  played: 5,
  error: 6,
})

/** WAMessageStatus enum -> CONTRACT status. */
export function statusFromRaw(rawStatus) {
  const n = toFiniteNumber(rawStatus)
  switch (n) {
    case WA_STATUS.ERROR:
      return 'error'
    case WA_STATUS.PENDING:
      return 'pending'
    case WA_STATUS.SERVER_ACK:
      return 'sent'
    case WA_STATUS.DELIVERY_ACK:
      return 'delivered'
    case WA_STATUS.READ:
      return 'read'
    case WA_STATUS.PLAYED:
      return 'played'
    default:
      return 'unknown'
  }
}

/** Pick the more advanced of two statuses (receipts only ever move forward). */
export function betterStatus(current, next) {
  if (!(next in STATUS_RANK)) return current in STATUS_RANK ? current : 'unknown'
  if (!(current in STATUS_RANK)) return next
  if (next === 'error') return 'error'
  if (current === 'error') return current
  return STATUS_RANK[next] > STATUS_RANK[current] ? next : current
}

/** Message receipt -> aggregate status for our own outgoing message. */
export function statusFromReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object') return 'delivered'
  if (receipt.playedTimestamp) return 'played'
  if (receipt.readTimestamp) return 'read'
  if (receipt.receiptTimestamp) return 'delivered'
  return 'delivered'
}

// ---------------------------------------------------------------------------
// Media helpers
// ---------------------------------------------------------------------------

/** Media metadata (CONTRACT Message.media) for a content object, else null. */
export function mediaMetadata(content) {
  if (!content || typeof content !== 'object') return null
  const type = getContentType(content)
  if (!type || !(type in MEDIA_CONTENT_TYPES)) return null
  const media = content[type]
  if (!media || typeof media !== 'object') return null
  const kind = MEDIA_CONTENT_TYPES[type]
  return {
    mimetype: safeString(media.mimetype, 200) || DEFAULT_MIMETYPES[type],
    fileName: safeString(media.fileName ?? media.title ?? '', 300),
    fileLength: clampInteger(media.fileLength, 0, 0, Number.MAX_SAFE_INTEGER),
    seconds: toFiniteNumber(media.seconds) === null ? null : Math.max(0, Math.floor(toFiniteNumber(media.seconds))),
    width: toFiniteNumber(media.width) === null ? null : Math.max(0, Math.floor(toFiniteNumber(media.width))),
    height: toFiniteNumber(media.height) === null ? null : Math.max(0, Math.floor(toFiniteNumber(media.height))),
    ptt: media.ptt === true,
    animated: Boolean(media.gifPlayback === true || media.isAnimated === true),
    hasThumbnail: typeof media.jpegThumbnail !== 'undefined' && media.jpegThumbnail !== null,
  }
}

/** JPEG thumbnail -> data URL (only for image/video/document previews). */
export function thumbnailOfContent(content) {
  if (!content || typeof content !== 'object') return null
  const type = getContentType(content)
  if (!['imageMessage', 'videoMessage', 'documentMessage'].includes(type)) return null
  const request = content[type]
  const thumbnail = request?.jpegThumbnail
  if (!thumbnail) return null
  try {
    const buffer = thumbnail instanceof Uint8Array ? Buffer.from(thumbnail) : Buffer.from(thumbnail)
    if (buffer.length === 0 || buffer.length > MAX_THUMBNAIL_BYTES) return null
    return `data:image/jpeg;base64,${buffer.toString('base64')}`
  } catch {
    return null
  }
}

/** Location object (CONTRACT Message.location), else null. */
export function locationOfContent(content) {
  if (!content || typeof content !== 'object') return null
  const type = getContentType(content)
  if (type !== 'locationMessage' && type !== 'liveLocationMessage') return null
  const location = content[type]
  if (!location || typeof location !== 'object') return null
  const lat = toFiniteNumber(location.degreesLatitude)
  const lng = toFiniteNumber(location.degreesLongitude)
  if (lat === null || lng === null) return null
  return {
    lat,
    lng,
    name: safeString(location.name ?? '', 300),
    address: safeString(location.address ?? '', 500),
  }
}

/** Contact object (CONTRACT Message.contact), else null. */
export function contactOfContent(content) {
  if (!content || typeof content !== 'object') return null
  const type = getContentType(content)
  if (type === 'contactMessage') {
    const contact = content.contactMessage
    if (!contact || typeof contact !== 'object') return null
    return {
      displayName: safeString(contact.displayName ?? '', 300),
      vcard: safeString(contact.vcard ?? '', 10000),
    }
  }
  if (type === 'contactsArrayMessage') {
    const contacts = Array.isArray(content.contactsArrayMessage?.contacts) ? content.contactsArrayMessage.contacts : []
    const first = contacts[0]
    if (!first || typeof first !== 'object') return null
    return {
      displayName: safeString(content.contactsArrayMessage.displayName ?? first.displayName ?? '', 300),
      vcard: safeString(first.vcard ?? '', 10000),
    }
  }
  return null
}

/** Serializable description of a downloadable media message (persisted encrypted). */
export function mediaSourceOf(rawMessage) {
  const { content } = unwrapContent(rawMessage?.message)
  if (!content) return null
  const type = getContentType(content)
  if (!type || !(type in MEDIA_CONTENT_TYPES)) return null
  const media = content[type]
  if (!media || typeof media !== 'object') return null
  return {
    type,
    mimetype: safeString(media.mimetype, 200) || DEFAULT_MIMETYPES[type],
    fileName: safeString(media.fileName ?? media.title ?? '', 300),
    mediaKey: base64Of(media.mediaKey),
    directPath: typeof media.directPath === 'string' ? media.directPath : null,
    url: typeof media.url === 'string' ? media.url : null,
    fileEncSha256: base64Of(media.fileEncSha256),
    fileSha256: base64Of(media.fileSha256),
    mediaKeyTimestamp: toFiniteNumber(media.mediaKeyTimestamp),
  }
}

/** Rebuild a Baileys `proto.IMessage` content object from a media source. */
export function contentFromMediaSource(source) {
  if (!source || typeof source !== 'object' || typeof source.type !== 'string') return null
  if (!(source.type in MEDIA_CONTENT_TYPES)) return null
  const media = {
    mimetype: source.mimetype || DEFAULT_MIMETYPES[source.type],
    fileName: source.fileName || undefined,
    mediaKey: bytesOf(source.mediaKey) ?? undefined,
    directPath: source.directPath ?? undefined,
    url: source.url ?? undefined,
    fileEncSha256: bytesOf(source.fileEncSha256) ?? undefined,
    fileSha256: bytesOf(source.fileSha256) ?? undefined,
    mediaKeyTimestamp: source.mediaKeyTimestamp ?? undefined,
  }
  return { [source.type]: media }
}

/** Build the minimal WAMessage Baileys needs to quote a stored message. */
export function quoteFromStored(message, mediaSource = null) {
  if (!message || typeof message.id !== 'string') return null
  const content = contentFromMediaSource(mediaSource) ?? {
    extendedTextMessage: { text: sanitizeText(message.text ?? '', 2048) },
  }
  return {
    key: {
      remoteJid: message.chatId,
      id: message.id,
      fromMe: message.fromMe === true,
    },
    message: content,
    messageTimestamp: Math.max(0, Math.floor(Number(message.timestamp ?? 0) / 1000)),
    pushName: message.authorName ?? undefined,
  }
}

// ---------------------------------------------------------------------------
// Message mapping
// ---------------------------------------------------------------------------

function quotedOfContent(content, resolveName) {
  const contextInfo =
    (content?.extendedTextMessage?.contextInfo) ||
    (content?.imageMessage?.contextInfo) ||
    (content?.videoMessage?.contextInfo) ||
    (content?.audioMessage?.contextInfo) ||
    (content?.documentMessage?.contextInfo) ||
    (content?.stickerMessage?.contextInfo) ||
    (content?.locationMessage?.contextInfo) ||
    (content?.contactMessage?.contextInfo) ||
    (content?.contactsArrayMessage?.contextInfo) ||
    (content?.call?.contextInfo) ||
    (content?.protocolMessage?.contextInfo) ||
    null
  if (!contextInfo || typeof contextInfo !== 'object') return null
  const id = safeString(contextInfo.stanzaId ?? '', 256)
  if (id === '') return null
  const authorJid = normalizeJid(contextInfo.participant ?? contextInfo.remoteJid ?? '')
  let authorName = null
  if (authorJid !== '' && typeof resolveName === 'function') {
    authorName = resolveName(authorJid) ?? null
  }
  const inner = unwrapContent(contextInfo.quotedMessage).content
  return {
    id,
    authorName,
    text: sanitizeText(textOfContent(inner), 2048),
  }
}

/**
 * Baileys WAMessage -> CONTRACT Message.
 *
 * @param {object} raw WAMessage
 * @param {{ chatId?: string, resolveName?: (jid: string) => (string|null|undefined), now?: number, defaultStatus?: string }} [options]
 * @returns {object} Message
 */
export function mapMessage(raw, options = {}) {
  const message = raw && typeof raw === 'object' ? raw : {}
  const key = message.key && typeof message.key === 'object' ? message.key : {}
  const chatId = normalizeJid(options.chatId ?? key.remoteJid ?? key.remoteJidAlt ?? '')
  const fromMe = key.fromMe === true
  const isGroup = isGroupJid(chatId)
  const participant = key.participant ?? key.participantAlt ?? message.participant ?? null
  const author = isGroup && typeof participant === 'string' && normalizeJid(participant) !== ''
    ? normalizeJid(participant)
    : null
  const resolveName = typeof options.resolveName === 'function' ? options.resolveName : null
  const authorName = author !== null && resolveName ? (resolveName(author) ?? null) : null

  const { content, edited: editedWrapper } = unwrapContent(message.message)
  const stubType = toFiniteNumber(message.messageStubType)
  const contentKind = kindOfContent(content)
  const protocolType = content?.protocolMessage?.type

  let kind = contentKind
  let edited = editedWrapper
  let revoked = false
  let text = textOfContent(content)

  if (protocolType === PROTOCOL_TYPE.REVOKE) {
    revoked = true
    kind = 'system'
    text = 'This message was deleted'
  } else if (protocolType === PROTOCOL_TYPE.MESSAGE_EDIT) {
    edited = true
    if (content?.protocolMessage?.editedMessage) {
      text = sanitizeText(textOfContent(content.protocolMessage.editedMessage), 65536)
    }
  }

  if (stubType !== null && stubType !== STUB_TYPE.UNKNOWN) {
    if (stubType === STUB_TYPE.REVOKE) {
      revoked = true
      kind = 'system'
      text = 'This message was deleted'
    } else if (MISSED_CALL_STUBS.has(stubType)) {
      kind = 'call'
      text = textOfStub(stubType, message.messageStubParameters)
    } else if (SYSTEM_STUB_TYPES.has(stubType)) {
      kind = 'system'
      text = textOfStub(stubType, message.messageStubParameters)
    } else {
      // Payment / unknown server-generated notices: show them as system lines
      // only when they carry a useful description; otherwise keep the content.
      const stubText = textOfStub(stubType, message.messageStubParameters)
      if (stubText !== '') {
        kind = 'system'
        text = stubText
      }
    }
  }

  if (kind === 'call' && text === '') text = 'Call'

  const media = kind in MEDIA_CONTENT_TYPES || ['image', 'video', 'audio', 'document', 'sticker'].includes(kind)
    ? mediaMetadata(content)
    : null

  const status =
    message.status !== null && message.status !== undefined
      ? statusFromRaw(message.status)
      : (options.defaultStatus ?? 'unknown')

  return {
    id: safeString(key.id ?? '', 256),
    chatId,
    fromMe,
    author,
    authorName,
    timestamp: unixSecondsToMs(message.messageTimestamp) ?? (options.now ?? Date.now()),
    kind: MESSAGE_KINDS.includes(kind) ? kind : 'unknown',
    text: sanitizeText(text, 65536),
    quoted: quotedOfContent(content, resolveName),
    media: media ?? null,
    thumbnail: thumbnailOfContent(content),
    location: locationOfContent(content),
    contact: contactOfContent(content),
    status: ['pending', 'sent', 'delivered', 'read', 'played', 'error', 'unknown'].includes(status) ? status : 'unknown',
    revoked,
    edited,
  }
}

/** Short preview used by ChatSummary.lastMessage. */
export function lastMessagePreview(message) {
  if (!message || typeof message !== 'object') return null
  return {
    id: safeString(message.id ?? '', 256),
    text: sanitizeText(message.text ?? '', 200),
    fromMe: message.fromMe === true,
    timestamp: clampInteger(message.timestamp, 0),
    kind: MESSAGE_KINDS.includes(message.kind) ? message.kind : 'unknown',
  }
}

/**
 * Baileys Chat (history/app state) -> CONTRACT ChatSummary.
 *
 * @param {object} chat proto.IConversation-like object
 * @param {{ resolveName?: (jid: string) => (string|null|undefined), now?: number, lastMessage?: object }} [options]
 */
export function mapChat(chat, options = {}) {
  const source = chat && typeof chat === 'object' ? chat : {}
  const id = normalizeJid(source.id ?? '')
  const isGroup = isGroupJid(id)
  const contactName = id !== '' && typeof options.resolveName === 'function' ? options.resolveName(id) : null
  const name = safeString(source.name ?? source.displayName ?? contactName ?? '', 200)
    || displayNameForJid(id)
  const timestamp =
    unixSecondsToMs(source.conversationTimestamp) ??
    unixSecondsToMs(source.lastMsgTimestamp) ??
    (options.lastMessage ? clampInteger(options.lastMessage.timestamp, 0) : 0)
  const muteEnd = unixSecondsToMs(source.muteEndTime)
  const now = options.now ?? Date.now()
  return {
    id,
    name,
    isGroup,
    unread: clampInteger(source.unreadCount, 0, 0, 1_000_000),
    pinned: source.pinned === true || Number(source.pinned) > 0,
    muted: muteEnd !== null && muteEnd > now,
    archived: source.archived === true,
    timestamp,
    lastMessage: options.lastMessage ? lastMessagePreview(options.lastMessage) : null,
  }
}

/**
 * Partial chat update (chats.update / app-state patches) -> partial ChatSummary.
 * Fields absent from the update are omitted so the store keeps its old value.
 */
export function mapChatUpdate(update, options = {}) {
  const source = update && typeof update === 'object' ? update : {}
  const id = normalizeJid(source.id ?? '')
  if (!isChatJid(id)) return null
  const partial = { id }
  const has = (key) => Object.prototype.hasOwnProperty.call(source, key)
  if (typeof source.name === 'string' && source.name !== '') partial.name = sanitizeText(source.name, 200)
  if (has('unreadCount')) partial.unread = clampInteger(source.unreadCount, 0, 0, 1_000_000)
  if (has('conversationTimestamp')) {
    const timestamp = unixSecondsToMs(source.conversationTimestamp)
    if (timestamp !== null) partial.timestamp = timestamp
  }
  if (has('pinned')) partial.pinned = source.pinned === true || Number(source.pinned) > 0
  if (has('archived')) partial.archived = source.archived === true
  if (has('muteEndTime')) {
    const muteEnd = unixSecondsToMs(source.muteEndTime)
    partial.muted = muteEnd !== null && muteEnd > (options.now ?? Date.now())
  }
  return partial
}

/** Baileys Contact -> compact persisted contact record. */
export function mapContact(contact) {
  const source = contact && typeof contact === 'object' ? contact : {}
  const id = normalizeJid(source.id ?? '')
  return {
    id,
    lid: normalizeJid(source.lid ?? ''),
    phoneNumber: phoneFromJid(normalizeJid(source.phoneNumber ?? '')) || phoneFromJid(id),
    name: safeString(source.name ?? '', 200),
    notify: safeString(source.notify ?? '', 200),
    verifiedName: safeString(source.verifiedName ?? '', 200),
    username: safeString(source.username ?? '', 200),
  }
}

/** Display name for a conversation from a contact record (name wins, notify next). */
export function contactDisplayName(contact) {
  if (!contact || typeof contact !== 'object') return ''
  return safeString(contact.name ?? '', 200) || safeString(contact.verifiedName ?? '', 200) || safeString(contact.notify ?? '', 200)
}

/** Baileys WACallEvent -> CONTRACT call event payload. */
export function mapCall(call) {
  const source = call && typeof call === 'object' ? call : {}
  const from = normalizeJid(source.from ?? source.chatId ?? '')
  const chatId = normalizeJid(source.chatId ?? source.from ?? '')
  return {
    id: safeString(source.id ?? '', 256),
    from,
    chatId,
    isVideo: source.isVideo === true,
    date: source.date instanceof Date ? source.date.getTime() : (toFiniteNumber(source.date) ?? Date.now()),
    status: safeString(source.status ?? 'unknown', 60) || 'unknown',
  }
}

// ---------------------------------------------------------------------------
// Cursor helpers (opaque `${timestamp}:${id}`)
// ---------------------------------------------------------------------------

export function encodeCursor(timestamp, id) {
  const ts = clampInteger(timestamp, 0, 0, Number.MAX_SAFE_INTEGER)
  const safeId = safeString(id ?? '', 512).replace(/[:\u0000-\u001f\s]/g, '')
  return `${ts}:${safeId}`
}

export function decodeCursor(cursor) {
  if (typeof cursor !== 'string') return null
  const trimmed = cursor.trim()
  if (trimmed === '' || trimmed.length > 700) return null
  const split = trimmed.indexOf(':')
  if (split <= 0) return null
  const timestampPart = trimmed.slice(0, split)
  const id = trimmed.slice(split + 1)
  if (!CURSOR_TIMESTAMP_PATTERN.test(timestampPart)) return null
  if (!MESSAGE_ID_PATTERN.test(id)) return null
  const timestamp = Number(timestampPart)
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) return null
  return { timestamp, id }
}

/** Loose super-set check for a WhatsApp message id (hex/base64-ish, no spaces). */
export function isMessageIdLike(value) {
  return typeof value === 'string' && MESSAGE_ID_PATTERN.test(value)
}

/** Chronological ordering used by the store and pagination. */
export function compareMessages(a, b) {
  const left = clampInteger(a?.timestamp, 0)
  const right = clampInteger(b?.timestamp, 0)
  if (left !== right) return left - right
  const leftId = String(a?.id ?? '')
  const rightId = String(b?.id ?? '')
  if (leftId < rightId) return -1
  if (leftId > rightId) return 1
  return 0
}

/** True when `message` sorts strictly before the cursor. */
export function isBeforeCursor(message, cursor) {
  if (!cursor) return false
  const ts = clampInteger(message?.timestamp, 0)
  if (ts !== cursor.timestamp) return ts < cursor.timestamp
  return String(message?.id ?? '') < cursor.id
}
