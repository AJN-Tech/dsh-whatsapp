/**
 * Lazy access to Baileys.
 *
 * The DSH host installs a plugin while its profile package graph is being
 * rewritten. A top-level ESM/Baileys import during that window can capture a
 * broken module namespace (e.g. `protobufjs/minimal.js` default undefined) and
 * poison the process-wide ESM cache: the plugin then fails to import and its
 * sidebar entry never appears. Loading Baileys only when the socket is actually
 * needed keeps the host entry (and therefore the UI) independent of that
 * transient cache state.
 *
 * `require(esm)` (Node >=22.5, the DSH desktop runtime) also avoids the ESM
 * cache entry for Baileys itself. The result is cached per process; a failed
 * load clears the cache so a later attempt after the profile settles can try
 * again.
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let cached = null

/** @returns {typeof import('@whiskeysockets/baileys')} */
export function baileys() {
  if (cached !== null) return cached
  try {
    cached = require('@whiskeysockets/baileys')
    return cached
  } catch (error) {
    cached = null
    const wrapped = new Error(`WhatsApp protocol library could not be loaded: ${error?.message ?? error}`)
    wrapped.code = 'baileys-unavailable'
    wrapped.cause = error
    throw wrapped
  }
}

/** Test seam: allow a fake module without touching the real one. */
export function setBaileysForTests(value) {
  cached = value
}
