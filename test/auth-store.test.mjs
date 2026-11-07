/**
 * lib/auth-store.js — Baileys auth state persisted through the SecretBox.
 *
 * No Baileys socket is opened: this test only exercises the credential/key
 * persistence contract with the real (encrypted) files under .test-tmp.
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { openSecretBox } from '../lib/crypto.js'
import { AuthStore } from '../lib/auth-store.js'

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP_ROOT = path.join(PLUGIN_DIR, '.test-tmp', 'auth')

// File-level cleanup: per-test t.after hooks close stores after the directory
// hook already ran, so the whole per-file root is removed once at the end.
after(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true })
})

let seq = 0

async function makeTempDir(t, prefix = 'auth-') {
  await fs.mkdir(TMP_ROOT, { recursive: true })
  const dir = path.join(TMP_ROOT, `${prefix}${process.pid}-${seq++}-${Date.now()}`)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })
  return dir
}

// Mirrors the pino-shaped logger index.js hands the AuthStore: Baileys' own
// cacheable key store calls logger.trace, so a realistic stub must have it.
const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, child() { return silentLogger } }

async function exists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

/** Open a box + AuthStore pair for the same dir and register cleanup. */
async function openStore(t, dir) {
  const box = await openSecretBox({ dataDir: dir })
  const auth = new AuthStore({ dataDir: dir, box, logger: silentLogger })
  t.after(async () => {
    await auth.close().catch(() => {})
    box.close()
  })
  return { box, auth }
}

/** Wait (with real setImmediate turns) until `file` appears; fails after ~2s. */
async function waitForFile(file, turns = 2000) {
  for (let i = 0; i < turns; i += 1) {
    if (await exists(file)) return true
    await new Promise((resolve) => setImmediate(resolve))
  }
  return false
}

test('fresh data dir: load() returns false and writes no sealed files', async (t) => {
  const dir = await makeTempDir(t)
  const { auth } = await openStore(t, dir)

  assert.equal(await auth.load(), false)
  assert.equal(auth.linked, false)
  assert.equal(auth.state.creds.registered, false)
  assert.equal(auth.lastError, null)
  assert.equal(await exists(path.join(dir, 'creds.enc')), false)
  assert.equal(await exists(path.join(dir, 'keys.enc')), false)
  // load() is idempotent for the lifetime of the instance.
  assert.equal(await auth.load(), false)
})

test('credentials survive a roundtrip through a second AuthStore instance', async (t) => {
  const dir = await makeTempDir(t)
  const box1 = await openSecretBox({ dataDir: dir })
  // Use a dedicated store whose box we control so the second instance can be
  // built while the first is still alive (same as a process restart would).
  const auth1 = new AuthStore({ dataDir: dir, box: box1, logger: silentLogger })
  t.after(async () => {
    await auth1.close().catch(() => {})
    box1.close()
  })

  assert.equal(await auth1.load(), false)
  auth1.state.creds.registered = true
  auth1.state.creds.registrationId = 4242
  auth1.state.creds.advSecretKey = 'adv-secret'
  await auth1.saveCreds()
  assert.equal(auth1.linked, true)
  assert.equal(await exists(path.join(dir, 'creds.enc')), true)

  // Signal keys land through the cacheable key store and must persist.
  await auth1.state.keys.set({
    'pre-key': { 'pk-1': { privKey: Buffer.from('abcd', 'hex'), pubKey: Buffer.from('ef', 'hex') } },
    session: { 'sess-1': { rootKey: Buffer.from([1, 2, 3]) } },
  })
  await auth1.flush()
  assert.equal(await exists(path.join(dir, 'keys.enc')), true)

  // A second AuthStore over the same directory + key is a process restart.
  const box2 = await openSecretBox({ dataDir: dir })
  const auth2 = new AuthStore({ dataDir: dir, box: box2, logger: silentLogger })
  t.after(async () => {
    await auth2.close().catch(() => {})
    box2.close()
  })

  assert.equal(await auth2.load(), true)
  assert.equal(auth2.linked, true)
  assert.equal(auth2.state.creds.registrationId, 4242)
  assert.equal(auth2.state.creds.advSecretKey, 'adv-secret')
  assert.equal(auth2.state.creds.registered, true)

  const preKeys = await auth2.state.keys.get('pre-key', ['pk-1', 'missing'])
  assert.deepEqual(Object.keys(preKeys), ['pk-1'])
  assert.deepEqual(preKeys['pk-1'].privKey, Buffer.from('abcd', 'hex'))
  assert.deepEqual(preKeys['pk-1'].pubKey, Buffer.from('ef', 'hex'))
  const sessions = await auth2.state.keys.get('session', ['sess-1'])
  assert.deepEqual(sessions['sess-1'].rootKey, Buffer.from([1, 2, 3]))
})

