/**
 * catalog — the built-in CLI runtime directory, modeled after Multica's
 * builtin runtimes (27 protocol families + atomcode/csc/devin/gemini extras).
 *
 * One adapter = everything the engines need to drive one CLI:
 *   protocol        wire protocol, drives engine + parser selection
 *   command         executable (resolved through PATH at call time)
 *   args            static argv template; '{prompt}' placeholder = argv
 *                   delivery, absence = prompt on stdin
 *   cwdFlag/modelFlag  optional per-run flags appended when caller supplies
 *                      cwd/model (run-scoped, never baked into args)
 *   env             extra environment for the child
 *   http            http-sse only: daemon endpoints + optional autostart exe
 *   verified        false = spawn shape plausible but not proven on a live CLI;
 *                   the panel marks these "未验证" and the management UI lets
 *                   users override any builtin with a same-key custom entry.
 *
 * Evidence for each entry: research/multica-runtime-catalog-2026-10-25.md
 * (Multica daemon source + daemon.log) and ai-tool-extension bridge READMEs.
 */

export const PROTOCOLS = ['claude-json', 'generic-json', 'acp', 'http-sse']

export const PROTOCOL_LABELS = {
  'claude-json': 'claude stream-json',
  'generic-json': 'JSON 事件流',
  acp: 'ACP (JSON-RPC over stdio)',
  'http-sse': 'HTTP SSE',
}

export const DEFAULT_TIMEOUT_MS = 180_000
export const ACP_TIMEOUT_MS = 600_000

export const KEY_RE = /^[a-z][a-z0-9-]*$/i

/** Aggregate defaults so every adapter is complete after normalizeAdapter. */
export function normalizeAdapter(raw) {
  const a = { ...raw }
  a.protocol = a.protocol || 'generic-json'
  a.promptDelivery = a.promptDelivery || 'stdin'
  a.args = Array.isArray(a.args) ? a.args.map(String) : []
  a.versionArgs = Array.isArray(a.versionArgs) ? a.versionArgs.map(String) : ['--version']
  a.env = a.env && typeof a.env === 'object' ? { ...a.env } : {}
  a.timeoutMs = Number(a.timeoutMs) > 0
    ? Number(a.timeoutMs)
    : a.protocol === 'acp' || a.protocol === 'http-sse' ? ACP_TIMEOUT_MS : DEFAULT_TIMEOUT_MS
  return a
}

/** Shape validation shared by the store (custom entries) and the catalog test.
 *  Returns a list of problems; empty = valid. */
export function validateAdapterShape(a) {
  const errors = []
  if (!a || typeof a !== 'object') return ['adapter must be an object']
  if (typeof a.key !== 'string' || !KEY_RE.test(a.key)) {
    errors.push(`key "${a.key}" 无效：字母开头，仅限字母/数字/连字符`)
  }
  if (typeof a.label !== 'string' || a.label.trim() === '') errors.push('label 必填')
  if (!PROTOCOLS.includes(a.protocol)) {
    errors.push(`protocol 必须是 ${PROTOCOLS.join(' / ')} 之一`)
  }
  if (!Array.isArray(a.args) || a.args.some((x) => typeof x !== 'string')) {
    errors.push('args 必须是字符串数组')
  }
  if (a.promptDelivery === 'argv' && !a.args.includes('{prompt}')) {
    errors.push('argv 传参时 args 模板必须包含 {prompt} 占位符')
  }
  if (a.promptDelivery === 'argv' && a.args.filter((x) => x === '{prompt}').length > 1) {
    errors.push('{prompt} 占位符最多出现一次')
  }
  if (a.env && typeof a.env !== 'object') errors.push('env 必须是对象')
  if (a.env) {
    for (const [k, v] of Object.entries(a.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== 'string') {
        errors.push(`env 项 "${k}" 无效（需 KEY=字符串值）`)
      }
    }
  }
  if (a.protocol === 'http-sse') {
    const http = a.http || {}
    if (typeof http.baseUrl !== 'string' || !/^https?:\/\//.test(http.baseUrl || '')) {
      errors.push('http-sse 需要 http.baseUrl（http(s)://…）')
    }
  } else if (typeof a.command !== 'string' || a.command.trim() === '') {
    errors.push('command 必填')
  }
  if (a.models !== undefined && (!Array.isArray(a.models) || a.models.some((x) => typeof x !== 'string'))) {
    errors.push('models 必须是字符串数组（模型目录）')
  }
  if (a.modelSupported !== undefined && typeof a.modelSupported !== 'boolean') {
    errors.push('modelSupported 必须是布尔值')
  }
  if (a.effortFlag !== undefined && (typeof a.effortFlag !== 'string' || a.effortFlag.trim() === '')) {
    errors.push('effortFlag 必须是非空字符串（如 --effort）')
  }
  return errors
}

