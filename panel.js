/**
 * panel — host half of the "CLI Agents" sidebar page.
 *
 * Routes over the host webServer (same pattern as dsh-pending-review-glow):
 *
 *   GET  /cli-bridge/clis            -> {at, clients:[probe rows]}   (30s cache)
 *   GET  /cli-bridge/clis?fresh=1    -> re-probe instead of the cache
 *   GET  /cli-bridge/clients         -> {clients, warnings} raw custom config
 *   POST /cli-bridge/clients         -> upsert one custom client (body = payload)
 *   PUT  /cli-bridge/clients         -> same as POST (body carries key)
 *   DELETE /cli-bridge/clients?key=  -> remove one custom client
 *   POST /cli-bridge/clients/test    -> probe a DRAFT payload without saving
 *   POST /cli-bridge/run             -> run one task NOW, direct from the panel
 *                                       (SSE: start/text/done|error events;
 *                                       disconnect CANCELS the run)
 *   GET  /cli-bridge/task.js         -> the task-board browser module
 *   GET  /cli-bridge/tasks           -> board snapshot {tasks, settings}
 *   POST /cli-bridge/tasks           -> queue a board task (server-side run;
 *                                       survives page close — see task-manager)
 *   PUT  /cli-bridge/tasks           -> update board settings {maxRunning}
 *   DELETE /cli-bridge/tasks?id=     -> delete one task record
 *   POST /cli-bridge/tasks/action    -> {id, action: stop|retry|archive|
 *                                       unarchive|delete} or archive_finished
 *   GET  /cli-bridge/tasks/stream    -> SSE: snapshot|changed|output|settings|
 *                                       deleted (disconnect NEVER cancels)
 *
 * The run route cancels the task when the response connection drops before
 * completion (client abort / panel closed): the engines kill the process tree
 * through their existing signal path, so no CLI ever outlives its run.
 *
 * task.js is served here (instead of living inside client.js) so the panel
 * shell and the task runner can be modified in parallel without touching the
 * same file; client.js pulls it in with a dynamic import on first mount.
 *
 * Deliberately free of dsh imports so `node test/panel.mjs` can exercise the
 * probe pipeline without a host; index.js only wires the route.
 */

import { readFileSync } from 'node:fs'
import { probeAdapter, listAdapters, getAdapter, runAdapter, resolveModels } from './registry.js'
import { getTaskManager } from './task-manager.js'
import * as store from './store.js'

export const ROUTE_PREFIX = '/cli-bridge'
export const ROUTE_CLIS = '/cli-bridge/clis'
export const ROUTE_CLIENTS = '/cli-bridge/clients'
export const ROUTE_CLIENTS_TEST = '/cli-bridge/clients/test'
export const ROUTE_MODELS = '/cli-bridge/models'
export const ROUTE_RUN = '/cli-bridge/run'
export const ROUTE_TASK_JS = '/cli-bridge/task.js'
export const ROUTE_TASKS = '/cli-bridge/tasks'
export const ROUTE_TASKS_ACTION = '/cli-bridge/tasks/action'
export const ROUTE_TASKS_STREAM = '/cli-bridge/tasks/stream'

/** Probe results are cached so the panel's periodic poll stays cheap;
 *  a probe spawns `where`/`--version` per CLI, which is not free. */
const CACHE_TTL_MS = 30_000

let cache = { at: 0, value: undefined }

function invalidateCache() {
  cache = { at: 0, value: undefined }
}

/** Probe every adapter in parallel. Never throws: a failed probe is a row. */
export async function probeAll({ fresh = false } = {}) {
  if (!fresh && cache.value && Date.now() - cache.at < CACHE_TTL_MS) return cache.value
  const adapters = await listAdapters()
  const clients = await Promise.all(
    adapters.map((adapter) =>
      probeAdapter(adapter)
        .then((probe) => ({
          key: adapter.key,
          label: adapter.label || adapter.key,
          ok: probe.ok,
          detail: probe.detail,
          source: adapter.source,
          protocol: adapter.protocol,
          verified: adapter.verified !== false,
          enabled: adapter.enabled !== false,
          overrides: adapter.overrides,
        }))
        .catch((error) => ({
          key: adapter.key,
          label: adapter.label || adapter.key,
          ok: false,
          detail: `probe failed: ${error?.message ?? error}`,
          source: adapter.source,
          protocol: adapter.protocol,
          verified: adapter.verified !== false,
          enabled: adapter.enabled !== false,
        })),
    ),
  )
  const at = Date.now()
  cache = { at, value: { at, clients } }
  return cache.value
}

/* ------------------------------------------------------------- http ------ */

function sendJson(response, status, body) {
  try {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(body === undefined ? undefined : JSON.stringify(body))
  } catch {
    /* client gone */
  }
}

