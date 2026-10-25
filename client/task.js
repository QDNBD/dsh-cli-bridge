/**
 * task — the panel's "任务看板" section, as its own browser module.
 *
 * Served by the host half at GET /cli-bridge/task.js and pulled in by
 * client.js through dynamic import(). This split is deliberate: the panel
 * shell (list/manage) and the task board evolve independently, so parallel
 * UI work never has to touch the same file.
 *
 * v0.7.0 rewrote the v0.5.0 run-box into a board (Multica-inspired, see
 * research/multica-task-board): tasks live SERVER-SIDE (task-manager.js), so
 * they survive closing/leaving the page — unlike /run, a disconnecting SSE
 * stream here is just a view problem, never a cancel.
 *
 *   composer  cli select (detected rows only) + cwd + optional model + prompt
 *             → POST /cli-bridge/tasks (queued; the server scheduler starts it)
 *   board     vertical status groups (运行中/排队中/已完成/失败/已停止), each
 *             card expands inline into the detail console (prompt/output/meta)
 *   transport one GET /cli-bridge/tasks/stream SSE per mount:
 *             snapshot | changed | output | settings | deleted; auto-reconnect
 *             (2s) with a REST resync so a flaky stream never lies
 *   control   停止 aborts server-side (engine kills the process tree), 重试
 *             re-queues a finished task (attempt+1), 归档/删除 tidy up
 *
 * No imports: React and the shared visual vocabulary arrive through
 * createTaskSection(deps), keeping this file host-agnostic and testable.
 */

const ROUTE_TASKS = '/cli-bridge/tasks'
const ROUTE_TASKS_ACTION = '/cli-bridge/tasks/action'
const ROUTE_TASKS_STREAM = '/cli-bridge/tasks/stream'
const OUT_MAX = 200_000 // live console cap (chars); the tail is kept

async function api(path, method, body) {
  const res = await fetch(path, {
    method: method || 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data && data.error) || 'HTTP ' + res.status)
  return data
}

function fmtDuration(ms) {
  if (!(ms >= 0)) return ''
  if (ms < 60_000) return (ms / 1000).toFixed(1) + 's'
  return Math.floor(ms / 60_000) + 'm' + Math.round((ms % 60_000) / 1000) + 's'
}

