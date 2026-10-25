/**
 * cli-runner — spawn a local agent CLI, feed it a prompt, assemble its answer.
 *
 * Two layers:
 *   runSpawn({command, argv, prompt, makeParser, ...})  — the spawn lifecycle
 *   runClient(client, prompt, opts)                     — legacy CLIENTS shape
 *   runSpawnAdapter(adapter, prompt, opts)              — catalog adapter shape
 *
 * Deliberately free of dsh imports so it can be exercised with plain node
 * (see test/smoke.mjs) before it is ever mounted in the host.
 *
 * Prompt safety: stdin delivery never puts caller text on the command line.
 * argv delivery (adapter.args contains '{prompt}') is required by some CLIs
 * (agy/gemini/qwen -p style); on Windows the command then runs through
 * cmd.exe, so every argument is escaped with the cross-spawn backslash rule
 * and the prompt text must not be trusted to survive cmd metacharacters
 * (%VAR% expansion, !delayedExpansion) — documented residual risk, stdin
 * adapters are preferred whenever the CLI supports it.
 */

import { spawn } from 'node:child_process'
import { buildArgs } from './catalog.js'

export const IS_WIN = process.platform === 'win32'
export const DEFAULT_TIMEOUT_MS = 180_000

/** Env override per adapter key: DSH_CLI_CLAUDE, DSH_CLI_GEMINI, DSH_MY_CLI... */
export function resolveCommand(adapter) {
  const envName = `DSH_CLI_${String(adapter.key || '').toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
  return process.env[envName] || adapter.command
}

/**
 * Windows shell argument escaping (the cross-spawn rule): plain tokens stay
 * bare, everything else gets wrapped in quotes with backslash-escaping for
 * embedded quotes and trailing backslashes. Applied to EVERY token of the
 * command line — static flags included — so absolute exe paths with spaces
 * (e.g. C:\Program Files\nodejs\node.exe) work through cmd.exe.
 */
export function quoteWinArg(arg) {
  const value = String(arg)
  if (value === '') return '""'
  if (/^[a-zA-Z0-9_\/.:\\-]+$/.test(value)) return value
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`
}

/* --------------------------------------------------------- spawn engine --- */

/**
 * Spawn one command, deliver the prompt (stdin or nothing — argv delivery is
 * the caller's job via `argv`), collect its JSONL event stream through
 * `makeParser()`, settle with {text, meta} or a descriptive rejection.
 */
export function runSpawn({ command, argv, prompt = '', cwd, timeoutMs = DEFAULT_TIMEOUT_MS, signal, env, makeParser, label }) {
  const name = label || command
  // Windows executes the npm `.cmd` shims through cmd.exe with every token
  // escaped; stdin-delivery adapters never put caller text on the line, and
  // argv-delivery adapters get the cross-spawn escaping (documented cmd
  // metacharacter caveat).
  const commandLine = [command, ...argv].map(quoteWinArg).join(' ')
  const startedAt = Date.now()

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(IS_WIN ? commandLine : command, IS_WIN ? [] : argv, {
        cwd: cwd || process.cwd(),
        shell: IS_WIN,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: env || process.env,
      })
    } catch (error) {
      reject(new Error(`${name}: cannot start "${command}": ${error.message}`))
      return
    }

    const stderrChunks = []
    const assembler = makeParser()
    let settled = false
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs)

    const onAbort = () => killTree(child)
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    const finish = (fn) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      fn()
    }

    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        if (line.trim().length > 0) assembler.push(line)
      }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      if (stderrChunks.length < 40) stderrChunks.push(chunk)
    })

    child.on('error', (error) => {
      finish(() => reject(new Error(`${name}: "${command}" failed to start: ${error.message}`)))
    })

    child.on('close', (code) => {
      if (buffer.trim().length > 0) assembler.push(buffer.replace(/\r$/, ''))
      const stderr = stderrChunks.join('').trim()
      if (timedOut) {
        finish(() => reject(new Error(`${name}: "${command}" timed out after ${timeoutMs}ms${stderr ? `\n${tail(stderr)}` : ''}`)))
        return
      }
      if (signal?.aborted) {
        finish(() => reject(new Error(`${name}: cancelled`)))
        return
      }
      const assembled = assembler.result()
      if (code !== 0) {
        finish(() =>
          reject(
            new Error(
              `${name}: "${command}" exited with code ${code}` +
                (assembled.text ? `\npartial output:\n${tail(assembled.text)}` : '') +
                (stderr ? `\nstderr:\n${tail(stderr)}` : ''),
            ),
          ),
        )
        return
      }
      const text = assembled.text?.trim()
      if (!text) {
        finish(() => reject(new Error(`${name}: "${command}" produced no answer${stderr ? `\nstderr:\n${tail(stderr)}` : ''}`)))
        return
      }
      finish(() => resolve({ text, meta: { ...assembled.meta, exitCode: code, durationMs: Date.now() - startedAt } }))
    })

    if (prompt !== '') {
      try {
        child.stdin.end(prompt, 'utf8')
      } catch {
        /* the close handler reports the real failure */
      }
    } else {
      child.stdin.end()
    }
  })
}

