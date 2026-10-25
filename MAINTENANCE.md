# dsh-cli-bridge 维护与优化指南（通用模式）

> **定位**：这份文档不讲"某版本改了什么"（那在 [README.md](README.md) 的变更史与踩坑实录里），讲的是**如何安全、持续地修改这个插件**——架构不变量、修改 SOP、可复用的 UI/引擎模式、测试策略。任何后续优化动手前先读这份。
> 适用范围：本插件的任何迭代；其中"DSH 插件契约"与"UI 模式库"两节对**任何 DSH UI 插件**通用。
> 本文件与开发实录/调研材料的完整版在文档主仓 `person-ai-learning-rec/dsh-cli-bridge/`（README、research/）。本仓库保留运行所需的维护指南副本。

---

## 1. 架构不变量（改任何东西都不能破坏）

这些是插件的承重墙。改动的第一步永远是确认没撞到它们。

### 1.1 分层与数据流（单向）

```
client/client.js（浏览器半，纯展示+fetch）
   ↓ HTTP
panel.js（路由层：解析/校验/分发，无业务逻辑）
   ↓
task-manager.js（看板任务生命周期：队列/调度/订阅——业务逻辑唯一归属）
   ↓
registry.js（注册表：builtin + custom 叠加、协议分发）
   ↓                    ↓
store.js（唯一持久化点）   引擎层（cli-runner / acp / atomcode）
   ↓                    ↓
clients.json + tasks.json   子进程 / HTTP daemon
```

- **反层级调用禁止**：引擎不 import registry/panel；task-manager 不 import panel；panel 不直接 spawn；client 不感知 CLI 细节（只认识 route 返回的字段）。
- **持久化只有一个入口**：一切配置/任务读写走 `store.js`（原子写 + promise 队列）。任何新代码需要存东西，加到 store，不要自己开文件。
- **浏览器半只认契约字段**：probe 行的 `{key,label,ok,detail,source,protocol,verified,enabled}`、clients 的 adapter 形状、看板卡的 task 记录（README §6b）。改字段 = 三处同步（panel 返回 / client 消费 / README schema）。
- **任务生命周期与页面解耦是看板的承重墙**：SSE 断开 ≠ 取消（对照 /run 直通的"断连即取消"）；只有显式 stop 走 AbortController 杀进程树。任何新路由/引擎改动都不得引入"页面关闭连坐任务"的路径。

### 1.2 adapter 是唯一扩展点

- 新 CLI 接入 = **数据**（catalog 加条目或用户自定义），不是代码。写代码才能接的 CLI 说明协议归类错了。
- **custom 同 key 覆盖 builtin** 是核心机制：内置参数不可信时（`verified:false`），修法永远是"同 key 自定义覆盖"，而不是改内置定义后发版。任何新字段都要考虑"custom 覆盖后行为是否正确"。
- 协议四类的判定准则（新 CLI 先问这三问）：
  1. 有 `--output-format stream-json`（claude 系克隆）？→ `claude-json`
  2. 说 ACP / ndJSON JSON-RPC 2.0？→ `acp`
  3. 本机 HTTP daemon + SSE？→ `http-sse`
  4. 其它自研 JSON 事件流 → `generic-json`（容错解析，容忍字段不齐）
  都不是 → 才考虑**新协议类型**（见 §5.1，成本高，需 mock 测试）。

### 1.3 引擎的一次性契约

- 每个 run 是独立进程/连接：**finish() 里必须杀进程树**（Windows shim 有孙进程，`taskkill /t`）；
- prompt 不上命令行（stdin/请求体优先；argv 型必须过 `quoteWinArg` 并在文档标注 cmd 元字符残留风险）；
- 超时/取消/早退都要走同一条 fail 路径，把 stderr 尾部带回错误信息（用户靠它排查 AUTH/配额）。

### 1.4 零依赖与版本兼容

