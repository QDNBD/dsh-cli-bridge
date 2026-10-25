/**
 * registry — the runtime view of all adapters: builtin catalog overlaid with
 * user-managed custom entries (same key = the custom entry wins, letting the
 * user fix any builtin's flags without touching plugin code).
 */

import { BUILTIN_ADAPTERS, BUILTIN_KEYS, normalizeAdapter } from './catalog.js'
import * as store from './store.js'
import { runSpawnAdapter, probeSpawnAdapter } from './cli-runner.js'
import { runAcpAdapter } from './acp.js'
import { runSse, probeSse, listSseModels } from './atomcode.js'

/** Fields a same-key override INHERITS from the builtin when it does not
 *  declare them itself — an override exists to fix flags, not to lose the
 *  builtin's model catalog / effort support. */
const INHERIT_FROM_BUILTIN = ['models', 'modelFlag', 'effortFlag', 'cwdFlag', 'modelSupported']

/** Full adapter list (builtins + custom), including disabled custom entries. */
export async function listAdapters() {
  const { clients } = await store.loadClients()
  const customByKey = new Map(clients.map((c) => [c.key, c]))
  const adapters = BUILTIN_ADAPTERS.map((b) => {
    const custom = customByKey.get(b.key)
    if (!custom) return { ...b, source: 'builtin', enabled: true }
    const inherited = { ...custom }
    for (const field of INHERIT_FROM_BUILTIN) {
      if (inherited[field] === undefined && b[field] !== undefined) inherited[field] = b[field]
    }
    return { ...inherited, source: 'custom', overrides: b.key, verified: true }
  })
  for (const client of clients) {
    if (!BUILTIN_KEYS.has(client.key)) {
      adapters.push({ ...normalizeAdapter(client), source: 'custom', verified: true })
    }
  }
  return adapters
}

export async function getAdapter(key) {
  return (await listAdapters()).find((a) => a.key === key)
}

/** Dispatch one prompt through any adapter protocol; resolves {text, meta}.
 *  onDelta(text) is an optional live-output callback (panel run box); engines
 *  treat it as best-effort display — result().text stays authoritative.
 *  effort is the runtime-native reasoning token; only adapters declaring
 *  effortFlag (spawn) or reasoning_effort config (acp) honour it. */
export async function runAdapter(adapter, prompt, { cwd, timeoutMs, signal, model, effort, onDelta } = {}) {
  switch (adapter.protocol) {
    case 'acp':
      return runAcpAdapter(adapter, prompt, { cwd, timeoutMs, signal, model, effort, onDelta })
    case 'http-sse': {
      return runSse(adapter.http || {}, adapter.key, prompt, {
        cwd,
        model,
        timeoutMs: timeoutMs || adapter.timeoutMs,
        signal,
        onDelta,
      })
    }
    default:
      return runSpawnAdapter(adapter, prompt, { cwd, timeoutMs, signal, model, effort, onDelta })
  }
}

/** Env override name for one adapter's model catalog (comma-separated ids). */
export function modelsEnvName(adapter) {
  return `DSH_CLI_${String(adapter.key || '').toUpperCase().replace(/[^A-Z0-9]/g, '_')}_MODELS`
}

/**
 * Resolve the model catalog for one adapter (Multica-style, precedence:
 * env override > daemon /models (http-sse) > static catalog > none).
 * Returns {models:[{id,label,default?}], supported, source}.
 * `supported:false` = the CLI ignores model selection entirely (honest bit,
 * Multica's qwenpaw/mcode stance) — callers should reject instead of passing
 * a value that would be ignored.
 */
export async function resolveModels(adapter) {
  if (adapter.modelSupported === false) {
    return { models: [], supported: false, source: 'unsupported' }
  }
  const envList = (process.env[modelsEnvName(adapter)] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (envList.length > 0) {
    return { models: envList.map((id) => ({ id })), supported: true, source: 'env' }
  }
  if (adapter.protocol === 'http-sse') {
    try {
      return { models: await listSseModels(adapter.http || {}), supported: true, source: 'daemon' }
    } catch {
      return { models: [], supported: true, source: 'none' }
    }
  }
  if (Array.isArray(adapter.models) && adapter.models.length > 0) {
    return { models: adapter.models.map((id) => ({ id })), supported: true, source: 'catalog' }
  }
  return { models: [], supported: true, source: 'none' }
}

/** Availability probe for any adapter protocol. */
export async function probeAdapter(adapter) {
  if (adapter.enabled === false) return { ok: false, detail: '已停用' }
  if (adapter.protocol === 'http-sse') return probeSse(adapter.http || {}, adapter.key)
  const probe = await probeSpawnAdapter(adapter)
  const command = process.env[`DSH_CLI_${String(adapter.key || '').toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] || adapter.command
  return {
    ok: probe.ok,
    detail: probe.ok
      ? `${probe.version || 'installed'} (${command})`
      : `NOT FOUND (${command})`,
  }
}
