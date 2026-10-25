/**
 * Task-manager E2E — the board's server-side lifecycle against a temp
 * DSH_HOME: create → run (real node child) → done, FIFO queueing under
 * maxRunning, stop (running + queued), retry, archive/delete, settings,
 * persistence round-trip and the host-restart reconcile.
 *   node test/task-manager.mjs
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempHome = mkdtempSync(join(tmpdir(), 'cli-bridge-tasks-'))
process.env.DSH_HOME = tempHome

const { upsertClient } = await import('../store.js')
const { TaskManager } = await import('../task-manager.js')

const problems = []
const check = (cond, message) => {
  if (!cond) problems.push(message)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Wait until `cond(task)` holds or the deadline passes; returns the task. */
async function waitFor(taskId, cond, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const mgr = currentManager
    const task = mgr?.snapshot().tasks.find((t) => t.id === taskId)
    if (task && cond(task)) return task
    if (Date.now() > deadline) return task
    await sleep(25)
  }
}

/** A custom spawn "CLI" whose behaviour is picked via the prompt, so one
 *  adapter covers every scenario (echo / slow / exit-nonzero). */
const echoCreated = await upsertClient({
  key: 'board-echo',
  label: 'Board Echo',
  protocol: 'generic-json',
  command: process.execPath,
  args: [
    '-e',
    [
      'let buf="";',
      'process.stdin.on("data",(d)=>{buf+=d});',
      'process.stdin.on("end",()=>{',
      'const p=buf.trim();',
      'if(p==="SLOW"){setTimeout(()=>console.log(JSON.stringify({type:"result",result:"slow done"})),400);return}',
      'if(p==="CRASH"){console.error("boom failed");process.exit(3);return}',
      'console.log(JSON.stringify({type:"result",result:"echo:"+p}))})',
    ].join(''),
  ],
  promptDelivery: 'stdin',
  timeoutMs: 15000,
})
check(echoCreated.ok === true, `adapter create failed: ${echoCreated.error}`)

let currentManager = new TaskManager()
await currentManager.ready()

// 1. happy path: create → running → done, output and meta recorded
{
  const { task } = { task: await currentManager.create({ cli: 'board-echo', prompt: 'hello board', cliLabel: 'Board Echo', origin: 'panel' }) }
  check(!!task && task.status === 'queued' && task.title === 'hello board', `create wrong: ${JSON.stringify(task)}`)
  const done = await waitFor(task.id, (t) => t.status === 'done')
  check(done?.status === 'done', `task never finished: ${JSON.stringify(done)}`)
  check(done?.output === 'echo:hello board', `output wrong: "${done?.output}"`)
  check(typeof done?.meta?.durationMs === 'number', 'meta.durationMs missing')
  check(!!done?.startedAt && !!done?.endedAt, 'timestamps missing')
}

// 2. FIFO queueing under maxRunning=1: second task waits, then starts
{
  const put = await currentManager.updateSettings({ maxRunning: 1 })
  check(put.ok === true && put.settings.maxRunning === 1, `settings wrong: ${JSON.stringify(put)}`)
  const first = await currentManager.create({ cli: 'board-echo', prompt: 'SLOW' })
  const second = await currentManager.create({ cli: 'board-echo', prompt: 'second' })
  await sleep(150)
  const snap = currentManager.snapshot()
  const a = snap.tasks.find((t) => t.id === first.id)
  const b = snap.tasks.find((t) => t.id === second.id)
  check(a?.status === 'running', `first should be running: ${a?.status}`)
  check(b?.status === 'queued', `second should be queued: ${b?.status}`)
  const bDone = await waitFor(second.id, (t) => t.status === 'done')
  check(bDone?.output === 'echo:second', `queued task output wrong: "${bDone?.output}"`)
  const aDone = await waitFor(first.id, (t) => t.status === 'done')
  check(aDone?.output === 'slow done', `slow task output wrong: "${aDone?.output}"`)
}

// 3. stop a running task → stopped, scheduler moves on
{
  currentManager.updateSettings({ maxRunning: 2 })
  const slow = await currentManager.create({ cli: 'board-echo', prompt: 'SLOW' })
  await waitFor(slow.id, (t) => t.status === 'running')
  const stopped = await currentManager.action(slow.id, 'stop')
  check(stopped.ok === true, `stop failed: ${JSON.stringify(stopped)}`)
  const after = await waitFor(slow.id, (t) => t.status === 'stopped')
  check(after?.status === 'stopped', `not stopped: ${after?.status}`)
}

// 4. stop a queued task → cancelled without running
{
  currentManager.updateSettings({ maxRunning: 1 })
  const blocker = await currentManager.create({ cli: 'board-echo', prompt: 'SLOW' })
  const parked = await currentManager.create({ cli: 'board-echo', prompt: 'parked' })
  await sleep(100)
  check(currentManager.snapshot().tasks.find((t) => t.id === parked.id)?.status === 'queued', 'parked should be queued')
  const res = await currentManager.action(parked.id, 'stop')
  check(res.ok === true && res.task.status === 'stopped', `queued stop wrong: ${JSON.stringify(res)}`)
  await currentManager.action(blocker.id, 'stop')
  await waitFor(blocker.id, (t) => t.status === 'stopped')
  currentManager.updateSettings({ maxRunning: 2 })
}

