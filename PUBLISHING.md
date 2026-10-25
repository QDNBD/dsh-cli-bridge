# 发布状态与 Runbook（dsh-cli-bridge）

> 本文件记录公开发布的当前状态与后续发版步骤。权威发布流程调研见 `research/plugin-publishing-workflow-2026-10-26.md`。

## 当前状态（2026-10-26）

| 项 | 值 |
| --- | --- |
| GitHub 仓库 | https://github.com/QDNBD/dsh-cli-bridge （main，已推 0.7.2） |
| npm 包名 | `@qdnbd/dsh-cli-bridge`（无 scope 名 dsh-cli-bridge 已被占用） |
| 元数据 | MIT · engines.dsh `>=0.2.0-rc.1 <0.3.0-0` · os `["win32"]` · repository 回链 ✓ |
| 收录 PR | ⬜ 未提（YAML 已备好：仓库 `publishing/awesome-dsh-plugin--data-plugins-QDNBD__dsh-cli-bridge.yml`） |

## 剩余手工步骤（需要登录凭据，机器上无法自动完成）

1. **npm 登录 + 发布**（本机 npm 未登录）：
   ```sh
   cd D:\code\git\dsh-cli-bridge
   npm login                 # 浏览器完成登录
   npm publish --access public
   ```
2. **GitHub 仓库元数据**（gh CLI 未装，网页 10 秒）：仓库页 About 齿轮 → Description 填 `Expose locally installed AI agent CLIs (AtomCode/Claude Code/Codex/Gemini/ACP…) to DeepSeek Harness — chat delegation, sidebar task box, visual manager. Windows only.` → Topics 加 `dsh-plugin`、`dsh`、`deepseek-harness`、`windows`。
3. **提收录 PR**：打开 https://github.com/awesome-dsh-plugin/awesome-dsh-plugin → Add file → Create new file → 文件名粘贴 `data/plugins/QDNBD__dsh-cli-bridge.yml` → 粘贴仓库 `publishing/` 里 YAML 的内容（去掉注释行）→ Commit（页面会自动 fork 并建 PR）→ CI 绿后等人工审核，通常一天内生效。
4. **（可选）第二市场**：https://dsh-plugin.org/zh/submit （topic 加过后它也会自己爬到）。

## 发版 Runbook（以后每次更新）

1. 在 `D:\code\git\dsh-cli-bridge` 改代码 → `node test/catalog.mjs && node test/routes.mjs && node test/custom-flow.mjs && node test/task-manager.mjs && node test/acp-engine.mjs && node test/smoke.mjs atomcode && node --check client/client.js`
2. `npm version patch`（或 minor）→ `git push --tags`
3. `npm publish --access public`（目录自动跟踪 npm 版本，市场出现"可更新"）
4. 本机安装：`dsh plugin --profile desktop add @qdnbd/dsh-cli-bridge`（或等市场更新提示）
5. 文档同步：本文件状态表 + person-ai-learning-rec README 状态表 + MAINTENANCE 踩坑

## 迁移注意（@local → @qdnbd 改名）

本机 profiles 目前装的是旧名 `@local/dsh-cli-bridge`（file: tgz 0.7.1）。npm 发布后迁移：

```sh
# 关闭应用后：
dsh plugin --profile desktop remove @local/dsh-cli-bridge
# 手动从 profile package.json 的 dsh.profile.bundles 里删除 "@local/dsh-cli-bridge" 并加入 "@qdnbd/dsh-cli-bridge"
dsh plugin --profile desktop add @qdnbd/dsh-cli-bridge
```
不迁移也能用（旧名 0.7.1 继续跑），但两包并存会造成工具重复注册，务必二选一。
