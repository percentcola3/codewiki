import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { renderSite } from '../src/site.mjs'

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

test('codewiki init installs Skill-first integrations and workflow docs', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'codewiki-init-'))
  try {
    mkdirSync(join(projectDir, '.codex'), { recursive: true })
    writeFileSync(join(projectDir, '.codex', 'config.toml'), '[features]\nexample = true\n')
    const output = runCli(['init'], projectDir)
    for (const file of [
      '.claude/skills/codewiki-generate/SKILL.md',
      '.claude/skills/codewiki-query/SKILL.md',
      '.claude/skills/codewiki-review/SKILL.md',
      '.agents/skills/codewiki-generate/SKILL.md',
      '.agents/skills/codewiki-query/SKILL.md',
      '.agents/skills/codewiki-review/SKILL.md',
      '.claude/settings.local.json',
      '.codex/rules/codewiki.rules',
      '.codewiki/workflow/agent-workflow.md',
      '.codewiki/workflow/references/output-schema.md',
      'codewiki.yml',
    ]) {
      assert.ok(existsSync(join(projectDir, file)), `missing ${file}`)
    }
    const mcp = JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf8'))
    assert.deepEqual(mcp.mcpServers.codewiki, { command: 'npx', args: ['-y', 'codewiki', 'mcp'] })
    const codexConfig = readFileSync(join(projectDir, '.codex', 'config.toml'), 'utf8')
    assert.match(codexConfig, /\[features]/)
    assert.match(codexConfig, /\[mcp_servers\.codewiki]/)
    assert.match(codexConfig, /command = "npx"/)
    assert.match(codexConfig, /args = \["-y", "codewiki", "mcp"\]/)
    const claudeSettings = JSON.parse(readFileSync(join(projectDir, '.claude', 'settings.local.json'), 'utf8'))
    assert.ok(claudeSettings.permissions.allow.includes('Read(./**)'))
    assert.ok(claudeSettings.permissions.allow.includes('Edit(./.codewiki/modules/**)'))
    assert.ok(claudeSettings.permissions.allow.includes('Bash(npx codewiki generate *)'))
    assert.ok(claudeSettings.permissions.allow.includes('mcp__codewiki__codewiki_explore'))
    assert.ok(claudeSettings.enabledMcpjsonServers.includes('codewiki'))
    const codexRules = readFileSync(join(projectDir, '.codex', 'rules', 'codewiki.rules'), 'utf8')
    assert.match(codexRules, /pattern = \["npx", "codewiki", \["generate", "query", "preview", "confidence"\]\]/)
    assert.doesNotMatch(codexRules, /approval_policy|decision = "never"/)
    assert.match(output, /知识检索通过 codewiki MCP 完成/)
    assert.match(output, /为 <模块> 生成知识库/)
    assert.match(readFileSync(join(projectDir, 'codewiki.yml'), 'utf8'), /knowledge_root: \.codewiki\/modules/)
    const gitignore = readFileSync(join(projectDir, '.gitignore'), 'utf8')
    assert.doesNotMatch(gitignore, /^\.codewiki\/?$/m)
    assert.match(gitignore, /^\.codewiki\/cache\/$/m)
    assert.match(gitignore, /^\.codewiki\/retrieval\.jsonl$/m)
    assert.match(gitignore, /^\*\*\/\.claude\/settings\.local\.json$/m)
    const generateSkill = readFileSync(join(projectDir, '.claude', 'skills', 'codewiki-generate', 'SKILL.md'), 'utf8')
    assert.match(generateSkill, /codewiki generate/)
    assert.match(generateSkill, /--finalize/)
    const querySkill = readFileSync(join(projectDir, '.claude', 'skills', 'codewiki-query', 'SKILL.md'), 'utf8')
    assert.match(querySkill, /codewiki query --feedback/)
    assert.match(querySkill, /codewiki_explore/)
    assert.match(querySkill, /Retrieval must use the project codewiki MCP server/)
    const reviewSkill = readFileSync(join(projectDir, '.claude', 'skills', 'codewiki-review', 'SKILL.md'), 'utf8')
    assert.match(reviewSkill, /codewiki preview --export/)
    assert.match(reviewSkill, /codewiki confidence/)
    // 幂等
    runCli(['init'], projectDir)
    assert.ok(existsSync(join(projectDir, '.claude', 'skills', 'codewiki-generate', 'SKILL.md')))
    const afterSecondInit = readFileSync(join(projectDir, '.codex', 'config.toml'), 'utf8')
    assert.equal((afterSecondInit.match(/\[mcp_servers\.codewiki]/g) || []).length, 1)
  } finally {
    rmSync(projectDir, { recursive: true, force: true })
  }
})

