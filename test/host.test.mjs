/**
 * Host entry activation without the WhatsApp protocol library.
 *
 * A first install into a running DSH must show the sidebar entry even while the
 * profile package graph is unstable. Baileys is therefore require()d lazily, not
 * at host-entry import time; this test fails if a static import creeps back in or
 * if apply() cannot register the API without a linked account.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply } from '../index.js'

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOST_FILES = [
  'index.js',
  'lib/auth-store.js',
  'lib/config.js',
  'lib/crypto.js',
  'lib/logger.js',
  'lib/media-cache.js',
  'lib/message-store.js',
  'lib/protocol.js',
  'lib/routes.js',
  'lib/service.js',
  'lib/whatsapp-client.js',
]

test('host modules never statically import the WhatsApp protocol library', async () => {
  for (const relative of HOST_FILES) {
    const source = await fs.readFile(path.join(PLUGIN_DIR, relative), 'utf8')
    assert.equal(
      /from\s+['"]@whiskeysockets\/baileys['"]/.test(source),
      false,
      `${relative} must use lib/baileys.js lazily, not a static Baileys import`,
    )
  }
})

test('apply registers the authenticated API with no linked account and no Baileys', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-whatsapp-host-'))
  const previous = process.env.DSH_WHATSAPP_DATA_DIR
  process.env.DSH_WHATSAPP_DATA_DIR = dataDir
  const routes = []
  let disposer = null
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get() { return undefined },
    inject(deps, callback) {
      assert.ok(deps.includes('webServer'))
      callback({
        webServer: {
          register(route) {
            routes.push(route)
            return () => {}
          },
        },
      })
    },
    effect(setup) { disposer = setup() },
  }
  try {
    apply(ctx)
    for (let i = 0; i < 100 && routes.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(routes.length, 16, 'all API routes should register before any Baileys load')
    const stateRoute = routes.find((route) => route.path === '/dsh-whatsapp/api/state')
    assert.ok(stateRoute, 'state route is missing')

    let body = ''
    const res = {
      headersSent: false,
      writableEnded: false,
      setHeader() {},
      writeHead(status) { this.status = status; this.headersSent = true },
      end(value) { body = String(value ?? ''); this.writableEnded = true },
      on() {},
    }
    await stateRoute.handler({
      method: 'GET',
      url: '/dsh-whatsapp/api/state',
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    }, res)
    assert.equal(res.status, 200)
    const state = JSON.parse(body)
    assert.equal(state.linked, false)
    assert.equal(state.connection, 'idle')
    assert.equal(state.storage, 'encrypted')
    assert.equal(state.callsSupported, false)
  } finally {
    if (typeof disposer === 'function') await disposer()
    if (previous === undefined) delete process.env.DSH_WHATSAPP_DATA_DIR
    else process.env.DSH_WHATSAPP_DATA_DIR = previous
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})