- 只用 Node 内置 + 宿主注入包（`@deepseek-ai/dsh-tools`、`dsh-home-paths` 这类**库**可 import，宿主**服务**只能 `inject`）；import 宿主库要带 fallback（`store.js` 的 `$DSH_HOME`/`~/.dsh` 回退是范本）。
- 兼容声明写 `dsh.compatibility`（对齐 dsh-cost-meter 的区间写法）；**只用稳定接缝**（`ctx.tools.register` / `ctx.webServer.register` / `ctx.slots`），宿主内部服务名一律不碰（free-models-hub 卡死 web boot 的前车之鉴）。

### 1.5 配置容错

- clients.json 里的非法条目**跳过并警告**，绝不让它拖垮插件加载（`store.loadClients` 是范本）；`version` 字段留给未来 schema 迁移。
- 用户手编文件是常态：所有校验错误要能**原样显示在 UI 上**（面板底部 warnings 区），不静默吞。

---

## 2. 修改 SOP（任何改动的固定流程）

### 2.1 定位改动层（决定要动哪些文件）

| 症状/需求 | 动哪里 | 不要动 |
| --- | --- | --- |
| 面板显示/交互问题 | `client/client.js`（+ 必要时 panel 返回字段） | 引擎 |
| 看板 UI（组合器/分组/卡片详情/操作按钮） | `client/task.js`（+ panel.js 的 `/tasks*`、`/task.js` 路由） | client.js 其他区、task-manager |
| 看板行为（排队/并发/停止/重试/回写/持久化） | `task-manager.js`（+ `store.js` 的 tasks 侧） | 路由层、client |
| 新增/调整 HTTP 路由 | `panel.js` + client 调用点 | store 内部 |
| 探测/清单/覆盖逻辑 | `registry.js`（`store.js` 只在持久化形状变化时动） | 引擎 |
| 新 CLI / 修参数 | `catalog.js` 加数据（或让用户走自定义覆盖） | 引擎 |
| 某类协议行为 | 对应引擎文件 + 该协议的测试 | catalog |
| 存储形状 | `store.js` + bump `version` + 迁移考虑 | — |

### 2.2 改中检查单

- [ ] 没破坏 §1 的不变量？
- [ ] 新用户可见文案中英双语（T 字典两份）？
- [ ] 新字段在 validateAdapterShape 有校验？错误文案中文可读？
- [ ] UI 用 `h()` 手写树——**每次改完立刻 `node --check client/client.js`**（括号配平≠语法正确，最常见两类错：三元 consequent 结尾多逗号、数组元素间漏逗号，见 §6 坑速查）。

### 2.3 改后流程（固定命令链）

```bash
node test/catalog.mjs && node test/acp-engine.mjs && node test/custom-flow.mjs && node test/task-manager.mjs && node test/routes.mjs
node test/smoke.mjs atomcode          # 真实 E2E（动过引擎/registry 必跑）
node --check client/client.js         # 动过 UI 必跑
npm pack --pack-destination D:\code\.dist
tasklist | grep -i "DeepSeek Harness" # 必须 0 行再装！
dsh plugin --profile desktop add file:D:/code/.dist/local-dsh-cli-bridge-<ver>.tgz
dsh plugin --profile dev add file:D:/code/.dist/local-dsh-cli-bridge-<ver>.tgz
# 重启桌面端验收；文档同步：README §1 状态表 / §7 使用指南 / §8 新坑（按格式补）
```

---

## 3. DSH 插件契约备忘（写任何宿主侧代码前过一遍）

| 事项 | 规则 |
| --- | --- |
| 工具注册 | `ctx.tools.register(defineTool({name, description, parameters, output, execute}))`，包在 `ctx.effect(() => {..., return 反注册}, '名称')` 里 |
| HTTP 路由 | `ctx.webServer.register({kind:'prefix', path, handler})`；handler 是 Node http 风格，**method 分发自己写**；body 用 `for await (chunk of request)` 读（上限保护）；写操作后记得失效探测缓存。**SSE 长连接**（如 `/run`）：先校验后开流（校验失败走普通 JSON 错误）；断连检测必须用 `response.on('close')` + finished 标记——Node≥16 的 `request` 'close' 在 body 读完后就会触发，不能当断连信号；断连即 abort AbortController，让引擎走既有 signal 路径杀进程树 |
| 侧栏页面 | 浏览器半经典脚本 `window.__ModuleLoader__.load({id: 包名, factory})`；factory 返回 `{inject:['slots'], apply}`；**能力门控**：`ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(...))`，两条注册（`name:'main'` 面板体 + `name:'sidebar.panellist'` 行图标/label） |
| 宿主服务 | 只通过 `inject` 数组声明（cordis 把服务挂到 ctx 上）；宿主**库**（dsh-home-paths 等）可以 import 但要 fallback |
| 安装 | 两步：`dsh plugin --profile <p> add file:<tgz>`（只加依赖）+ bundle 名进 profile `package.json` 的 `dsh.profile.bundles`；**装前必须关应用**（hoisted 布局 + 运行中句柄 = EPERM 且会清空包目录） |
| 持久化 | `~/.dsh/storages/<插件名>/`；绝不放插件包内（pnpm 更新连目录删）；原子写 tmp+rename+EPERM/EBUSY 重试 + 进程内串行队列 |

