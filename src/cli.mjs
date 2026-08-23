#!/usr/bin/env node
// codewiki CLI — command dispatch + AST scan pipeline orchestration.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildProjectIndex, evaluateKnowledgeBase, exploreKnowledgeBase, formatExploreResult, MODULES_ROOT } from './scan/knowledge-retrieval.mjs'
import { runConfidence } from './confidence.mjs'
import { runInit } from './init.mjs'
import { runPreview } from './preview.mjs'
import { renderSite } from './site.mjs'
import { runFeedback, runCaseAdd } from './feedback.mjs'

const SCAN_DIR = join(dirname(fileURLToPath(import.meta.url)), 'scan')

const usage = `codewiki — 前端仓库知识库 CLI

用法:
  codewiki init [--project <root>]
      初始化：安装 /wiki-scan、/wiki-explore 指令，注册 MCP，下发工作流文档
  codewiki scan <target> [--output ${MODULES_ROOT}/<module>] [--incremental]
      运行 AST 六阶段管线，产出 <module>/navigation/ 结构化代码图
  codewiki scan <target> <output-dir> --validate
      只跑证据自检（引用 file:line 校验 + 逐文件置信评分）
  codewiki index [--module <name>] [--json]
      构建检索索引（语义文档 + bindings + 导航图），写入 .codewiki/cache/
  codewiki query "<问题>" [--module <name>] [--detail semantic|evidence] [--json]
      检索知识库，返回语义文档与 file:line 代码证据
  codewiki evaluate --cases <file.json> [--repeat N] [--output <file>]
      用固定问题集评估检索质量（Top-3 命中率 / 证据召回率 / 冷热延迟）
  codewiki confidence [--module <name>] [--days 30] [--json]
      汇总证据分、场景覆盖、检索命中与用户评级，输出模块置信度评级
  codewiki feedback record --rating good|bad --query "..." [--module M] [--retrieval-id ID] [--comment "..."]
      记录 wiki-explore 回答的用户评级（写入 .codewiki/feedback.jsonl）
  codewiki case add --module M --title "..." --question "..." --answer "..." --evidence <file:line> [--unverified]
      增补用户确认的知识（写入 .codewiki/knowledge-overlay/，index 后可检索）
  codewiki site [--module <name>]
      渲染交互式 HTML 站点到 .codewiki/site/
  codewiki preview [--port 4173] [--no-open] [--module <name>]
      渲染站点并启动本地服务器，自动打开浏览器
  codewiki mcp
      启动 stdio MCP Server（工具 codewiki_explore），供 AI Agent 接入

环境变量:
  CODEWIKI_PROJECT_ROOT   MCP/检索默认项目根目录（默认当前目录）`

const flags = {}
const positional = []
const options = { projectRoot: process.cwd(), module: '', detail: '', maxTopics: 5, repeat: 1, json: false, days: 30, evidence: [] }

for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i]
  if (!arg.startsWith('--')) { positional.push(arg); continue }
  const [name, inline] = arg.slice(2).split('=', 2)
  if (['json', 'incremental', 'validate', 'rebuild', 'no-open', 'unverified'].includes(name)) { flags[name] = true; if (name === 'json') options.json = true; continue }
  const value = inline ?? process.argv[++i]
  if (value == null) fail(`--${name} 缺少参数`)
  if (name === 'project') options.projectRoot = value
  else if (name === 'module') options.module = value
  else if (name === 'detail') options.detail = value
  else if (name === 'max-topics') options.maxTopics = Number(value)
  else if (name === 'repeat') options.repeat = Number(value)
  else if (name === 'days') options.days = Number(value)
  else if (name === 'port') options.port = Number(value)
  else if (name === 'cases') options.casesPath = value
  else if (name === 'output') options.outputPath = value
  else if (name === 'query') options.query = value
  else if (name === 'rating') options.rating = value
  else if (name === 'retrieval-id') options.retrievalId = value
  else if (name === 'comment') options.comment = value
  else if (name === 'title') options.title = value
  else if (name === 'question') options.question = value
  else if (name === 'answer') options.answer = value
  else if (name === 'evidence') options.evidence.push(value)
  else fail(`未知参数: --${name}`)
}

let command = positional.shift() || ''
let sub = ''
if (['feedback', 'case'].includes(command)) sub = positional.shift() || ''

function fail(message, showUsage = false) {
  process.stderr.write(`[codewiki] ${message}\n`)
  if (showUsage) process.stderr.write(`\n${usage}\n`)
  process.exit(1)
}

function outputArgs() {
  return ['--output', options.outputPath]
}

