/**
 * Encrypted-at-rest storage primitives.
 *
 * Nothing here knows about WhatsApp. It owns one 32-byte master key per data
 * directory and seals named files with AES-256-GCM. The key lives in `key.bin`
 * (mode 0600) unless `DSH_WHATSAPP_PASSPHRASE` is set, in which case it is
 * derived with scrypt from the passphrase and `salt.bin`; in that mode no key
 * file exists at all. This protects an offline copy of the profile directory and
 * backups. It is not a defence against malicious code running as the same OS
 * user, and the plugin says so in its README.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const MAGIC = 'DSHWA1'
const AAD_PREFIX = 'dsh-whatsapp/v1/'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const SCRYPT_OPS = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

export class SecretBoxError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'SecretBoxError'
    this.code = code
  }
}

function aad(name) {
  return Buffer.from(AAD_PREFIX + name, 'utf8')
}

async function ensurePrivateDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  try {
    const stat = await fs.stat(dir)
    if ((stat.mode & 0o077) !== 0) await fs.chmod(dir, 0o700)
  } catch {
    // Windows has no POSIX mode bits; best effort is enough.
  }
}

async function readPrivateFile(file) {
  try {
    return await fs.readFile(file)
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

async function writePrivateFile(file, data) {
  const dir = path.dirname(file)
  await ensurePrivateDir(dir)
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`)
  let handle
  try {
    handle = await fs.open(tmp, 'w', 0o600)
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    handle = null
    await fs.rename(tmp, file)
    try {
      await fs.chmod(file, 0o600)
    } catch {
      // Best effort on filesystems without POSIX permissions.
    }
  } catch (error) {
    if (handle) {
      try { await handle.close() } catch { /* nothing else to do */ }
    }
    try { await fs.unlink(tmp) } catch { /* the rename may have happened */ }
    throw error
  }
}

async function deletePrivateFile(file) {
  try {
    await fs.unlink(file)
  } catch (error) {
    if (error && error.code === 'ENOENT') return
    throw error
  }
}

function envelopeName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 128 || name.includes('/') || name.includes('\\')) {
    throw new SecretBoxError('bad-name', 'secret file name must be a short basename')
  }
  return name
}

/**
 * Seal bytes under the named file's AAD. Returns the serialized envelope, ready
 * to atomically write to `<dataDir>/<name>`.
 */
function sealBytes(key, name, plaintext) {
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
  cipher.setAAD(aad(name))
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  const envelope = {
    v: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: data.toString('base64'),
  }
  return Buffer.from(`${MAGIC}\n${JSON.stringify(envelope)}\n`, 'utf8')
}

function openBytes(key, name, fileBytes) {
  const text = fileBytes.toString('utf8')
  if (!text.startsWith(`${MAGIC}\n`)) {
    throw new SecretBoxError('corrupt', `${name}: not a dsh-whatsapp secret file`)
  }
  let envelope
  try {
    envelope = JSON.parse(text.slice(MAGIC.length + 1))
  } catch {
    throw new SecretBoxError('corrupt', `${name}: malformed envelope`)
  }
  if (!envelope || envelope.v !== 1 || envelope.alg !== 'aes-256-gcm') {
    throw new SecretBoxError('corrupt', `${name}: unsupported envelope version`)
  }
  let iv, tag, data
  try {
    iv = Buffer.from(envelope.iv, 'base64')
    tag = Buffer.from(envelope.tag, 'base64')
    data = Buffer.from(envelope.data, 'base64')
  } catch {
    throw new SecretBoxError('corrupt', `${name}: malformed ciphertext fields`)
  }
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new SecretBoxError('corrupt', `${name}: malformed ciphertext fields`)
  }
  let decipher
  try {
    decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
    decipher.setAAD(aad(name))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()])
  } catch {
    throw new SecretBoxError('bad-key', `${name}: authentication failed (wrong passphrase, wrong key, or tampered file)`)
  }
}

export class SecretBox {
  #key
  #dataDir

  constructor({ key, dataDir, source }) {
    if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
      throw new SecretBoxError('bad-key', 'master key must be 32 bytes')
    }
    this.#key = key
    this.#dataDir = dataDir
    this.source = source
    this.closed = false
  }

  get dataDir() {
    return this.#dataDir
  }

  /** Serialize `value` (JSON, Buffers preserved by the caller's replacer), seal it. */
  seal(name, value) {
    if (this.closed) throw new SecretBoxError('closed', 'secret box is closed')
    const plain = Buffer.isBuffer(value) || value instanceof Uint8Array
      ? Buffer.from(value)
      : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
    return sealBytes(this.#key, envelopeName(name), plain)
  }

  /** Decrypt a sealed envelope back to bytes. */
  open(name, fileBytes) {
    if (this.closed) throw new SecretBoxError('closed', 'secret box is closed')
    if (!Buffer.isBuffer(fileBytes)) throw new SecretBoxError('corrupt', 'ciphertext must be a Buffer')
    return openBytes(this.#key, envelopeName(name), fileBytes)
  }

  async sealFile(name, value) {
    await writePrivateFile(path.join(this.#dataDir, envelopeName(name)), this.seal(name, value))
  }

  async openFile(name, { required = false } = {}) {
    const file = path.join(this.#dataDir, envelopeName(name))
    const bytes = await readPrivateFile(file)
    if (bytes === null) {
      if (required) throw new SecretBoxError('missing', `${name} is missing`)
      return null
    }
    return this.open(name, bytes)
  }

  async deleteFile(name) {
    await deletePrivateFile(path.join(this.#dataDir, envelopeName(name)))
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.#key.fill(0)
  }
}

/**
 * Open (or create) the master key for a data directory.
 * @param {{dataDir: string, passphrase?: string|null}} options
 * @returns {Promise<SecretBox>}
 */
export async function openSecretBox({ dataDir, passphrase = null }) {
  if (typeof dataDir !== 'string' || dataDir === '') throw new SecretBoxError('bad-dir', 'dataDir is required')
  await ensurePrivateDir(dataDir)

  if (typeof passphrase === 'string' && passphrase.length > 0) {
    const saltFile = path.join(dataDir, 'salt.bin')
    let salt = await readPrivateFile(saltFile)
    if (salt === null) {
      salt = crypto.randomBytes(16)
      await writePrivateFile(saltFile, salt)
    }
    if (salt.length < 16) throw new SecretBoxError('corrupt', 'salt.bin is too short')
    const key = crypto.scryptSync(Buffer.from(passphrase, 'utf8'), salt, KEY_BYTES, SCRYPT_OPS)
    return new SecretBox({ key, dataDir, source: 'passphrase' })
  }

  const keyFile = path.join(dataDir, 'key.bin')
  let key = await readPrivateFile(keyFile)
  if (key === null) {
    key = crypto.randomBytes(KEY_BYTES)
    await writePrivateFile(keyFile, key)
  }
  if (key.length !== KEY_BYTES) throw new SecretBoxError('corrupt', 'key.bin is not 32 bytes')
  return new SecretBox({ key, dataDir, source: 'keyfile' })
}

export { ensurePrivateDir, readPrivateFile, writePrivateFile, deletePrivateFile }
