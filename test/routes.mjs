/**
 * Panel routes E2E — exercise the real webServer handler with mock req/res,
 * covering GET/POST/PUT/DELETE /clients, GET ?all=1, POST /clients/test,
 * GET /clis, GET /task.js and the SSE run route POST /run (happy path,
 * live deltas, premature-disconnect cancel, validation errors).
 * Uses a temp DSH_HOME so the real config is untouched.
 *   node test/routes.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'cli-bridge-routes-'))

const panel = await import('../panel.js')
const store = await import('../store.js')

// ---- mock host ---------------------------------------------------------- //
let handler = null
// cordis mounts injected services directly on ctx (ctx.webServer.register),
// so the mock mirrors that shape.
const ctx = {
  webServer: {
    register(spec) {
      handler = spec.handler
    },
  },
  effect(fn) {
    fn.call(ctx)
  },
}

function mockRequest(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function mockResponse() {
  const listeners = {}
  return {
    statusCode: 0,
    headers: null,
    body: undefined,
    chunks: [],
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = headers
    },
    write(chunk) {
      this.chunks.push(String(chunk))
    },
    end(payload) {
      this.body = payload
    },
    on(event, fn) {
      ;(listeners[event] = listeners[event] || []).push(fn)
    },
    emitClose() {
      for (const fn of listeners.close || []) fn()
    },
  }
}

async function call(method, url, body) {
  const res = mockResponse()
  await handler(mockRequest(method, url, body), res)
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : undefined }
}

/** Streaming variant: collects write() chunks (SSE) or the end() payload. */
async function callRaw(method, url, body) {
  const res = mockResponse()
  await handler(mockRequest(method, url, body), res)
  const text = res.chunks.length > 0 ? res.chunks.join('') : typeof res.body === 'string' ? res.body : ''
  return { status: res.statusCode, headers: res.headers || {}, text, res }
}

function parseSse(text) {
  const events = []
  for (const frame of String(text).split('\n\n')) {
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue
      try {
        events.push(JSON.parse(line.slice(5).trim()))
      } catch {
        /* skip malformed frame */
      }
    }
  }
  return events
}

const problems = []
const check = (cond, message) => {
  if (!cond) problems.push(message)
}

panel.registerPanelRoute(ctx)
check(typeof handler === 'function', 'handler not registered')

// 1. GET /clis (fresh) — full catalog probe rows with source/protocol
const clis = await call('GET', '/cli-bridge/clis?fresh=1')
check(clis.status === 200 && Array.isArray(clis.json.clients), 'GET /clis failed')
check(clis.json.clients.length >= 30, `expected >=30 rows, got ${clis.json.clients.length}`)
check(clis.json.clients.every((c) => c.source && c.protocol), 'rows missing source/protocol')
const atomRow = clis.json.clients.find((c) => c.key === 'atomcode')
check(atomRow?.ok === true, `atomcode probe unexpected: ${JSON.stringify(atomRow)}`)

// 2. GET /clients — empty at first
let listing = await call('GET', '/cli-bridge/clients')
check(listing.status === 200 && listing.json.clients.length === 0, 'initial GET /clients not empty')

// 3. POST /clients — create
const payload = {
  key: 'echo-route',
  label: 'Echo Route',
  protocol: 'generic-json',
  command: process.execPath,
  args: ['-e', 'console.log(JSON.stringify({type:"result",result:"route ok"}))'],
  promptDelivery: 'stdin',
  timeoutMs: 15000,
}
const created = await call('POST', '/cli-bridge/clients', payload)
check(created.status === 200 && created.json.ok === true, `POST /clients failed: ${JSON.stringify(created.json)}`)
check(created.json.replaced === false, 'first create should not report replaced')

// invalid payload rejected
const bad = await call('POST', '/cli-bridge/clients', { ...payload, key: 'Bad!' })
check(bad.json.ok === false && bad.json.error, 'invalid key not rejected')

// 4. GET /clients — now contains it, persisted
listing = await call('GET', '/cli-bridge/clients')
check(listing.json.clients.some((c) => c.key === 'echo-route'), 'created client missing from listing')

// 5. PUT /clients — toggle enabled
const stored = listing.json.clients.find((c) => c.key === 'echo-route')
const toggled = await call('PUT', '/cli-bridge/clients', { ...stored, enabled: false })
check(toggled.json.ok === true, `PUT toggle failed: ${JSON.stringify(toggled.json)}`)
listing = await call('GET', '/cli-bridge/clients')
check(listing.json.clients.find((c) => c.key === 'echo-route').enabled === false, 'enabled flag not persisted')