test('saveCreds writes immediately (no flush wait needed)', async (t) => {
  const dir = await makeTempDir(t)
  const { auth } = await openStore(t, dir)
  await auth.load()
  auth.state.creds.registered = true
  assert.equal(await exists(path.join(dir, 'creds.enc')), false)
  await auth.saveCreds()
  assert.equal(await exists(path.join(dir, 'creds.enc')), true)
  // And the file decrypts to a registered credential set.
  const reopenedBox = await openSecretBox({ dataDir: dir })
  t.after(() => reopenedBox.close())
  const plain = JSON.parse((await reopenedBox.openFile('creds.enc')).toString('utf8'))
  assert.equal(plain.registered, true)
})

test('key set debounce persists after the debounce window without an explicit flush', async (t) => {
  const dir = await makeTempDir(t)
  const { auth } = await openStore(t, dir)
  await auth.load()
  auth.state.creds.registered = true
  await auth.saveCreds()

  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await auth.state.keys.set({ 'sender-key': { 'sk-1': { iv: Buffer.from([7, 7]) } } })
    assert.equal(await exists(path.join(dir, 'keys.enc')), false)
    t.mock.timers.tick(75)
  } finally {
    t.mock.timers.reset()
  }
  // The debounced flush is asynchronous; let its fs writes finish.
  assert.equal(await waitForFile(path.join(dir, 'keys.enc')), true)
})

test('flush() persists pending keys synchronously enough to reload', async (t) => {
  const dir = await makeTempDir(t)
  const { auth } = await openStore(t, dir)
  await auth.load()
  auth.state.creds.registered = true
  await auth.saveCreds()

  await auth.state.keys.set({ app_state: { 'k': { value: 'v' } } })
  await auth.flush()

  const box2 = await openSecretBox({ dataDir: dir })
  const auth2 = new AuthStore({ dataDir: dir, box: box2, logger: silentLogger })
  t.after(async () => {
    await auth2.close().catch(() => {})
    box2.close()
  })
  await auth2.load()
  const got = await auth2.state.keys.get('app_state', ['k'])
  assert.deepEqual(got.k, { value: 'v' })
})

test('unregistered half-pairing credentials are not linked, and are preserved for a retry', async (t) => {
  const dir = await makeTempDir(t)
  // Write an unregistered creds.enc (registered stays false).
  const box1 = await openSecretBox({ dataDir: dir })
  const auth1 = new AuthStore({ dataDir: dir, box: box1, logger: silentLogger })
  t.after(async () => {
    await auth1.close().catch(() => {})
    box1.close()
  })
  await auth1.load()
  assert.equal(auth1.state.creds.registered, false)
  await auth1.saveCreds()
  assert.equal(await exists(path.join(dir, 'creds.enc')), true)

  // A fresh instance must treat that as "not linked" but never delete a
  // credential file from a load: a plugin reload can race a write, and an
  // explicit Log out / Re-link is the only destructive path.
  const box2 = await openSecretBox({ dataDir: dir })
  const auth2 = new AuthStore({ dataDir: dir, box: box2, logger: silentLogger })
  t.after(async () => {
    await auth2.close().catch(() => {})
    box2.close()
  })
  assert.equal(await auth2.load(), false)
  assert.equal(auth2.state.creds.registered, false)
  assert.equal(await exists(path.join(dir, 'creds.enc')), true)
  assert.equal(await exists(path.join(dir, 'keys.enc')), false) 
})

test('unreadable stored credentials fall back to unlinked without deleting the file', async (t) => {
  const dir = await makeTempDir(t)
  const box = await openSecretBox({ dataDir: dir })
  t.after(() => box.close())
  await box.sealFile('creds.enc', 'this is not JSON')

  const auth = new AuthStore({ dataDir: dir, box, logger: silentLogger })
  t.after(async () => {
    await auth.close().catch(() => {})
  })
  assert.equal(await auth.load(), false)
  assert.equal(auth.state.creds.registered, false)
  // The corrupt file is left in place; an explicit re-link overwrites it.
  assert.equal(await exists(path.join(dir, 'creds.enc')), true)
})

