import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'

const root = join(import.meta.dirname, '..')
const bin = join(root, 'bin', 'codewiki.js')

function runCli(args, cwd) {
  return execFileSync(process.execPath, [bin, ...args], { encoding: 'utf8', cwd, timeout: 60000 })
}

function scaffold() {
  // 一个最小可检索的知识库模块
  const projectDir = mkdtempSync(join(tmpdir(), 'codewiki-flow-'))
  const moduleDir = join(projectDir, '.codewiki', 'modules', 'orders')
  return { projectDir, moduleDir }
}

function writeModuleFiles({ projectDir, moduleDir }) {
  const navDir = join(moduleDir, 'navigation')
  mkdirSync(join(moduleDir, 'product'), { recursive: true })
  mkdirSync(navDir, { recursive: true })
  writeFileSync(join(moduleDir, 'manifest.yml'), 'version: "3.6"\nmodule: orders\ntarget_dirs: [src]\n')
  writeFileSync(join(moduleDir, 'product', '01-订单导出-flow.md'), [
    '---',
    'id: kb:orders:product:export',
    'kind: business',
    'title: 订单导出',
    'aliases: [导出按钮]',
    'questions:',
    '  - 导出按钮怎么实现？',
    'entities: [订单]',
    '---',
    '',
    '# 订单导出',
    '',
    '点击导出按钮触发批量导出，见 src/views/order/list.vue:12。',
    '',
    '| 字段 | 来源 |',
    '| --- | --- |',
    '| orderNo | /api/orders |',
  ].join('\n'))
  writeFileSync(join(navDir, 'file-graph.json'), JSON.stringify({
    data: { nodes: [{ id: 'src/views/order/list.vue' }], edges: [] },
  }))
  writeFileSync(join(navDir, 'validation-report.json'), JSON.stringify({
    status: 'PASS',
    per_file_confidence: [{ doc: 'a.md', ratio: 0.9, confidence_v2: { overall_confidence: { score: 0.9, grade: 'A', policy: 'kb-confidence-v2' } } }],
  }))
  return { projectDir, moduleDir }
}

test('codewiki init installs commands, MCP config and workflow docs', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'codewiki-init-'))
  try {
    runCli(['init'], projectDir)
    for (const file of ['.claude/commands/wiki-scan.md', '.claude/commands/wiki-explore.md', '.codewiki/workflow/agent-workflow.md', '.codewiki/workflow/references/output-schema.md']) {
      assert.ok(existsSync(join(projectDir, file)), `missing ${file}`)
    }
    const mcp = JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf8'))
    assert.ok(mcp.mcpServers.codewiki.command.length > 0)
    assert.ok(mcp.mcpServers.codewiki.args.some(arg => String(arg).endsWith('codewiki.js')))
    assert.match(readFileSync(join(projectDir, '.gitignore'), 'utf8'), /\.codewiki\/?/)
    // 指令内容引用本地 CLI 与工作流文档
    const scanCommand = readFileSync(join(projectDir, '.claude', 'commands', 'wiki-scan.md'), 'utf8')
    assert.match(scanCommand, /codewiki scan/)
    assert.match(scanCommand, /\.codewiki\/workflow\/agent-workflow\.md/)
    const exploreCommand = readFileSync(join(projectDir, '.claude', 'commands', 'wiki-explore.md'), 'utf8')
    assert.match(exploreCommand, /codewiki feedback record/)
    assert.match(exploreCommand, /codewiki case add/)
    // 幂等
    runCli(['init'], projectDir)
    assert.ok(existsSync(join(projectDir, '.claude', 'commands', 'wiki-scan.md')))
  } finally {
    rmSync(projectDir, { recursive: true, force: true })
  }
})