// 6. GET /clients?all=1 — builtin + custom full configs for editor prefill
const all = await call('GET', '/cli-bridge/clients?all=1')
check(all.json.clients.length >= 31, `?all=1 expected >=31, got ${all.json.clients.length}`)
const echoAll = all.json.clients.find((c) => c.key === 'echo-route')
check(echoAll?.source === 'custom' && echoAll?.enabled === false, 'custom entry wrong in ?all=1')
const claudeAll = all.json.clients.find((c) => c.key === 'claude')
check(Array.isArray(claudeAll?.args) && claudeAll.args.includes('-p'), 'builtin prefill config missing args')

// 7. POST /clients/test — draft probe without saving (use builtin gemini, installed locally)
const test = await call('POST', '/cli-bridge/clients/test', {
  key: 'route-test-probe',
  label: 'x',
  protocol: 'generic-json',
  command: 'gemini',
  args: ['--version'],
  promptDelivery: 'stdin',
})
check(test.status === 200 && typeof test.json.ok === 'boolean', 'test route failed')
check(test.json.ok === true, `gemini probe failed: ${test.json.detail || test.json.error}`)

// 8. DELETE /clients?key=
const removed = await call('DELETE', '/cli-bridge/clients?key=echo-route')
check(removed.json.ok === true, 'DELETE failed')
listing = await call('GET', '/cli-bridge/clients')
check(listing.json.clients.length === 0, 'clients not empty after delete')

// 9. GET /models — catalog resolution per adapter
const modelsClaude = await call('GET', '/cli-bridge/models?key=claude')
check(modelsClaude.status === 200 && Array.isArray(modelsClaude.json.models), 'GET /models failed')
check(modelsClaude.json.models.some((m) => m.id === 'sonnet'), 'claude catalog missing sonnet')
check(modelsClaude.json.source === 'catalog', `claude source unexpected: ${modelsClaude.json.source}`)
const modelsUnsupported = await call('GET', '/cli-bridge/models?key=qwenpaw')
check(modelsUnsupported.json.supported === false, 'qwenpaw should report supported=false')
const modelsUnknown = await call('GET', '/cli-bridge/models?key=nope')
check(modelsUnknown.json.models.length === 0 && modelsUnknown.json.error, 'unknown key should be empty with error')

// 9b. unknown path -> 404
const missing = await call('GET', '/cli-bridge/nope')
check(missing.status === 404, 'unknown path not 404')

// 10. GET /task.js — the task-runner browser module, served as JS
const taskJs = await callRaw('GET', '/cli-bridge/task.js')
check(taskJs.status === 200 && /javascript/.test(String(taskJs.headers['content-type'])), `task.js not served as JS: ${taskJs.status} ${taskJs.headers['content-type']}`)
check(taskJs.text.includes('createTaskSection'), 'task.js content missing createTaskSection')

// 11. POST /run — validation errors stay plain JSON before the stream opens
const noCli = await call('POST', '/cli-bridge/run', { prompt: 'x' })
check(noCli.status === 400 && noCli.json?.error, 'missing cli not rejected')
const unknownCli = await call('POST', '/cli-bridge/run', { cli: 'nope', prompt: 'x' })
check(unknownCli.status === 404 && unknownCli.json?.error, 'unknown cli not 404')
const noPrompt = await call('POST', '/cli-bridge/run', { cli: 'claude', prompt: '  ' })
check(noPrompt.status === 400 && noPrompt.json?.error, 'empty prompt not rejected')

