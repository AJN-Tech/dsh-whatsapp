/**
 * dsh-whatsapp — host half.
 *
 * A left-sidebar entry in the DSH web client opens a full-page WhatsApp Web
 * clone. This half owns the linked-device socket (Baileys), the encrypted local
 * state, and the authenticated JSON/SSE API the client talks to.
 *
 * Everything is created lazily inside `ctx.inject(['webServer'])` and disposed
 * through `ctx.effect`, so a missing service or a plugin reload can never leave
 * a socket, a route, or a timer behind.
 */
import { createAuthStore } from './lib/auth-store.js'
import { API_PREFIX, PLUGIN_ID, resolveDataDir } from './lib/config.js'
import { openSecretBox } from './lib/crypto.js'
import { registerRoutes } from './lib/routes.js'
import { createWhatsAppService } from './lib/service.js'

export const name = PLUGIN_ID

function safeLog(ctx, level, message, detail) {
  try {
    const logger = ctx?.logger
    const fn = logger && typeof logger[level] === 'function' ? logger[level] : undefined
    if (fn) {
      if (detail === undefined) fn.call(logger, `[dsh-whatsapp] ${message}`)
      else fn.call(logger, `[dsh-whatsapp] ${message}`, detail)
    } else if (level === 'error') console.error(`[dsh-whatsapp] ${message}`, detail ?? '')
    else if (level === 'warn') console.warn(`[dsh-whatsapp] ${message}`, detail ?? '')
  } catch {
    // Logging must never be able to fail plugin startup.
  }
}

function getService(ctx, id) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(id) : undefined
  } catch {
    return undefined
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

function json(res, status, body) {
  if (res.headersSent) return
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(text)
}

/**
 * Route admission. The web client's own connection plugin knows the session
 * cookie and answers with a rejection status; without it (older host), only a
 * loopback request whose Host/Origin agree can reach the API. This is the same
 * policy DSH's first-party route owners use.
 */
function createAdmit(ctx) {
  const connection = getService(ctx, 'connection')
  if (connection && typeof connection.requestRejection === 'function') {
    return (req, res) => {
      let rejected
      try {
        rejected = connection.requestRejection(req)
      } catch {
        json(res, 403, { error: 'Forbidden', code: 'admission-failed' })
        return false
      }
      if (rejected) {
        json(res, rejected, { error: rejected === 401 ? 'Unauthorized' : 'Forbidden', code: `http-${rejected}` })
        return false
      }
      return true
    }
  }
  return (req, res) => {
    const remote = req.socket?.remoteAddress ?? ''
    if (!LOOPBACK.has(remote)) {
      json(res, 403, { error: 'Forbidden', code: 'loopback-only' })
      return false
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      json(res, 403, { error: 'Forbidden', code: 'cross-site' })
      return false
    }
    const origin = req.headers.origin
    if (origin !== undefined) {
      let originHost = ''
      try {
        originHost = new URL(origin).host
      } catch {
        originHost = ''
      }
      if (originHost === '' || originHost !== req.headers.host) {
        json(res, 403, { error: 'Forbidden', code: 'origin-mismatch' })
        return false
      }
    }
    return true
  }
}

export function apply(ctx) {
  ctx.inject(['webServer'], (sub) => {
    const webServer = sub?.webServer
    if (!webServer || typeof webServer.register !== 'function') {
      safeLog(ctx, 'warn', 'webServer service is not available; API routes were not registered')
      return
    }
    const dataDir = resolveDataDir()
    const admit = createAdmit(ctx)
    const logger = {
      info: (message, detail) => safeLog(ctx, 'info', message, detail),
      warn: (message, detail) => safeLog(ctx, 'warn', message, detail),
      error: (message, detail) => safeLog(ctx, 'error', message, detail),
      debug: () => {},
      trace: () => {},
      child: () => logger,
    }

    ctx.effect(() => {
      let disposed = false
      let service = null
      let auth = null
      let box = null
      let disposers = []

      const fail = (error) => {
        safeLog(ctx, 'error', 'failed to initialise; WhatsApp stays unavailable', {
          message: String(error?.message ?? error).slice(0, 300),
          code: error?.code,
        })
      }

      void (async () => {
        box = await openSecretBox({ dataDir })
        auth = createAuthStore({ dataDir, box, logger })
        const linked = await auth.load()
        if (disposed) {
          await auth.close()
          box.close()
          return
        }
        service = createWhatsAppService({ dataDir, box, auth, logger, apiPrefix: API_PREFIX })
        disposers = registerRoutes({ service, admit, logger, webServer }) || []
        safeLog(ctx, 'info', `API registered at ${API_PREFIX} (${linked ? 'linked device' : 'not linked'})`)
        if (linked) {
          service.start().catch(fail)
        }
      })().catch(fail)

      return async () => {
        disposed = true
        for (const dispose of disposers) {
          try {
            dispose()
          } catch (error) {
            safeLog(ctx, 'warn', 'route disposer failed', { message: String(error?.message ?? error) })
          }
        }
        disposers = []
        try {
          await service?.dispose?.()
        } catch (error) {
          safeLog(ctx, 'warn', 'service dispose failed', { message: String(error?.message ?? error) })
        }
        service = null
        try {
          await auth?.close?.()
        } catch { /* best effort */ }
        auth = null
        try {
          box?.close?.()
        } catch { /* best effort */ }
        box = null
      }
    }, 'dsh-whatsapp: linked-device service')
  })
}