async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 1_000_000) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  return text ? JSON.parse(text) : {}
}

/** task.js is read once per plugin lifecycle; a read failure surfaces as a
 *  500 instead of taking the whole route table down. */
let taskJsCache = null
function taskJsSource() {
  if (taskJsCache === null) {
    try {
      taskJsCache = readFileSync(new URL('./client/task.js', import.meta.url), 'utf8')
    } catch (error) {
      taskJsCache = { error: `task.js unreadable: ${error?.message ?? error}` }
    }
  }
  return taskJsCache
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function registerPanelRoute(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (request, response) => {
          let url
          try {
            url = new URL(request.url || '/', 'http://dsh.internal')
          } catch {
            sendJson(response, 400, { error: 'bad url' })
            return
          }
          const method = (request.method || 'GET').toUpperCase()

          try {
            if (url.pathname === ROUTE_CLIS) {
              if (method !== 'GET' && method !== 'HEAD') {
                sendJson(response, 405, { error: 'method not allowed' })
                return
              }
              const snapshot = await probeAll({ fresh: url.searchParams.get('fresh') === '1' })
              sendJson(response, 200, method === 'HEAD' ? undefined : snapshot)
              return
            }

            if (url.pathname === ROUTE_CLIENTS_TEST && method === 'POST') {
              const payload = await readBody(request)
              const check = store.validateClientPayload(payload)
              if (check.error) {
                sendJson(response, 200, { ok: false, error: check.error })
                return
              }
              const probe = await probeAdapter(check.client).catch((error) => ({
                ok: false,
                detail: error?.message ?? String(error),
              }))
              sendJson(response, 200, { ok: probe.ok, detail: probe.detail })
              return
            }

            if (url.pathname === ROUTE_MODELS && method === 'GET') {
              // model catalog for one adapter (?key=); absent/unsupported → empty list
              const key = url.searchParams.get('key') || ''
              const adapter = (await listAdapters()).find((a) => a.key === key)
              if (!adapter) {
                sendJson(response, 200, { key, models: [], supported: true, source: 'none', error: `unknown cli "${key}"` })
                return
              }
              const catalog = await resolveModels(adapter).catch((error) => ({
                models: [],
                supported: true,
                source: 'none',
                error: error?.message ?? String(error),
              }))
              sendJson(response, 200, { key, ...catalog })
              return
            }

            if (url.pathname === ROUTE_TASK_JS) {
              if (method !== 'GET' && method !== 'HEAD') {
                sendJson(response, 405, { error: 'method not allowed' })
                return
              }
              const source = taskJsSource()
              if (typeof source !== 'string') {
                sendJson(response, 500, { error: source.error })
                return
              }
              try {
                response.writeHead(200, {
                  'content-type': 'text/javascript; charset=utf-8',
                  'cache-control': 'no-store',
                })
                response.end(method === 'HEAD' ? undefined : source)
              } catch {
                /* client gone */
              }
              return
            }

            if (url.pathname === ROUTE_RUN) {
              if (method !== 'POST') {
                sendJson(response, 405, { error: 'method not allowed' })
                return
              }
              const payload = await readBody(request)
              const key = String(payload.cli || '').trim().toLowerCase()
              const prompt = typeof payload.prompt === 'string' ? payload.prompt : ''
              if (!key || !prompt.trim()) {
                sendJson(response, 400, { error: 'cli and prompt are required' })
                return
              }
              const adapter = await getAdapter(key)
              if (!adapter) {
                sendJson(response, 404, { error: `unknown cli "${key}"；可用 CLI 见 GET /clis 或面板清单` })
                return
              }
              if (adapter.enabled === false) {
                sendJson(response, 400, { error: `"${key}" 已停用；可在 CLI 运行时页面重新启用` })
                return
              }

              // stream open: validation is done, later failures ride the stream
              response.writeHead(200, {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-store',
                connection: 'keep-alive',
              })
              const controller = new AbortController()
              let finished = false
              const write = (event) => {
                if (finished) return
                try {
                  response.write(`data: ${JSON.stringify(event)}\n\n`)
                } catch {
                  /* client gone — the close handler cancels the run */
                }
              }
              // Node >=16 emits request 'close' once the body is drained, so
              // the response stream is the only reliable disconnect signal.
              response.on('close', () => {
                if (!finished) controller.abort(new Error('client disconnected'))
              })

              write({ type: 'start', cli: adapter.key, protocol: adapter.protocol })
              try {
                const result = await runAdapter(adapter, prompt, {
                  cwd: typeof payload.cwd === 'string' && payload.cwd.trim() ? payload.cwd.trim() : undefined,
                  model: payload.model ? String(payload.model) : undefined,
                  timeoutMs: Number(payload.timeoutMs) > 0 ? Number(payload.timeoutMs) : undefined,
                  signal: controller.signal,
                  onDelta: (delta) => write({ type: 'text', delta }),
                })
                write({ type: 'done', text: result.text, meta: result.meta })
              } catch (error) {
                write({ type: 'error', error: error?.message ?? String(error) })
              } finally {
                finished = true
                try {
                  response.end()
                } catch {
                  /* already closed */
                }
              }
              return
            }

            // Board: tasks live in the task-manager (host half), so they
            // outlive this page. Unlike /run, a disconnecting stream here is
            // a view problem only — never a cancel.
            if (url.pathname === ROUTE_TASKS_STREAM && method === 'GET') {
              const mgr = getTaskManager()
              await mgr.ready()
              response.writeHead(200, {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-store',
                connection: 'keep-alive',
              })
              let open = true
              const send = (event) => {
                if (!open) return
                try {
                  response.write(`data: ${JSON.stringify(event)}\n\n`)
                } catch {
                  open = false
                }
              }
              send({ type: 'snapshot', ...mgr.snapshot() })
              const unsubscribe = mgr.subscribe(send)
              // comment ping keeps intermediaries from closing an idle stream
              const ping = setInterval(() => {
                if (!open) return
                try {
                  response.write(': ping\n\n')
                } catch {
                  open = false
                }
              }, 25_000)
              response.on('close', () => {
                open = false
                clearInterval(ping)
                unsubscribe()
              })
              return
            }

            if (url.pathname === ROUTE_TASKS_ACTION && method === 'POST') {
              const payload = await readBody(request)
              const action = String(payload.action || '')
              if (!action) {
                sendJson(response, 400, { error: 'action is required' })
                return
              }
              const mgr = getTaskManager()
              const result =
                action === 'archive_finished'
                  ? await mgr.archiveFinished()
                  : await mgr.action(String(payload.id || ''), action)
              sendJson(response, 200, result)
              return
            }

            if (url.pathname === ROUTE_TASKS) {
              const mgr = getTaskManager()
              if (method === 'GET') {
                await mgr.ready()
                sendJson(response, 200, mgr.snapshot())
                return
              }
              if (method === 'POST') {
                const payload = await readBody(request)
                const key = String(payload.cli || '').trim().toLowerCase()
                const prompt = typeof payload.prompt === 'string' ? payload.prompt : ''
                if (!key || !prompt.trim()) {
                  sendJson(response, 400, { error: 'cli and prompt are required' })
                  return
                }
                const adapter = await getAdapter(key)
                if (!adapter) {
                  sendJson(response, 404, { error: `unknown cli "${key}"；可用 CLI 见 GET /clis 或面板清单` })
                  return
                }
                if (adapter.enabled === false) {
                  sendJson(response, 400, { error: `"${key}" 已停用；可在 CLI 运行时页面重新启用` })
                  return
                }
                const task = await mgr.create({
                  cli: adapter.key,
                  cliLabel: adapter.label || adapter.key,
                  prompt,
                  cwd: typeof payload.cwd === 'string' && payload.cwd.trim() ? payload.cwd.trim() : undefined,
                  model: payload.model && String(payload.model).trim() ? String(payload.model).trim() : undefined,
                  origin: 'panel',
                })
                sendJson(response, 200, { task })
                return
              }
              if (method === 'PUT') {
                const payload = await readBody(request)
                sendJson(response, 200, await mgr.updateSettings(payload))
                return
              }
              if (method === 'DELETE') {
                const id = url.searchParams.get('id') || ''
                if (!id) {
                  sendJson(response, 400, { error: 'id is required' })
                  return
                }
                sendJson(response, 200, await mgr.action(id, 'delete'))
                return
              }
              sendJson(response, 405, { error: 'method not allowed' })
              return
            }

            if (url.pathname === ROUTE_CLIENTS) {
              if (method === 'GET') {
                if (url.searchParams.get('all') === '1') {
                  // full adapter configs (builtin + custom) for editor prefills
                  sendJson(response, 200, { clients: await listAdapters(), warnings: [] })
                  return
                }
                sendJson(response, 200, await store.loadClients())
                return
              }
              if (method === 'POST' || method === 'PUT') {
                const payload = await readBody(request)
                const result = await store.upsertClient(payload)
                if (result.ok) invalidateCache()
                sendJson(response, 200, result)
                return
              }
              if (method === 'DELETE') {
                const key = url.searchParams.get('key') || ''
                const result = await store.deleteClient(key)
                if (result.ok) invalidateCache()
                sendJson(response, 200, result)
                return
              }
              sendJson(response, 405, { error: 'method not allowed' })
              return
            }

            sendJson(response, 404, 'not found')
          } catch (error) {
            sendJson(response, 500, { error: error?.message ?? String(error) })
          }
        },
      }),
    'cli-bridge: panel routes',
  )
}
