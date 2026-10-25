# UI 浏览器实测环境

用宿主同款 React 18 UMD 挂载真实的 `client/client.js`，在真浏览器里验证面板交互（节点 数量/输入/保存链路/截图）。

## 用法

```bash
# 一次性：安装 react（仅测试用，不会被打进插件包）
cd test/ui-harness && npm init -y && npm i react@18.3.1 react-dom@18.3.1
# 启动（server.js 会把 ../.. 当插件根、../node_modules 当 react 来源；PORT 环境变量可换端口，默认 8791）
node server.js
# 浏览器打开 http://127.0.0.1:8791/host.html
```

server.js 对 `/cli-bridge/*` 路由返回桩数据（4 条 CLI、空自定义、测试/保存回显 ok，外加 **board-stub.js 内存看板**：入队→运行→完成的完整推演 + /tasks/stream SSE），console 会打印收到的 SAVE/TEST/RUN/TASK CREATE/ACTION payload。

## 它抓住过的 bug

- **生产 React 静默丢弃函数 children**：`h(Field, {...}, () => h('input'))` 的表单渲染出全部标签但 0 个 input（用户"无法点击输入"）。修复：Field 内部调用函数 children。**教训：h() 树里组件的函数 children 必须由组件自己调用；UI 自检要数 DOM 元素（input 数量），只看文字渲染正常是不够的。**

- **展开丢卡片行 / 归档双份渲染**（v0.7.0）：展开分支只返回详情导致行消失；归档开关让归档卡片同时在状态组和归档组。修复：展开返回 `[card, detail]`、分组按互斥谓词推导。**教训："点 X 展开 Y" 必须断言 X 还在；分组渲染输入数组必须互斥。**
- **harness 自动化用 `evaluate(el => el.click())`**：Playwright 真实 click 与 React 每秒重渲染竞争会 3s 超时（元素可见、count 正常也超），DOM 直点秒过且等价真实点击。