function runPipeline(target) {
  if (!target) fail('scan 需要目标路径', true)
  const absTarget = resolve(options.projectRoot, target)
  if (!existsSync(absTarget)) fail(`目标目录不存在: ${absTarget}`)
  if (!options.outputPath) options.outputPath = join(MODULES_ROOT, basename(absTarget))
  const pipeline = [
    // Order matters: graph-cluster must run before deep-analyzer; field-lineage
    // fuses the intermediates produced by the three parallel-capable stages.
    ['nav-parser.mjs', [...outputArgs(), ...(flags.incremental ? ['--incremental'] : [])]],
    ['graph-cluster.mjs', [...outputArgs()]],
    ['data-shape-tracer.mjs', [...outputArgs()]],
    ['pinia-tracker.mjs', [...outputArgs()]],
    ['deep-analyzer.mjs', [...outputArgs()]],
    ['field-lineage.mjs', [...outputArgs()]],
  ]
  const startedAt = Date.now()
  for (const [script, args] of pipeline) {
    const scriptPath = join(SCAN_DIR, script)
    if (!existsSync(scriptPath)) fail(`缺少脚本: ${scriptPath}（安装可能不完整）`)
    process.stderr.write(`▶ ${script}\n`)
    const result = spawnSync(process.execPath, [scriptPath, absTarget, ...args], {
      cwd: options.projectRoot,
      stdio: 'inherit',
    })
    if (result.status !== 0) fail(`${script} 失败（退出码 ${result.status}）`)
  }
  process.stderr.write(`✓ 管线完成，产出 ${options.outputPath}/navigation/，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`)
  process.stderr.write(`✓ 下一步：撰写 product/frontend 语义层后运行 codewiki index（工作流见 /wiki-scan）\n`)
}

try {
  if (command === 'init') {
    process.exit(runInit({ ...options, force: flags.force }))
  } else if (command === 'scan') {
    if (flags.validate) {
      const [target, outputDir] = positional
      if (!target || !outputDir) fail(`scan --validate 需要 <target> <output-dir>（例如 ${MODULES_ROOT}/<module>）`)
      const result = spawnSync(process.execPath, [join(SCAN_DIR, 'deep-analyzer.mjs'), target, outputDir, '--validate'], {
        cwd: options.projectRoot,
        stdio: 'inherit',
      })
      process.exit(result.status ?? 1)
    }
    runPipeline(positional[0])
  } else if (command === 'index' || command === 'build') {
    const indexes = buildProjectIndex({ ...options, projectRoot: options.projectRoot })
    const summary = indexes.map(index => ({
      module: index.metadata.module,
      knowledge: index.knowledge.length,
      navigation_nodes: index.nav_nodes.length,
      navigation_edges: index.nav_edges.length,
      bindings: index.bindings.length,
      warnings: index.warnings,
    }))
    process.stdout.write(options.json
      ? `${JSON.stringify(summary, null, 2)}\n`
      : summary.map(item => `[codewiki] ${item.module}: ${item.knowledge} 篇语义文档，${item.navigation_nodes} 个导航节点，${item.bindings} 条绑定${item.warnings.length ? `，${item.warnings.length} 条警告` : ''}`).join('\n') + '\n')
  } else if (command === 'query' || command === 'explore') {
    const query = positional.join(' ') || options.query
    if (!query.trim()) fail('query 需要检索问题', true)
    const result = exploreKnowledgeBase({ ...options, query })
    process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatExploreResult(result)}\n`)
  } else if (command === 'evaluate') {
    if (!options.casesPath) fail('evaluate 需要 --cases <json>')
    const casesPath = resolve(options.projectRoot, options.casesPath)
    const parsed = JSON.parse(readFileSync(casesPath, 'utf8'))
    const evaluation = evaluateKnowledgeBase({ ...options, cases: Array.isArray(parsed) ? parsed : parsed.cases })
    const output = `${JSON.stringify(evaluation, null, 2)}\n`
    if (options.outputPath) writeFileSync(resolve(options.projectRoot, options.outputPath), output, 'utf8')
    process.stdout.write(output)
    if (evaluation.summary.failed > 0) process.exitCode = 1
  } else if (command === 'confidence') {
    process.exit(await runConfidence(options))
  } else if (command === 'feedback') {
    process.exit(runFeedback({ sub, ...options }))
  } else if (command === 'case') {
    if (sub !== 'add') fail('用法: codewiki case add --module M --title ... --question ... --answer ... --evidence <file:line>')
    process.exit(runCaseAdd({ ...options, verified: flags.unverified ? false : true }))
  } else if (command === 'site') {
    const site = renderSite(options.projectRoot, { module: options.module })
    process.stdout.write(`[codewiki] 站点已生成：${site.outDir}\n`)
    for (const module of site.modules) process.stdout.write(`  - ${module.name}: ${module.docs} 篇文档，评级 ${module.grade}\n`)
  } else if (command === 'preview') {
    process.exit(await runPreview({ ...options, noOpen: flags['no-open'] }))
  } else if (command === 'mcp') {
    await import('./scan/mcp-server.mjs')
  } else if (command === 'help' || command === '--help' || command === '-h' || command === '') {
    process.stdout.write(`${usage}\n`)
  } else {
    fail(`未知命令: ${command}`, true)
  }
} catch (error) {
  process.stderr.write(`[codewiki] ${error.message}\n`)
  process.exit(1)
}