test('codewiki init enables MCP by default and preserves unrelated MCP servers', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'codewiki-init-mcp-'))
  try {
    writeFileSync(join(projectDir, '.mcp.json'), `${JSON.stringify({ mcpServers: { existing: { command: 'existing-server' } } }, null, 2)}\n`)
    mkdirSync(join(projectDir, '.claude'), { recursive: true })
    writeFileSync(join(projectDir, '.claude', 'settings.local.json'), `${JSON.stringify({
      permissions: { allow: ['Bash(npm test *)'], deny: ['Read(./.env)'] },
      enabledMcpjsonServers: ['existing'],
    }, null, 2)}\n`)
    runCli(['init'], projectDir)
    const mcp = JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf8'))
    assert.deepEqual(mcp.mcpServers.existing, { command: 'existing-server' })
    assert.deepEqual(mcp.mcpServers.codewiki, { command: 'npx', args: ['-y', 'codewiki', 'mcp'] })
    assert.match(readFileSync(join(projectDir, '.codex', 'config.toml'), 'utf8'), /\[mcp_servers\.codewiki]/)
    const settings = JSON.parse(readFileSync(join(projectDir, '.claude', 'settings.local.json'), 'utf8'))
    assert.ok(settings.permissions.allow.includes('Bash(npm test *)'))
    assert.deepEqual(settings.permissions.deny, ['Read(./.env)'])
    assert.deepEqual(settings.enabledMcpjsonServers, ['existing', 'codewiki'])

    runCli(['init'], projectDir)
    assert.deepEqual(JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf8')).mcpServers.codewiki, { command: 'npx', args: ['-y', 'codewiki', 'mcp'] })
    assert.equal((readFileSync(join(projectDir, '.codex', 'config.toml'), 'utf8').match(/\[mcp_servers\.codewiki]/g) || []).length, 1)
  } finally {
    rmSync(projectDir, { recursive: true, force: true })
  }
})

test('codewiki upgrade refreshes integrations without overwriting team knowledge', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'codewiki-upgrade-'))
  try {
    runCli(['init'], projectDir)
    const instructionsPath = join(projectDir, '.codewiki', 'INSTRUCTIONS.md')
    const modulePath = join(projectDir, '.codewiki', 'modules', 'orders', 'product', 'orders.md')
    writeFileSync(instructionsPath, '# 团队说明\n', 'utf8')
    mkdirSync(join(modulePath, '..'), { recursive: true })
    writeFileSync(modulePath, '# 订单知识\n', 'utf8')
    writeFileSync(join(projectDir, '.claude', 'skills', 'codewiki-query', 'SKILL.md'), 'old skill\n', 'utf8')
    mkdirSync(join(projectDir, '.claude', 'commands'), { recursive: true })
    writeFileSync(join(projectDir, '.claude', 'commands', 'wiki-scan.md'), 'legacy command\n', 'utf8')

    const output = runCli(['upgrade'], projectDir)
    assert.match(output, /升级完成/)
    assert.match(readFileSync(join(projectDir, '.claude', 'skills', 'codewiki-query', 'SKILL.md'), 'utf8'), /name: codewiki-query/)
    assert.equal(existsSync(join(projectDir, '.claude', 'commands', 'wiki-scan.md')), false)
    assert.deepEqual(JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf8')).mcpServers.codewiki, { command: 'npx', args: ['-y', 'codewiki', 'mcp'] })
    assert.equal(readFileSync(instructionsPath, 'utf8'), '# 团队说明\n')
    assert.equal(readFileSync(modulePath, 'utf8'), '# 订单知识\n')
  } finally {
    rmSync(projectDir, { recursive: true, force: true })
  }
})