/** Build the section component against one panel shell. */
export function createTaskSection({ React, zh, COLOR, STYLE, Field, sectionHead, readFlag, writeFlag }) {
  const h = React.createElement
  const { useEffect, useMemo, useRef, useState } = React

  const STATUS_COLOR = {
    running: COLOR.accent,
    queued: COLOR.dim,
    done: COLOR.ok,
    failed: COLOR.missing,
    stopped: COLOR.warn,
  }

  const T = zh
    ? {
        section: '任务看板',
        hint: '任务在后台运行：关闭/切走本页面不会中断，重开页面即恢复视图；对话里 cli_agent 的委派也会记录到这里。',
        cli: 'CLI',
        cwd: '工作目录（可空，记住上次）',
        cwdPh: 'D:\\code\\myproject',
        model: '模型（可空）',
        promptPh: '写下要执行的任务…',
        pickCli: '选择 CLI…',
        run: '运行',
        submitting: '提交中…',
        noCli: '请先选择 CLI',
        noPrompt: '请填写任务内容',
        noCliAvailable: '没有检测到可用的 CLI，请先看上方运行时清单',
        gRunning: '运行中',
        gQueued: '排队中',
        gDone: '已完成',
        gFailed: '失败',
        gStopped: '已停止',
        gArchived: '已归档',
        stop: '停止',
        retry: '重试',
        archive: '归档',
        unarchive: '恢复',
        del: '删',
        delConfirm: '删除任务"%s"？不可恢复。',
        archiveAll: '归档全部已完成',
        showArchived: '已归档',
        empty: '看板还没有任务——用上方组合器发起，或直接在对话里调 cli_agent。',
        connLost: '⚠ 看板实时连接中断，正在重连（视图可能滞后）…',
        concurrent: '并发上限',
        queuedAhead: (n) => (n > 0 ? '前面 ' + n + ' 个' : '即将运行'),
        attemptTag: (n) => '第' + n + '次',
        promptLabel: '任务内容',
        runningNow: '运行中',
        tools: '工具',
        loading: '…',
        session: '会话',
        exit: '退出码',
      }
    : {
        section: 'Task Board',
        hint: 'Tasks run in the background: leaving or closing this page never cancels them; cli_agent delegations from chat are recorded here too.',
        cli: 'CLI',
        cwd: 'Working dir (optional, remembers last)',
        cwdPh: 'D:\\code\\myproject',
        model: 'Model (optional)',
        promptPh: 'Describe the task to run…',
        pickCli: 'Pick a CLI…',
        run: 'Run',
        submitting: 'Submitting…',
        noCli: 'Pick a CLI first',
        noPrompt: 'The task prompt is empty',
        noCliAvailable: 'No detected CLI available — check the runtime list above',
        gRunning: 'Running',
        gQueued: 'Queued',
        gDone: 'Done',
        gFailed: 'Failed',
        gStopped: 'Stopped',
        gArchived: 'Archived',
        stop: 'Stop',
        retry: 'Retry',
        archive: 'Archive',
        unarchive: 'Restore',
        del: 'Del',
        delConfirm: 'Delete task "%s"? This cannot be undone.',
        archiveAll: 'Archive all finished',
        showArchived: 'Archived',
        empty: 'No tasks yet — start one above, or delegate via cli_agent in chat.',
        connLost: '⚠ Board stream disconnected, reconnecting (view may lag)…',
        concurrent: 'Max parallel',
        queuedAhead: (n) => (n > 0 ? (n > 1 ? n - 1 + ' ahead' : 'starts next') : 'starts next'),
        attemptTag: (n) => 'attempt ' + n,
        promptLabel: 'Prompt',
        runningNow: 'running',
        tools: 'tools',
        loading: '…',
        session: 'session',
        exit: 'exit',
      }

  const GROUPS = [
    ['running', T.gRunning],
    ['queued', T.gQueued],
    ['done', T.gDone],
    ['failed', T.gFailed],
    ['stopped', T.gStopped],
  ]

  function metaSummary(task) {
    const parts = []
    const meta = task.meta || {}
    const ms =
      task.status === 'running' && task.startedAt
        ? Date.now() - new Date(task.startedAt).getTime()
        : meta.durationMs != null
          ? meta.durationMs
          : task.startedAt && task.endedAt
            ? new Date(task.endedAt).getTime() - new Date(task.startedAt).getTime()
            : null
    if (ms != null) parts.push(fmtDuration(ms))
    if (meta.model) parts.push(String(meta.model))
    if (typeof meta.costUsd === 'number') parts.push('$' + meta.costUsd.toFixed(4))
    if (typeof meta.toolCalls === 'number') parts.push(T.tools + ' ' + meta.toolCalls)
    return parts.join(' · ')
  }

  /** TaskBoard — availableRows: [{key,label,protocol}] (detected, enabled);
   *  preset: {key, at} from a runtime row's ▶ button, selects that CLI. */
  return function TaskBoard({ availableRows, preset }) {
    const [open, setOpen] = useState(function () {
      return readFlag('cli-bridge:taskOpen', true)
    })
    const [cli, setCli] = useState(function () {
      try {
        return window.localStorage.getItem('cli-bridge:taskCli') || ''
      } catch (error) {
        return ''
      }
    })
    const [cwd, setCwd] = useState(function () {
      try {
        return window.localStorage.getItem('cli-bridge:taskCwd') || ''
      } catch (error) {
        return ''
      }
    })
    const [model, setModel] = useState('')
    const [prompt, setPrompt] = useState('')
    const [formError, setFormError] = useState(null)
    const [submitting, setSubmitting] = useState(false)

    const [tasks, setTasks] = useState([])
    const [settings, setSettings] = useState({ maxRunning: 2 })
    const [expandedId, setExpandedId] = useState(null)
    const [showArchived, setShowArchived] = useState(false)
    const [connected, setConnected] = useState(false)
    const [tick, setTick] = useState(0)

    const alive = useRef(true)
    const streamAbort = useRef(null)
    const retryTimer = useRef(null)
    const outRef = useRef(null)
    const rows = availableRows || []

    /* ------------------------------------------------- event application --- */

    function applySnapshot(data) {
      setTasks(Array.isArray(data && data.tasks) ? data.tasks : [])
      if (data && data.settings) setSettings(data.settings)
    }

    function upsertTask(task) {
      if (!task || !task.id) return
      setTasks(function (prev) {
        const index = prev.findIndex(function (t) {
          return t.id === task.id
        })
        if (index < 0) return prev.concat([task])
        const next = prev.slice()
        next[index] = task
        return next
      })
    }

    function applyEvent(event) {
      if (!event || !event.type) return
      if (event.type === 'snapshot') {
        applySnapshot(event)
        setConnected(true)
      } else if (event.type === 'changed') {
        upsertTask(event.task)
      } else if (event.type === 'output') {
        setTasks(function (prev) {
          return prev.map(function (t) {
            if (t.id !== event.id || typeof event.delta !== 'string') return t
            let out = t.output + event.delta
            if (out.length > OUT_MAX) out = '…' + out.slice(-OUT_MAX)
            return { ...t, output: out }
          })
        })
      } else if (event.type === 'settings') {
        setSettings(event.settings || { maxRunning: 2 })
      } else if (event.type === 'deleted') {
        setTasks(function (prev) {
          return prev.filter(function (t) {
            return t.id !== event.id
          })
        })
      }
    }

    /* ------------------------------------------------------- sse stream --- */

    function connectStream() {
      if (!alive.current) return
      if (streamAbort.current) {
        try {
          streamAbort.current.abort()
        } catch (error) {
          /* closing an old stream must never break a new one */
        }
      }
      const controller = new AbortController()
      streamAbort.current = controller
      fetch(ROUTE_TASKS_STREAM, { signal: controller.signal, cache: 'no-store' })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status)
          const ctype = res.headers.get('content-type') || ''
          if (ctype.indexOf('text/event-stream') < 0) throw new Error('unexpected response: ' + ctype)
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let pending = ''
          function pump() {
            reader.read().then(
              function (step) {
                if (!alive.current) return
                if (step.done) throw new Error('stream closed')
                pending += decoder.decode(step.value, { stream: true })
                let frameEnd
                while ((frameEnd = pending.indexOf('\n\n')) >= 0) {
                  const frame = pending.slice(0, frameEnd)
                  pending = pending.slice(frameEnd + 2)
                  const lines = frame.split('\n')
                  for (let i = 0; i < lines.length; i++) {
                    const line = lines[i]
                    if (!line.startsWith('data:')) continue
                    let event = null
                    try {
                      event = JSON.parse(line.slice(5).trim())
                    } catch (error) {
                      continue
                    }
                    applyEvent(event)
                  }
                }
                pump()
              },
              function () {
                scheduleReconnect()
              },
            )
          }
          pump()
        })
        .catch(function () {
          scheduleReconnect()
        })
    }

    function scheduleReconnect() {
      if (!alive.current) return
      setConnected(false)
      // REST resync first so the board stays truthful even while reconnecting
      api(ROUTE_TASKS).then(
        function (data) {
          if (alive.current) applySnapshot(data)
        },
        function () {
          /* retry will surface the failure if it persists */
        },
      )
      if (retryTimer.current) return
      retryTimer.current = setTimeout(function () {
        retryTimer.current = null
        connectStream()
      }, 2000)
    }

    // mount: initial snapshot + stream; unmount: drop the VIEW only — the
    // server keeps running the tasks (that is the point of the board).
    useEffect(function () {
      alive.current = true
      api(ROUTE_TASKS).then(
        function (data) {
          if (alive.current) applySnapshot(data)
        },
        function (error) {
          if (alive.current) setFormError(String((error && error.message) || error))
        },
      )
      connectStream()
      return function () {
        alive.current = false
        if (streamAbort.current) streamAbort.current.abort()
        if (retryTimer.current) {
          clearTimeout(retryTimer.current)
          retryTimer.current = null
        }
      }
    }, [])

    // elapsed-seconds heartbeat while anything is running
    const anyRunning = tasks.some(function (t) {
      return t.status === 'running'
    })
    useEffect(function () {
      if (!anyRunning) return
      const timer = setInterval(function () {
        setTick(function (value) {
          return value + 1
        })
      }, 1000)
      return function () {
        clearInterval(timer)
      }
    }, [anyRunning])

    // keep the expanded console pinned to the newest output
    useEffect(function () {
      const el = outRef.current
      if (el) el.scrollTop = el.scrollHeight
    }, [expandedId, tick, tasks])

    // ▶ on a runtime row: select that CLI and reveal the section
    useEffect(
      function () {
        if (!preset || !preset.key || !preset.at) return
        setOpen(true)
        writeFlag('cli-bridge:taskOpen', true)
        setCli(preset.key)
        setFormError(null)
      },
      [preset && preset.at],
    )

    function toggleOpen() {
      setOpen(function (value) {
        writeFlag('cli-bridge:taskOpen', !value)
        return !value
      })
    }

    /* --------------------------------------------------------- actions --- */

    async function startTask() {
      if (submitting) return
      if (!cli) {
        setFormError(T.noCli)
        return
      }
      if (!prompt.trim()) {
        setFormError(T.noPrompt)
        return
      }
      setFormError(null)
      setSubmitting(true)
      try {
        try {
          window.localStorage.setItem('cli-bridge:taskCli', cli)
          window.localStorage.setItem('cli-bridge:taskCwd', cwd)
        } catch (error) {
          /* remembering is best-effort */
        }
        const data = await api(ROUTE_TASKS, 'POST', {
          cli,
          prompt,
          cwd: cwd.trim() || undefined,
          model: model.trim() || undefined,
        })
        if (data && data.task) upsertTask(data.task)
        setPrompt('')
      } catch (error) {
        setFormError(String((error && error.message) || error))
      } finally {
        setSubmitting(false)
      }
    }

    async function runAction(id, action) {
      try {
        const data = await api(ROUTE_TASKS_ACTION, 'POST', { id, action })
        if (data && data.task) upsertTask(data.task)
        else if (data && data.ok && action === 'delete') {
          setTasks(function (prev) {
            return prev.filter(function (t) {
              return t.id !== id
            })
          })
        } else if (data && data.ok === false) {
          setFormError(data.error || '操作失败')
        }
      } catch (error) {
        setFormError(String((error && error.message) || error))
      }
    }

    async function archiveAll() {
      try {
        await api(ROUTE_TASKS_ACTION, 'POST', { action: 'archive_finished' })
        const data = await api(ROUTE_TASKS)
        applySnapshot(data)
      } catch (error) {
        setFormError(String((error && error.message) || error))
      }
    }

    async function changeConcurrency(value) {
      try {
        const data = await api(ROUTE_TASKS, 'PUT', { maxRunning: Number(value) })
        if (data && data.settings) setSettings(data.settings)
      } catch (error) {
        setFormError(String((error && error.message) || error))
      }
    }

    /* ---------------------------------------------------------- pieces --- */

    function cardSubtitle(task, queueAhead) {
      const parts = [task.cli]
      if (task.status === 'queued') parts.push(T.queuedAhead(queueAhead))
      else if (task.status === 'running' && task.startedAt) parts.push(T.runningNow + ' ' + fmtDuration(Date.now() - new Date(task.startedAt).getTime()))
      else {
        const summary = metaSummary(task)
        if (summary) parts.push(summary)
      }
      if (task.attempt > 1) parts.push(T.attemptTag(task.attempt))
      if (task.origin === 'tool') parts.push(zh ? '对话委派' : 'from chat')
      return parts.join(' · ')
    }

    function actionButtons(task) {
      const buttonStyle = STYLE.button
      const stop = function (fn) {
        return function (e) {
          e.stopPropagation()
          fn()
        }
      }
      if (task.status === 'running' || task.status === 'queued') {
        return [
          h(
            'button',
            { key: 'stop', style: { ...buttonStyle, color: COLOR.missing, borderColor: COLOR.missing }, onClick: stop(function () { runAction(task.id, 'stop') }) },
            '■ ' + T.stop,
          ),
        ]
      }
      const buttons = [
        h('button', { key: 'retry', style: { ...buttonStyle, color: COLOR.accent, borderColor: COLOR.accent }, onClick: stop(function () { runAction(task.id, 'retry') }) }, '↻ ' + T.retry),
      ]
      if (!task.archived) {
        buttons.push(h('button', { key: 'arch', style: buttonStyle, onClick: stop(function () { runAction(task.id, 'archive') }) }, T.archive))
      } else {
        buttons.push(h('button', { key: 'unarch', style: buttonStyle, onClick: stop(function () { runAction(task.id, 'unarchive') }) }, T.unarchive))
      }
      buttons.push(
        h(
          'button',
          {
            key: 'del',
            style: buttonStyle,
            onClick: stop(function () {
              const label = String(task.title || task.id).replace(/%s/g, '')
              if (window.confirm((zh ? '删除任务 "' : 'Delete task "') + label + (zh ? '"？不可恢复。' : '"? This cannot be undone.'))) {
                runAction(task.id, 'delete')
              }
            }),
          },
          T.del,
        ),
      )
      return buttons
    }

    function renderCard(task, queueAhead) {
      const color = STATUS_COLOR[task.status] || COLOR.dim
      const expanded = expandedId === task.id
      const children = [
        h('span', {
          key: 'dot',
          style: { width: 8, height: 8, borderRadius: '50%', flex: '0 0 auto', backgroundColor: color },
        }),
        h('div', { key: 'mid', style: { flex: 1, minWidth: 0 } }, [
          h(
            'div',
            {
              key: 'title',
              style: { fontSize: 12, fontWeight: 600, color: COLOR.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            },
            (task.title || task.id) + (task.archived ? (zh ? '（已归档）' : ' (archived)') : ''),
          ),
          h('div', { key: 'sub', style: { fontSize: 11, color: COLOR.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, cardSubtitle(task, queueAhead)),
        ]),
      ].concat(actionButtons(task))
      const card = h(
        'div',
        {
          key: task.id,
          'data-task-id': task.id,
          'data-task-status': task.status,
          onClick: function () {
            setExpandedId(expanded ? null : task.id)
          },
          style: { ...STYLE.card, cursor: 'pointer', alignItems: 'center', marginBottom: expanded ? 0 : 8, borderRadius: expanded ? '8px 8px 0 0' : 8 },
        },
        children,
      )
      if (!expanded) return card
      const meta = task.meta || {}
      const metaParts = []
      if (meta.sessionId) metaParts.push(T.session + ' ' + meta.sessionId)
      if (typeof meta.exitCode === 'number') metaParts.push(T.exit + ' ' + meta.exitCode)
      // the card row must STAY above its detail (inline-editor pattern) —
      // dropping it would hide the retry/archive/delete actions
      return [
        card,
        h('div', { key: task.id + ':detail', 'data-task-detail': task.id, style: { border: '1px solid ' + COLOR.border, borderTop: 'none', borderRadius: '0 0 8px 8px', padding: '8px 10px', marginBottom: 8 } }, [
          task.cwd || task.model
            ? h(
                'div',
                { key: 'cfg', style: { fontSize: 11, color: COLOR.dim, marginBottom: 6 } },
                [task.cwd ? (zh ? '目录 ' : 'cwd ') + task.cwd : null, task.model ? (zh ? '模型 ' : 'model ') + task.model : null].filter(Boolean).join(' · '),
              )
            : null,
          h(
            'div',
            { key: 'plabel', style: { fontSize: 11, color: COLOR.dim, marginBottom: 2 } },
            T.promptLabel + (task.attempt > 1 ? ' · ' + T.attemptTag(task.attempt) : ''),
          ),
          h(
            'pre',
            {
              key: 'prompt',
              style: { margin: '0 0 8px', padding: '6px 8px', maxHeight: 110, overflowY: 'auto', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: COLOR.input, borderRadius: 6, color: COLOR.text },
            },
            task.prompt || '',
          ),
          task.error
            ? h(
                'div',
                { key: 'err', style: { marginBottom: 8, padding: '6px 8px', borderRadius: 6, fontSize: 12, color: COLOR.missing, border: '1px solid ' + COLOR.missing, whiteSpace: 'pre-wrap', wordBreak: 'break-all' } },
                task.error,
              )
            : null,
          h(
            'pre',
            {
              key: 'out',
              ref: outRef,
              'data-task-output': '1',
              style: { margin: '0 0 8px', padding: '6px 8px', maxHeight: 260, overflowY: 'auto', fontSize: 12, fontFamily: 'ui-monospace, Consolas, monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: COLOR.input, borderRadius: 6, color: COLOR.text },
            },
            task.output || (task.status === 'running' ? T.loading : ''),
          ),
          metaSummary(task) || metaParts.length > 0
            ? h('div', { key: 'meta', style: { fontSize: 11, color: COLOR.dim } }, [metaSummary(task)].concat(metaParts).filter(Boolean).join(' · '))
            : null,
        ]),
      ]
    }

    /* ----------------------------------------------------------- render --- */

    // status groups always hold NON-archived tasks; archived ones live only in
    // their own group below the toggle — never in both places at once
    const active = tasks.filter(function (t) { return !t.archived })
    const grouped = useMemo(
      function () {
        const map = { running: [], queued: [], done: [], failed: [], stopped: [] }
        for (const task of active) {
          if (map[task.status]) map[task.status].push(task)
        }
        // active groups FIFO so the next-up task is on top; finished newest-first
        map.running.sort(function (a, b) { return String(a.createdAt).localeCompare(String(b.createdAt)) })
        map.queued.sort(function (a, b) { return String(a.createdAt).localeCompare(String(b.createdAt)) })
        const desc = function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)) }
        map.done.sort(desc)
        map.failed.sort(desc)
        map.stopped.sort(desc)
        return map
      },
      [tasks],
    )
    const archivedTasks = tasks.filter(function (t) { return t.archived })
    const activeCount = grouped.running.length + grouped.queued.length
    const finishedVisibleCount = grouped.done.length + grouped.failed.length + grouped.stopped.length

    const cliOptions = [h('option', { key: '', value: '', disabled: true }, T.pickCli)].concat(
      rows.map(function (row) {
        return h('option', { key: row.key, value: row.key }, row.key + ' — ' + (row.label || row.key))
      }),
    )
    const cliKnown = !cli || rows.some(function (row) { return row.key === cli })

    const groupBlocks = []
    for (const [statusKey, label] of GROUPS) {
      const list = grouped[statusKey]
      if (list.length === 0) continue
      groupBlocks.push(
        h('div', { key: 'grp-' + statusKey, 'data-board-group': statusKey }, [
          h(
            'div',
            { key: 'head', style: { fontSize: 11, fontWeight: 600, color: STATUS_COLOR[statusKey], margin: '10px 0 6px', display: 'flex', alignItems: 'center', gap: 6 } },
            [
              h('span', { key: 'n' }, label + ' (' + list.length + ')'),
              statusKey === 'queued' && settings.maxRunning
                ? h('span', { key: 'slot', style: { fontWeight: 400, color: COLOR.dim } }, '· ' + (zh ? '并发' : 'parallel') + ' ' + settings.maxRunning)
                : null,
            ],
          ),
        ].concat(
          list.map(function (task, index) {
            return renderCard(task, statusKey === 'queued' ? index : 0)
          }),
        )),
      )
    }

    return h('div', { 'data-task-section': '1' }, [
      sectionHead(open, toggleOpen, T.section, activeCount > 0 ? activeCount : undefined, T.hint),
      open
        ? h('div', { key: 'body' }, [
            h('div', { key: 'hint', style: { color: COLOR.dim, fontSize: 12, marginBottom: 8 } }, T.hint),
            rows.length === 0
              ? h('div', { key: 'nocli', style: { color: COLOR.warn, fontSize: 12, marginBottom: 8 } }, T.noCliAvailable)
              : null,
            // minmax(0,…) lets grid tracks shrink below the inputs' default
            // min-content width — without it the 340px sidebar gets a
            // horizontal scrollbar (v0.5.0's composer had the same latent bug)
            h('div', { key: 'grid', style: { display: 'grid', gridTemplateColumns: 'minmax(0,1.2fr) minmax(0,1fr) minmax(0,0.8fr)', gap: 8, marginBottom: 8 } }, [
                h(Field, { key: 'cli', label: T.cli }, function () {
                  return h(
                    'select',
                    {
                      style: STYLE.input,
                      value: cliKnown ? cli : '',
                      onChange: function (e) {
                        setCli(e.target.value)
                      },
                    },
                    cliOptions,
                  )
                }),
                h(Field, { key: 'cwd', label: T.cwd }, function () {
                  return h('input', {
                    style: STYLE.input,
                    value: cwd,
                    onChange: function (e) {
                      setCwd(e.target.value)
                    },
                    placeholder: T.cwdPh,
                  })
                }),
                h(Field, { key: 'model', label: T.model }, function () {
                  return h('input', {
                    style: STYLE.input,
                    value: model,
                    onChange: function (e) {
                      setModel(e.target.value)
                    },
                  })
                }),
              ]),
            h('textarea', {
              key: 'prompt',
              style: { ...STYLE.input, minHeight: 64, resize: 'vertical', marginBottom: 8 },
              value: prompt,
              onChange: function (e) {
                setPrompt(e.target.value)
              },
              placeholder: T.promptPh,
            }),
            h('div', { key: 'actions', style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 } }, [
              h(
                'button',
                {
                  key: 'run',
                  style: { ...STYLE.button, borderColor: COLOR.accent, color: COLOR.accent },
                  disabled: rows.length === 0 || submitting,
                  onClick: startTask,
                  'data-run-task': '1',
                },
                submitting ? T.submitting : '▶ ' + T.run,
              ),
              h(Field, { key: 'conc', label: T.concurrent }, function () {
                return h(
                  'select',
                  {
                    style: { ...STYLE.input, width: 64 },
                    value: String(settings.maxRunning),
                    onChange: function (e) {
                      changeConcurrency(e.target.value)
                    },
                  },
                  [1, 2, 3, 4, 5].map(function (n) {
                    return h('option', { key: n, value: String(n) }, String(n))
                  }),
                )
              }),
              formError
                ? h('div', { key: 'err', style: { color: COLOR.missing, fontSize: 12, whiteSpace: 'pre-wrap' } }, formError)
                : null,
            ]),
            connected
              ? null
              : h('div', { key: 'conn', style: { color: COLOR.warn, fontSize: 12, margin: '4px 0 8px' } }, T.connLost),
            tasks.length === 0
              ? h('div', { key: 'empty', style: { color: COLOR.dim, fontSize: 12, padding: '8px 0' } }, T.empty)
              : groupBlocks,
            finishedVisibleCount > 0
              ? h(
                  'button',
                  { key: 'archiveall', style: STYLE.button, onClick: archiveAll },
                  T.archiveAll + ' (' + finishedVisibleCount + ')',
                )
              : null,
            archivedTasks.length > 0
              ? h(
                  'button',
                  {
                    key: 'showarch',
                    style: { ...STYLE.button, marginLeft: 8, color: showArchived ? COLOR.accent : COLOR.text, borderColor: showArchived ? COLOR.accent : COLOR.border },
                    onClick: function () {
                      setShowArchived(function (v) {
                        return !v
                      })
                    },
                  },
                  T.showArchived + ' (' + archivedTasks.length + ')',
                )
              : null,
            showArchived && archivedTasks.length > 0
              ? h('div', { key: 'archgrp', 'data-board-group': 'archived' }, [
                  h('div', { key: 'ahead', style: { fontSize: 11, fontWeight: 600, color: COLOR.dim, margin: '10px 0 6px' } }, T.gArchived + ' (' + archivedTasks.length + ')'),
                ].concat(
                  archivedTasks
                    .slice()
                    .sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)) })
                    .map(function (task) { return renderCard(task, 0) }),
                ))
              : null,
          ])
        : null,
    ])
  }
}
