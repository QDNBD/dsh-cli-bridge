/**
 * acp — Agent Client Protocol engine (newline-delimited JSON-RPC 2.0 over
 * stdio), for the 14 ACP-family adapters in the catalog (devin, qoderclicn,
 * kimi, kiro, grok, dim, hermes, mcode, muse, qoder, traecli, qwenpaw,
 * zeroclaw, reasonix).
 *
 * One-shot contract (matches this plugin's cli_agent semantics, no resume):
 *   spawn -> initialize -> [authenticate when the agent offers methods]
 *         -> session/new -> session/prompt -> consume session/update
 *         notifications until the prompt responds with a stopReason.
 *
 * Unattended choices: declared fs/terminal capabilities are false; agent
 * permission requests are answered with the first allow_once option so a
 * delegated task can actually run (same stance as Multica's --yolo family).
 *
 * Free of dsh imports; test/acp-engine.mjs exercises it against a mock agent.
 */

import { spawn } from 'node:child_process'
import { IS_WIN, killTree, quoteWinArg } from './cli-runner.js'

export async function runAcpAdapter(adapter, prompt, { cwd, timeoutMs, signal, model, effort, onDelta } = {}) {
  const effectiveTimeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : adapter.timeoutMs
  const startedAt = Date.now()

  return new Promise((resolve, reject) => {
    let child
    try {
      const exe = process.env[`DSH_CLI_${String(adapter.key || '').toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] || adapter.command
      // ACP args are static flags from the adapter config (the prompt travels
      // in session/prompt JSON, never on the command line), every token
      // escaped for cmd.exe (exe paths with spaces included).
      child = spawn([exe, ...adapter.args].map(quoteWinArg).join(' '), IS_WIN ? [] : adapter.args, {
        cwd: cwd || process.cwd(),
        shell: IS_WIN,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: Object.keys(adapter.env || {}).length > 0 ? { ...process.env, ...adapter.env } : process.env,
      })
    } catch (error) {
      reject(new Error(`${adapter.key}: cannot start "${adapter.command}": ${error.message}`))
      return
    }

    const stderrChunks = []
    let settled = false
    let timedOut = false
    let stdoutBuffer = ''

    const texts = []
    const meta = {}
    const toolCallIds = new Set()
    let nextId = 1
    const pendingCalls = new Map()

    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, effectiveTimeout)
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
      // one-shot contract: the agent process never outlives the turn
      killTree(child)
      fn()
    }

    const fail = (message) => finish(() => {
      const stderr = stderrChunks.join('').trim()
      reject(new Error(`${adapter.key}: ${message}${stderr ? `\nstderr:\n${tail(stderr)}` : ''}`))
    })

    const send = (payload) => {
      try {
        child.stdin.write(JSON.stringify(payload) + '\n')
      } catch (error) {
        fail(`failed to write to agent stdin: ${error.message}`)
      }
    }

    const call = (method, params) =>
      new Promise((resolveCall, rejectCall) => {
        const id = nextId++
        pendingCalls.set(id, { resolve: resolveCall, reject: rejectCall })
        send({ jsonrpc: '2.0', id, method, params })
      })

    const handleUpdate = (update) => {
      const kind = update?.sessionUpdate
      if (kind === 'agent_message_chunk') {
        for (const block of contentBlocks(update.content)) {
          texts.push(block)
          if (onDelta) onDelta(block)
        }
      } else if (kind === 'agent_thought_chunk') {
        /* thinking: not part of the final-answer contract */
      } else if (kind === 'tool_call' || kind === 'tool_call_update') {
        if (update.toolCallId) toolCallIds.add(update.toolCallId)
      }
      /* plan / available_commands_update / current_mode_update: ignored */
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk
      let index
      while ((index = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, index).replace(/\r$/, '')
        stdoutBuffer = stdoutBuffer.slice(index + 1)
        if (line.trim().length === 0) continue
        let message
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message.id !== undefined && message.method === undefined) {
          // response to one of our calls
          const pending = pendingCalls.get(message.id)
          if (pending) {
            pendingCalls.delete(message.id)
            if (message.error) pending.reject(Object.assign(new Error(message.error.message || 'ACP error'), { code: message.error.code, data: message.error.data }))
            else pending.resolve(message.result)
          }
        } else if (message.method !== undefined && message.id !== undefined) {
          // agent -> client request: permission prompts auto-allow, rest refuse
          if (message.method === 'session/request_permission') {
            const options = message.params?.options || []
            const allow = options.find((o) => o.kind === 'allow_once') || options[0]
            send({
              jsonrpc: '2.0',
              id: message.id,
              result: allow
                ? { outcome: { outcome: 'selected', optionId: allow.optionId } }
                : { outcome: { outcome: 'cancelled' } },
            })
          } else {
            send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not supported by cli-bridge' } })
          }
        } else if (message.method !== undefined) {
          // notification
          if (message.method === 'session/update') handleUpdate(message.params?.update)
        }
      }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      if (stderrChunks.length < 40) stderrChunks.push(chunk)
    })

    child.on('error', (error) => fail(`"${adapter.command}" failed to start: ${error.message}`))
    child.on('close', (code) => {
      if (settled) return
      if (timedOut) fail(`timed out after ${effectiveTimeout}ms`)
      else if (signal?.aborted) fail('cancelled')
      else fail(`agent exited early (code ${code}) before the turn completed`)
    })

    async function run() {
      const init = await call('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      })
      meta.protocolVersion = init?.protocolVersion
      const authMethods = Array.isArray(init?.authMethods) ? init.authMethods : []
      if (authMethods.length > 0) {
        try {
          await call('authenticate', { methodId: authMethods[0].id })
        } catch {
          /* agent may not actually require it; session/new decides */
        }
      }
      const session = await call('session/new', { cwd: cwd || process.cwd(), mcpServers: [] })
      meta.sessionId = session?.sessionId
      if (model) {
        // best effort: agents that expose config options honour it, others error
        // which we swallow — model selection must never break the delegation.
        try {
          await call('session/set_config_option', { sessionId: session?.sessionId, configId: 'model', value: String(model) })
        } catch {
          /* ignore */
        }
      }
      if (effort) {
        // same best-effort stance for the runtime-native reasoning token
        // (DSH ACP exposes model / reasoning_effort config options).
        try {
          await call('session/set_config_option', { sessionId: session?.sessionId, configId: 'reasoning_effort', value: String(effort) })
        } catch {
          /* ignore */
        }
      }
      const outcome = await call('session/prompt', {
        sessionId: session?.sessionId,
        prompt: [{ type: 'text', text: String(prompt ?? '') }],
      })
      meta.stopReason = outcome?.stopReason
      const text = texts.join('').trim()
      if (signal?.aborted) {
        fail('cancelled')
        return
      }
      if (!text) {
        fail(`produced no answer (stopReason=${meta.stopReason || '?'})`)
        return
      }
      finish(() => {
        meta.toolCalls = toolCallIds.size
        meta.durationMs = Date.now() - startedAt
        resolve({ text, meta })
      })
    }

    run().catch((error) => fail(error.message || String(error)))
  })
}

function contentBlocks(content) {
  const blocks = Array.isArray(content) ? content : [content]
  const out = []
  for (const block of blocks) {
    if (typeof block === 'string') out.push(block)
    else if (block?.type === 'text' && typeof block.text === 'string') out.push(block.text)
  }
  return out
}

function tail(text, limit = 1200) {
  const value = String(text)
  return value.length > limit ? `…${value.slice(-limit)}` : value
}