test('codewiki uninstall removes integrations but preserves team knowledge', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'codewiki-uninstall-'))
  try {
    runCli(['init'], projectDir)
    const modulePath = join(projectDir, '.codewiki', 'modules', 'orders', 'README.md')
    mkdirSync(join(modulePath, '..'), { recursive: true })
    writeFileSync(modulePath, '# Orders\n', 'utf8')
    mkdirSync(join(projectDir, '.claude', 'commands'), { recursive: true })
    writeFileSync(join(projectDir, '.claude', 'commands', 'wiki-explore.md'), 'legacy command\n', 'utf8')
    const settingsPath = join(projectDir, '.claude', 'settings.local.json')
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    settings.permissions.allow.push('Bash(npm test *)')
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')

    const output = runCli(['uninstall'], projectDir)
    for (const path of [
      '.claude/skills/codewiki-generate',
      '.claude/skills/codewiki-query',
      '.claude/skills/codewiki-review',
      '.agents/skills/codewiki-generate',
      '.agents/skills/codewiki-query',
      '.agents/skills/codewiki-review',
      '.claude/commands/wiki-explore.md',
      '.codex/rules/codewiki.rules',
      '.codewiki/workflow',
    ]) assert.equal(existsSync(join(projectDir, path)), false, `still exists: ${path}`)
    assert.equal(JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf8')).mcpServers, undefined)
    assert.doesNotMatch(readFileSync(join(projectDir, '.codex', 'config.toml'), 'utf8'), /\[mcp_servers\.codewiki]/)
    const remainingSettings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    assert.deepEqual(remainingSettings.permissions.allow, ['Bash(npm test *)'])
    assert.equal(remainingSettings.enabledMcpjsonServers, undefined)
    for (const path of ['codewiki.yml', '.codewiki/INSTRUCTIONS.md', '.codewiki/modules/orders/README.md']) {
      assert.ok(existsSync(join(projectDir, path)), `knowledge asset removed: ${path}`)
    }
    assert.match(output, /已保留团队知识资产/)
  } finally {
    rmSync(projectDir, { recursive: true, force: true })
  }
})

test('codewiki init keeps .codewiki modules trackable while ignoring local state', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'codewiki-init-legacy-'))
  try {
    mkdirSync(join(projectDir, '.codewiki', 'modules', 'orders'), { recursive: true })
    writeFileSync(join(projectDir, '.gitignore'), '.codewiki/\n')
    runCli(['init'], projectDir)
    assert.match(readFileSync(join(projectDir, 'codewiki.yml'), 'utf8'), /knowledge_root: \.codewiki\/modules/)
    const gitignore = readFileSync(join(projectDir, '.gitignore'), 'utf8')
    assert.doesNotMatch(gitignore, /^\.codewiki\/?$/m)
    assert.match(gitignore, /^\.codewiki\/feedback\.jsonl$/m)
  } finally {
    rmSync(projectDir, { recursive: true, force: true })
  }
})

