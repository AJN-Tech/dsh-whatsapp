/**
 * lib/crypto.js — encrypted-at-rest primitives.
 *
 * These tests only use the real filesystem under the plugin's own .test-tmp
 * directory (never /tmp, never the network) and clean up after themselves.
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  openSecretBox,
  SecretBox,
  SecretBoxError,
} from '../lib/crypto.js'

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP_ROOT = path.join(PLUGIN_DIR, '.test-tmp', 'crypto')

// File-level cleanup: per-test t.after hooks close stores after the directory
// hook already ran, so the whole per-file root is removed once at the end.
after(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true })
})

let seq = 0

async function makeTempDir(t, prefix = 'crypto-') {
  await fs.mkdir(TMP_ROOT, { recursive: true })
  const dir = path.join(TMP_ROOT, `${prefix}${process.pid}-${seq++}-${Date.now()}`)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })
  return dir
}

function fileMode(stat) {
  return stat.mode & 0o777
}

async function exists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

async function expectCode(promiseOrFn, code) {
  const run = typeof promiseOrFn === 'function' ? promiseOrFn : () => promiseOrFn
  await assert.rejects(async () => {
    await run()
  }, (error) => {
    assert.ok(error instanceof SecretBoxError, `expected SecretBoxError, got ${error?.name}: ${error?.message}`)
    assert.equal(error.code, code)
    return true
  })
}

/** Rewrite one ciphertext byte inside a sealed envelope. */
function tamper(sealed) {
  const text = sealed.toString('utf8')
  const split = text.indexOf('\n')
  const magic = text.slice(0, split)
  const envelope = JSON.parse(text.slice(split + 1))
  const data = Buffer.from(envelope.data, 'base64')
  data[0] = data[0] ^ 0xff
  envelope.data = data.toString('base64')
  return Buffer.from(`${magic}\n${JSON.stringify(envelope)}\n`, 'utf8')
}

function replaceMagic(sealed) {
  const text = sealed.toString('utf8')
  return Buffer.from(`NOTDSH${text.slice(6)}`, 'utf8')
}

test('creates data dir 0700 and key.bin 0600, source is keyfile', async (t) => {
  const dir = await makeTempDir(t)
  const box = await openSecretBox({ dataDir: dir })
  t.after(() => box.close())

  assert.equal(box.source, 'keyfile')
  assert.equal(fileMode(await fs.stat(dir)), 0o700)

  const keyFile = path.join(dir, 'key.bin')
  assert.equal(fileMode(await fs.stat(keyFile)), 0o600)
  assert.equal((await fs.stat(keyFile)).size, 32)

  const second = await openSecretBox({ dataDir: dir })
  t.after(() => second.close())
  assert.equal(second.source, 'keyfile')
  // Reopening must reuse the same master key: seal with one, open with the other.
  const sealed = box.seal('creds.enc', { hello: 'world' })
  assert.deepEqual(JSON.parse(second.open('creds.enc', sealed).toString()), { hello: 'world' })
})

test('tightens a pre-existing group-readable data dir to 0700', async (t) => {
  const dir = await makeTempDir(t)
  await fs.chmod(dir, 0o755)
  const box = await openSecretBox({ dataDir: dir })
  t.after(() => box.close())
  assert.equal(fileMode(await fs.stat(dir)), 0o700)
})

test('seal/open roundtrip preserves JSON, strings, Buffers and Uint8Array', async (t) => {
  const dir = await makeTempDir(t)
  const box = await openSecretBox({ dataDir: dir })
  t.after(() => box.close())

  const value = { nested: { list: [1, 2, 3] }, name: 'creds', ok: true }
  const sealed = box.seal('creds.enc', value)
  assert.ok(Buffer.isBuffer(sealed))
  assert.ok(sealed.toString('utf8').startsWith('DSHWA1\n'))
  // Plaintext must not leak into the sealed bytes.
  assert.equal(sealed.includes(Buffer.from('nested')), false)
  assert.deepEqual(JSON.parse(box.open('creds.enc', sealed).toString('utf8')), value)

  assert.equal(box.open('creds.enc', box.seal('creds.enc', 'hello')).toString('utf8'), 'hello')

  const bufferValue = Buffer.from([0, 1, 2, 250, 255])
  assert.deepEqual(box.open('creds.enc', box.seal('creds.enc', bufferValue)), bufferValue)

  const uint8 = new Uint8Array([9, 8, 7])
  assert.deepEqual([...box.open('creds.enc', box.seal('creds.enc', uint8))], [9, 8, 7])
})

test('a different data dir (different key) cannot open the ciphertext', async (t) => {
  const dirA = await makeTempDir(t, 'crypto-a-')
  const dirB = await makeTempDir(t, 'crypto-b-')
  const boxA = await openSecretBox({ dataDir: dirA })
  const boxB = await openSecretBox({ dataDir: dirB })
  t.after(() => boxA.close())
  t.after(() => boxB.close())

  const sealed = boxA.seal('creds.enc', { secret: true })
  await expectCode(() => boxB.open('creds.enc', sealed), 'bad-key')
})

test('tampered ciphertext and tampered envelope are rejected', async (t) => {
  const dir = await makeTempDir(t)
  const box = await openSecretBox({ dataDir: dir })
  t.after(() => box.close())

  const sealed = box.seal('creds.enc', { secret: true })
  await expectCode(() => box.open('creds.enc', tamper(sealed)), 'bad-key')
  await expectCode(() => box.open('creds.enc', replaceMagic(sealed)), 'corrupt')
  await expectCode(() => box.open('creds.enc', Buffer.from('DSHWA1\nnot json\n')), 'corrupt')
  await expectCode(() => box.open('creds.enc', Buffer.from('DSHWA1\n{"v":2,"alg":"aes-256-gcm"}\n')), 'corrupt')
})