test('wipe() deletes sealed files and resets the in-memory state', async (t) => {
  const dir = await makeTempDir(t)
  const { auth } = await openStore(t, dir)
  await auth.load()
  auth.state.creds.registered = true
  await auth.saveCreds()
  await auth.state.keys.set({ session: { 's-1': { a: 1 } } })
  await auth.flush()
  assert.equal(await exists(path.join(dir, 'creds.enc')), true)
  assert.equal(await exists(path.join(dir, 'keys.enc')), true)

  await auth.wipe()
  assert.equal(auth.linked, false)
  assert.equal(auth.state.creds.registered, false)
  assert.equal(await exists(path.join(dir, 'creds.enc')), false)
  assert.equal(await exists(path.join(dir, 'keys.enc')), false)

  // Nothing pending may resurrect the files after the wipe.
  await auth.flush()
  assert.equal(await exists(path.join(dir, 'creds.enc')), false)
  assert.equal(await exists(path.join(dir, 'keys.enc')), false)

  // The wiped instance can be re-loaded from scratch.
  assert.equal(await auth.load(), false)
})

test('close() flushes pending keys and does not recreate creds.enc after a wipe', async (t) => {
  const dir = await makeTempDir(t)
  const box = await openSecretBox({ dataDir: dir })
  const auth = new AuthStore({ dataDir: dir, box, logger: silentLogger })
  t.after(() => box.close())

  await auth.load()
  auth.state.creds.registered = true
  await auth.saveCreds()
  await auth.state.keys.set({ session: { 's-2': { b: 2 } } })

  // No explicit flush: close() must persist pending key state.
  await auth.close()
  assert.equal(await exists(path.join(dir, 'keys.enc')), true)

  const box2 = await openSecretBox({ dataDir: dir })
  const auth2 = new AuthStore({ dataDir: dir, box: box2, logger: silentLogger })
  t.after(async () => {
    await auth2.close().catch(() => {})
    box2.close()
  })
  assert.equal(await auth2.load(), true)
  const got = await auth2.state.keys.get('session', ['s-2'])
  assert.deepEqual(got['s-2'], { b: 2 })
})

test('wipe() then close() leaves no plaintext or recreated sealed state', async (t) => {
  const dir = await makeTempDir(t)
  const box = await openSecretBox({ dataDir: dir })
  const auth = new AuthStore({ dataDir: dir, box, logger: silentLogger })
  t.after(() => box.close())

  await auth.load()
  auth.state.creds.registered = true
  await auth.saveCreds()
  await auth.wipe()
  await auth.close()

  assert.equal(await exists(path.join(dir, 'creds.enc')), false)
  assert.equal(await exists(path.join(dir, 'keys.enc')), false)
  assert.equal(auth.linked, false)
  assert.equal(auth.state, null)
  // close() is idempotent.
  await auth.close()
})

test('a second load on the same instance does not re-read or reset state', async (t) => {
  const dir = await makeTempDir(t)
  const { auth } = await openStore(t, dir)
  await auth.load()
  auth.state.creds.registered = true
  await auth.saveCreds()
  assert.equal(await auth.load(), true)
  assert.equal(auth.state.creds.registered, true)
})

test('works with the fallback logger when none is injected (Baileys cache-miss path)', async (t) => {
  // Regression: the constructor's fallback logger lacked trace(), but Baileys'
  // makeCacheableSignalKeyStore calls logger?.trace() on every cache miss, so a
  // no-logger AuthStore threw "logger?.trace is not a function" (lib/auth-store.js).
  const dir = await makeTempDir(t)
  const box = await openSecretBox({ dataDir: dir })
  const auth = new AuthStore({ dataDir: dir, box })
  t.after(async () => {
    await auth.close().catch(() => {})
    box.close()
  })

  assert.equal(await auth.load(), false)
  assert.deepEqual(await auth.state.keys.get('session', ['missing']), {})
  auth.state.creds.registered = true
  await auth.saveCreds()
  await auth.state.keys.set({ session: { 's-1': { a: 1 } } })
  assert.deepEqual(await auth.state.keys.get('session', ['s-1']), { 's-1': { a: 1 } })
  await auth.flush()
  await auth.close()
})