---

## 4. UI 通用模式库（每个模式：问题 → 做法 → 范本位置）

这些模式在 `client/client.js` 里都已落地，后续改 UI 优先复用同一形状，保持一个文件内风格一致。

| 模式 | 解决的问题 | 做法要点 | 范本 |
| --- | --- | --- | --- |
| **内部滚动区** | 侧栏宿主不替你滚，长内容溢出 | 根：`height:'100%'` + flex 列；头部固定；内容区 `flex:1 + overflowY:'auto' + minHeight:0`，再加 `maxHeight:'calc(100vh - 150px)'` 兜底宿主不给高度 | Panel 根/`body` |
| **区块折叠** | 单页内容太多 | `sectionHead(open, onToggle, label, count, hint)` 通用头；状态存 localStorage（读写都 try/catch）；**折叠时关闭该区打开的编辑器**，否则"点了没反应" | `sectionHead` + `toggleList/toggleManage` |
| **行内编辑器** | 表单出现在页面底部，点了编辑要翻很久 | 编辑器渲染在**被点行之后**：列表 map 返回 `[rowEl, editorEl]`（editorEl 按 `editor.editingKey/overrides === row.key` 锚定）；"添加"模式的表单留在区块内；两处共用 `renderEditor()` | `renderEditor` + list map |
| **搜索过滤** | 条目多找不到 | 每区独立 `query` state；`haystack = key+label+协议label` 拼接后 `indexOf(lower)`；空态区分"没有数据"与"无匹配"两种文案 | `visibleRows/visibleCustom` |
| **低价值行默认隐藏** | 全是红色未检出条目时噪音大 | 过滤默认 `!showMissing || row.ok`；开关按钮带计数 `(N)`、激活变色、状态存 localStorage | `showMissing` |
| **编辑即测 + 倒计时自动保存** | 表单保存前缺验证，用户忘保存 | 打开编辑器 → 自动 `runDraftTest` → 通过则 `startCountdown(10)`；**editorRef 保证倒计时回调读到最新编辑器状态**；修改字段/取消/手动保存都 `stopCountdown`；测试失败不倒计时 | `runDraftTest/startCountdown/performSave` |
| **表单打开必可见** | 表单开在滚动区视野外，用户以为"点了没反应" | 打开编辑器后 `setTimeout` 查 `[data-editor-form]` → `scrollIntoView({block:'nearest'})` + 聚焦第一个输入框（`revealEditor(doFocus)`） | `revealEditor/openAddEditor` |
| **结果横幅置顶** | 保存/测试的错误显示在按钮下方被漏看 | testLine 渲染在表单第一行，带色边框 banner（成功绿/失败红），`whiteSpace:pre-wrap` 保证多行错误完整可见 | EditorForm 顶部 |
| **整行粘贴自动拆分** | 用户想粘整条命令而不是逐字段填 | 命令字段 `onChange` 检测 `nativeEvent.inputType === 'insertFromPaste'` 且含空白 → `tokenizeCommandLine`（引号感知）拆成 command + args（每行一个），argv 型自动补 `{prompt}`；键盘输入不受影响 | command 字段 onChange |
| **包装组件必须调用函数 children** ⚠️ | **生产 React 静默丢弃函数 children（不报错不渲染）**——表单有标签但 0 个输入框（"无法点击输入"级 bug） | 包装组件内部 `typeof children === 'function' ? children() : children`；`h()` 树里给自定义组件传渲染逻辑时要么组件调用、要么传元素；UI 自检必须**数 DOM 元素**（`querySelectorAll('input').length`），文字正常≠控件存在 | `Field`（带防回归注释） |
| **懒加载独立模块区** | 大块 UI 要与 client.js 并行开发，避免同文件互踩 | 区块独立成 `client/task.js`（真 ES module，无 import，`createTaskSection({React, zh, COLOR, STYLE, Field, sectionHead, readFlag, writeFlag})` 注入依赖返回组件）；panel.js 加 `GET /task.js` 伺服；client.js 用 `TaskMount` 包装组件在 useEffect 里动态 `import('/cli-bridge/task.js')`（classic script 允许动态 import），加载失败**内联降级显示**不炸面板；行间通信走 props（`preset:{key,at}`）保持单向 | `TaskMount`/`ensureTaskSection` + `client/task.js` |
| **流式输出控制台** | 长任务静默运行让用户以为卡死 | fetch + AbortController 消费 SSE（帧按 `\n\n` 切、行取 `data:`）；增量 delta 只做实时视图，终态 `done`/`changed` 到达时**整体替换为权威文本**；控制台 `<pre>` 封顶（MAX_OUT 截尾）+ 自动滚底；状态行带耗时心跳（1s tick）。**两种断连语义并存**：`/run` 直通=断连即取消（杀进程树）；看板 `/tasks/stream`=断连仅丢视图，自动重连+REST 对账，任务照跑 | `client/task.js` SSE 消费 |
| **行内展开必须保留行** ⚠️ | 点卡片/行展开详情后操作按钮消失 | 展开分支返回 `[rowEl, detailEl]` 数组（行内编辑器模式的泛化），**行元素永远在**；行与详情用圆角拼整体（行 `8px 8px 0 0`、详情 `0 0 8px 8px`）；展开态断言行 count 不变 | `client/task.js` `renderCard` |
| **分组互斥归属** | 同一条目出现在两个分组里（双份 DOM 两处可操作） | 每个分组的输入数组独立按互斥谓词推导（状态组=`!archived`、归档组=`archived`），**不共享可变过滤源**；空组不渲染 | `client/task.js` `grouped` |
| **服务端任务生命周期** | 页面关闭=任务死亡（v0.5.0 语义）的失控感 | 任务放宿主半 `task-manager.js`：FIFO 队列 + maxRunning 槽位 + 订阅广播（changed/output/deleted/settings）；`beginToolRun` 让工具调用回写看板但**绕过队列**（对话优先）；持久化只在状态变更时写（运行中增量在内存），重启 reconcile（running→failed，queued 续跑）；**会被 JSON 序列化的对象上绝不挂运行时句柄**（timer/controller 存独立 Map，见 README 坑 13） | `task-manager.js` |
| **新手说明书内嵌表单** | 不懂 CLI 的用户面对"协议/传参/参数模板"无从下手 | GuideBox 组件：可折叠说明（默认 add 模式展开、edit 模式不渲染）；内容=确认工具能跑→标识名称→协议口诀→命令参数（stdin/argv 区别）→测试保存，加 FAQ 与可照抄完整示例；文案全在 T 字典便于改 | `GuideBox` |
| **自动保存只用于新增** | 编辑已保存条目时倒计时强制保存，用户"只是看一眼"也被改写 | `isAddEditor(ed)`（editingKey===null 且 overrides===undefined）才在测试通过后 `startCountdown`；编辑模式显式保存；打开编辑器自动测试保留（仅状态展示） | `editRow/onTest` |
| **脏取消确认** | 有未保存修改点取消/切换编辑对象，静默丢失 | 编辑器携带 `initialDraftJson`（打开时 payload 快照）；`confirmDiscardIfDirty()` 比较当前 payload，不同则 `window.confirm`；挂在 取消/editRow/openAddEditor 三个入口 | `confirmDiscardIfDirty` |
| **编辑器跟随发起入口** | 管理区点编辑却跳到运行时区渲染，页面跳来跳去 | editor 带 `origin`（'list'/'manage'）；渲染条件按 origin 分流：list=行内锚定（exclude origin manage），manage=区块内渲染；只有 list 来源才强制展开运行时区 | `editRow(row, origin)` + `editorAnchorKey` |
| **真浏览器实测环境** | h() 树问题语法查不出、mock 测不到交互 | `test/ui-harness/`：宿主 shim（ModuleLoader + slots）+ 宿主同款 React 18 UMD 挂载真实 client.js + 桩路由（clis/clients/test/save/**run SSE 桩**/**伺服真实 task.js**）；浏览器里点/输/存/跑全流程验证，server console 看 SAVE/TEST/RUN payload | `test/ui-harness/README.md` |
| **错误必须可见** | 静默失败让用户以为"没反应" | 路由级错误进 `pageError`，表单级进 `testLine`，store 警告进 warnings 区；fetch 封装统一抛错 | `api()` |
| **确认危险操作** | 误删 | `window.confirm` 带 key 文案；删除同 key 覆盖前提示"还原内置"语义 | `deleteRow` |

