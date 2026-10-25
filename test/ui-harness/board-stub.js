/**
 * board-stub — a minimal in-memory task manager for the ui-harness: enough
 * lifecycle (queued → running → done, stop/retry/archive/delete, settings)
 * to click through the real board UI in a browser. Not a product file.
 */
const tasks = []
const timers = new Map() // task id → run timer; NEVER stored on the task —
// timers are Timeout objects with circular refs and would break JSON round-trips
let maxRunning = 2
const subscribers = new Set()

const emit = (event) => {
  for (const fn of subscribers) {
    try { fn(event) } catch {}
  }
}
const snapshot = () => ({ tasks: tasks.map((t) => ({ ...t })), settings: { maxRunning } })

function create(payload) {
  const prompt = String(payload.prompt || '')
  if (!prompt.trim()) throw new Error('任务内容不能为空')
  if (!payload.cli) throw new Error('缺少 cli')
  const task = {
    id: 'stub_' + Date.now().toString(36) + '_' + tasks.length,
    title: (prompt.split(/\r?\n/).find((l) => l.trim()) || prompt).trim().slice(0, 60),
    cli: payload.cli,
    cliLabel: payload.cli,
    cwd: payload.cwd || undefined,
    model: payload.model || undefined,
    prompt,
    status: 'queued',
    archived: false,
    attempt: 1,
    origin: 'panel',
    createdAt: new Date().toISOString(),
    startedAt: null,
    endedAt: null,
    output: '',
    error: null,
    meta: null,
  }
  tasks.push(task)
  emit({ type: 'changed', task: { ...task } })
  schedule()
  return { ...task }
}

function schedule() {
  let running = tasks.filter((t) => t.status === 'running').length
  for (const task of tasks) {
    if (running >= maxRunning) break
    if (task.status !== 'queued') continue
    start(task)
    running++
  }
}

function start(task) {
  task.status = 'running'
  task.startedAt = new Date().toISOString()
  emit({ type: 'changed', task: { ...task } })
  let i = 0
  const timer = setInterval(() => {
    i += 1
    if (task.status !== 'running') return clearInterval(timer)
    if (i <= 5) {
      task.output += `chunk ${i} — `
      emit({ type: 'output', id: task.id, delta: `chunk ${i} — ` })
      return
    }
    clearInterval(timer)
    timers.delete(task.id)
    task.status = 'done'
    task.endedAt = new Date().toISOString()
    task.meta = { durationMs: 1800, model: task.model || 'stub-model', toolCalls: 1, sessionId: 'stub-1' }
    emit({ type: 'changed', task: { ...task } })
  }, 300)
  timers.set(task.id, timer)
}

function action(payload) {
  const action = payload.action
  if (action === 'archive_finished') {
    let n = 0
    for (const t of tasks) {
      if (!t.archived && ['done', 'failed', 'stopped'].includes(t.status)) {
        t.archived = true
        n++
        emit({ type: 'changed', task: { ...t } })
      }
    }
    return { ok: true, archived: n }
  }
  const task = tasks.find((t) => t.id === payload.id)
  if (!task) return { ok: false, error: '未找到任务 ' + payload.id }
  if (action === 'stop') {
    if (timers.has(task.id)) clearInterval(timers.get(task.id))
    task.status = 'stopped'
    task.endedAt = new Date().toISOString()
    task.error = task.status === 'stopped' && task.output ? task.error : '已停止'
    if (!task.output) task.error = task.status === 'queued' ? '已取消（未开始）' : '已停止'
    emit({ type: 'changed', task: { ...task } })
    schedule()
    return { ok: true, task: { ...task } }
  }
  if (action === 'retry') {
    if (!['done', 'failed', 'stopped'].includes(task.status)) return { ok: false, error: '只能重试已结束的任务' }
    task.status = 'queued'
    task.attempt = (task.attempt || 1) + 1
    task.startedAt = null
    task.endedAt = null
    task.output = ''
    task.error = null
    task.meta = null
    emit({ type: 'changed', task: { ...task } })
    schedule()
    return { ok: true, task: { ...task } }
  }
  if (action === 'archive') {
    if (!['done', 'failed', 'stopped'].includes(task.status)) return { ok: false, error: '请先停止任务再归档' }
    task.archived = true
    emit({ type: 'changed', task: { ...task } })
    return { ok: true, task: { ...task } }
  }
  if (action === 'unarchive') {
    task.archived = false
    emit({ type: 'changed', task: { ...task } })
    return { ok: true, task: { ...task } }
  }
  if (action === 'delete') {
    if (timers.has(task.id)) clearInterval(timers.get(task.id))
    const index = tasks.indexOf(task)
    if (index >= 0) tasks.splice(index, 1)
    emit({ type: 'deleted', id: payload.id })
    return { ok: true }
  }
  return { ok: false, error: '未知操作 ' + action }
}

function settings(patch) {
  const max = Number(patch && patch.maxRunning)
  if (Number.isFinite(max)) maxRunning = Math.min(5, Math.max(1, Math.round(max)))
  emit({ type: 'settings', settings: { maxRunning } })
  schedule()
  return { ok: true, settings: { maxRunning } }
}

module.exports = {
  snapshot,
  subscribe: (fn) => {
    subscribers.add(fn)
    return () => subscribers.delete(fn)
  },
  create,
  action,
  settings,
}