/** Build concrete argv from the template for one run. */
export function buildArgs(adapter, { prompt = '', model, cwd, effort } = {}) {
  const argv = adapter.args.map((part) => (part === '{prompt}' ? String(prompt) : part))
  if (model && adapter.modelFlag) argv.push(adapter.modelFlag, String(model))
  if (effort && adapter.effortFlag) argv.push(adapter.effortFlag, String(effort))
  if (cwd && adapter.cwdFlag) argv.push(adapter.cwdFlag, String(cwd))
  return argv
}

export function adapterLabel(a) {
  return a.label || a.key
}

/* ------------------------------------------------------------------ entries */

const claudeFamily = (key, label, command, extra = {}) => ({
  key,
  label,
  protocol: 'claude-json',
  command,
  args: ['-p', '--output-format', 'stream-json', '--verbose'],
  promptDelivery: 'stdin',
  modelFlag: '--model',
  ...extra,
})

const acpFamily = (key, label, command, args, extra = {}) => ({
  key,
  label,
  protocol: 'acp',
  command,
  args,
  promptDelivery: 'stdin',
  ...extra,
})

const jsonFamily = (key, label, command, args, promptDelivery, extra = {}) => ({
  key,
  label,
  protocol: 'generic-json',
  command,
  args,
  promptDelivery,
  ...extra,
})

