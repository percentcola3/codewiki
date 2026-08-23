// codewiki preview — 渲染 HTML 站点并启动本地服务器，自动打开浏览器。
import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { renderSite } from './site.mjs'

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
}

function openBrowser(url) {
  const platform = process.platform
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try { execFile(command, args, () => {}) } catch { /* 无图形环境时忽略 */ }
}

export async function runPreview(options = {}) {
  const projectRoot = resolve(options.projectRoot || process.cwd())
  let site
  try {
    site = renderSite(projectRoot, { module: options.module })
  } catch (error) {
    process.stderr.write(`[codewiki] ${error.message}\n`)
    return 1
  }
  const siteDir = join(projectRoot, '.codewiki', 'site')
  const port = options.port == null ? 4173 : Number(options.port)

  const server = createServer((request, response) => {
    const urlPath = decodeURIComponent((request.url || '/').split('?')[0])
    let filePath = join(siteDir, urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, ''))
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      filePath = join(siteDir, 'index.html')
    }
    response.setHeader('Content-Type', CONTENT_TYPES[extname(filePath)] || 'application/octet-stream')
    response.setHeader('Cache-Control', 'no-store')
    createReadStream(filePath).on('error', () => {
      response.statusCode = 404
      response.end('not found')
    }).pipe(response)
  })

  await new Promise(done => server.listen(port, '127.0.0.1', done))
  const url = `http://127.0.0.1:${server.address().port}/`
  process.stdout.write(`[codewiki] 知识库站点已启动：${url}\n`)
  process.stdout.write(`[codewiki] ${site.modules.length} 个模块：${site.modules.map(m => `${m.name}(${m.docs} 篇/${m.grade})`).join('、')}\n`)
  process.stdout.write('[codewiki] Ctrl+C 停止\n')
  if (options.noOpen !== true) openBrowser(url)

  await new Promise(() => {}) // 服务直至进程被终止
  return 0
}
