<p align="center"><img src="icon.svg" width="88" alt="dsh-cli-bridge logo"></p>

# dsh-cli-bridge

[![npm](https://img.shields.io/npm/v/@qdnbd/dsh-cli-bridge)](https://www.npmjs.com/package/@qdnbd/dsh-cli-bridge)
![platform](https://img.shields.io/badge/platform-Windows-blue)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**English** | [中文](README.zh.md)

Expose your locally installed AI agent CLIs to [DeepSeek Harness](https://www.deepseek.com/zh/harness) — delegate tasks from chat, run them directly from a sidebar task box, and manage everything visually. **Windows only** (no macOS build).

- **Chat delegation** — DeepSeek calls the `cli_agent` tool to hand a self-contained task to any installed CLI and brings back the final answer.
- **Sidebar page** — a live catalog of 30 built-in CLI runtimes (auto-detected) plus your own custom entries: search, run, edit, enable/disable.
- **Task box** — pick a CLI, type a task, watch streaming output, stop anytime. No AI middleman.
- **30 builtin runtimes** — AtomCode, Claude Code, Codex, Gemini, opencode, Devin, Kimi, Grok, Qwen, Trae, Qoder, Antigravity and the rest of the ACP family, over four wire protocols (claude stream-json / JSON events / **ACP** / HTTP SSE).
- **Custom CLIs without code** — add any local CLI through a guided form (protocol cheat-sheet, full-line paste auto-split, built-in beginner guide, test-then-save), or edit `~/.dsh/storages/dsh-cli-bridge/clients.json` by hand.
- **Model catalogs & effort** — per-adapter model lists (static, env override `DSH_CLI_<KEY>_MODELS`, or live daemon discovery) with honest validation; reasoning-effort pass-through where the CLI supports it.

## Install

In DeepSeek Harness Desktop: **Settings → Plugins** (or a plugin market that lists this package) and install `@qdnbd/dsh-cli-bridge`. From a terminal:

```sh
dsh plugin --profile <your-profile> add @qdnbd/dsh-cli-bridge
```

Restart the app. Requires the target CLIs to be installed locally (only the ones you want to use); AtomCode's daemon is auto-started if found under `D:\exe\atomcode*.exe` (override with `DSH_SSE_EXE_ATOMCODE` / `DSH_ATOMCODE_URL`).

## Usage

- In chat: *"调一下 cli_agents 列出可用的 CLI"* → then *"用 cli_agent 让 atomcode 修复 D:\code\xxx 的报错"*.
- In the **CLI 运行时** sidebar page: browse detected CLIs, hit **▶** to run a task directly, or **＋ 添加自定义 CLI** to connect anything else — the form ships a step-by-step beginner guide.
- Tools: `cli_agent(prompt, cli?, cwd?, model?, effort?, timeoutMs?)` and `cli_agents()`.

## Configuration

Custom adapters live in `~/.dsh/storages/dsh-cli-bridge/clients.json` (also editable from the panel). Env overrides:

| Variable | Purpose |
| --- | --- |
| `DSH_CLI_<KEY>` | Override the executable for any adapter (e.g. `DSH_CLI_CLAUDE=D:\bin\claude.exe`) |
| `DSH_CLI_<KEY>_MODELS` | Comma-separated model catalog override |
| `DSH_SSE_EXE_<KEY>` | Daemon executable for http-sse adapters (auto-start) |
| `DSH_ATOMCODE_URL` | AtomCode daemon base URL (default `http://127.0.0.1:13456`) |

Full adapter schema, protocol details and the maintenance story: see [MAINTENANCE.md](MAINTENANCE.md).

## Development

```sh
node test/catalog.mjs && node test/routes.mjs && node test/custom-flow.mjs
node test/acp-engine.mjs && node test/smoke.mjs atomcode
node --check client/client.js          # h() tree syntax gate
# UI interaction changes: run test/ui-harness (see its README)
```

Zero runtime dependencies — Node built-ins plus host-injected `@deepseek-ai/dsh-tools` only.

## License

[MIT](LICENSE)