test('AAD binds a sealed name: creds ciphertext cannot be opened as keys', async (t) => {
  const dir = await makeTempDir(t)
  const box = await openSecretBox({ dataDir: dir })
  t.after(() => box.close())

  const sealed = box.seal('creds.enc', { who: 'creds' })
  await expectCode(() => box.open('keys.enc', sealed), 'bad-key')
  // The same name still works.
  assert.deepEqual(JSON.parse(box.open('creds.enc', sealed).toString()), { who: 'creds' })
})

test('passphrase mode creates salt.bin, no key.bin, and derives the key from the phrase', async (t) => {
  const dir = await makeTempDir(t, 'crypto-pass-')

  const box = await openSecretBox({ dataDir: dir, passphrase: 'correct horse battery staple' })
  assert.equal(box.source, 'passphrase')
  assert.equal(await exists(path.join(dir, 'salt.bin')), true)
  assert.equal(await exists(path.join(dir, 'key.bin')), false)
  assert.ok((await fs.stat(path.join(dir, 'salt.bin'))).size >= 16)

  const sealed = box.seal('creds.enc', { passphrase: true })
  box.close()

  const same = await openSecretBox({ dataDir: dir, passphrase: 'correct horse battery staple' })
  t.after(() => same.close())
  assert.deepEqual(JSON.parse(same.open('creds.enc', sealed).toString()), { passphrase: true })

  // Same salt, different passphrase => different key => authentication failure.
  const wrong = await openSecretBox({ dataDir: dir, passphrase: 'wrong passphrase' })
  t.after(() => wrong.close())
  await expectCode(() => wrong.open('creds.enc', sealed), 'bad-key')
})

test('an existing key.bin is reused, and a corrupt key.bin is rejected', async (t) => {
  const dir = await makeTempDir(t)
  const box = await openSecretBox({ dataDir: dir })
  const sealed = box.seal('creds.enc', 'stable')
  box.close()

  // Keep the same key: decryption still works on reopen.
  assert.equal((await fs.stat(path.join(dir, 'key.bin'))).size, 32)

  const corruptDir = await makeTempDir(t, 'crypto-badkey-')
  await fs.writeFile(path.join(corruptDir, 'key.bin'), Buffer.from([1, 2, 3]))
  await expectCode(() => openSecretBox({ dataDir: corruptDir }), 'corrupt')
})

test('sealFile is atomic: no temp files remain and file is 0600', async (t) => {
  const dir = await makeTempDir(t)
  const box = await openSecretBox({ dataDir: dir })
  t.after(() => box.close())

  await box.sealFile('creds.enc', { atomic: true })
  const names = await fs.readdir(dir)
  assert.deepEqual(names.sort(), ['creds.enc', 'key.bin'])
  assert.equal(names.some((name) => name.includes('.tmp')), false)
  assert.equal(fileMode(await fs.stat(path.join(dir, 'creds.enc'))), 0o600)

  // openFile reads it back through the same AAD.
  assert.deepEqual(JSON.parse((await box.openFile('creds.enc')).toString()), { atomic: true })
})

test('openFile returns null for a missing file unless required; deleteFile is idempotent', async (t) => {
  const dir = await makeTempDir(t)
  const box = await openSecretBox({ dataDir: dir })
  t.after(() => box.close())

  assert.equal(await box.openFile('keys.enc'), null)
  await expectCode(() => box.openFile('keys.enc', { required: true }), 'missing')

  await box.sealFile('keys.enc', { k: 1 })
  assert.deepEqual(JSON.parse((await box.openFile('keys.enc')).toString()), { k: 1 })
  await box.deleteFile('keys.enc')
  assert.equal(await exists(path.join(dir, 'keys.enc')), false)
  // Deleting a missing file is not an error.
  await box.deleteFile('keys.enc')
})

test('rejects unsafe or oversized secret file names', async (t) => {
  const dir = await makeTempDir(t)
  const box = await openSecretBox({ dataDir: dir })
  t.after(() => box.close())

  for (const bad of ['', 'a/b', '..\\x', 'x'.repeat(200)]) {
    await expectCode(() => box.seal(bad, 'v'), 'bad-name')
    await expectCode(() => box.open(bad, box.seal('creds.enc', 'v')), 'bad-name')
  }
})

test('a closed box refuses to seal or open and zeroizes its key', async (t) => {
  const dir = await makeTempDir(t)
  const box = await openSecretBox({ dataDir: dir })
  const sealed = box.seal('creds.enc', 'x')
  box.close()
  await expectCode(() => box.seal('creds.enc', 'y'), 'closed')
  await expectCode(() => box.open('creds.enc', sealed), 'closed')
})

test('openSecretBox requires a dataDir and rejects non-Buffer ciphertext', async (t) => {
  await expectCode(() => openSecretBox({ dataDir: '' }), 'bad-dir')
  await expectCode(() => openSecretBox({}), 'bad-dir')

  const dir = await makeTempDir(t)
  const box = await openSecretBox({ dataDir: dir })
  t.after(() => box.close())
  await expectCode(() => box.open('creds.enc', 'not a buffer'), 'corrupt')
  // A SecretBox cannot be constructed with a short key.
  await expectCode(() => new SecretBox({ key: Buffer.alloc(16), dataDir: dir, source: 'test' }), 'bad-key')
})
