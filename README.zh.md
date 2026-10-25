<p align="center"><img src="icon.svg" width="88" alt="dsh-cli-bridge logo"></p>

# dsh-cli-bridge

[![npm](https://img.shields.io/npm/v/@qdnbd/dsh-cli-bridge)](https://www.npmjs.com/package/@qdnbd/dsh-cli-bridge)
![platform](https://img.shields.io/badge/platform-Windows-blue)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[English](README.md) | **中文**

把本机已装的 AI 命令行工具接入 [DeepSeek Harness](https://www.deepseek.com/zh/harness)——对话里委派任务、侧栏任务框直接运行、可视化统一管理。**仅支持 Windows**（无 macOS 版本）。

- **对话委派**：DeepSeek 调用 `cli_agent` 工具，把自包含任务交给本机任意 CLI，带回最终答案。
- **侧栏页面**：30 条内置 CLI 运行时目录（自动探测）+ 自定义条目，支持搜索、运行、编辑、启停。
- **任务框**：选 CLI、写任务、看流式输出、随时停止，不经 AI 中转。
- **30 条内置目录**：AtomCode、Claude Code、Codex、Gemini、opencode、Devin、Kimi、Grok、Qwen、Trae、Qoder、Antigravity 及整个 ACP 家族——四种线协议（claude stream-json / JSON 事件流 / **ACP** / HTTP SSE）。
- **零代码接入自定义 CLI**：引导式表单（协议口诀、整行粘贴自动拆分、内置新手说明书、测试后保存），或手编 `~/.dsh/storages/dsh-cli-bridge/clients.json`。
- **模型目录与推理档位**：每条目的模型清单（静态 / 环境变量 `DSH_CLI_<KEY>_MODELS` / daemon 动态发现）+ 诚实校验；支持档位透传。

## 安装

DeepSeek Harness 桌面端：**设置 → 插件**（或收录了本包的插件市场）安装 `@qdnbd/dsh-cli-bridge`。命令行：

```sh
dsh plugin --profile <你的profile> add @qdnbd/dsh-cli-bridge
```

重启应用。要求：你想用的 CLI 已在本机安装（按需即可）；AtomCode 守护进程未启动时会自动从 `D:\exe\atomcode*.exe` 拉起（可用 `DSH_SSE_EXE_ATOMCODE` / `DSH_ATOMCODE_URL` 覆盖）。

## 使用

- 对话：*"调一下 cli_agents 列出可用的 CLI"* → *"用 cli_agent 让 atomcode 修复 D:\code\xxx 的报错"*。
- 侧栏「CLI 运行时」页面：浏览可用 CLI、点 **▶** 直接下发任务、点 **＋ 添加自定义 CLI** 接入新工具——表单内置分步新手说明书。
- 工具：`cli_agent(prompt, cli?, cwd?, model?, effort?, timeoutMs?)` 与 `cli_agents()`。

## 配置

自定义条目在 `~/.dsh/storages/dsh-cli-bridge/clients.json`（面板里也能改）。环境变量覆盖：

| 变量 | 用途 |
| --- | --- |
| `DSH_CLI_<KEY>` | 覆盖任意条目的可执行文件（如 `DSH_CLI_CLAUDE=D:\bin\claude.exe`） |
| `DSH_CLI_<KEY>_MODELS` | 逗号分隔的模型目录覆盖 |
| `DSH_SSE_EXE_<KEY>` | http-sse 条目的守护进程可执行文件（自动拉起） |
| `DSH_ATOMCODE_URL` | AtomCode 守护进程地址（默认 `http://127.0.0.1:13456`） |

完整 adapter schema、协议细节与维护指南见 [MAINTENANCE.md](MAINTENANCE.md)。

## 开发

```sh
node test/catalog.mjs && node test/routes.mjs && node test/custom-flow.mjs
node test/acp-engine.mjs && node test/smoke.mjs atomcode
node --check client/client.js          # h() 树语法门禁
# UI 交互改动必跑：test/ui-harness（见其 README）
```

零运行时依赖——仅 Node 内置模块 + 宿主注入的 `@deepseek-ai/dsh-tools`。

## 许可证

[MIT](LICENSE)