UI 改动的一般原则：**一个交互动作只做一件事并在视觉上即时反馈**（倒计时显示在按钮上、错误贴着表单）；所有列表状态变化后调 `loadProbes/loadClients/loadAllAdapters` 三件套刷新（`mutate()` 封装了"改完即刷"）。

---

## 5. 引擎与数据扩展模式

### 5.1 新协议类型（重活，先确认四类真的不够）

1. `catalog.js`：`PROTOCOLS` 加枚举 + `PROTOCOL_LABELS` 加文案；
2. 新引擎文件：仿 `acp.js` 的形状——`runXxx(adapter, prompt, {cwd, timeoutMs, signal, model}) → {text, meta}`，内部自己管超时/abort/杀进程/错误带 stderr；
3. `registry.runAdapter` 加 dispatch 分支；`probeAdapter` 加探测分支；
4. **mock 测试**：`test/mock-*.mjs` 造一个最小对端 + `test/xxx-engine.mjs` 断言 text/meta/杀进程后退出（这是不依赖真实 CLI 的唯一验证手段）；
5. README §2 协议表加一行。

### 5.2 新 spawn 型 CLI（轻活）

`catalog.js` 加条目（协议 + 命令 + args 模板 + verified 标注）→ `node test/catalog.mjs` 校验。参数没实锤就 `verified:false` + note 写清依据，让用户走覆盖修正。argv 传参（args 含 `{prompt}`）要三思：Windows cmd 元字符风险，能 stdin 就 stdin。

