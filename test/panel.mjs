/**
 * Live probe test for the panel route data — no dsh host needed.
 *   node test/panel.mjs          # cached-or-fresh probe of every backend
 */
import { probeAll } from '../panel.js'

const startedAt = Date.now()
const snapshot = await probeAll({ fresh: true })
console.log(JSON.stringify({ ok: true, wallMs: Date.now() - startedAt, ...snapshot }, null, 2))
