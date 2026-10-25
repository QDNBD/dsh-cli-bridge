/**
 * ACP engine E2E — run the real acp.js engine against the mock agent.
 *   node test/acp-engine.mjs
 */
import { runAcpAdapter } from '../acp.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const adapter = {
  key: 'mock-acp',
  label: 'Mock ACP',
  protocol: 'acp',
  command: process.execPath,
  args: [join(here, 'mock-acp-agent.mjs')],
  promptDelivery: 'stdin',
  timeoutMs: 30_000,
  env: {},
}

const startedAt = Date.now()
const deltas = []
try {
  const { text, meta } = await runAcpAdapter(adapter, 'reply with: pong', {
    timeoutMs: 30_000,
    onDelta: (chunk) => deltas.push(chunk),
  })
  const result = { ok: true, text, meta, deltas: deltas.length, wallMs: Date.now() - startedAt }
  const good =
    text === 'pong from mock' &&
    meta.sessionId === 'mock-session-1' &&
    meta.stopReason === 'end_turn' &&
    meta.toolCalls === 1 &&
    deltas.join('') === text
  console.log(JSON.stringify(result, null, 2))
  if (!good) {
    console.error('ACP engine assertions failed')
    process.exit(1)
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2))
  process.exit(1)
}
