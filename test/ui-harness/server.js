/**
 * Test harness server: serves the real plugin client.js + react UMD builds,
 * and stubs the host webServer routes with canned JSON.
 *   node server.js  (port 8791)
 */
const http = require('http')
const fs = require('fs')
const path = require('path')

const PLUGIN_DIR = path.resolve(__dirname, '..', '..')
const NODE_MODULES = path.resolve(__dirname, 'node_modules') // react UMD per README installs here
const UI_DIR = __dirname

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

function sendJson(res, body) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const p = url.pathname
  console.log(req.method, p)

  if (p === '/cli-bridge/clis') {
    return sendJson(res, {
      at: Date.now(),
      clients: [
        { key: 'atomcode', label: 'AtomCode', ok: true, detail: 'daemon up', source: 'builtin', protocol: 'http-sse', verified: true, enabled: true },
        { key: 'claude', label: 'Claude Code', ok: true, detail: '2.1.259', source: 'builtin', protocol: 'claude-json', verified: true, enabled: true },
        { key: 'codex', label: 'Codex CLI', ok: true, detail: '0.153.0', source: 'builtin', protocol: 'generic-json', verified: true, enabled: true },
        { key: 'kimi', label: 'Kimi CLI', ok: false, detail: 'NOT FOUND', source: 'builtin', protocol: 'acp', verified: false, enabled: true },
      ],
    })
  }
  if (p === '/cli-bridge/clients' && req.method === 'GET' && url.searchParams.get('all') === '1') {
    return sendJson(res, { clients: [{ key: 'claude', label: 'Claude Code', protocol: 'claude-json', command: 'claude', args: ['-p', '--output-format', 'stream-json', '--verbose'], promptDelivery: 'stdin', timeoutMs: 180000, env: {} }], warnings: [] })
  }
  if (p === '/cli-bridge/clients' && req.method === 'GET') {
    return sendJson(res, { clients: [{ key: 'echo-route', label: 'Echo Route', protocol: 'generic-json', command: 'node', args: ['-e', 'console.log(JSON.stringify({type:"result",result:"ok"}))'], promptDelivery: 'stdin', timeoutMs: 15000, env: {}, enabled: true }], warnings: [] })
  }
  if (p === '/cli-bridge/clients/test') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      console.log('TEST payload:', body)
      return sendJson(res, { ok: true, detail: '2.1.259 (mock)' })
    })
    return
  }
  if (p === '/cli-bridge/clients' && (req.method === 'POST' || req.method === 'PUT')) {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      console.log('SAVE payload:', body)
      return sendJson(res, { ok: true, client: JSON.parse(body) })
    })
    return
  }

  if (p === '/cli-bridge/task.js') {
    const file = path.join(PLUGIN_DIR, 'client', 'task.js')
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
    return fs.createReadStream(file).pipe(res)
  }

  // ---- board stubs: an in-memory task manager good enough to click through -- //
  if (p.startsWith('/cli-bridge/tasks')) {
    const board = require('./board-stub.js')
    if (p === '/cli-bridge/tasks/stream' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' })
      const send = (obj) => {
        try { res.write(`data: ${JSON.stringify(obj)}\n\n`) } catch {}
      }
      send({ type: 'snapshot', ...board.snapshot() })
      const unsubscribe = board.subscribe(send)
      const ping = setInterval(() => {
        try { res.write(': ping\n\n') } catch {}
      }, 20_000)
      req.on('close', () => {
        clearInterval(ping)
        unsubscribe()
      })
      return
    }
    if (p === '/cli-bridge/tasks/action' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        console.log('ACTION payload:', body)
        return sendJson(res, board.action(JSON.parse(body || '{}')))
      })
      return
    }
    if (p === '/cli-bridge/tasks' && req.method === 'GET') return sendJson(res, board.snapshot())
    if (p === '/cli-bridge/tasks' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        console.log('TASK CREATE payload:', body)
        try {
          return sendJson(res, { task: board.create(JSON.parse(body || '{}')) })
        } catch (error) {
          return sendJson(res, { error: String(error.message || error) })
        }
      })
      return
    }
    if (p === '/cli-bridge/tasks' && req.method === 'PUT') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        console.log('SETTINGS payload:', body)
        return sendJson(res, board.settings(JSON.parse(body || '{}')))
      })
      return
    }
  }

  if (p === '/cli-bridge/run' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      console.log('RUN payload:', body)
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' })
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
      send({ type: 'start', cli: 'claude', protocol: 'claude-json' })
      let i = 0
      const timer = setInterval(() => {
        i += 1
        if (i <= 5) send({ type: 'text', delta: `chunk ${i} — ` })
        else {
          clearInterval(timer)
          send({ type: 'done', text: 'chunk 1 — chunk 2 — chunk 3 — chunk 4 — chunk 5 — (mock done)', meta: { durationMs: 5300, model: 'mock-model', toolCalls: 2, sessionId: 'mock-run-1' } })
          res.end()
        }
      }, 300)
      res.on('close', () => clearInterval(timer))
    })
    return
  }

  // static files
  let base, rel
  if (p.startsWith('/node_modules/')) {
    base = NODE_MODULES
    rel = p.slice('/node_modules/'.length)
  } else if (p.startsWith('/client/')) {
    base = PLUGIN_DIR
    rel = p.slice(1)
  } else {
    base = UI_DIR
    rel = p === '/' ? 'host.html' : p.slice(1)
  }
  const file = path.resolve(base, rel)
  if (!(file === base || file.startsWith(base + path.sep)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404)
    return res.end('not found: ' + file)
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
})

server.listen(Number(process.env.PORT) || 8791, '127.0.0.1', () =>
  console.log('harness at http://127.0.0.1:' + (Number(process.env.PORT) || 8791) + '/host.html'),
)
