/**
 * store — persistence for user-managed custom CLI adapters.
 *
 * Path convention follows the DSH community plugins (dsh-cost-meter,
 * dsh-taskboard): `<dshHome>/storages/dsh-cli-bridge/clients.json`, where
 * dshHome comes from @deepseek-ai/dsh-home-paths when importable, else
 * $DSH_HOME, else ~/.dsh. Data must NEVER live inside the plugin package —
 * pnpm updates delete package directories wholesale.
 *
 * Concurrency: every read-modify-write is serialized through an in-process
 * promise queue (webServer handlers run concurrently), and writes are atomic
 * (tmp file + rename, with the Windows EPERM/EBUSY bounded retry that
 * @deepseek-ai/dsh-atomic-write established as the house pattern).
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { normalizeAdapter, validateAdapterShape } from './catalog.js'

const FILE_NAME = 'clients.json'
const TASKS_FILE_NAME = 'tasks.json'
const RENAME_RETRIES = 5
const RENAME_RETRY_MS = 150

/** Task store bounds: never persist unbounded history — the board keeps the
 *  newest MAX_TASKS records and the last OUTPUT_CAP chars of output each. */
export const MAX_TASKS = 300
export const TASK_OUTPUT_CAP = 120_000

let cachedHome

async function dshHome() {
  if (cachedHome) return cachedHome
  try {
    const mod = await import('@deepseek-ai/dsh-home-paths')
    if (typeof mod.resolveDshHome === 'function') {
      const resolved = mod.resolveDshHome()
      if (typeof resolved === 'string' && resolved) {
        cachedHome = resolved
        return cachedHome
      }
    }
  } catch {
    /* not importable outside the host — fall through */
  }
  cachedHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return cachedHome
}

export async function storeFile() {
  return join(await dshHome(), 'storages', 'dsh-cli-bridge', FILE_NAME)
}

/* ------------------------------------------------------------- queue ------ */

let tail = Promise.resolve()

/** Run `fn` after every previously queued operation settles (errors don't
 *  poison the queue). */
function serial(fn) {
  const run = tail.then(fn)
  tail = run.catch(() => {})
  return run
}

/* ------------------------------------------------------------- io --------- */

async function atomicWrite(filePath, text) {
  const dir = dirname(filePath)
  await mkdir(dir, { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, text, 'utf8')
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(tmp, filePath)
      return
    } catch (error) {
      const code = error?.code
      if ((code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') && attempt < RENAME_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_MS))
        continue
      }
      throw error
    }
  }
}

/** Load and normalize the custom list. Invalid entries are dropped (with the
 *  reason attached) so one hand-edited typo cannot break the whole plugin. */
export async function loadClients() {
  const filePath = await storeFile()
  let raw
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { clients: [], warnings: [] }
    throw error
  }
  const warnings = []
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { clients: [], warnings: [`clients.json 解析失败，已忽略：${error.message}`] }
  }
  const list = Array.isArray(parsed?.clients) ? parsed.clients : []
  const clients = []
  for (const entry of list) {
    const normalized = normalizeAdapter({ ...entry, source: 'custom' })
    const problems = validateAdapterShape(normalized)
    if (problems.length > 0) {
      warnings.push(`自定义 CLI "${entry?.key ?? '?'}" 配置无效已忽略：${problems.join('；')}`)
      continue
    }
    clients.push(normalized)
  }
  return { clients, warnings }
}

function saveClients(clients) {
  const body = JSON.stringify({ version: 1, savedAt: new Date().toISOString(), clients }, null, 2)
  return storeFile().then((filePath) => atomicWrite(filePath, body))
}

/* ------------------------------------------------------------- crud ------- */

/** Validate + normalize a client payload from the management UI. Returns
 *  {client} or {error}. `source` is forced to 'custom'. */
export function validateClientPayload(payload) {
  const candidate = normalizeAdapter({ ...(payload || {}), source: 'custom' })
  const problems = validateAdapterShape(candidate)
  if (problems.length > 0) return { error: problems.join('；') }
  if (typeof candidate.timeoutMs !== 'undefined' && (!Number.isFinite(candidate.timeoutMs) || candidate.timeoutMs < 1000)) {
    return { error: 'timeoutMs 需为不小于 1000 的毫秒数' }
  }
  return { client: candidate }
}

export function listClients() {
  return serial(async () => (await loadClients()).clients)
}

