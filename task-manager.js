/**
 * task-manager — server-side lifecycle for board tasks (v0.7.0 任务看板).
 *
 * The board decouples task lifetime from the panel page: a task lives here,
 * in the host half, and keeps running when the sidebar page closes (the SSE
 * stream disconnecting is NOT a cancel — only an explicit stop is). This is
 * the deliberate contrast to the /run direct route, whose disconnect cancels.
 *
 * Layering (see MAINTENANCE.md §1): panel.js → task-manager → store.js (the
 * only persistence point) + registry.runAdapter (engines untouched, the
 * one-shot process contract still holds). This module never imports panel.
 *
 * State machine (borrowed from Multica's AgentTask, reduced to our domain):
 *
 *   queued ──scheduler──▶ running ──┬─▶ done
 *      │                   │  │     ├─▶ failed
 *      └─stop──────────────┘  │     └─▶ stopped (user stop / tool abort)
 *                             └─host restart─▶ failed (reconciled on load)
 *
 * Concurrency: `settings.maxRunning` slots (1..5); queued tasks start FIFO.
 * Tool runs (cli_agent) bypass the queue via beginToolRun — a chat delegation
 * must never wait behind board tasks — but still land on the board.
 */

import * as store from './store.js'
import { getAdapter, runAdapter } from './registry.js'

/** Board tasks may legitimately run long; give them a 30-minute floor even
 *  when the adapter's own default timeout is shorter (spawn default is 180s —
 *  far too aggressive for a queued board task). */
const BOARD_TASK_TIMEOUT_MS = 30 * 60_000

const TERMINAL = new Set(['done', 'failed', 'stopped'])
const TITLE_CAP = 60

function deriveTitle(prompt) {
  const line = (String(prompt || '').split(/\r?\n/).find((l) => l.trim()) || '').trim()
  return line.length > TITLE_CAP ? line.slice(0, TITLE_CAP - 1) + '…' : line
}

function newId() {
  return 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
}

export class TaskManager {
  #tasks = new Map() // id → record (insertion order = creation order = FIFO)
  #settings = { maxRunning: 2 }
  #controllers = new Map() // id → AbortController, size = running count
  #subscribers = new Set()
  #ready = null

  constructor() {
    this.#ready = this.#load()
  }

  /** Resolves once persisted tasks are loaded, reconciled and rescheduled. */
  ready() {
    return this.#ready
  }