// 12. POST /run — happy path with a claude-json fake CLI: start event, live
// deltas in arrival order, then a done event whose text/meta are authoritative.
// The m1 pair is the same-id double-text-block regression (claude stream-json
// emits per-block events sharing one message id — append, never overwrite).
const fakeScript = [
  'console.log(JSON.stringify({type:"assistant",message:{id:"m1",content:[{type:"text",text:"hello "}]}}))',
  'console.log(JSON.stringify({type:"assistant",message:{id:"m1",content:[{type:"text",text:"!"}]}}))',
  'console.log(JSON.stringify({type:"assistant",message:{id:"m2",content:[{type:"text",text:"world"}]}}))',
  'console.log(JSON.stringify({type:"result",result:"hello ! world",session_id:"sess-route",total_cost_usd:0.02}))',
].join(';')
const fakeCreated = await call('POST', '/cli-bridge/clients', {
  key: 'route-fake',
  label: 'Fake Claude',
  protocol: 'claude-json',
  command: process.execPath,
  args: ['-e', fakeScript],
  promptDelivery: 'stdin',
  timeoutMs: 15000,
})
check(fakeCreated.json?.ok === true, `route-fake create failed: ${JSON.stringify(fakeCreated.json)}`)
const runOk = await callRaw('POST', '/cli-bridge/run', { cli: 'route-fake', prompt: 'hi' })
check(runOk.status === 200 && /event-stream/.test(String(runOk.headers['content-type'])), `run stream did not open: ${runOk.status}`)
const runEvents = parseSse(runOk.text)
check(runEvents[0]?.type === 'start' && runEvents[0].cli === 'route-fake', `no start event: ${JSON.stringify(runEvents[0])}`)
const deltas = runEvents.filter((e) => e.type === 'text').map((e) => e.delta)
check(deltas.join('') === 'hello !world', `deltas wrong: ${JSON.stringify(deltas)}`)
const doneEvent = runEvents.find((e) => e.type === 'done')
check(doneEvent?.text === 'hello !\nworld', `done.text wrong (same-id text block lost?): ${JSON.stringify(doneEvent?.text)}`)
check(doneEvent?.meta?.sessionId === 'sess-route' && doneEvent?.meta?.costUsd === 0.02, `done.meta wrong: ${JSON.stringify(doneEvent?.meta)}`)
check(typeof doneEvent?.meta?.durationMs === 'number', 'done.meta missing durationMs')

