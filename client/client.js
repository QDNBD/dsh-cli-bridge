/**
 * dsh-cli-bridge — browser half: the "CLI Agents" sidebar page.
 *
 * CLASSIC SCRIPT: registers a lazy factory with the page module loader (id
 * must equal the package name). The factory returns the Cordis plugin, which
 * mounts one sidebar panel with two sections:
 *
 *   运行时   — probed availability of every adapter (builtin + custom),
 *              fed by GET /cli-bridge/clis (15s poll)
 *   任务     — run a task straight from the panel (no chat model in the
 *              loop) against any detected CLI; POST /cli-bridge/run streams
 *              live output over SSE, Stop aborts and kills the run
 *   管理     — CRUD over user-managed custom adapters against
 *              /cli-bridge/clients, with a draft probe test
 *
 * Plain React + inline styles (same zero-dependency shape as
 * dsh-pending-review-glow); dsw CSS variables with hardcoded fallbacks.
 */
window.__ModuleLoader__.load({
  id: '@qdnbd/dsh-cli-bridge',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState } = React

    const PANEL_ID = 'cli-bridge'
    const ROUTE_CLIS = '/cli-bridge/clis'
    const ROUTE_CLIENTS = '/cli-bridge/clients'
    const ROUTE_CLIENTS_TEST = '/cli-bridge/clients/test'
    const POLL_MS = 15000
    const ROUTE_TASK_JS = '/cli-bridge/task.js'

    const PROTOCOL_OPTIONS = ['http-sse', 'claude-json', 'generic-json', 'acp']
    const PROTOCOL_LABELS = {
      'http-sse': 'HTTP SSE',
      'claude-json': 'claude stream-json',
      'generic-json': 'JSON 事件流',
      acp: 'ACP',
    }

    const zh = (function () {
      try {
        return String((navigator && navigator.language) || '').toLowerCase().indexOf('zh') === 0
      } catch (error) {
        return false
      }
    })()

    const T = zh
      ? {
          title: 'CLI 运行时',
          subtitle: '本机可被 cli_agent 调用的 AI CLI（内置目录 + 自定义）',
          sectionRuntime: '运行时',
          searchPlaceholder: '搜索 key / 名称 / 协议…',
          noMatch: '无匹配',
          showMissingHint: '同时显示未检测到的 CLI',
          autoSaveHint: '测试通过，%s 秒后自动保存；修改内容或点「取消」可停止',
          overrideHint: '将覆盖内置 "%s" 的配置（保存即生效；删除该自定义条目即还原内置）',
          refresh: '刷新',
          probing: '探测中…',
          ok: '可用',
          missing: '未检测到',
          builtin: '内置',
          custom: '自定义',
          unverified: '未验证',
          disabled: '已停用',
          manageTitle: '管理自定义 CLI',
          manageHint: '新增、修改、停用自定义接入；与内置同 key 时覆盖内置配置。',
          add: '＋ 添加自定义 CLI',
          edit: '编辑',
          del: '删除',
          delConfirm: '删除自定义 CLI "%s"？',
          enable: '启用',
          disable: '停用',
          test: '测试',
          save: '保存',
          cancel: '取消',
          testing: '测试中…',
          saving: '保存中…',
          fieldName: '标识 (key)',
          fieldLabel: '名称',
          fieldProtocol: '协议类型',
          fieldCommand: '命令',
          commandPasteHint: '可整行粘贴（含参数），自动拆分',
          discardConfirm: '有未保存的修改，确定放弃？',
          guideTitle: '📖 使用说明：三分钟接入一个新 CLI',
          guideCollapse: '收起',
          guideExpand: '展开',
          guideIntro:
            '这个表单把"你本机能跑的一个 AI 命令行工具"接入面板——填完后 DeepSeek 对话和上方任务区都能调用它，不需要写任何代码。',
          guideSteps: [
            {
              t: '先确认工具能跑',
              d: '按 Win+R 输入 cmd 回车，在黑窗口里敲这个工具的命令名，如：mycli --version。能打印版本号 → 可以接入；提示"不是内部或外部命令" → 先安装它，或找到它的完整路径（如 D:\\tools\\mycli.exe），第 4 步把完整路径填进"命令"。',
            },
            {
              t: '填标识和名称',
              d: '标识：唯一的英文 ID（字母开头，可用数字和 -），例如 my-cli。名称：显示用的名字，例如 我的工具。',
            },
            {
              t: '选协议类型（照口诀选）',
              d: '① 它是 Claude Code 或其兼容版（如 csc）→ 选 claude stream-json；② 它是个常驻本地服务、有自己的网址（如 http://127.0.0.1:端口）→ 选 HTTP SSE，并填下方的服务地址；③ 它的官方文档说支持 ACP（Agent Client Protocol）→ 选 ACP；④ 不确定 → 选 JSON 事件流（最常见的默认）。',
            },
            {
              t: '填命令和参数',
              d: '命令：第 1 步验证过的命令名（支持整行粘贴 "mycli -p --flag"，自动拆分）。参数模板：每个参数单独一行。关键在"任务传参方式"：stdin（推荐）= 工具从标准输入读任务，参数里不用写任务本身；argv = 参数里必须有一行 {prompt}，运行时替换成任务内容。',
            },
            {
              t: '测试 → 保存',
              d: '点「测试」：绿色显示版本号 = 接入成功；红色 NOT FOUND = 命令名不对或没安装（见下方 FAQ）。通过后 10 秒自动保存（或点「保存」立即保存）。之后在对话里说"用 my-cli 做……"，或在上方任务区选它运行。',
            },
          ],
          guideFaqTitle: '常见问题',
          guideFaq: [
            { q: '测试红色 NOT FOUND？', a: '命令没被找到。三选一：① 用完整路径当命令（如 D:\\tools\\mycli.exe）；② 把工具所在目录加进 PATH 环境变量；③ 确认它真的安装了。' },
            { q: '运行很久没结果/超时？', a: '① 把"超时毫秒"调大（慢任务建议 600000）；② 用 mycli --help 查它的非交互用法，照抄参数；③ 需要 API Key 的工具，在"环境变量"里加一行 KEY=VALUE。' },
            { q: '怎么让它自动干活、不要每次确认？', a: '加权限放行参数（各家不同）：claude 系加 --permission-mode bypassPermissions；gemini 系加 --yolo；其它在 --help 里找 yolo / auto / dangerously 类似字样。' },
            { q: '保存错了 / 不想要了？', a: '在「管理自定义 CLI」列表点「删除」。如果它覆盖了某个内置 CLI，删除后会自动还原内置配置。' },
            { q: '模型和档位是什么？', a: '模型：这个 CLI 用哪个模型跑（如 --model gpt-x，填进"模型参数 flag"旁的字段不填 flag 本身）；档位：思考深度（如 --effort high，填在"模型参数 flag"）。不确定就都留空，CLI 用自己的默认值。' },
          ],
          guideExample:
            '完整示例 — 接入一个叫 foo 的工具：\n标识: foo        名称: Foo 助手\n协议: JSON 事件流  传参: argv\n命令: foo\n参数模板（每行一个）:\n  -p\n  {prompt}\n→ 点「测试」变绿 → 自动保存 → 对话里说"用 foo 帮我……"',
          fieldArgs: '参数模板（每行一个；argv 传参用 {prompt} 占位）',
          fieldDelivery: '任务传参方式',
          deliveryStdin: 'stdin（推荐）',
          deliveryArgv: 'argv（-p 风格）',
          fieldModelFlag: '模型参数 flag（如 --model，可空）',
          fieldCwdFlag: '目录参数 flag（如 --dir，可空）',
          fieldTimeout: '超时毫秒',
          fieldEnv: '环境变量（每行 KEY=VALUE）',
          fieldBaseUrl: '服务地址 baseUrl',
          fieldHealthPath: '健康检查路径',
          fieldChatPath: '对话路径',
          fieldPromptField: 'prompt 字段名',
          fieldCwdField: 'cwd 字段名',
          fieldModelField: 'model 字段名',
          fieldExeGlob: '守护进程可执行文件（自动拉起用，可空）',
          commandHint: 'http-sse 协议无需命令，填下方服务地址',
          none: '暂无自定义 CLI，点上面按钮添加',
          loadError: '加载失败',
        }
      : {
          title: 'CLI Agents',
          subtitle: 'Local agent CLIs callable through cli_agent (builtin + custom)',
          sectionRuntime: 'Runtimes',
          searchPlaceholder: 'Search key / label / protocol…',
          noMatch: 'No match',
          showMissingHint: 'Also show CLIs that were not detected',
          autoSaveHint: 'Test passed — auto-saving in %ss; edit or Cancel to stop',
          overrideHint: 'Overrides the builtin "%s" config (applied on save; deleting this custom entry restores the builtin)',
          refresh: 'Refresh',
          probing: 'Probing…',
          ok: 'available',
          missing: 'not found',
          builtin: 'builtin',
          custom: 'custom',
          unverified: 'unverified',
          disabled: 'disabled',
          manageTitle: 'Manage custom CLIs',
          manageHint: 'Add, edit, enable or disable custom adapters. Same key as a builtin overrides it.',
          add: '＋ Add custom CLI',
          edit: 'Edit',
          del: 'Delete',
          delConfirm: 'Delete custom CLI "%s"?',
          enable: 'Enable',
          disable: 'Disable',
          test: 'Test',
          save: 'Save',
          cancel: 'Cancel',
          testing: 'Testing…',
          saving: 'Saving…',
          fieldName: 'Key',
          fieldLabel: 'Label',
          fieldProtocol: 'Protocol',
          fieldCommand: 'Command',
          commandPasteHint: 'Paste a full command line (with args) to auto-split',
          discardConfirm: 'Discard unsaved changes?',
          guideTitle: '📖 Guide: connect a new CLI in 3 minutes',
          guideCollapse: 'collapse',
          guideExpand: 'expand',
          guideIntro:
            'This form connects a local AI command-line tool to the panel — DeepSeek chat and the task box above can then call it. No coding required.',
          guideSteps: [
            {
              t: 'Verify the tool runs',
              d: 'Open a terminal and run its command, e.g. mycli --version. Prints a version → ready to connect. "not recognized" → install it first, or locate the full path (e.g. D:\\tools\\mycli.exe) and use that as the command in step 4.',
            },
            { t: 'Key & label', d: 'Key: a unique English id (letters first, digits and - allowed), e.g. my-cli. Label: any display name.' },
            {
              t: 'Pick the protocol (cheat sheet)',
              d: '① Claude Code or a clone of it → claude stream-json; ② a resident local service with a URL (http://127.0.0.1:port) → HTTP SSE; ③ its docs mention ACP (Agent Client Protocol) → ACP; ④ unsure → JSON events (the common default).',
            },
            {
              t: 'Command & args',
              d: 'Command: the verified name (full-line paste "mycli -p --flag" auto-splits). Args: one per line. Delivery matters: stdin (recommended) = the tool reads the task from standard input, no task in args; argv = args must contain one line {prompt}, replaced with the task text at run time.',
            },
            { t: 'Test → save', d: 'Click Test: green with a version = connected; red NOT FOUND = wrong name or not installed (see FAQ). After green, auto-saves within 10s (or click Save). Then ask DeepSeek "use my-cli to …", or pick it in the task box.' },
          ],
          guideFaqTitle: 'FAQ',
          guideFaq: [
            { q: 'Test shows NOT FOUND?', a: 'Command not found. Either use the full path as the command, add the folder to PATH, or install the tool.' },
            { q: 'No result / timeout?', a: 'Raise the timeout ms; check --help for the one-shot usage; tools needing API keys take KEY=VALUE lines in Env.' },
            { q: 'Make it run without confirmations?', a: 'Add a permission bypass flag: claude family --permission-mode bypassPermissions, gemini family --yolo, others: look for yolo/auto/dangerously in --help.' },
            { q: 'Saved wrong / want it gone?', a: 'Delete it in the management list. Deleting an entry that overrides a builtin restores the builtin.' },
            { q: 'What are model/effort?', a: 'Model: which model the CLI runs (--model gpt-x). Effort: reasoning depth (--effort high). Leave empty to use the CLI defaults.' },
          ],
          guideExample:
            'Full example — connect a tool called foo:\nKey: foo        Label: Foo helper\nProtocol: JSON events  Delivery: argv\nCommand: foo\nArgs (one per line):\n  -p\n  {prompt}\n→ Test (green) → auto-save → ask "use foo to …"',
          fieldArgs: 'Args template (one per line; {prompt} placeholder for argv delivery)',
          fieldDelivery: 'Prompt delivery',
          deliveryStdin: 'stdin (recommended)',
          deliveryArgv: 'argv (-p style)',
          fieldModelFlag: 'Model flag (e.g. --model, optional)',
          fieldCwdFlag: 'Cwd flag (e.g. --dir, optional)',
          fieldTimeout: 'Timeout ms',
          fieldEnv: 'Env (KEY=VALUE per line)',
          fieldBaseUrl: 'Base URL',
          fieldHealthPath: 'Health path',
          fieldChatPath: 'Chat path',
          fieldPromptField: 'Prompt field',
          fieldCwdField: 'Cwd field',
          fieldModelField: 'Model field',
          fieldExeGlob: 'Daemon exe (for autostart, optional)',
          commandHint: 'http-sse needs no command — fill the base URL below',
          none: 'No custom CLIs yet — add one above',
          loadError: 'Load failed',
        }

    const COLOR = {
      ok: 'var(--dsw-alias-state-success, #22c55e)',
      missing: 'var(--dsw-alias-state-danger, #f43f5e)',
      warn: 'var(--dsw-alias-state-warning, #f59e0b)',
      text: 'var(--dsw-alias-color-text-primary, inherit)',
      dim: 'var(--dsw-alias-color-text-tertiary, inherit)',
      border: 'var(--dsw-alias-color-border-subtle, rgba(127,127,127,.35))',
      accent: 'var(--dsw-alias-color-brand-default, #4f6ef7)',
      input: 'var(--dsw-alias-color-bg-input, transparent)',
    }

    const STYLE = {
      card: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 10px',
        border: '1px solid ' + COLOR.border,
        borderRadius: 8,
        marginBottom: 8,
      },
      sectionTitle: { fontWeight: 600, fontSize: 13, margin: '14px 0 8px' },
      button: {
        border: '1px solid ' + COLOR.border,
        background: 'transparent',
        color: COLOR.text,
        borderRadius: 6,
        padding: '2px 10px',
        fontSize: 12,
        cursor: 'pointer',
      },
      badge: (color) => ({
        fontSize: 10,
        padding: '1px 6px',
        borderRadius: 999,
        border: '1px solid ' + color,
        color,
        flex: '0 0 auto',
      }),
      input: {
        width: '100%',
        boxSizing: 'border-box',
        background: COLOR.input,
        color: COLOR.text,
        border: '1px solid ' + COLOR.border,
        borderRadius: 6,
        padding: '4px 8px',
        fontSize: 12,
        fontFamily: 'inherit',
      },
      label: { fontSize: 11, color: COLOR.dim, marginBottom: 2, display: 'block' },
    }

    /* ------------------------------------------------------------- api --- */

    async function api(path, method, body) {
      const res = await fetch(path, {
        method: method || 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || 'HTTP ' + res.status)
      return data
    }

    /* ------------------------------------------------------------ draft --- */

    function emptyDraft() {
      return {
        key: '',
        label: '',
        protocol: 'generic-json',
        command: '',
        argsText: '-p\n{prompt}',
        promptDelivery: 'argv',
        modelFlag: '',
        cwdFlag: '',
        timeoutMs: '180000',
        envText: '',
        baseUrl: 'http://127.0.0.1:13456',
        healthPath: '/health',
        chatPath: '/chat',
        promptField: 'message',
        cwdField: 'cwd',
        modelField: 'model',
        autostartExeGlob: '',
        enabled: true,
      }
    }

    function payloadToDraft(client) {
      const draft = emptyDraft()
      draft.key = client.key || ''
      draft.label = client.label || ''
      draft.protocol = client.protocol || 'generic-json'
      draft.command = client.command || ''
      draft.argsText = (client.args || []).join('\n')
      draft.promptDelivery = client.promptDelivery || 'stdin'
      draft.modelFlag = client.modelFlag || ''
      draft.cwdFlag = client.cwdFlag || ''
      draft.timeoutMs = String(client.timeoutMs || 180000)
      draft.envText = Object.entries(client.env || {})
        .map(([k, v]) => k + '=' + v)
        .join('\n')
      const http = client.http || {}
      draft.baseUrl = http.baseUrl || draft.baseUrl
      draft.healthPath = http.healthPath || '/health'
      draft.chatPath = http.chatPath || '/chat'
      draft.promptField = http.promptField || 'message'
      draft.cwdField = http.cwdField || 'cwd'
      draft.modelField = http.modelField || 'model'
      draft.autostartExeGlob = http.autostartExeGlob || ''
      draft.enabled = client.enabled !== false
      return draft
    }

    function draftToPayload(draft) {
      const args = draft.argsText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
      const env = {}
      for (const line of draft.envText.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const eq = trimmed.indexOf('=')
        if (eq > 0) env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
      }
      const payload = {
        key: draft.key.trim(),
        label: draft.label.trim(),
        protocol: draft.protocol,
        args,
        promptDelivery: draft.promptDelivery,
        modelFlag: draft.modelFlag.trim() || undefined,
        cwdFlag: draft.cwdFlag.trim() || undefined,
        timeoutMs: Number(draft.timeoutMs) > 0 ? Number(draft.timeoutMs) : undefined,
        env,
        enabled: draft.enabled !== false,
      }
      if (draft.protocol === 'http-sse') {
        payload.http = {
          baseUrl: draft.baseUrl.trim(),
          healthPath: draft.healthPath.trim() || '/health',
          chatPath: draft.chatPath.trim() || '/chat',
          promptField: draft.promptField.trim() || 'message',
          cwdField: draft.cwdField.trim() || 'cwd',
          modelField: draft.modelField.trim() || 'model',
          autostartExeGlob: draft.autostartExeGlob.trim() || undefined,
        }
      } else {
        payload.command = draft.command.trim()
      }
      return payload
    }

    /* ----------------------------------------------------------- pieces --- */

    function Dot({ ok }) {
      return h('span', {
        style: {
          width: 8,
          height: 8,
          borderRadius: '50%',
          flex: '0 0 auto',
          backgroundColor: ok ? COLOR.ok : COLOR.missing,
        },
      })
    }

    /** Field wrapper. `children` may be an element or a FACTORY FUNCTION —
     *  production React silently drops function children (no error, no DOM),
     *  so the wrapper must call it. Dropping this call = a form with labels
     *  and zero inputs (the "can't type" bug). */
    function Field({ label, children }) {
      return h('div', { style: { marginBottom: 8 } }, [
        h('label', { key: 'l', style: STYLE.label }, label),
        typeof children === 'function' ? children() : children,
      ])
    }

    /** Built-in beginner guide for the add form: steps + FAQ, collapsible. */
    function GuideBox({ defaultOpen }) {
      const [open, setOpen] = useState(function () {
        return defaultOpen
      })
      return h('div', { key: 'guide', style: { border: '1px dashed ' + COLOR.border, borderRadius: 8, padding: '10px 12px', marginBottom: 10, background: 'rgba(127,127,127,.06)' } }, [
        h(
          'div',
          {
            style: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none', fontWeight: 600, fontSize: 13 },
            onClick: function () {
              setOpen(function (o) {
                return !o
              })
            },
          },
          [
            h('span', { style: { color: COLOR.dim } }, open ? '▾' : '▸'),
            h('span', null, T.guideTitle),
            h('span', { style: { flex: 1 } }),
            h('span', { style: { color: COLOR.dim, fontSize: 11, fontWeight: 400 } }, open ? T.guideCollapse : T.guideExpand),
          ],
        ),
        open
          ? h('div', { style: { marginTop: 8, fontSize: 12, lineHeight: 1.7, color: COLOR.text } }, [
              h('div', { key: 'intro', style: { color: COLOR.dim, marginBottom: 8 } }, T.guideIntro),
              T.guideSteps.map(function (step, i) {
                return h('div', { key: i, style: { marginBottom: 10 } }, [
                  h('div', { style: { fontWeight: 600 } }, '第 ' + (i + 1) + ' 步 · ' + step.t),
                  h('div', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, step.d),
                ])
              }),
              h('div', { style: { fontWeight: 600, marginTop: 4, marginBottom: 6 } }, T.guideFaqTitle),
              T.guideFaq.map(function (item, i) {
                return h('div', { key: 'f' + i, style: { marginBottom: 8 } }, [
                  h('div', { style: { fontWeight: 600 } }, 'Q' + (i + 1) + '：' + item.q),
                  h('div', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, item.a),
                ])
              }),
              h('div', { style: { padding: '8px 10px', border: '1px solid ' + COLOR.border, borderRadius: 6, whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: 11 } }, T.guideExample),
            ])
          : null,
      ])
    }

    function EditorForm({ draft, setDraft, onSave, onTest, onCancel, busy, testLine, countdown, isAdd }) {
      const set = (patch) => setDraft({ ...draft, ...patch })
      const isSse = draft.protocol === 'http-sse'
      return h('div', { 'data-editor-form': '1', style: { border: '1px solid ' + COLOR.border, borderRadius: 8, padding: 12, marginBottom: 8 } }, [
        isAdd ? h(GuideBox, { key: 'guide', defaultOpen: true }) : null,
        testLine
          ? h(
              'div',
              {
                key: 'banner',
                style: {
                  marginBottom: 10,
                  padding: '6px 10px',
                  borderRadius: 6,
                  fontSize: 12,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  border: '1px solid ' + (testLine.ok ? COLOR.ok : COLOR.missing),
                  color: testLine.ok ? COLOR.ok : COLOR.missing,
                },
              },
              testLine.text,
            )
          : null,
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 } }, [
          h(Field, { key: 'k', label: T.fieldName }, () =>
            h('input', {
              style: STYLE.input,
              value: draft.key,
              onChange: (e) => set({ key: e.target.value }),
              placeholder: 'my-cli',
            }),
          ),
          h(Field, { key: 'l', label: T.fieldLabel }, () =>
            h('input', {
              style: STYLE.input,
              value: draft.label,
              onChange: (e) => set({ label: e.target.value }),
              placeholder: 'My CLI',
            }),
          ),
          h(Field, { key: 'p', label: T.fieldProtocol }, () =>
            h(
              'select',
              {
                style: STYLE.input,
                value: draft.protocol,
                onChange: (e) => set({ protocol: e.target.value }),
              },
              PROTOCOL_OPTIONS.map((p) => h('option', { key: p, value: p }, PROTOCOL_LABELS[p])),
            ),
          ),
          h(Field, { key: 'd', label: T.fieldDelivery }, () =>
            h(
              'select',
              {
                style: STYLE.input,
                value: draft.promptDelivery,
                onChange: (e) => set({ promptDelivery: e.target.value }),
              },
              [
                h('option', { key: 'stdin', value: 'stdin' }, T.deliveryStdin),
                h('option', { key: 'argv', value: 'argv' }, T.deliveryArgv),
              ],
            ),
          ),
        ]),
        isSse
          ? h('div', { style: { fontSize: 11, color: COLOR.dim, margin: '4px 0 8px' } }, T.commandHint)
          : h(Field, { label: T.fieldCommand + '（' + T.commandPasteHint + '）' }, () =>
              h('input', {
                style: STYLE.input,
                value: draft.command,
                onChange: function (e) {
                  const value = e.target.value
                  // full-line paste: "mycli -p --flag value" -> command + args rows
                  const inputType = (e.nativeEvent && e.nativeEvent.inputType) || ''
                  if (inputType === 'insertFromPaste' && /\s/.test(value.trim())) {
                    const tokens = tokenizeCommandLine(value)
                    if (tokens.length > 1) {
                      const rest = tokens.slice(1)
                      const args =
                        draft.promptDelivery === 'argv' && rest.indexOf('{prompt}') < 0
                          ? rest.concat('{prompt}')
                          : rest
                      set({ command: tokens[0], argsText: args.join('\n') })
                      return
                    }
                  }
                  set({ command: value })
                },
                placeholder: 'mycli  或  mycli -p --flag',
              }),
            ),
        !isSse
          ? h(Field, { label: T.fieldArgs }, () =>
              h('textarea', {
                style: { ...STYLE.input, minHeight: 56, resize: 'vertical' },
                value: draft.argsText,
                onChange: (e) => set({ argsText: e.target.value }),
              }),
            )
          : null,
        isSse
          ? h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 } }, [
              h(Field, { key: 'u', label: T.fieldBaseUrl }, () =>
                h('input', { style: STYLE.input, value: draft.baseUrl, onChange: (e) => set({ baseUrl: e.target.value }) }),
              ),
              h(Field, { key: 'e', label: T.fieldExeGlob }, () =>
                h('input', {
                  style: STYLE.input,
                  value: draft.autostartExeGlob,
                  onChange: (e) => set({ autostartExeGlob: e.target.value }),
                  placeholder: 'D:\\exe\\mydaemon*.exe',
                }),
              ),
              h(Field, { key: 'h', label: T.fieldHealthPath }, () =>
                h('input', { style: STYLE.input, value: draft.healthPath, onChange: (e) => set({ healthPath: e.target.value }) }),
              ),
              h(Field, { key: 'c', label: T.fieldChatPath }, () =>
                h('input', { style: STYLE.input, value: draft.chatPath, onChange: (e) => set({ chatPath: e.target.value }) }),
              ),
              h(Field, { key: 'pf', label: T.fieldPromptField }, () =>
                h('input', { style: STYLE.input, value: draft.promptField, onChange: (e) => set({ promptField: e.target.value }) }),
              ),
              h(Field, { key: 'mf', label: T.fieldModelField }, () =>
                h('input', { style: STYLE.input, value: draft.modelField, onChange: (e) => set({ modelField: e.target.value }) }),
              ),
            ])
          : h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 } }, [
              h(Field, { key: 'm', label: T.fieldModelFlag }, () =>
                h('input', {
                  style: STYLE.input,
                  value: draft.modelFlag,
                  onChange: (e) => set({ modelFlag: e.target.value }),
                  placeholder: '--model',
                }),
              ),
              h(Field, { key: 'c', label: T.fieldCwdFlag }, () =>
                h('input', {
                  style: STYLE.input,
                  value: draft.cwdFlag,
                  onChange: (e) => set({ cwdFlag: e.target.value }),
                  placeholder: '--dir',
                }),
              ),
              h(Field, { key: 't', label: T.fieldTimeout }, () =>
                h('input', {
                  style: STYLE.input,
                  value: draft.timeoutMs,
                  onChange: (e) => set({ timeoutMs: e.target.value }),
                }),
              ),
            ]),
        h(Field, { label: T.fieldEnv }, () =>
          h('textarea', {
            style: { ...STYLE.input, minHeight: 32, resize: 'vertical' },
            value: draft.envText,
            onChange: (e) => set({ envText: e.target.value }),
            placeholder: 'MY_API_KEY=sk-…',
          }),
        ),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 } }, [
          h(
            'button',
            { key: 't', style: STYLE.button, onClick: onTest, disabled: busy },
            busy && testLine && testLine.testing ? T.testing : T.test,
          ),
          h(
            'button',
            {
              key: 's',
              style: { ...STYLE.button, borderColor: COLOR.accent, color: COLOR.accent },
              onClick: onSave,
              disabled: busy,
            },
            busy && !testLine?.testing
              ? T.saving
              : countdown
                ? T.save + ' (' + countdown + 's)'
                : T.save,
          ),
          h('button', { key: 'c', style: STYLE.button, onClick: onCancel, disabled: busy }, T.cancel),
          h('div', { key: 'grow', style: { flex: 1 } }),
        ]),
        countdown
          ? h('div', { key: 'cd', style: { marginTop: 6, fontSize: 12, color: COLOR.ok } }, T.autoSaveHint.replace('%s', countdown))
          : null,
      ])
    }

    /* ------------------------------------------------------ persistence --- */

    function readFlag(key, fallback) {
      try {
        const value = window.localStorage.getItem(key)
        return value === null ? fallback : value === '1'
      } catch (error) {
        return fallback
      }
    }

    function writeFlag(key, value) {
      try {
        window.localStorage.setItem(key, value ? '1' : '0')
      } catch (error) {
        /* storage unavailable: session-only */
      }
    }

    /** Split a pasted full command line into tokens (quote-aware). */
    function tokenizeCommandLine(line) {
      const tokens = []
      const re = /"([^"]*)"|'([^']*)'|(\S+)/g
      let match
      while ((match = re.exec(String(line)))) {
        tokens.push(match[1] !== undefined ? match[1] : match[2] !== undefined ? match[2] : match[3])
      }
      return tokens
    }

    function sectionHead(open, onToggle, label, count, hint) {
      return h(
        'div',
        {
          key: 'sh-' + label,
          onClick: onToggle,
          style: {
            ...STYLE.sectionTitle,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            userSelect: 'none',
          },
          title: hint,
        },
        [
          h('span', { style: { color: COLOR.dim } }, open ? '▾' : '▸'),
          h('span', null, label + (typeof count === 'number' ? ' (' + count + ')' : '')),
        ],
      )
    }

    /* ------------------------------------------------ task section (lazy) --- */

    // The task runner (composer + live console) is its own browser module at
    // /cli-bridge/task.js — separate file, separate lifecycle, so panel-shell
    // work and task-runner work never collide in one editor. Pulled in once on
    // first mount; a load failure shows inline instead of breaking the panel.
    let taskSectionPromise = null
    let TaskSection = null

    function ensureTaskSection() {
      if (TaskSection) return Promise.resolve(true)
      if (!taskSectionPromise) {
        taskSectionPromise = import(ROUTE_TASK_JS)
          .then(function (mod) {
            TaskSection = mod.createTaskSection({
              React: React,
              zh: zh,
              COLOR: COLOR,
              STYLE: STYLE,
              Field: Field,
              sectionHead: sectionHead,
              readFlag: readFlag,
              writeFlag: writeFlag,
            })
            return true
          })
          .catch(function (error) {
            taskSectionPromise = null
            throw error
          })
      }
      return taskSectionPromise
    }

    function TaskMount({ availableRows, preset }) {
      const [state, setState] = useState(TaskSection ? 'ready' : 'loading')
      useEffect(function () {
        if (TaskSection) return
        let on = true
        ensureTaskSection().then(
          function () {
            if (on) setState('ready')
          },
          function (error) {
            if (on) setState(String((error && error.message) || error))
          },
        )
        return function () {
          on = false
        }
      }, [])
      if (state === 'ready' && TaskSection) return h(TaskSection, { availableRows: availableRows, preset: preset })
      if (state === 'loading')
        return h('div', { key: 'taskload', style: { color: COLOR.dim, fontSize: 12, margin: '6px 0' } }, zh ? '任务模块加载中…' : 'loading task runner…')
      return h(
        'div',
        { key: 'taskerr', style: { color: COLOR.missing, fontSize: 12, margin: '6px 0' } },
        (zh ? '任务模块加载失败：' : 'task module failed: ') + state,
      )
    }

    /* ------------------------------------------------------------- panel --- */

    function Panel() {
      const [probes, setProbes] = useState(null)
      const [clients, setClients] = useState(null)
      const [allAdapters, setAllAdapters] = useState([])
      const [busy, setBusy] = useState(false)
      const [listOpen, setListOpen] = useState(function () {
        return readFlag('cli-bridge:listOpen', true)
      })
      const [manageOpen, setManageOpen] = useState(function () {
        return readFlag('cli-bridge:manageOpen', true)
      })
      const [editor, setEditor] = useState(null) // {draft, editingKey, overrides?} | null
      const [formBusy, setFormBusy] = useState(false)
      const [testLine, setTestLine] = useState(null)
      const [countdown, setCountdown] = useState(null)
      const [pageError, setPageError] = useState(null)
      const [runtimeQuery, setRuntimeQuery] = useState('')
      const [manageQuery, setManageQuery] = useState('')
      const [showMissing, setShowMissing] = useState(function () {
        return readFlag('cli-bridge:showMissing', false)
      })
      const [taskPreset, setTaskPreset] = useState(null) // {key, at} from a runtime row's ▶ button
      const alive = useRef(true)
      const editorRef = useRef(null)
      const countdownRef = useRef(null)

      useEffect(function () {
        alive.current = true
        return function () {
          alive.current = false
          if (countdownRef.current) clearInterval(countdownRef.current)
        }
      }, [])

      useEffect(function () {
        editorRef.current = editor
      }, [editor])

      function stopCountdown() {
        if (countdownRef.current) {
          clearInterval(countdownRef.current)
          countdownRef.current = null
        }
        setCountdown(null)
      }

      function startCountdown(seconds) {
        stopCountdown()
        setCountdown(seconds)
        const deadline = Date.now() + seconds * 1000
        countdownRef.current = setInterval(function () {
          const remaining = Math.ceil((deadline - Date.now()) / 1000)
          if (remaining <= 0) {
            stopCountdown()
            performSave()
          } else {
            setCountdown(remaining)
          }
        }, 250)
      }

      function toggleSection(setter, key) {
        setter(function (open) {
          writeFlag(key, !open)
          return !open
        })
      }

      function toggleList() {
        const next = !listOpen
        writeFlag('cli-bridge:listOpen', next)
        setListOpen(next)
        if (!next) stopEditor()
      }

      function toggleManage() {
        const next = !manageOpen
        writeFlag('cli-bridge:manageOpen', next)
        setManageOpen(next)
        if (!next) stopEditor()
      }

      function stopEditor() {
        stopCountdown()
        setEditor(null)
        setTestLine(null)
      }

      /** Bring the freshly opened editor into view (and optionally focus its
       *  first field) — without this the form can open below the fold and
       *  look like "clicking did nothing". */
      function revealEditor(doFocus) {
        setTimeout(function () {
          try {
            const el = document.querySelector('[data-editor-form]')
            if (!el) return
            el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
            if (doFocus) {
              const first = el.querySelector('input, select, textarea')
              if (first) first.focus()
            }
          } catch (error) {
            /* scrolling is best-effort */
          }
        }, 80)
      }

      function openAddEditor() {
        if (!confirmDiscardIfDirty()) return
        setTestLine(null)
        setEditor({ draft: emptyDraft(), editingKey: null })
        revealEditor(true)
      }

      /** True when the open editor is the ADD flow (the only one with
       *  auto-save countdown). Editing an existing entry always saves
       *  explicitly — a 10s force-save on "just looking" is hostile. */
      function isAddEditor(ed) {
        return !!ed && ed.editingKey === null && ed.overrides === undefined
      }

      /** Guard for discarding an open editor: confirm when the draft differs
       *  from what it was opened with. Returns false when the user aborts. */
      function confirmDiscardIfDirty() {
        const current = editorRef.current
        if (!current || !current.initialDraftJson) return true
        try {
          if (JSON.stringify(draftToPayload(current.draft)) === current.initialDraftJson) return true
        } catch (error) {
          return true
        }
        return window.confirm(T.discardConfirm)
      }

      async function loadProbes(fresh) {
        try {
          const next = await api(ROUTE_CLIS + (fresh ? '?fresh=1' : ''))
          if (alive.current) {
            setProbes(next)
            setPageError(null)
          }
        } catch (error) {
          if (alive.current) setPageError(String((error && error.message) || error))
        }
      }

      async function loadClients() {
        try {
          const next = await api(ROUTE_CLIENTS)
          if (alive.current) setClients(next)
        } catch (error) {
          if (alive.current) setPageError(String((error && error.message) || error))
        }
      }

      async function loadAllAdapters() {
        try {
          const next = await api(ROUTE_CLIENTS + '?all=1')
          if (alive.current) setAllAdapters(next.clients || [])
        } catch (error) {
          /* prefill source only — probe rows still work without it */
        }
      }

      useEffect(function () {
        loadProbes(false)
        loadClients()
        loadAllAdapters()
        const timer = setInterval(function () {
          loadProbes(false)
        }, POLL_MS)
        return function () {
          clearInterval(timer)
        }
      }, [])

      async function refreshAll() {
        setBusy(true)
        await Promise.all([loadProbes(true), loadClients(), loadAllAdapters()])
        if (alive.current) setBusy(false)
      }

      async function mutate(action) {
        setFormBusy(true)
        try {
          await action()
          await loadClients()
          await loadAllAdapters()
          await loadProbes(true)
        } catch (error) {
          if (alive.current) setTestLine({ ok: false, text: String((error && error.message) || error) })
        } finally {
          if (alive.current) setFormBusy(false)
        }
      }

      /** Open the editor. `origin` decides WHERE it renders: 'list' anchors it
       *  inline after the clicked runtime row; 'manage' keeps it inside the
       *  management section (editing an entry you found there should not jump
       *  the page up to the runtime list). Editing never arms the auto-save
       *  countdown — that is add-flow only. */
      function editRow(row, origin) {
        const where = origin === 'manage' ? 'manage' : 'list'
        if (!confirmDiscardIfDirty()) return
        setManageOpen(true)
        writeFlag('cli-bridge:manageOpen', true)
        if (where === 'list') {
          setListOpen(true)
          writeFlag('cli-bridge:listOpen', true)
        }
        stopCountdown()
        setTestLine(null)
        let draft
        let payloadJson
        if (row.source === 'custom') {
          const stored = customList.find(function (c) {
            return c.key === row.key
          })
          draft = payloadToDraft(stored || row)
          payloadJson = JSON.stringify(draftToPayload(draft))
          setEditor({ draft: draft, editingKey: row.key, origin: where, initialDraftJson: payloadJson })
        } else {
          const builtin = allAdapters.find(function (a) {
            return a.key === row.key
          })
          draft = payloadToDraft(builtin || row)
          payloadJson = JSON.stringify(draftToPayload(draft))
          setEditor({ draft: draft, editingKey: null, overrides: row.key, origin: where, initialDraftJson: payloadJson })
        }
        // auto-test on open (status at a glance); NO auto-save countdown in
        // edit mode — explicit 保存 only.
        void runDraftTest(draft)
        revealEditor(false)
      }

      async function runDraftTest(draft) {
        setTestLine({ testing: true, text: T.testing })
        try {
          const result = await api(ROUTE_CLIENTS_TEST, 'POST', draftToPayload(draft))
          const line = {
            ok: !!result.ok,
            text: result.ok
              ? T.ok + ': ' + (result.detail || '')
              : (result.error || T.missing) + ': ' + (result.detail || ''),
          }
          setTestLine(line)
          return line
        } catch (error) {
          const line = { ok: false, text: String((error && error.message) || error) }
          setTestLine(line)
          return line
        }
      }

      function performSave() {
        mutate(async function () {
          const current = editorRef.current
          if (!current) return
          const payload = draftToPayload(current.draft)
          const result = await api(ROUTE_CLIENTS, 'POST', payload)
          if (result.ok === false) throw new Error(result.error || 'save failed')
          stopEditor()
        })
      }

      function toggleRow(row) {
        const stored = customList.find(function (c) {
          return c.key === row.key
        })
        if (!stored) return
        mutate(async function () {
          await api(ROUTE_CLIENTS, 'PUT', { ...stored, enabled: stored.enabled === false })
        })
      }

      function deleteRow(row) {
        if (!window.confirm(T.delConfirm.replace('%s', row.key))) return
        mutate(async function () {
          await api(ROUTE_CLIENTS + '?key=' + encodeURIComponent(row.key), 'DELETE')
          if (editor && editor.editingKey === row.key) setEditor(null)
        })
      }

      function renderEditor(extraStyle) {
        return h(
          'div',
          { key: 'editorWrap', style: extraStyle || null },
          [
            editor.overrides
              ? h(
                  'div',
                  { key: 'ovh', style: { color: COLOR.warn, fontSize: 12, marginBottom: 6 } },
                  T.overrideHint.replace('%s', editor.overrides),
                )
              : null,
            h(EditorForm, {
              key: 'form',
              isAdd: isAddEditor(editor),
              draft: editor.draft,
              setDraft: function (draft) {
                stopCountdown()
                setEditor({ ...editor, draft })
                setTestLine(null)
              },
              busy: formBusy,
              testLine,
              countdown,
              onTest: async function () {
                const line = await runDraftTest(editorRef.current.draft)
                // auto-save countdown is add-flow only; editing saves explicitly
                if (line.ok && isAddEditor(editorRef.current)) startCountdown(10)
              },
              onSave: function () {
                stopCountdown()
                performSave()
              },
              onCancel: function () {
                if (!confirmDiscardIfDirty()) return
                stopEditor()
              },
            }),
          ],
        )
      }

      const probeRows = (probes && probes.clients) || []
      const customList = (clients && clients.clients) || []
      const warnings = (clients && clients.warnings) || []
      const runtimeQueryLower = runtimeQuery.trim().toLowerCase()
      const visibleRows = probeRows.filter(function (row) {
        if (!showMissing && !row.ok) return false
        if (!runtimeQueryLower) return true
        const haystack = (row.key + ' ' + (row.label || '') + ' ' + (PROTOCOL_LABELS[row.protocol] || row.protocol)).toLowerCase()
        return haystack.indexOf(runtimeQueryLower) >= 0
      })
      const missingCount = probeRows.filter(function (row) {
        return !row.ok
      }).length
      const availableRows = probeRows.filter(function (row) {
        return row.ok && row.enabled !== false
      })
      const editorAnchorKey =
        editor && editor.origin !== 'manage' ? editor.editingKey || editor.overrides || null : null
      const manageQueryLower = manageQuery.trim().toLowerCase()
      const visibleCustom = customList.filter(function (c) {
        if (!manageQueryLower) return true
        const haystack = (c.key + ' ' + (c.label || '') + ' ' + (PROTOCOL_LABELS[c.protocol] || c.protocol)).toLowerCase()
        return haystack.indexOf(manageQueryLower) >= 0
      })

      // Full-height column with an internal scroll body: the sidebar host does
      // not scroll for us, and 30+ rows (plus management) overflow otherwise.
      // maxHeight guards the case where the host container has no fixed height.
      return h(
        'div',
        {
          style: {
            padding: '16px',
            color: COLOR.text,
            fontSize: 13,
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            boxSizing: 'border-box',
          },
        },
        [
        h('div', { key: 'head', style: { display: 'flex', alignItems: 'baseline', gap: 8, flex: '0 0 auto' } }, [
          h('div', { key: 't', style: { fontWeight: 600, fontSize: 15 } }, T.title),
          h('div', { key: 'grow', style: { flex: 1 } }),
          h(
            'button',
            { key: 'r', style: STYLE.button, onClick: refreshAll, disabled: busy },
            busy ? T.probing : T.refresh,
          ),
        ]),
        h('div', { key: 'sub', style: { color: COLOR.dim, margin: '4px 0 12px', flex: '0 0 auto' } }, T.subtitle),

        h(
          'div',
          {
            key: 'body',
            style: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', maxHeight: 'calc(100vh - 150px)', paddingRight: 2 },
          },
          [
        pageError
          ? h('div', { key: 'err', style: { color: COLOR.missing, marginBottom: 8 } }, T.loadError + ': ' + pageError)
          : null,

        sectionHead(listOpen, toggleList, T.sectionRuntime, visibleRows.length),
        listOpen
          ? h('div', { key: 'listWrap' }, [
              h('div', { key: 'toolbar', style: { display: 'flex', gap: 8, marginBottom: 8 } }, [
                h('input', {
                  key: 'q',
                  style: { ...STYLE.input, flex: 1 },
                  value: runtimeQuery,
                  onChange: function (e) {
                    setRuntimeQuery(e.target.value)
                  },
                  placeholder: T.searchPlaceholder,
                }),
                h(
                  'button',
                  {
                    key: 'sm',
                    style: { ...STYLE.button, flex: '0 0 auto', color: showMissing ? COLOR.accent : COLOR.dim },
                    title: T.showMissingHint,
                    onClick: function () {
                      const next = !showMissing
                      writeFlag('cli-bridge:showMissing', next)
                      setShowMissing(next)
                    },
                  },
                  T.missing + ' (' + missingCount + ')',
                ),
              ]),
              visibleRows.length === 0
                ? h('div', { key: 'nomatch', style: { color: COLOR.dim, fontSize: 12 } }, T.noMatch)
                : h(
                    'div',
                    { key: 'list' },
                    visibleRows.map(function (row) {
                      const rowEl = h(
                        'div',
                        { key: row.key, 'data-runtime-key': row.key, style: { ...STYLE.card, opacity: row.enabled ? 1 : 0.6 }, title: row.detail },
                        [
                          h(Dot, { key: 'dot', ok: row.ok }),
                          h('span', { key: 'key', style: { fontWeight: 600, minWidth: 84 } }, row.key),
                          h('span', { key: 'label', style: { color: COLOR.dim } }, row.label),
                          h('span', { key: 'grow', style: { flex: 1 } }),
                          h('span', { key: 'b1', style: STYLE.badge(COLOR.accent) }, row.source === 'custom' ? T.custom : T.builtin),
                          h('span', { key: 'b2', style: STYLE.badge(COLOR.dim) }, PROTOCOL_LABELS[row.protocol] || row.protocol),
                          row.verified === false ? h('span', { key: 'b3', style: STYLE.badge(COLOR.warn) }, T.unverified) : null,
                          row.enabled === false ? h('span', { key: 'b4', style: STYLE.badge(COLOR.warn) }, T.disabled) : null,
                          h(
                            'span',
                            { key: 'status', style: { color: row.ok ? COLOR.ok : COLOR.missing, fontSize: 12, flex: '0 0 auto' } },
                            row.ok ? T.ok : T.missing,
                          ),
                          row.ok && row.enabled !== false
                            ? h('button', {
                                key: 'run',
                                style: { ...STYLE.button, color: COLOR.ok },
                                title: zh ? '用此 CLI 发起任务' : 'Run a task with this CLI',
                                onClick: function () {
                                  setTaskPreset({ key: row.key, at: Date.now() })
                                },
                              }, '▶')
                            : null,
                          row.source === 'custom'
                            ? h(
                                'button',
                                { key: 'tg', style: STYLE.button, onClick: function () { toggleRow(row) } },
                                (function () {
                                  const stored = customList.find(function (c) { return c.key === row.key })
                                  return stored && stored.enabled === false ? T.enable : T.disable
                                })(),
                              )
                            : null,
                          h('button', { key: 'ed', style: STYLE.button, onClick: function () { editRow(row, 'list') } }, T.edit),
                          row.source === 'custom'
                            ? h(
                                'button',
                                { key: 'del', style: { ...STYLE.button, color: COLOR.missing }, onClick: function () { deleteRow(row) } },
                                T.del,
                              )
                            : null,
                        ],
                      )
                      const editorEl = editorAnchorKey === row.key ? renderEditor({ marginBottom: 8 }) : null
                      return [rowEl, editorEl]
                    }),
                  ),
            ])
          : null,

        h(TaskMount, { key: 'task', availableRows: availableRows, preset: taskPreset }),

        sectionHead(manageOpen, toggleManage, T.manageTitle, customList.length, T.manageHint),
        manageOpen
          ? h('div', { key: 'mbody' }, [
              h('div', { key: 'mhint', style: { color: COLOR.dim, fontSize: 12, marginBottom: 8 } }, T.manageHint),
              h('div', { key: 'mtoolbar', style: { marginBottom: 8 } }, [
                h('input', {
                  key: 'mq',
                  style: STYLE.input,
                  value: manageQuery,
                  onChange: function (e) {
                    setManageQuery(e.target.value)
                  },
                  placeholder: T.searchPlaceholder,
                }),
              ]),
              editor === null
                ? h(
                    'button',
                    {
                      key: 'add',
                      style: { ...STYLE.button, borderColor: COLOR.accent, color: COLOR.accent, marginBottom: 8 },
                      onClick: function () {
                        openAddEditor()
                      },
                    },
                    T.add,
                  )
                : editor.origin === 'manage' || (editor.editingKey === null && editor.overrides === undefined)
                  ? renderEditor()
                  : null,

              visibleCustom.length === 0
                ? h('div', { key: 'none', style: { color: COLOR.dim, fontSize: 12 } }, customList.length === 0 ? T.none : T.noMatch)
                : h(
                    'div',
                    { key: 'customs' },
                    visibleCustom.map(function (client) {
                      return h('div', { key: client.key, 'data-cli-key': client.key, style: { ...STYLE.card, opacity: client.enabled === false ? 0.6 : 1 } }, [
                        h('span', { key: 'key', style: { fontWeight: 600, minWidth: 84 } }, client.key),
                        h('span', { key: 'label', style: { color: COLOR.dim } }, client.label),
                        h('span', { key: 'grow', style: { flex: 1 } }),
                        h('span', { key: 'b2', style: STYLE.badge(COLOR.dim) }, PROTOCOL_LABELS[client.protocol] || client.protocol),
                        client.overrides ? h('span', { key: 'ov', style: STYLE.badge(COLOR.warn) }, '⇦ ' + T.builtin) : null,
                        h(
                          'button',
                          {
                            key: 'tg',
                            style: STYLE.button,
                            onClick: function () {
                              mutate(async function () {
                                await api(ROUTE_CLIENTS, 'PUT', { ...client, enabled: client.enabled === false })
                              })
                            },
                          },
                          client.enabled === false ? T.enable : T.disable,
                        ),
                        h(
                          'button',
                          {
                            key: 'ed',
                            style: STYLE.button,
                            onClick: function () {
                              editRow(client, 'manage')
                            },
                          },
                          T.edit,
                        ),
                        h(
                          'button',
                          {
                            key: 'del',
                            style: { ...STYLE.button, color: COLOR.missing },
                            onClick: function () {
                              deleteRow(client)
                            },
                          },
                          T.del,
                        ),
                      ])
                    }),
                  ),

              warnings.length > 0
                ? h(
                    'div',
                    { key: 'warn', style: { color: COLOR.warn, fontSize: 12, marginTop: 8, whiteSpace: 'pre-wrap' } },
                    warnings.join('\n'),
                  )
                : null,
            ])
          : null,
        ]),
      ])
    }

    function Icon(owner) {
      const size = (owner && owner.size) || 16
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
        },
        h('path', {
          d: 'M2.5 3.5h11v9h-11z',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          rx: 1,
        }),
        h('path', {
          d: 'M4.5 6.5l1.8 1.5-1.8 1.5M8 10h3',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Capability-gated registration (same pattern as dsh-pending-review-glow):
        // slots.inject fires when the host actually provides the slot, and the
        // returned register-disposer scopes the contribution to that moment.
        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register(
            { name: 'main', key: PANEL_ID, order: 60 },
            function () {
              return h(Panel)
            },
          )
        })
        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 60,
              label: function () {
                return T.title
              },
            },
            function (owner) {
              return h(Icon, owner || {})
            },
          )
        })
      },
    }
  },
})
