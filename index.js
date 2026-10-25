/**
 * dsh-cli-bridge — expose locally installed agent CLIs to the dsh agent.
 *
 * Why a tool and not an LLM adapter: a CLI such as Claude Code is itself an
 * agent — it owns its tools, its context window and its own session store.
 * Treating it as a "model" would silently mix two tool loops; exposing it as a
 * callable capability keeps both loops honest, and matches the shape Multica's
 * runtime uses (spawn the CLI, parse its event stream, attribute the run).
 *
 * v0.4: the adapter set is catalog-driven (30 builtins after Multica's
 * builtin runtime families) plus user-managed custom adapters persisted in
 * ~/.dsh/storages/dsh-cli-bridge/clients.json and editable from the sidebar
 * page. registry.js overlays custom-over-builtin; panel.js serves the routes.
 *
 * v0.7: cli_agent delegations are recorded on the task board (task-manager.js,
 * origin=tool) — outside the board queue, so chat answers are never throttled
 * — making the board the single view of every CLI run on this machine.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { listAdapters, getAdapter, runAdapter, probeAdapter, resolveModels, modelsEnvName } from './registry.js'
import { getTaskManager } from './task-manager.js'
import { PROTOCOL_LABELS } from './catalog.js'
import { registerPanelRoute } from './panel.js'

export const name = 'cli-bridge'
export const inject = ['tools', 'webServer']

export function apply(ctx) {
  registerPanelRoute(ctx)
  ctx.effect(() => {
    const disposeAgent = ctx.tools.register(
      defineTool({
        name: 'cli_agent',
        description:
          'Run a locally installed agent CLI (atomcode, claude, codex, opencode, gemini, devin, kimi, grok, qwen and more — ' +
          'see cli_agents for the live list) on a prompt and return its final answer. ' +
          'Use it to delegate a self-contained task to another agent that has its own tools and its own account. ' +
          'The CLI runs in the given working directory and may modify files there, so state the task precisely.',
        parameters: {
          prompt: {
            type: 'string',
            required: true,
            description: 'The full task for the CLI agent. Include every file path and constraint it needs.',
          },
          cli: {
            type: 'string',
            description: 'Which CLI to run. Defaults to atomcode. Call cli_agents first to see what is available.',
          },
          cwd: {
            type: 'string',
            description: 'Working directory for the CLI. Defaults to the current session working directory.',
          },
          model: {
            type: 'string',
            description:
              'Optional model id. Validated against the adapter model catalog when one exists (static list, ' +
              'DSH_CLI_<KEY>_MODELS env override, or daemon discovery); pass-through otherwise.',
          },
          effort: {
            type: 'string',
            description:
              'Optional runtime-native reasoning/effort token (e.g. low|medium|high|xhigh|max). Only adapters ' +
              'declaring effort support honour it; others reject the call instead of silently ignoring it.',
          },
          timeoutMs: {
            type: 'number',
            description: 'Hard timeout in milliseconds. Defaults to the adapter timeout (180s spawn, 600s acp/http-sse).',
          },
          verbose: {
            type: 'boolean',
            description: 'Append run metadata (cli, protocol, model, session, cost, duration) to the answer.',
          },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args, exec) {
          const key = String(args.cli || 'atomcode').toLowerCase()
          const adapter = await getAdapter(key)
          if (!adapter) {
            const all = await listAdapters()
            throw new Error(
              `cli_agent: unknown cli "${key}"; available: ${all.map((a) => a.key).join(', ')}. ` +
                'Custom CLIs can be added on the CLI Agents sidebar page.',
            )
          }
          if (adapter.enabled === false) {
            throw new Error(`cli_agent: "${key}" 已停用；可在 CLI 运行时页面重新启用`)
          }
          if (args.model) {
            // Multica 式诚实校验：有目录就拒绝目录外的模型（手动输入兜底走 env 覆盖）
            const catalog = await resolveModels(adapter)
            if (!catalog.supported) {
              throw new Error(`cli_agent: "${key}" 不支持模型选择（该 CLI 会忽略 model 参数）`)
            }
            if (
              catalog.models.length > 0 &&
              !catalog.models.some((m) => m.id === String(args.model))
            ) {
              throw new Error(
                `cli_agent: 模型 "${args.model}" 不在 "${key}" 的目录里；可用: ${catalog.models.map((m) => m.id).join(', ')}。` +
                  `要追加候选，设置环境变量 ${modelsEnvName(adapter)}（逗号分隔）后重试。`,
              )
            }
          }
          if (args.effort && !adapter.effortFlag && adapter.protocol !== 'acp') {
            throw new Error(
              `cli_agent: "${key}" 未声明推理档位支持（effortFlag）；` +
                '可在 CLI 运行时页面编辑该条目补 effortFlag（如 --effort），或换用支持档位的 CLI。',
            )
          }
          const timeoutMs = Number(args.timeoutMs) > 0 ? Number(args.timeoutMs) : undefined
          // Tool delegations are recorded on the board (origin=tool) but run
          // OUTSIDE the queue: a chat answer must never wait behind board
          // tasks. The record keeps the board the single view of all CLI runs.
          const prompt = String(args.prompt ?? '')
          const record = getTaskManager().beginToolRun({ adapter, prompt, cwd: args.cwd, model: args.model })
          let result
          try {
            result = await runAdapter(adapter, prompt, {
              cwd: args.cwd,
              model: args.model,
              effort: args.effort,
              timeoutMs,
              signal: exec?.signal,
              onDelta: (delta) => record.delta(delta),
            })
          } catch (error) {
            await record.fail(error, exec?.signal?.aborted ? 'stopped' : 'failed')
            throw error
          }
          await record.done(result)
          if (args.verbose) {
            return (
              `${result.text}\n\n---\ncli=${key} protocol=${adapter.protocol} model=${result.meta.model || '?'} ` +
              `session=${result.meta.sessionId || '?'} cost=${formatCost(result.meta.costUsd)} ` +
              `duration=${result.meta.durationMs ?? '?'}ms exit=${result.meta.exitCode ?? '-'}`
            )
          }
          return result.text
        },
      }),
    )

    const disposeList = ctx.tools.register(
      defineTool({
        name: 'cli_agents',
        description:
          'List the CLI runtimes this machine exposes (builtin catalog + user-managed custom entries) with their ' +
          'availability. Call it before cli_agent when you are unsure a CLI exists.',
        parameters: {},
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute() {
          const adapters = await listAdapters()
          const lines = await Promise.all(
            adapters.map(async (adapter) => {
              const probe = await probeAdapter(adapter).catch((error) => ({
                ok: false,
                detail: error?.message ?? String(error),
              }))
              const tags = [adapter.source === 'custom' ? '自定义' : '内置', PROTOCOL_LABELS[adapter.protocol] || adapter.protocol]
              if (adapter.verified === false) tags.push('未验证')
              if (adapter.enabled === false) tags.push('已停用')
              let modelInfo = ''
              if (probe.ok) {
                try {
                  const catalog = await resolveModels(adapter)
                  if (!catalog.supported) modelInfo = ' [不支持模型选择]'
                  else if (catalog.models.length > 0)
                    modelInfo = ` [模型目录 ${catalog.models.length} 个: ${catalog.models.map((m) => m.id).slice(0, 6).join('/')}${catalog.models.length > 6 ? '…' : ''}]`
                } catch {
                  /* catalog discovery is advisory for the listing */
                }
              }
              return `${adapter.key}: ${adapter.label} [${tags.join('/')}] — ${probe.ok ? '可用' : '未检测到'} (${probe.detail})${modelInfo}`
            }),
          )
          return lines.join('\n')
        },
      }),
    )

    console.log('[cli-bridge] registered cli_agent + cli_agents over the adapter registry (builtin + custom)')

    return () => {
      for (const dispose of [disposeAgent, disposeList]) {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          /* a failing disposer must not mask the other */
        }
      }
    }
  }, 'cli-bridge tools')
}

function formatCost(value) {
  return typeof value === 'number' ? `$${value.toFixed(6)}` : '?'
}
