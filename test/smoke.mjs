/**
 * Live smoke test for the CLI bridge core — no dsh host needed.
 *   node test/smoke.mjs            # atomcode (daemon auto-starts)
 *   node test/smoke.mjs claude     # spawn-based client
 */
import { CLIENTS, runClient } from '../cli-runner.js'
import { runAtomcode } from '../atomcode.js'

const key = process.argv[2] || 'atomcode'
if (key !== 'atomcode' && !CLIENTS[key]) {
  console.error(`unknown cli: ${key}`)
  process.exit(2)
}

const startedAt = Date.now()
try {
  const result =
    key === 'atomcode'
      ? await runAtomcode('reply with the single word: pong', { timeoutMs: 120_000 })
      : await runClient(CLIENTS[key], 'reply with the single word: pong', { timeoutMs: 120_000 })
  console.log(
    JSON.stringify(
      {
        ok: true,
        cli: key,
        text: result.text,
        meta: result.meta,
        wallMs: Date.now() - startedAt,
      },
      null,
      2,
    ),
  )
} catch (error) {
  console.error(JSON.stringify({ ok: false, cli: key, error: error.message }, null, 2))
  process.exit(1)
}