// 5. failure records the error; retry re-queues with attempt+1 and clean state
{
  const bad = await currentManager.create({ cli: 'board-echo', prompt: 'CRASH' })
  const failed = await waitFor(bad.id, (t) => t.status === 'failed')
  check(failed?.status === 'failed' && /boom|exit/i.test(failed?.error || ''), `failure not recorded: ${JSON.stringify(failed?.error)}`)
  const retried = await currentManager.action(bad.id, 'retry')
  check(retried.ok === true && retried.task.status === 'queued' && retried.task.attempt === 2, `retry wrong: ${JSON.stringify(retried)}`)
  const doneAgain = await waitFor(bad.id, (t) => t.status === 'failed')
  check(doneAgain?.attempt === 2, `attempt not persisted: ${doneAgain?.attempt}`)
  const retryOfFinished = await currentManager.action(bad.id, 'retry')
  check(retryOfFinished.ok === true, 'retry of failed task rejected')
  await currentManager.action(bad.id, 'stop')
  await waitFor(bad.id, (t) => t.status === 'stopped' || t.status === 'failed')
}

// 6. archive / unarchive / delete semantics
{
  const t = await currentManager.create({ cli: 'board-echo', prompt: 'archive me' })
  await waitFor(t.id, (x) => x.status === 'done')
  const arch = await currentManager.action(t.id, 'archive')
  check(arch.ok === true && arch.task.archived === true, `archive wrong: ${JSON.stringify(arch)}`)
  const un = await currentManager.action(t.id, 'unarchive')
  check(un.ok === true && un.task.archived === false, 'unarchive wrong')
  const del = await currentManager.action(t.id, 'delete')
  check(del.ok === true, `delete failed: ${JSON.stringify(del)}`)
  check(!currentManager.snapshot().tasks.some((x) => x.id === t.id), 'task still listed after delete')
  const ghost = await currentManager.action(t.id, 'retry')
  check(ghost.ok === false, 'action on deleted task should fail')
}

// 7. archiveFinished sweeps every terminal task
{
  const swept = await currentManager.archiveFinished()
  check(swept.ok === true && swept.archived > 0, `archiveFinished wrong: ${JSON.stringify(swept)}`)
  const remaining = currentManager.snapshot().tasks.filter((t) => !t.archived)
  check(remaining.every((t) => t.status === 'running' || t.status === 'queued'), 'non-terminal task archived')
}

// 8. persistence round-trip: a NEW manager sees the same tasks and settings
{
  const before = currentManager.snapshot()
  currentManager = new TaskManager()
  await currentManager.ready()
  const after = currentManager.snapshot()
  check(after.tasks.length === before.tasks.length, `task count drifted: ${after.tasks.length} vs ${before.tasks.length}`)
  const sample = after.tasks.find((t) => t.title === 'hello board')
  check(sample?.output === 'echo:hello board', 'persisted output lost')
  check(after.settings.maxRunning === 2, `settings lost: ${JSON.stringify(after.settings)}`)
}

// 9. host-restart reconcile: a persisted running task becomes failed
{
  const raw = JSON.parse(readFileSync(join(tempHome, 'storages', 'dsh-cli-bridge', 'tasks.json'), 'utf8'))
  raw.tasks.push({
    id: 't_ghost',
    title: 'interrupted',
    cli: 'board-echo',
    prompt: 'x',
    status: 'running',
    archived: false,
    attempt: 1,
    origin: 'panel',
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    endedAt: null,
    output: 'partial',
    error: null,
    meta: null,
  })
  writeFileSync(join(tempHome, 'storages', 'dsh-cli-bridge', 'tasks.json'), JSON.stringify(raw))
  currentManager = new TaskManager()
  await currentManager.ready()
  const ghost = currentManager.snapshot().tasks.find((t) => t.id === 't_ghost')
  check(ghost?.status === 'failed' && /重启/.test(ghost?.error || ''), `reconcile wrong: ${JSON.stringify(ghost)}`)
  check(ghost?.output === 'partial', 'partial output lost in reconcile')
}

// 10. tool runs bypass the queue but land on the board
{
  currentManager.updateSettings({ maxRunning: 1 })
  const blocker = await currentManager.create({ cli: 'board-echo', prompt: 'SLOW' })
  await waitFor(blocker.id, (t) => t.status === 'running')
  const rec = currentManager.beginToolRun({ adapter: { key: 'board-echo', label: 'Board Echo' }, prompt: 'tool delegation', model: 'm1' })
  check(currentManager.snapshot().tasks.find((t) => t.id === rec.id)?.status === 'running', 'tool run not running immediately')
  rec.delta('partial tool out')
  await rec.done({ text: 'tool answer', meta: { durationMs: 5 } })
  const recorded = currentManager.snapshot().tasks.find((t) => t.id === rec.id)
  check(recorded?.status === 'done' && recorded?.output === 'tool answer' && recorded?.origin === 'tool', `tool record wrong: ${JSON.stringify(recorded)}`)
  await currentManager.action(blocker.id, 'stop')
  currentManager.updateSettings({ maxRunning: 2 })
}

// 11. invalid create inputs are rejected
{
  let threw = false
  try {
    await currentManager.create({ cli: 'board-echo', prompt: '   ' })
  } catch {
    threw = true
  }
  check(threw, 'empty prompt accepted')
  threw = false
  try {
    await currentManager.create({ cli: '', prompt: 'x' })
  } catch {
    threw = true
  }
  check(threw, 'missing cli accepted')
}

// a just-stopped task's terminal persist may still be draining; wait it out so
// cleanup does not race a late atomicWrite (the write itself is harmless)
await sleep(250)
rmSync(tempHome, { recursive: true, force: true })

if (problems.length > 0) {
  console.error(JSON.stringify({ ok: false, problems }, null, 2))
  process.exit(1)
}
console.log(JSON.stringify({ ok: true, board: 'task-manager lifecycle all pass' }, null, 2))