### 5.3 环境变量覆盖约定（保持命名规则）

- `DSH_CLI_<KEY大写，非字母数字转_>`：覆盖任意 spawn/acp 条目的命令；
- `DSH_SSE_EXE_<KEY>`：http-sse 守护进程 exe；`DSH_ATOMCODE_URL` 等条目专属项放条目定义里并在 README schema 注明。

### 5.4 store 形状演进

新增字段：`validateClientPayload` 加校验 + `normalizeAdapter` 给默认值 + 旧文件天然兼容（缺字段走默认）。改语义/删字段：bump `version`，`loadClients` 里做迁移，**不迁移就跳过该条目并警告**。

---

## 6. 测试策略（加功能 = 加对层的测试）

| 测试 | 守住的层 | 手段 |
| --- | --- | --- |
| `catalog.mjs` | 目录数据完整性 | 纯校验：schema/唯一性/占位符/buildArgs/负载校验 |
| `routes.mjs` | panel 路由 + store 集成 | **mock 宿主**：ctx 直接挂 `webServer.register` 捕获 handler，mock req（async iterable body）/res（含 write 流式 + close 事件），全 method 打一遍 + `/run` SSE（成功/增量/断连取消/校验拒绝）+ 看板 `/tasks*` 全路由（创建校验/排队执行/停止/重试/归档/删/设置钳制/stream snapshot）+ `/task.js` 伺服；临时 `$DSH_HOME` 防污染 |
| `task-manager.mjs` | 看板生命周期（task-manager + store tasks 侧） | 临时 `$DSH_HOME` + `new TaskManager()`（**不**用单例）：真实 node 子进程当 mock CLI（echo/SLOW/CRASH 一个 adapter 按提示词分身）；断言 跑通/输出/meta、maxRunning=1 的 FIFO 排队、停 running/queued、失败记录 stderr、retry attempt+1、archive/unarchive/delete、archiveFinished、持久化 round-trip（新实例读回）、手写 running 记录的重启 reconcile、beginToolRun 绕队列回写、非法 create 拒绝 |
| `acp-engine.mjs` + `mock-acp-agent.mjs` | ACP 引擎 | 内置最小对端，断言 text/meta/工具计数/onDelta 增量=最终文本/**进程退出** |
| `custom-flow.mjs` | store+registry 全链 | 临时 `$DSH_HOME`：增/查/跑（真实 node 子进程）/覆盖/还原/删/校验拒绝 |
| `smoke.mjs` / `panel.mjs` | 真实端到端 | 真跑 atomcode pong / 全量探测打印 |

规则：**UI 逻辑没有自动化测试**（无构建链），所以 UI 的纪律是"语法必查 + 路由层必有 mock 测试兜底 + 错误必上屏"；给引擎加逻辑时必须同时给 mock 用例（含失败路径：早退/超时/错误响应）。**UI 交互类改动（表单/输入/按钮）必须跑 `test/ui-harness/` 真浏览器实测**——v0.5.0 的"表单 0 输入框"事故证明：`node --check` + 全文本渲染正常都拦不住"函数 children 被生产 React 静默丢弃"这类问题，只有数 DOM 元素/真实输入才能抓住（v0.7.0 的"展开丢卡片行""归档双份渲染"也都是真浏览器抓的）。**harness 自动化用 `evaluate(el => el.click())` 直点**——Playwright 真实 click 与 React 重渲染竞争会 3s 超时（README 坑 14），别浪费时间重试 locator。

---

## 7. 发布纪律

- 版本号随手 bump（patch=UI/文档修复，minor=能力新增）；`package.json` `files` 清单同步新文件（漏一个 = 装出去就崩）；
- `compatibility.dsh` 区间只在宿主大版本变化时动；
- 发布三件套：README §1 状态表、§7 使用指南、§8 踩坑（新坑按"现象/根因/修复/预防"格式）；
- 长期记忆与本文档保持互指：改文档位置不变（本目录权威），README 里只留指针。

---

## 8. 坑速查（细则见 README §8，这里只列触发条件）

| 场景 | 必须想起 |
| --- | --- |
| 装插件 | 关应用（tasklist 确认 0） |
| 改 client.js | `node --check`（三元无逗号/数组有逗号/括号配平≠语法对） |
| 改看板 UI | `node --check client/task.js`；展开/分组改动必跑 ui-harness（行保留+互斥归属）；改 `/tasks*`/`/task.js` 路由同步 routes.mjs + ui-harness 桩 |
| 改 task-manager | task-manager.mjs 加用例；杀进程树走 AbortController；JSON 化对象上禁挂运行时句柄；持久化只在状态变更时写 |
| SSE 长连接 | 断连检测用 `response.on('close')`（request 'close' 在 body 读完就触发）；`/run` 断连→取消；`/tasks/stream` 断连→仅丢视图自动重连 |
| 大块 UI 与 client.js 并行开发 | 拆独立模块（task.js 模式：panel 伺服 + 动态 import + deps 注入），别往 client.js 里堆 |
| 改路由 | routes.mjs 加用例；写操作失效探测缓存 |
| 动引擎 | 杀进程树、错误带 stderr、prompt 不上命令行；加 onDelta 类回调必须配 mock 断言 |
| 加持久化字段 | 容错加载 + UI 显示警告 + version 迁移 |
| Windows 命令行 | quoteWinArg 全 token；exe 路径空格；argv 型的 cmd 元字符残留风险 |
| 宿主 API | 只用稳定接缝 + import 库带 fallback |
| Git Bash 里跑 npm pack | `--pack-destination` 用正斜杠 `D:/code/.dist`（反斜杠被 bash 吃掉 → enoent） |