export const BUILTIN_ADAPTERS = [
  /* --- claude stream-json family ------------------------------------- */
  claudeFamily('claude', 'Claude Code', 'claude', {
    verified: true,
    // claude CLI 接受的别名模型；完整目录以 env 覆盖或手动输入为准
    models: ['default', 'opus', 'sonnet', 'haiku'],
  }),
  claudeFamily('codebuddy', 'CodeBuddy（腾讯）', 'codebuddy', {
    verified: false,
    note: '仿 claude 协议（Multica codebuddySDKMessage），参数未实测',
  }),
  claudeFamily('deveco', 'DevEco（华为）', 'deveco', {
    verified: false,
    note: '仿 claude 参数族；不支持 --max-turns（会被忽略）',
  }),
  {
    key: 'csc',
    label: 'CoStrict',
    protocol: 'claude-json',
    command: 'csc',
    args: ['-p', '--verbose', '--output-format', 'stream-json', '--permission-mode', 'bypassPermissions'],
    promptDelivery: 'stdin',
    modelFlag: '--model',
    verified: false,
    note: 'CoStrict CLI；协议同 claude stream-json（multica-csc-extension 已验证），本机未装',
  },

  /* --- per-CLI JSON event streams ------------------------------------ */
  jsonFamily('codex', 'Codex CLI', 'codex', ['exec', '--json'], 'stdin', {
    verified: true,
    modelFlag: '--model',
  }),
  jsonFamily('opencode', 'OpenCode', 'opencode', ['run', '--format', 'json'], 'stdin', {
    verified: true,
    cwdFlag: '--dir',
    modelFlag: '--model',
  }),
  jsonFamily('copilot', 'GitHub Copilot CLI', 'copilot', ['--output-format', 'json'], 'stdin', {
    verified: false,
  }),
  jsonFamily('cursor', 'Cursor Agent', 'cursor-agent', ['-p', '{prompt}', '--output-format', 'json'], 'argv', {
    verified: false,
    note: '自研 JSON 流 + hooks，参数未实测',
  }),
  jsonFamily('qwen', 'Qwen Code', 'qwen', ['-p', '{prompt}', '--output-format', 'json'], 'argv', {
    verified: false,
    modelFlag: '--model',
    note: 'gemini-cli 系；Multica 走 stdin pipe + mcp_config，此处用简化参数',
  }),
  jsonFamily('codearts', 'CodeArts（华为）', 'codearts', ['-p', '{prompt}'], 'argv', {
    verified: false,
    note: '自研 JSON 事件流，参数未实测',
  }),
  jsonFamily(
    'antigravity',
    'Google Antigravity',
    'agy',
    ['-p', '{prompt}', '--dangerously-skip-permissions', '--output-format', 'json'],
    'argv',
    { verified: true, modelFlag: '--model' },
  ),
  jsonFamily('pi', 'Pi', 'pi', ['-p', '{prompt}', '--output-format', 'json'], 'argv', {
    verified: false,
    effortFlag: '--effort',
    note: 'pi JSON 模式；档位 flag --effort（Multica 实证）；无人值守可加 --trust-all-tools / --allow-all-tools',
  }),
  jsonFamily('omp', 'Oh-My-Pi', 'omp', ['-p', '{prompt}', '--output-format', 'json'], 'argv', {
    verified: false,
    effortFlag: '--effort',
    note: 'pi 协议族之上的 runtime；档位 flag --effort（Multica 实证）；无人值守可加 --trust-all-tools',
    modelFlag: '--model',
  }),
  jsonFamily('gemini', 'Gemini CLI', 'gemini', ['-p', '{prompt}', '--output-format', 'json'], 'argv', {
    verified: false,
    modelFlag: '--model',
    note: '本机已装；无人值守可加 --yolo',
  }),
  jsonFamily('openclaw', 'OpenClaw', 'openclaw', ['-p', '{prompt}'], 'argv', {
    verified: false,
    note: '自管会话目录 + session/setModel',
  }),

  /* --- ACP (JSON-RPC 2.0 over stdio) family -------------------------- */
  acpFamily('devin', 'Devin CLI', 'devin', ['acp'], { verified: true }),
  acpFamily('qoderclicn', 'Qoder CN', 'qoderclicn', ['--yolo', '--acp'], { verified: true }),
  acpFamily('kimi', 'Kimi CLI', 'kimi', [], {
    verified: false,
    note: 'ACP；激活子命令/参数需按 kimi 文档确认，可在管理页覆盖',
  }),
  acpFamily('kiro', 'Kiro', 'kiro-cli', [], {
    verified: false,
    note: 'ACP；激活参数未实测',
  }),
  acpFamily('grok', 'Grok CLI (xAI)', 'grok', [], {
    verified: false,
    env: {},
    note: 'ACP；激活参数未实测',
  }),
  acpFamily('dim', 'Dim', 'dim', [], { verified: false }),
  acpFamily('hermes', 'Hermes', 'hermes', [], {
    verified: false,
    env: { HERMES_YOLO_MODE: '1' },
    note: 'ACP；Multica 以 HERMES_YOLO_MODE=1 无人值守',
  }),
  acpFamily('mcode', 'MiniMax Code', 'mcode', [], {
    verified: false,
    modelSupported: false,
    note: 'ACP；不支持模型选择（Multica 实证，同 qwenpaw）',
  }),
  acpFamily('muse', 'Muse Code', 'muse', [], {
    verified: false,
    note: 'JSON-RPC（ACP 变体）；Multica dsh-muse-code 社区插件先例',
  }),
  acpFamily('qoder', 'Qoder', 'qodercli', [], { verified: false }),
  acpFamily('traecli', 'Trae', 'traecli', [], { verified: false }),
  acpFamily('qwenpaw', 'QwenPaw', 'qwenpaw', [], {
    verified: false,
    modelSupported: false,
    note: 'ACP；不支持模型选择（Multica 实证）',
  }),
  acpFamily('zeroclaw', 'ZeroClaw', 'zeroclaw', [], {
    verified: false,
    note: 'ACP；需在其配置里 set [acp].default_agent',
  }),
  acpFamily('reasonix', 'Reasonix', 'reasonix', [], { verified: false }),

  /* --- HTTP SSE ------------------------------------------------------- */
  {
    key: 'atomcode',
    label: 'AtomCode',
    protocol: 'http-sse',
    command: 'atomcode',
    args: [],
    promptDelivery: 'stdin',
    verified: true,
    http: {
      baseUrl: process.env.DSH_ATOMCODE_URL || process.env.ATOMCODE_BASE_URL || 'http://127.0.0.1:13456',
      healthPath: '/health',
      chatPath: '/chat',
      promptField: 'message',
      cwdField: 'cwd',
      modelField: 'model',
      autostartExeGlob: 'D:\\exe\\atomcode*.exe',
      autostartArgs: ['daemon', '--port', '13456', '--no-auth', '--no-telemetry'],
    },
  },
]

export const BUILTIN_KEYS = new Set(BUILTIN_ADAPTERS.map((a) => a.key))

export function builtinByKey(key) {
  return BUILTIN_ADAPTERS.find((a) => a.key === key)
}