// 13. POST /run — the connection dropping mid-run cancels it (engine rejects
// with "cancelled" after killing the process tree)
const sleeperCreated = await call('POST', '/cli-bridge/clients', {
  key: 'route-sleeper',
  label: 'Sleeper',
  protocol: 'generic-json',
  command: process.execPath,
  args: ['-e', 'setInterval(function(){},1000)'],
  promptDelivery: 'stdin',
  timeoutMs: 30000,
})
check(sleeperCreated.json?.ok === true, `route-sleeper create failed: ${JSON.stringify(sleeperCreated.json)}`)
{
  const res = mockResponse()
  const pending = handler(mockRequest('POST', '/cli-bridge/run', { cli: 'route-sleeper', prompt: 'stay' }), res)
  const deadline = Date.now() + 5000
  while (res.chunks.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  check(res.chunks.length > 0, 'run stream never opened for the sleeper')
  res.emitClose()
  await Promise.race([
    pending,
    new Promise((_, reject) => setTimeout(() => reject(new Error('cancel path timed out')), 10000)),
  ])
  const events = parseSse(res.chunks.join(''))
  const errEvent = events.find((e) => e.type === 'error')
  check(!!errEvent && /cancelled/i.test(String(errEvent.error)), `cancel error missing: ${JSON.stringify(errEvent)}`)
}

// 14. Board routes — GET/POST/PUT/DELETE /tasks + /tasks/action + SSE stream
{
  // empty snapshot first
  const empty = await call('GET', '/cli-bridge/tasks')
  check(empty.status === 200 && Array.isArray(empty.json.tasks) && empty.json.tasks.length === 0, 'initial board not empty')
  check(empty.json.settings?.maxRunning >= 1, 'board settings missing')

  // validation: plain JSON errors before any stream would open
  const noCli = await call('POST', '/cli-bridge/tasks', { prompt: 'x' })
  check(noCli.status === 400 && noCli.json?.error, 'board create missing cli not rejected')
  const unknownCli = await call('POST', '/cli-bridge/tasks', { cli: 'nope', prompt: 'x' })
  check(unknownCli.status === 404 && unknownCli.json?.error, 'board create unknown cli not 404')
  const noPrompt = await call('POST', '/cli-bridge/tasks', { cli: 'route-fake', prompt: '  ' })
  check(noPrompt.status === 400 && noPrompt.json?.error, 'board create empty prompt not rejected')

  // happy path: queue against the fake claude CLI from step 12 and wait for done
  const created = await call('POST', '/cli-bridge/tasks', { cli: 'route-fake', prompt: 'board hello', cwd: tmpdir(), model: 'sonnet' })
  check(created.status === 200 && created.json.task?.id, `board create failed: ${JSON.stringify(created.json)}`)
  check(created.json.task.status === 'queued' && created.json.task.title === 'board hello', `created card wrong: ${JSON.stringify(created.json.task)}`)
  const taskId = created.json.task.id
  const deadline = Date.now() + 10_000
  let finished = null
  while (Date.now() < deadline) {
    const snap = await call('GET', '/cli-bridge/tasks')
    finished = snap.json.tasks.find((t) => t.id === taskId)
    if (finished && (finished.status === 'done' || finished.status === 'failed')) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  check(finished?.status === 'done', `board task never finished: ${JSON.stringify(finished)}`)
  check(finished?.output === 'hello !\nworld', `board task output wrong: "${finished?.output}"`)
  check(finished?.cwd === tmpdir() && finished?.model === 'sonnet' && finished?.origin === 'panel', 'board task payload fields lost')

  // stop a running task → stopped
  const sleeperTask = await call('POST', '/cli-bridge/tasks', { cli: 'route-sleeper', prompt: 'board sleeper' })
  check(sleeperTask.json.task?.id, 'sleeper board task not created')
  await new Promise((resolve) => setTimeout(resolve, 300)) // let the scheduler start it
  const stopped = await call('POST', '/cli-bridge/tasks/action', { id: sleeperTask.json.task.id, action: 'stop' })
  check(stopped.status === 200 && stopped.json.ok === true, `board stop failed: ${JSON.stringify(stopped.json)}`)
  const stopDeadline = Date.now() + 10_000
  let stopState = null
  while (Date.now() < stopDeadline) {
    const snap = await call('GET', '/cli-bridge/tasks')
    stopState = snap.json.tasks.find((t) => t.id === sleeperTask.json.task.id)
    if (stopState && stopState.status === 'stopped') break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  check(stopState?.status === 'stopped', `board task not stopped: ${stopState?.status}`)

  // retry re-queues, archive hides, archive_finished sweeps, delete removes
  const retry = await call('POST', '/cli-bridge/tasks/action', { id: sleeperTask.json.task.id, action: 'retry' })
  check(retry.json.ok === true && retry.json.task?.status === 'queued' && retry.json.task?.attempt === 2, `board retry wrong: ${JSON.stringify(retry.json)}`)
  await call('POST', '/cli-bridge/tasks/action', { id: sleeperTask.json.task.id, action: 'stop' })
  // stop on a RUNNING task terminalizes asynchronously (abort → engine kill);
  // wait for stopped before archiving
  const stopWaitDeadline = Date.now() + 10_000
  let stopWait = null
  while (Date.now() < stopWaitDeadline) {
    const snap = await call('GET', '/cli-bridge/tasks')
    stopWait = snap.json.tasks.find((t) => t.id === sleeperTask.json.task.id)
    if (stopWait && stopWait.status === 'stopped') break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  check(stopWait?.status === 'stopped', `second stop did not land: ${stopWait?.status}`)
  const archived = await call('POST', '/cli-bridge/tasks/action', { id: sleeperTask.json.task.id, action: 'archive' })
  check(archived.json.ok === true && archived.json.task?.archived === true, `board archive wrong: ${JSON.stringify(archived.json)}`)
  const sweep = await call('POST', '/cli-bridge/tasks/action', { action: 'archive_finished' })
  check(sweep.json.ok === true, `archive_finished failed: ${JSON.stringify(sweep.json)}`)
  const del = await call('DELETE', '/cli-bridge/tasks?id=' + encodeURIComponent(taskId))
  check(del.json.ok === true, `board delete failed: ${JSON.stringify(del.json)}`)
  const afterDelete = await call('GET', '/cli-bridge/tasks')
  check(!afterDelete.json.tasks.some((t) => t.id === taskId), 'deleted task still on the board')

  // settings: maxRunning clamped to 1..5
  const put = await call('PUT', '/cli-bridge/tasks', { maxRunning: 4 })
  check(put.json.ok === true && put.json.settings?.maxRunning === 4, `settings put wrong: ${JSON.stringify(put.json)}`)
  const putHigh = await call('PUT', '/cli-bridge/tasks', { maxRunning: 99 })
  check(putHigh.json.settings?.maxRunning === 5, 'maxRunning not clamped to 5')
  await call('PUT', '/cli-bridge/tasks', { maxRunning: 2 })

  // SSE stream: first frame is the full snapshot, then it stays open
  const stream = await callRaw('GET', '/cli-bridge/tasks/stream')
  check(stream.status === 200 && /event-stream/.test(String(stream.headers['content-type'])), `board stream did not open: ${stream.status}`)
  const streamEvents = parseSse(stream.text)
  check(streamEvents[0]?.type === 'snapshot' && Array.isArray(streamEvents[0].tasks), `no snapshot event: ${JSON.stringify(streamEvents[0])}`)
  stream.res.emitClose()
}

rmSync(process.env.DSH_HOME, { recursive: true, force: true })

if (problems.length > 0) {
  console.error(JSON.stringify({ ok: false, problems }, null, 2))
  process.exit(1)
}
console.log(JSON.stringify({ ok: true, route: 'panel routes all pass', probed: clis.json.clients.length }, null, 2))