  async #load() {
    const { tasks, settings, warnings } = await store.loadTasks()
    this.#settings = settings
    let reconciled = 0
    for (const task of tasks) {
      if (task.status === 'running') {
        // The process died with the previous host instance — say so honestly.
        task.status = 'failed'
        task.error = 'DSH 重启，任务中断'
        task.endedAt = task.endedAt || new Date().toISOString()
        reconciled++
      }
      this.#tasks.set(task.id, task)
    }
    if (warnings.length > 0) console.log('[cli-bridge] tasks.json:', warnings.join('；'))
    await this.#persist()
    if (reconciled > 0) console.log(`[cli-bridge] board: reconciled ${reconciled} interrupted task(s) to failed`)
    this.#schedule()
  }

  /* ------------------------------------------------------- read views --- */

  snapshot() {
    return {
      tasks: [...this.#tasks.values()].map((t) => ({ ...t })),
      settings: { ...this.#settings },
    }
  }

  subscribe(fn) {
    this.#subscribers.add(fn)
    return () => this.#subscribers.delete(fn)
  }

  #emit(event) {
    for (const fn of this.#subscribers) {
      try {
        fn(event)
      } catch {
        /* one broken subscriber must not starve the others */
      }
    }
  }

  #touch(task) {
    this.#emit({ type: 'changed', task: { ...task } })
  }

  async #persist() {
    try {
      await store.saveTasks([...this.#tasks.values()], this.#settings)
    } catch (error) {
      console.log('[cli-bridge] tasks.json 保存失败:', error?.message ?? error)
    }
  }

  /* ---------------------------------------------------------- create ---- */

  /** Queue a board task. Validation of cli/prompt belongs to the route; this
   *  only guards the invariants the manager itself relies on. */
  async create({ cli, prompt, cwd, model, origin = 'panel', cliLabel }) {
    await this.ready()
    const text = String(prompt ?? '')
    if (!text.trim()) throw new Error('任务内容不能为空')
    if (!cli) throw new Error('缺少 cli')
    const now = new Date().toISOString()
    const task = {
      id: newId(),
      title: deriveTitle(text),
      cli: String(cli),
      cliLabel: cliLabel || String(cli),
      cwd: cwd || undefined,
      model: model || undefined,
      prompt: text,
      status: 'queued',
      archived: false,
      attempt: 1,
      origin,
      createdAt: now,
      startedAt: null,
      endedAt: null,
      output: '',
      error: null,
      meta: null,
    }
    this.#tasks.set(task.id, task)
    this.#touch(task)
    // snapshot BEFORE scheduling: the scheduler may flip the task to running
    // synchronously, and the route's response should describe the enqueue
    const card = { ...task }
    await this.#persist()
    this.#schedule()
    return card
  }

  /* -------------------------------------------------------- scheduler --- */

  /** Fill free slots FIFO. #start flips status synchronously before its first
   *  await, so the loop below can never double-start a task. */
  #schedule() {
    for (const task of this.#tasks.values()) {
      if (this.#controllers.size >= this.#settings.maxRunning) break
      if (task.status !== 'queued') continue
      this.#start(task)
    }
  }

  async #start(task) {
    const controller = new AbortController()
    this.#controllers.set(task.id, controller)
    task.status = 'running'
    task.startedAt = new Date().toISOString()
    task.error = null
    this.#touch(task)
    try {
      const adapter = await getAdapter(task.cli)
      if (!adapter) throw new Error(`CLI "${task.cli}" 不存在（可能已被删除）`)
      if (adapter.enabled === false) throw new Error(`CLI "${task.cli}" 已停用；可在 CLI 运行时页面重新启用`)
      const result = await runAdapter(adapter, task.prompt, {
        cwd: task.cwd,
        model: task.model,
        timeoutMs: Math.max(Number(adapter.timeoutMs) || 0, BOARD_TASK_TIMEOUT_MS),
        signal: controller.signal,
        onDelta: (delta) => this.#appendOutput(task, delta),
      })
      task.status = 'done'
      task.endedAt = new Date().toISOString()
      task.meta = result.meta || null
      // The engine's final text is authoritative (same rule as the v0.5.0
      // console); keep the streamed tail only when the engine said nothing.
      task.output = typeof result.text === 'string' && result.text ? result.text : task.output
      this.#touch(task)
    } catch (error) {
      const stopped = controller.signal.aborted
      task.status = stopped ? 'stopped' : 'failed'
      task.endedAt = new Date().toISOString()
      task.error = stopped ? '已停止' : String((error && error.message) || error)
      this.#touch(task)
    } finally {
      this.#controllers.delete(task.id)
      await this.#persist()
      this.#schedule()
    }
  }

  #appendOutput(task, delta) {
    if (typeof delta !== 'string' || !delta) return
    let out = task.output + delta
    if (out.length > store.TASK_OUTPUT_CAP) out = '…' + out.slice(-store.TASK_OUTPUT_CAP)
    task.output = out
    this.#emit({ type: 'output', id: task.id, delta })
  }

  /* ----------------------------------------------------------- mutate --- */

  /** stop | retry | archive | unarchive | delete. Business errors come back
   *  as {ok:false,error} (the /clients route convention), not HTTP throws. */
  async action(id, action) {
    await this.ready()
    const task = this.#tasks.get(id)
    if (!task) return { ok: false, error: `未找到任务 ${id}` }
    switch (action) {
      case 'stop': {
        if (task.status === 'queued') {
          task.status = 'stopped'
          task.endedAt = new Date().toISOString()
          task.error = '已取消（未开始）'
          this.#touch(task)
          await this.#persist()
          return { ok: true, task: { ...task } }
        }
        if (task.status === 'running') {
          this.#controllers.get(id)?.abort(new Error('stopped'))
          // the terminal transition lands in #start's catch and is broadcast
          return { ok: true, task: { ...task } }
        }
        return { ok: false, error: '任务已结束，无需停止' }
      }
      case 'retry': {
        if (!TERMINAL.has(task.status)) return { ok: false, error: '只能重试已结束的任务' }
        task.status = 'queued'
        task.attempt = (task.attempt || 1) + 1
        task.startedAt = null
        task.endedAt = null
        task.error = null
        task.meta = null
        task.output = ''
        this.#touch(task)
        const card = { ...task }
        await this.#persist()
        this.#schedule()
        return { ok: true, task: card }
      }
      case 'archive': {
        if (!TERMINAL.has(task.status)) return { ok: false, error: '请先停止任务再归档' }
        task.archived = true
        this.#touch(task)
        await this.#persist()
        return { ok: true, task: { ...task } }
      }
      case 'unarchive': {
        task.archived = false
        this.#touch(task)
        await this.#persist()
        return { ok: true, task: { ...task } }
      }
      case 'delete': {
        if (task.status === 'running') return { ok: false, error: '请先停止运行中的任务再删除' }
        this.#tasks.delete(id)
        this.#emit({ type: 'deleted', id })
        await this.#persist()
        return { ok: true }
      }
      default:
        return { ok: false, error: `未知操作 "${action}"` }
    }
  }

  /** Archive every finished task in one go (board footer button). */
  async archiveFinished() {
    await this.ready()
    let count = 0
    for (const task of this.#tasks.values()) {
      if (!task.archived && TERMINAL.has(task.status)) {
        task.archived = true
        count++
        this.#touch(task)
      }
    }
    if (count > 0) await this.#persist()
    return { ok: true, archived: count }
  }

  async updateSettings(patch) {
    await this.ready()
    this.#settings = store.normalizeTaskSettings({ ...this.#settings, ...(patch || {}) })
    await this.#persist()
    this.#emit({ type: 'settings', settings: { ...this.#settings } })
    this.#schedule()
    return { ok: true, settings: { ...this.#settings } }
  }

  /* -------------------------------------------------------- tool runs --- */

  /** Record a cli_agent delegation on the board WITHOUT the queue: tool runs
   *  are synchronous answers to the chat model and must not wait behind board
   *  tasks. The caller owns the actual run and reports back through the
   *  returned handle ({id, delta, done, fail}). */
  beginToolRun({ adapter, prompt, cwd, model }) {
    const now = new Date().toISOString()
    const task = {
      id: newId(),
      title: deriveTitle(prompt),
      cli: adapter.key,
      cliLabel: adapter.label || adapter.key,
      cwd: cwd || undefined,
      model: model || undefined,
      prompt: String(prompt ?? ''),
      status: 'running',
      archived: false,
      attempt: 1,
      origin: 'tool',
      createdAt: now,
      startedAt: now,
      endedAt: null,
      output: '',
      error: null,
      meta: null,
    }
    this.#tasks.set(task.id, task)
    this.#touch(task)
    return {
      id: task.id,
      delta: (delta) => this.#appendOutput(task, delta),
      done: async (result) => {
        task.status = 'done'
        task.endedAt = new Date().toISOString()
        task.meta = result?.meta || null
        task.output = typeof result?.text === 'string' && result.text ? result.text : task.output
        this.#touch(task)
        await this.#persist()
      },
      fail: async (error, status = 'failed') => {
        task.status = status === 'stopped' ? 'stopped' : 'failed'
        task.endedAt = new Date().toISOString()
        task.error = String((error && error.message) || error)
        this.#touch(task)
        await this.#persist()
      },
    }
  }
}

/* -------------------------------------------------------- singleton ------- */

let singleton = null

/** Host-half shared instance (panel routes + cli_agent tool). Tests build
 *  their own TaskManager instead. */
export function getTaskManager() {
  if (!singleton) singleton = new TaskManager()
  return singleton
}
