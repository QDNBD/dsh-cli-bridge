/**
 * Minimal ACP agent mock for engine tests — speaks newline-delimited
 * JSON-RPC 2.0 over stdio: initialize, session/new, session/prompt (emits a
 * thought chunk, two message chunks and a tool_call, then end_turn).
 * Also answers session/request_permission with allow_once (exercising the
 * engine's auto-allow path).
 */
import { createInterface } from 'node:readline'

const rl = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity })

function send(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n')
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

rl.on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = message
  if (id === undefined) return // notification from client: ignore
  switch (method) {
    case 'initialize':
      respond(id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false },
        authMethods: [],
      })
      break
    case 'authenticate':
      respond(id, {})
      break
    case 'session/new':
      respond(id, { sessionId: 'mock-session-1' })
      break
    case 'session/set_config_option':
      respond(id, { currentModel: params?.value ?? null })
      break
    case 'session/prompt':
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_thought_chunk', content: [{ type: 'text', text: 'thinking…' }] },
        },
      })
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'echo' },
        },
      })
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: [{ type: 'text', text: 'pong ' }, { type: 'text', text: 'from mock' }],
          },
        },
      })
      // agent->client permission request: the engine should auto-allow
      send({
        jsonrpc: '2.0',
        id: 9001,
        method: 'session/request_permission',
        params: { sessionId: params.sessionId, options: [{ optionId: 'opt-allow', kind: 'allow_once', name: 'Allow' }] },
      })
      setTimeout(() => respond(id, { stopReason: 'end_turn' }), 200)
      break
    default:
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `mock does not implement ${method}` } })
  }
})

// answer our own outgoing permission request when the engine replies
rl.on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.id === 9001 && message.result) {
    process.stderr.write('mock: permission auto-allowed\n')
  }
})