/* ------------------------------------------- catalog adapter (v0.4) ------- */

import { parseClaudeStream, parseGenericJsonLines } from './parsers.js'

export function makeParserFor(adapter, onDelta) {
  const factory = adapter.protocol === 'claude-json' ? parseClaudeStream : parseGenericJsonLines
  return onDelta ? () => factory(onDelta) : factory
}

/**
 * Run one prompt through a catalog adapter (claude-json | generic-json).
 * acp/http-sse adapters are dispatched elsewhere (acp.js / atomcode.js).
 * onDelta(text) streams accepted text chunks as they arrive (panel live view).
 */
export function runSpawnAdapter(adapter, prompt, { cwd, timeoutMs, signal, model, effort, onDelta } = {}) {
  if (adapter.promptDelivery === 'argv' && !adapter.args.includes('{prompt}')) {
    return Promise.reject(new Error(`adapter "${adapter.key}" 配置错误：argv 传参缺少 {prompt} 占位符`))
  }
  const argv = buildArgs(adapter, { prompt: adapter.promptDelivery === 'argv' ? prompt : '', model, cwd, effort })
  return runSpawn({
    command: resolveCommand(adapter),
    argv,
    prompt: adapter.promptDelivery === 'argv' ? '' : String(prompt ?? ''),
    cwd,
    timeoutMs: timeoutMs || adapter.timeoutMs,
    signal,
    env: Object.keys(adapter.env || {}).length > 0 ? { ...process.env, ...adapter.env } : process.env,
    makeParser: makeParserFor(adapter, onDelta),
    label: `${adapter.key}`,
  })
}

/** Version/availability probe for any spawn adapter. */
export function probeSpawnAdapter(adapter) {
  const command = resolveCommand(adapter)
  return probeCommand(command, adapter.versionArgs || ['--version'])
}

/* ------------------------------------------------- legacy CLIENTS shape --- */

export const CLIENTS = {
  claude: {
    label: 'Claude Code',
    command: () => process.env.DSH_CLI_CLAUDE || 'claude',
    args: () => ['-p', '--output-format', 'stream-json', '--verbose'],
    parse: parseClaudeStream,
  },
  opencode: {
    label: 'opencode',
    command: () => process.env.DSH_CLI_OPENCODE || 'opencode',
    // stdin support unverified; a CLI that needs the prompt on argv fails fast here.
    args: () => ['run', '--format', 'json'],
    parse: parseGenericJsonLines,
  },
  codex: {
    label: 'Codex CLI',
    command: () => process.env.DSH_CLI_CODEX || 'codex',
    // `codex exec` reads instructions from stdin when stdin is piped.
    args: () => ['exec', '--json'],
    parse: parseGenericJsonLines,
  },
}

export function runClient(client, prompt, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  return runSpawn({
    command: client.command(),
    argv: client.args(),
    prompt,
    cwd,
    timeoutMs,
    signal,
    makeParser: client.parse,
    label: client.label,
  })
}

/* ----------------------------------------------------------------- misc --- */

function tail(text, limit = 1200) {
  const value = String(text)
  return value.length > limit ? `…${value.slice(-limit)}` : value
}

/** Kill a CLI and everything it started (Windows shims spawn grandchildren). */
export function killTree(child) {
  if (!child || child.killed) return
  try {
    if (IS_WIN && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      })
      return
    }
    child.kill('SIGTERM')
  } catch {
    /* best effort */
  }
}

/** `where`/`which` probe plus a cheap version command for display. */
export async function probeCommand(command, versionArgs = ['--version']) {
  try {
    const located = await runSimple(IS_WIN ? 'where' : 'which', [command])
    if (located.code !== 0 || !located.stdout.trim()) return { ok: false }
    const version = await runSimple(command, versionArgs, 8000)
    return { ok: true, version: (version.stdout || version.stderr).trim().split('\n')[0] }
  } catch {
    return { ok: false }
  }
}

function runSimple(command, args, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, {
        shell: IS_WIN,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      resolve({ code: -1, stdout: '', stderr: '' })
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => killTree(child), timeoutMs)
    child.stdout?.on('data', (d) => (stdout += d))
    child.stderr?.on('data', (d) => (stderr += d))
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ code: -1, stdout: '', stderr: '' })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}
