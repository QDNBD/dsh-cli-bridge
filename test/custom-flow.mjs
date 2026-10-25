/**
 * Custom-adapter flow E2E — store CRUD + registry overlay + real run, all
 * against a temp DSH_HOME so the real ~/.dsh/storages is untouched.
 *   node test/custom-flow.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempHome = mkdtempSync(join(tmpdir(), 'cli-bridge-test-'))
process.env.DSH_HOME = tempHome

const { upsertClient, deleteClient, listClients } = await import('../store.js')
const { listAdapters, runAdapter } = await import('../registry.js')
const { storeFile } = await import('../store.js')

const problems = []
const check = (cond, message) => {
  if (!cond) problems.push(message)
}

// 1. upsert a custom spawn adapter that echoes via node
const payload = {
  key: 'echo-cli',
  label: 'Echo CLI',
  protocol: 'generic-json',
  command: process.execPath,
  args: ['-e', 'console.log(JSON.stringify({type:"result",result:"custom ok",model:"m1"}))'],
  promptDelivery: 'stdin',
  timeoutMs: 15000,
  env: {},
}
const upsert = await upsertClient(payload)
check(upsert.ok === true, `upsert failed: ${upsert.error}`)

// 2. persistence round-trip
const listed = await listClients()
check(listed.some((c) => c.key === 'echo-cli'), 'client missing after reload')

// 3. registry overlay + real run
const adapters = await listAdapters()
const adapter = adapters.find((a) => a.key === 'echo-cli')
check(Boolean(adapter), 'registry missing custom adapter')
check(adapter?.source === 'custom', 'source should be custom')
if (adapter) {
  const { text, meta } = await runAdapter(adapter, 'ignored', { timeoutMs: 15000 })
  check(text === 'custom ok', `run output unexpected: "${text}"`)
  check(meta.model === 'm1', `meta.model unexpected: ${meta.model}`)
}

// 4. same-key builtin override (claude → echo)
const override = await upsertClient({ ...payload, key: 'claude', label: 'Claude (echo)' })
check(override.ok === true, `builtin override failed: ${override.error}`)
const overlaid = (await listAdapters()).find((a) => a.key === 'claude')
check(overlaid?.source === 'custom' && overlaid?.overrides === 'claude', 'override not applied')

// 5. delete + confirm builtin restored
await deleteClient('claude')
const restored = (await listAdapters()).find((a) => a.key === 'claude')
check(restored?.source === 'builtin', 'builtin not restored after override removal')
const del = await deleteClient('echo-cli')
check(del.ok === true, 'delete failed')
check((await listClients()).length === 0, 'clients not empty after delete')

// 6. validation rejects garbage
const bad = await upsertClient({ key: 'Bad Key!', label: 'x', protocol: 'generic-json', command: 'x' })
check(bad.ok === false, 'invalid key not rejected')

rmSync(tempHome, { recursive: true, force: true })

if (problems.length > 0) {
  console.error(JSON.stringify({ ok: false, problems }, null, 2))
  process.exit(1)
}
console.log(JSON.stringify({ ok: true, storeFile: await storeFile() }, null, 2))
