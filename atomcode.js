/**
 * http-sse engine — drive an HTTP daemon agent (POST /chat, SSE response).
 *
 * Wire contract (verified by multica-atomcode-extension/atomcode-bridge.py):
 *   GET  <healthPath>  -> daemon liveness
 *   POST <chatPath>    {<promptField>, <cwdField>?, <modelField>?}
 *                      Accept: text/event-stream
 *     data: {"type":"runtime_info","provider":..,"model":..}
 *     data: {"type":"session_assigned","session_id":..}
 *     data: {"type":"text","content":..}          <- answer body, accumulated
 *     data: {"type":"tokens","prompt":N,"completion":N}
 *     data: {"type":"tool_start"|"tool_result", ...}
 *     data: {"type":"done","tokens":N,"stop_reason":..}
 *
 * The atomcode builtin supplies defaults (baseUrl 127.0.0.1:13456, daemon
 * auto-start from D:\exe\atomcode*.exe); custom http-sse adapters pass their
 * own spec fields. Free of dsh imports — see test/smoke.mjs.
 */

import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'

export const ATOMCODE_LABEL = 'AtomCode'
export const ATOMCODE_TIMEOUT_MS = 600_000

export const DEFAULT_SSE_SPEC = {
  baseUrl: process.env.DSH_ATOMCODE_URL || process.env.ATOMCODE_BASE_URL || 'http://127.0.0.1:13456',
  healthPath: '/health',
  chatPath: '/chat',
  promptField: 'message',
  cwdField: 'cwd',
  modelField: 'model',
  autostartExeGlob: 'D:\\exe\\atomcode*.exe',
  autostartArgs: ['daemon', '--port', '13456', '--no-auth', '--no-telemetry'],
}

export function normalizeSpec(spec = {}) {
  return {
    ...DEFAULT_SSE_SPEC,
    ...spec,
    baseUrl: String(spec.baseUrl || DEFAULT_SSE_SPEC.baseUrl).replace(/\/+$/, ''),
  }
}

function envExeOverride(key) {
  const envName = `DSH_SSE_EXE_${String(key || '').toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
  return process.env[envName]
}

/** Resolve the daemon autostart exe: env override > glob (newest match). */
export function sseExe(spec, key) {
  const override = envExeOverride(key) || process.env.ATOMCODE_EXE
  if (override) return override
  const glob = spec.autostartExeGlob
  if (!glob) return undefined
  try {
    const dir = glob.replace(/[\\/][^\\/]*$/, '')
    const pattern = new RegExp(`^${glob.split(/[\\/]/).pop().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i')
    const candidates = readdirSync(dir).filter((name) => pattern.test(name)).sort()
    if (candidates.length > 0) return `${dir}\\${candidates[candidates.length - 1]}`
  } catch {
    /* glob dir absent — fall through */
  }
  return undefined
}