export function upsertClient(payload) {
  return serial(async () => {
    const check = validateClientPayload(payload)
    if (check.error) return { ok: false, error: check.error }
    const { clients, warnings } = await loadClients()
    const next = clients.filter((c) => c.key !== check.client.key)
    next.push(check.client)
    await saveClients(next)
    return { ok: true, client: check.client, warnings, replaced: clients.some((c) => c.key === check.client.key) }
  })
}

export function deleteClient(key) {
  return serial(async () => {
    const { clients } = await loadClients()
    const next = clients.filter((c) => c.key !== key)
    if (next.length === clients.length) return { ok: false, error: `未找到自定义 CLI "${key}"` }
    await saveClients(next)
    return { ok: true }
  })
}

export function setClientEnabled(key, enabled) {
  return serial(async () => {
    const { clients } = await loadClients()
    const client = clients.find((c) => c.key === key)
    if (!client) return { ok: false, error: `未找到自定义 CLI "${key}"` }
    client.enabled = Boolean(enabled)
    await saveClients(clients)
    return { ok: true, client }
  })
}

/** All enabled custom clients (registry view for index.js). */
export async function enabledClients() {
  const { clients } = await loadClients()
  return clients.filter((c) => c.enabled !== false)
}

/* ------------------------------------------------------------ tasks ------- */

const TASK_STATUSES = new Set(['queued', 'running', 'done', 'failed', 'stopped'])
const DEFAULT_TASK_SETTINGS = Object.freeze({ maxRunning: 2 })

/** Load persisted board tasks + settings. Same tolerance contract as
 *  loadClients: one hand-edited typo must not break the plugin — invalid
 *  records are dropped with the reason attached. */
export async function loadTasks() {
  const filePath = await tasksFile()
  let raw
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { tasks: [], settings: { ...DEFAULT_TASK_SETTINGS }, warnings: [] }
    throw error
  }
  const warnings = []
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { tasks: [], settings: { ...DEFAULT_TASK_SETTINGS }, warnings: [`tasks.json 解析失败，已忽略：${error.message}`] }
  }
  const settings = normalizeTaskSettings(parsed?.settings)
  const list = Array.isArray(parsed?.tasks) ? parsed.tasks : []
  const tasks = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') {
      warnings.push('tasks.json 里有一条非对象记录已忽略')
      continue
    }
    const problems = []
    if (typeof entry.id !== 'string' || !entry.id) problems.push('缺 id')
    if (typeof entry.cli !== 'string' || !entry.cli) problems.push('缺 cli')
    if (typeof entry.prompt !== 'string') problems.push('缺 prompt')
    if (!TASK_STATUSES.has(entry.status)) problems.push(`非法 status "${entry.status}"`)
    if (problems.length > 0) {
      warnings.push(`任务 "${entry?.title || entry?.id || '?'}" 无效已忽略：${problems.join('；')}`)
      continue
    }
    tasks.push({
      ...entry,
      status: entry.status,
      archived: entry.archived === true,
      attempt: Number.isFinite(entry.attempt) && entry.attempt >= 1 ? Math.floor(entry.attempt) : 1,
      output: typeof entry.output === 'string' ? entry.output.slice(-TASK_OUTPUT_CAP) : '',
      error: typeof entry.error === 'string' ? entry.error : null,
      meta: entry.meta && typeof entry.meta === 'object' ? entry.meta : null,
    })
  }
  if (tasks.length > MAX_TASKS) tasks.splice(0, tasks.length - MAX_TASKS)
  return { tasks, settings, warnings }
}

export function normalizeTaskSettings(raw) {
  const max = Number(raw?.maxRunning)
  const maxRunning = Number.isFinite(max) ? Math.min(5, Math.max(1, Math.round(max))) : DEFAULT_TASK_SETTINGS.maxRunning
  return { maxRunning }
}

/** Persist a full task list + settings atomically (queue-serialized). */
export function saveTasks(tasks, settings) {
  const body = JSON.stringify(
    {
      version: 1,
      savedAt: new Date().toISOString(),
      settings: normalizeTaskSettings(settings),
      tasks: tasks.slice(-MAX_TASKS).map((t) => ({ ...t, output: String(t.output || '').slice(-TASK_OUTPUT_CAP) })),
    },
    null,
    2,
  )
  return tasksFile().then((filePath) => atomicWrite(filePath, body))
}

export async function tasksFile() {
  return join(await dshHome(), 'storages', 'dsh-cli-bridge', TASKS_FILE_NAME)
}
