/**
 * Catalog integrity test — no dsh host, no CLI spawns.
 *   node test/catalog.mjs
 */
import { BUILTIN_ADAPTERS, PROTOCOLS, buildArgs, validateAdapterShape } from '../catalog.js'
import { validateClientPayload } from '../store.js'

const problems = []
const seen = new Set()

for (const adapter of BUILTIN_ADAPTERS) {
  const errors = validateAdapterShape(adapter)
  if (errors.length > 0) problems.push(`${adapter.key}: ${errors.join('；')}`)
  if (seen.has(adapter.key)) problems.push(`${adapter.key}: key 重复`)
  seen.add(adapter.key)
  if (!PROTOCOLS.includes(adapter.protocol)) problems.push(`${adapter.key}: protocol 越界`)
  if (adapter.promptDelivery === 'argv' && !adapter.args.includes('{prompt}')) {
    problems.push(`${adapter.key}: argv 传参缺 {prompt} 占位符`)
  }
  if (adapter.promptDelivery === 'stdin' && adapter.args.includes('{prompt}')) {
    problems.push(`${adapter.key}: stdin 传参不应含 {prompt} 占位符`)
  }
}

// buildArgs smoke: template + model + cwd flags
const argv = buildArgs(
  { args: ['-p', '{prompt}', '--output-format', 'json'], modelFlag: '--model', cwdFlag: '--dir' },
  { prompt: 'hi there', model: 'm1', cwd: 'D:\\x' },
)
const expected = ['-p', 'hi there', '--output-format', 'json', '--model', 'm1', '--dir', 'D:\\x']
if (JSON.stringify(argv) !== JSON.stringify(expected)) {
  problems.push(`buildArgs 输出异常: ${JSON.stringify(argv)}`)
}

// store payload validation: reject bad, accept good
const bad = validateClientPayload({ key: '9bad', label: 'x', protocol: 'generic-json', command: '', promptDelivery: 'argv', args: [] })
if (!bad.error) problems.push('store 校验未拒绝非法 payload')
const good = validateClientPayload({
  key: 'my-cli', label: 'My CLI', protocol: 'generic-json', command: 'mycli',
  args: ['-p', '{prompt}'], promptDelivery: 'argv', timeoutMs: 5000,
})
if (good.error) problems.push(`store 校验误拒合法 payload: ${good.error}`)
if (good.client?.source !== 'custom') problems.push('store 未强制 source=custom')

if (problems.length > 0) {
  console.error(JSON.stringify({ ok: false, problems }, null, 2))
  process.exit(1)
}
console.log(
  JSON.stringify({
    ok: true,
    builtins: BUILTIN_ADAPTERS.length,
    byProtocol: BUILTIN_ADAPTERS.reduce((acc, a) => ({ ...acc, [a.protocol]: (acc[a.protocol] || 0) + 1 }), {}),
    verified: BUILTIN_ADAPTERS.filter((a) => a.verified).length,
  }, null, 2),
)