async function healthy(spec) {
  try {
    const res = await fetch(`${spec.baseUrl}${spec.healthPath}`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

/** Bring the daemon up if needed. Throws with the reason when unreachable. */
export async function ensureSseDaemon(spec, key) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await healthy(spec)) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  const exe = sseExe(spec, key)
  if (!exe) {
    throw new Error(`daemon not reachable at ${spec.baseUrl}${spec.healthPath}，且未配置可执行文件（http.exe）`)
  }
  spawn(exe, spec.autostartArgs || [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref()
  for (let attempt = 0; attempt < 15; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    if (await healthy(spec)) return
  }
  throw new Error(`daemon not reachable at ${spec.baseUrl}${spec.healthPath} and could not be started from "${exe}"`)
}

/** Quick availability summary for probes/panels. */
export async function probeSse(spec, key) {
  const s = normalizeSpec(spec)
  if (await healthy(s)) return { ok: true, detail: `daemon at ${s.baseUrl}` }
  const exe = sseExe(s, key)
  if (exe) return { ok: true, detail: `daemon down; exe ${exe} (auto-starts on first call)` }
  return { ok: false, detail: `daemon down at ${s.baseUrl}${s.healthPath} and no exe configured` }
}

/** Model catalog discovery over GET /models (contract from
 *  multica-atomcode-extension: data.{models|data|list}[] with
 *  {id|model|name, label|name, default}). 60s cache per baseUrl. */
const MODELS_CACHE_TTL_MS = 60_000
const modelsCache = new Map() // baseUrl -> {at, models}

export async function listSseModels(spec) {
  const s = normalizeSpec(spec)
  const cached = modelsCache.get(s.baseUrl)
  if (cached && Date.now() - cached.at < MODELS_CACHE_TTL_MS) return cached.models
  try {
    const res = await fetch(`${s.baseUrl}/models`, { signal: AbortSignal.timeout(4000) })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    let data = await res.json()
    if (data && typeof data === 'object') {
      for (const key of ['models', 'data', 'list']) {
        if (Array.isArray(data[key])) {
          data = data[key]
          break
        }
      }
    }
    const models = []
    if (Array.isArray(data)) {
      data.forEach((m, i) => {
        if (!m || typeof m !== 'object') return
        const id = m.id || m.model || m.name || String(i)
        models.push({ id: String(id), label: String(m.label || m.name || id), default: !!m.default })
      })
    }
    if (!models.some((m) => m.default) && models.length > 0) models[0].default = true
    modelsCache.set(s.baseUrl, { at: Date.now(), models })
    return models
  } catch (error) {
    throw new Error(`atomcode: /models 发现失败: ${error?.message ?? error}`)
  }
}

/** Run one prompt through an SSE daemon; resolves with {text, meta}.
 *  onDelta(text) streams answer chunks as they arrive (panel live view). */
export async function runSse(spec, key, prompt, { cwd, model, timeoutMs, signal, onDelta } = {}) {
  const s = normalizeSpec(spec)
  const effectiveTimeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : ATOMCODE_TIMEOUT_MS
  await ensureSseDaemon(s, key)
  const payload = { [s.promptField]: String(prompt ?? '') }
  if (cwd && s.cwdField) payload[s.cwdField] = String(cwd)
  if (model && s.modelField) payload[s.modelField] = String(model)

  const controller = new AbortController()
  const onAbort = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error('timeout'))
  }, effectiveTimeout)

  const texts = []
  const meta = { daemon: s.baseUrl }
  const startedAt = Date.now()
  let doneSeen = false

  try {
    const res = await fetch(`${s.baseUrl}${s.chatPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`atomcode: ${s.chatPath} HTTP ${res.status}${body ? `\n${tail(body)}` : ''}`)
    }

    const decoder = new TextDecoder()
    let pending = ''
    for await (const chunk of res.body) {
      pending += decoder.decode(chunk, { stream: true })
      let index
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index).replace(/\r$/, '').trim()
        pending = pending.slice(index + 1)
        if (!line.startsWith('data:')) continue
        const body = line.slice(5).trim()
        if (!body) continue
        let event
        try {
          event = JSON.parse(body)
        } catch {
          continue
        }
        const type = event?.type
        if (type === 'text' && typeof event.content === 'string') {
          texts.push(event.content)
          if (onDelta) onDelta(event.content)
        } else if (type === 'runtime_info') {
          if (event.provider) meta.provider = event.provider
          if (event.model) meta.model = event.model
        } else if (type === 'session_assigned') {
          meta.sessionId = event.session_id
        } else if (type === 'tokens') {
          meta.inputTokens = event.prompt
          meta.outputTokens = event.completion
        } else if (type === 'tool_start') {
          meta.toolCalls = (meta.toolCalls || 0) + 1
        } else if (type === 'done') {
          doneSeen = true
          meta.stopReason = event.stop_reason || 'completed'
          if (event.session_id) meta.sessionId = event.session_id
          if (typeof event.tokens === 'number') meta.totalTokens = event.tokens
          if (typeof event.tool_calls === 'number') meta.toolCalls = event.tool_calls
        }
        /* reasoning / tool_result / ping / capability: not needed for the
           final-answer contract; ignored on purpose. */
      }
    }

    const text = texts.join('').trim()
    if (timedOut) throw new Error(`timed out after ${effectiveTimeout}ms`)
    if (signal?.aborted) throw new Error('cancelled')
    if (!text) {
      throw new Error(
        `produced no answer${doneSeen ? ` (stop_reason=${meta.stopReason})` : ' (stream ended without a done event)'}`,
      )
    }
    return { text, meta: { ...meta, durationMs: Date.now() - startedAt } }
  } catch (error) {
    if (timedOut) throw new Error(`timed out after ${effectiveTimeout}ms`)
    if (signal?.aborted && !controller.signal.aborted) throw new Error('cancelled')
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

function tail(text, limit = 1200) {
  const value = String(text)
  return value.length > limit ? `…${value.slice(-limit)}` : value
}

/* --------------------------------------------------- atomcode conveniences */

export async function ensureAtomcodeDaemon() {
  await ensureSseDaemon(normalizeSpec({}), 'atomcode')
  return DEFAULT_SSE_SPEC.baseUrl
}

export async function probeAtomcode() {
  return probeSse({}, 'atomcode')
}

export async function runAtomcode(prompt, opts = {}) {
  const { text, meta } = await runSse({}, 'atomcode', prompt, opts)
  return { text, meta: { ...meta, daemon: meta.daemon || DEFAULT_SSE_SPEC.baseUrl } }
}

export function atomcodeBaseUrl() {
  return DEFAULT_SSE_SPEC.baseUrl
}

export function atomcodeExe() {
  return sseExe(normalizeSpec({}), 'atomcode') || 'atomcode'
}