test('feedback record + case add feed overlay into retrieval and confidence', () => {
  const { projectDir, moduleDir } = scaffold()
  try {
    writeModuleFiles({ projectDir, moduleDir })
    runCli(['index'], projectDir)

    // 差评记录
    runCli(['feedback', 'record', '--rating', 'bad', '--query', '退款什么情况下允许', '--module', 'orders', '--comment', '没答到点子上'], projectDir)
    const feedback = readFileSync(join(projectDir, '.codewiki', 'feedback.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(feedback[0].rating, 'bad')
    assert.equal(feedback[0].module, 'orders')

    // 增补用户确认的知识 → overlay
    runCli(['case', 'add', '--module', 'orders', '--title', '退款条件', '--question', '什么情况下允许退款？',
      '--answer', '订单为已支付且未发货状态时允许退款，见 src/views/order/refund.vue:42。',
      '--evidence', 'src/views/order/refund.vue:42'], projectDir)
    const overlayPath = join(projectDir, '.codewiki', 'knowledge-overlay', 'orders.jsonl')
    const overlay = readFileSync(overlayPath, 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(overlay.length, 1)
    assert.equal(overlay[0].source, 'user')
    assert.equal(overlay[0].verified, true)
    assert.match(overlay[0].id, /^kb-case:orders:/)

    // overlay 立即可检索（index 后）
    runCli(['index'], projectDir)
    const queryOutput = runCli(['query', '退款', '--json'], projectDir)
    const result = JSON.parse(queryOutput)
    assert.ok(result.modules.some(m => m.topics.some(t => t.id === overlay[0].id)), 'overlay case not retrievable')

    // confidence：user case 计入场景覆盖，差评构成 Gap
    const confidence = JSON.parse(runCli(['confidence', '--json'], projectDir))
    const module = confidence.modules[0]
    assert.ok(module.scenario_coverage.applicable >= 1)
    assert.ok(module.retrieval_usage.rated_count >= 1)
    assert.ok(module.retrieval_usage.top_bad_rated_queries.some(q => q.query.includes('退款')))
    assert.ok(module.gap_closure.discovered >= 1)
  } finally {
    rmSync(projectDir, { recursive: true, force: true })
  }
})

test('site renders interactive HTML pages', () => {
  const { projectDir, moduleDir } = scaffold()
  try {
    writeModuleFiles({ projectDir, moduleDir })
    runCli(['site'], projectDir)
    const siteDir = join(projectDir, '.codewiki', 'site')
    for (const file of ['index.html', 'orders.html', 'site-data.json']) {
      assert.ok(existsSync(join(siteDir, file)), `missing ${file}`)
    }
    const indexHtml = readFileSync(join(siteDir, 'index.html'), 'utf8')
    assert.match(indexHtml, /订单导出/)
    assert.match(indexHtml, /badge/) // 评级徽章
    const moduleHtml = readFileSync(join(siteDir, 'orders.html'), 'utf8')
    assert.match(moduleHtml, /<table>/) // markdown 表格已渲染
    assert.match(moduleHtml, /class="ev"/) // 证据 chip 高亮
    assert.match(moduleHtml, /globalSearch|filterDocs/) // 交互脚本
    const searchData = JSON.parse(readFileSync(join(siteDir, 'site-data.json'), 'utf8'))
    assert.ok(searchData.some(item => item.title === '订单导出' && item.aliases.includes('导出按钮')))
  } finally {
    rmSync(projectDir, { recursive: true, force: true })
  }
})

test('preview serves the site over HTTP', { timeout: 30000 }, async () => {
  const { projectDir, moduleDir } = scaffold()
  const server = spawn(process.execPath, [bin, 'preview', '--port', '0', '--no-open'], {
    cwd: projectDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    writeModuleFiles({ projectDir, moduleDir })
    // --port 0 时从 stdout 解析实际端口；失败则回退默认端口
    const port = await new Promise(resolve => {
      const onData = chunk => {
        const match = String(chunk).match(/http:\/\/127\.0\.0\.1:(\d+)/)
        if (match) { server.stdout.off('data', onData); resolve(Number(match[1])) }
      }
      server.stdout.on('data', onData)
      server.stderr.on('data', onData)
      setTimeout(() => resolve(4173), 5000)
    })
    const response = await fetch(`http://127.0.0.1:${port}/`)
    assert.equal(response.status, 200)
    const html = await response.text()
    assert.match(html, /codewiki/)
    const data = await (await fetch(`http://127.0.0.1:${port}/site-data.json`)).json()
    assert.ok(Array.isArray(data))
  } finally {
    server.kill('SIGTERM')
    rmSync(projectDir, { recursive: true, force: true })
  }
})