test('query feedback and generate supplement close the Case regression loop', () => {
  const { projectDir, moduleDir } = scaffold()
  try {
    writeModuleFiles({ projectDir, moduleDir })
    // 先检索，再通过同一个 query 入口记录差评。
    const firstQuery = JSON.parse(runCli(['query', '退款什么情况下允许', '--module', 'orders', '--json'], projectDir))
    const feedbackOutput = runCli(['query', '--feedback', 'bad', '--retrieval-id', firstQuery.retrieval_id, '--comment', '没答到点子上'], projectDir)
    const feedback = readFileSync(join(projectDir, '.codewiki', 'feedback.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(feedback[0].rating, 'bad')
    assert.equal(feedback[0].module, 'orders')
    const gapId = feedbackOutput.match(/gap:orders:[a-f0-9]+/)?.[0]
    assert.ok(gapId)

    // 对真实检索的好评自动沉淀 feedback Case，而不是等下一次 generate。
    const goodQuery = JSON.parse(runCli(['query', '导出按钮怎么实现', '--module', 'orders', '--json'], projectDir))
    const goodOutput = runCli(['query', '--feedback', 'good', '--retrieval-id', goodQuery.retrieval_id], projectDir)
    assert.match(goodOutput, /已沉淀反馈确认 Case/)
    const feedbackCase = JSON.parse(readFileSync(join(moduleDir, 'retrieval-cases.json'), 'utf8')).cases[0]
    assert.equal(feedbackCase.source, 'feedback')
    assert.equal(feedbackCase.source_ref, goodQuery.retrieval_id)

    // 用户确认后，知识进入可提交的 quality Markdown。
    const knowledgeOutput = runCli(['generate', '--module', 'orders', '--kind', 'feedback', '--title', '退款条件', '--question', '退款什么情况下允许',
      '--answer', '订单为已支付且未发货状态时允许退款，见 src/views/order/refund.vue:42。',
      '--evidence', 'code:src/views/order/refund.vue:42', '--gap-id', gapId], projectDir)
    const knowledgeId = knowledgeOutput.match(/kb:orders:quality:feedback:[a-f0-9]+/)?.[0]
    assert.ok(knowledgeId)
    const qualityDir = join(moduleDir, 'quality', 'manual')
    const qualityFiles = readdirSync(qualityDir)
    assert.equal(qualityFiles.length, 1)
    assert.ok(readFileSync(join(qualityDir, qualityFiles[0]), 'utf8').includes(gapId))

    // generate 已自动建立 Case、重建索引并完成回归。
    const queryOutput = runCli(['query', '退款', '--json'], projectDir)
    const result = JSON.parse(queryOutput)
    assert.ok(result.modules.some(m => m.topics.some(t => t.id === knowledgeId)), 'quality knowledge not retrievable')

    const casesPath = join('.codewiki', 'modules', 'orders', 'retrieval-cases.json')
    assert.equal(JSON.parse(readFileSync(join(projectDir, casesPath), 'utf8')).cases.length, 2)

    const confidence = JSON.parse(runCli(['confidence', '--module', 'orders', '--json'], projectDir))
    const module = confidence.modules[0]
    assert.ok(module.retrieval_usage.rated_count >= 1)
    assert.ok(module.retrieval_usage.top_bad_rated_queries.some(q => q.query.includes('退款')))
    assert.equal(module.gap_closure.discovered, 1)
    assert.equal(module.gap_closure.closed, 1)
    assert.equal(module.case_report.active_cases, 2)
    assert.equal(module.case_report.regression.failed, 0)
    assert.ok(module.case_report.matched >= 1)

    renderSite(projectDir)
    const moduleHtml = readFileSync(join(projectDir, '.codewiki', 'site', 'orders.html'), 'utf8')
    assert.match(moduleHtml, /质量知识层/)
    assert.match(moduleHtml, /退款条件/)
  } finally {
    rmSync(projectDir, { recursive: true, force: true })
  }
})

test('site renders interactive HTML pages', () => {
  const { projectDir, moduleDir } = scaffold()
  try {
    writeModuleFiles({ projectDir, moduleDir })
    renderSite(projectDir)
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

test('preview --export renders the site without starting a server', () => {
  const { projectDir, moduleDir } = scaffold()
  try {
    writeModuleFiles({ projectDir, moduleDir })
    const output = runCli(['preview', '--export'], projectDir)
    assert.match(output, /静态知识站点已生成/)
    assert.ok(existsSync(join(projectDir, '.codewiki', 'site', 'index.html')))
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
