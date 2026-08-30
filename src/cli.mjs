#!/usr/bin/env node
// codewiki CLI — command dispatch + AST scan pipeline orchestration.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { buildProjectIndex, compileUnifiedGraph, evaluateKnowledgeBase, exploreKnowledgeBase, formatExploreResult, moduleDirs } from './scan/knowledge-retrieval.mjs'
import { runConfidence } from './confidence.mjs'
import { runInit, runUninstall, runUpgrade } from './init.mjs'
import { runPreview } from './preview.mjs'
import { runFeedback, runKnowledgeAdd } from './feedback.mjs'
import { knowledgeRootRelative, statePath } from './config.mjs'
import { loadEvalCases, recordEvaluationRun, runEvalAdd } from './report.mjs'
import { appendJsonl, createRetrievalId, openGap } from './quality-state.mjs'
import { discoverSourceUnits, isFrontendSourceUnit, sourceUnitSummary } from './scan/source-units.mjs'
import { classifyGeneratedImpact } from './generation/impact.mjs'
import {
  assertGenerationUnchanged,
  assertKnowledgeImpactReviewed,
  beginGenerationTransaction,
  completeGenerationTransaction,
  rollbackGenerationTransaction,
  updateGenerationTransaction,
} from './generation/transaction.mjs'

const SCAN_DIR = join(dirname(fileURLToPath(import.meta.url)), 'scan')

const usage = `codewiki — 把前后端代码沉淀为可检索的业务知识

用法:
  npx codewiki init [--project <root>]
      安装 Claude Code/Codex Skills 与 MCP，初始化共享知识和本地状态
  npx codewiki upgrade [--project <root>]
      升级 Skills、工作流和项目集成，不覆盖团队说明与知识资产
  npx codewiki uninstall [--project <root>]
      移除项目集成，保留配置、团队说明与知识资产

初始化后，在 Claude Code 或 Codex 中直接说：
  “为订单模块生成知识库”
  “订单退款需要满足什么条件？”
  “预览订单知识库”
  “检查订单模块的知识置信度”

生成、检索、预览和置信检查由已安装的 Skills 编排；知识检索通过 MCP 完成。`

const flags = {}
const positional = []
let projectRootExplicit = false
const options = {
  projectRoot: process.cwd(), module: '', detail: '', maxTopics: 5, repeat: 1, json: false, days: 30,
  evidence: [], aliases: [], entities: [], gapIds: [], knowledgeIds: [], evidenceIds: [], tags: [],
}

for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i]
  if (!arg.startsWith('--')) { positional.push(arg); continue }
  const [name, inline] = arg.slice(2).split('=', 2)
  if (['help', 'json', 'update', 'finalize', 'rebuild', 'no-open', 'export', 'force', 'expect-not-found'].includes(name)) {
    flags[name] = true
    if (name === 'json') options.json = true
    if (name === 'expect-not-found') options.expectFound = false
    continue
  }
  const value = inline ?? process.argv[++i]
  if (value == null) fail(`--${name} 缺少参数`)
  if (name === 'project') {
    options.projectRoot = value
    projectRootExplicit = true
  }
  else if (name === 'module') options.module = value
  else if (name === 'detail') options.detail = value
  else if (name === 'max-topics') options.maxTopics = Number(value)
  else if (name === 'repeat') options.repeat = Number(value)
  else if (name === 'days') options.days = Number(value)
  else if (name === 'port') options.port = Number(value)
  else if (name === 'query') options.query = value
  else if (name === 'feedback') options.feedback = value
  else if (name === 'retrieval-id') options.retrievalId = value
  else if (name === 'comment') options.comment = value
  else if (name === 'title') options.title = value
  else if (name === 'question') options.question = value
  else if (name === 'answer') options.answer = value
  else if (name === 'evidence') options.evidence.push(value)
  else if (name === 'kind') options.kind = value
  else if (name === 'alias') options.aliases.push(value)
  else if (name === 'entity') options.entities.push(value)
  else if (name === 'gap-id') options.gapIds.push(value)
  else if (name === 'knowledge-id') options.knowledgeIds.push(value)
  else if (name === 'evidence-id') options.evidenceIds.push(value)
  else if (name === 'eval-case-id') options.evalCaseId = value
  else if (name === 'id') options.id = value
  else if (name === 'source-ref') options.sourceRef = value
  else if (name === 'tag') options.tags.push(value)
  else fail(`未知参数: --${name}`)
}

const command = positional.shift() || ''
const PROJECT_SCOPED_COMMANDS = new Set(['init', 'upgrade', 'uninstall'])

function fail(message, showUsage = false) {
  process.stderr.write(`[codewiki] ${message}\n`)
  if (showUsage) process.stderr.write(`\n${usage}\n`)
  process.exit(1)
}

if (projectRootExplicit && !PROJECT_SCOPED_COMMANDS.has(command)) {
  fail('--project 只允许用于 init、upgrade 和 uninstall；知识操作必须在当前项目内运行')
}

function outputArgs() {
  return ['--output', options.outputPath]
}

function supportsLegacyFrontendEnhancer(unit) {
  if (!isFrontendSourceUnit(unit)) return false
  if (unit.framework === 'generic-js') return true
  if (unit.framework !== 'vue') return false
  const major = Number(String(unit.framework_version || '').match(/(\d+)\./)?.[1] || 3)
  return major >= 3
}

function runPipeline(target) {
  if (!target && !options.module) fail('generate 需要目标路径或已配置的 --module', true)
  const requestedTarget = target ? resolve(options.projectRoot, target) : null
  if (requestedTarget && !existsSync(requestedTarget)) fail(`目标目录不存在: ${requestedTarget}`)
  const moduleName = options.module || basename(requestedTarget)
  const sourceUnits = discoverSourceUnits({ projectRoot: options.projectRoot, moduleName, target })
  if (sourceUnits.length === 0) fail(`未发现模块 ${moduleName} 的可分析 Source Unit；请检查目标路径或 codewiki.yml`)
  const transactionTarget = sourceUnits.length === 1 ? sourceUnits[0].abs_path : resolve(options.projectRoot)
  if (!options.outputPath) options.outputPath = join(knowledgeRootRelative(options.projectRoot), moduleName)
  const moduleDir = resolve(options.projectRoot, options.outputPath)
  const transaction = beginGenerationTransaction({
    projectRoot: options.projectRoot,
    moduleName,
    moduleDir,
    targetDir: transactionTarget,
  })
  const legacyFrontendUnit = sourceUnits.length === 1 && supportsLegacyFrontendEnhancer(sourceUnits[0]) ? sourceUnits[0] : null
  const pipeline = [
    ['fact-extractor.mjs', [
      ...(target ? [target] : []),
      '--project', resolve(options.projectRoot),
      '--module', moduleName,
      ...outputArgs(),
    ], resolve(options.projectRoot)],
    ...(legacyFrontendUnit ? [
      // The existing six-stage profile remains the deep Vue/TS enhancer for a
      // single frontend Source Unit. Multi-unit modules use normalized facts.
      ['nav-parser.mjs', [...outputArgs(), ...(flags.update ? ['--incremental'] : [])], legacyFrontendUnit.abs_path],
      ['graph-cluster.mjs', [...outputArgs()], legacyFrontendUnit.abs_path],
      ['data-shape-tracer.mjs', [...outputArgs()], legacyFrontendUnit.abs_path],
      ['pinia-tracker.mjs', [...outputArgs()], legacyFrontendUnit.abs_path],
      ['deep-analyzer.mjs', [...outputArgs()], legacyFrontendUnit.abs_path],
      ['field-lineage.mjs', [...outputArgs()], legacyFrontendUnit.abs_path],
    ] : []),
  ]
  const startedAt = Date.now()
  try {
    for (const [script, args, scriptTarget] of pipeline) {
      const scriptPath = join(SCAN_DIR, script)
      if (!existsSync(scriptPath)) throw new Error(`缺少脚本: ${scriptPath}（安装可能不完整）`)
      process.stderr.write(`▶ ${script}\n`)
      const scriptArgs = script === 'fact-extractor.mjs'
        ? [scriptPath, ...args]
        : [scriptPath, scriptTarget || transactionTarget, ...args]
      const result = spawnSync(process.execPath, scriptArgs, options.json
        ? { cwd: options.projectRoot, stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8' }
        : { cwd: options.projectRoot, stdio: 'inherit' })
      // --json 保证 stdout 只有最终 JSON；各扫描阶段的日志统一转到 stderr。
      if (options.json && result.stdout) process.stderr.write(result.stdout)
      if (result.error) throw result.error
      if (result.status !== 0) throw new Error(`${script} 失败（退出码 ${result.status}）`)
    }
    compileUnifiedGraph(moduleDir, options.projectRoot)
    const impact = classifyGeneratedImpact(transaction.baseline_dir, moduleDir)
    updateGenerationTransaction(options.projectRoot, moduleName, { impact })
    process.stderr.write(`✓ Source Units：${sourceUnits.map(sourceUnitSummary).join('；')}\n`)
    process.stderr.write(`✓ 管线完成，产出 ${options.outputPath}/navigation/，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`)
    process.stderr.write(`✓ 影响分类：${impact.classification}（${impact.reason}）\n`)
    if (impact.knowledge_ids?.length) process.stderr.write(`✓ 受影响知识：${impact.knowledge_ids.join(', ')}\n`)
    if (impact.eval_case_ids?.length) process.stderr.write(`✓ 需回归 Case：${impact.eval_case_ids.join(', ')}\n`)
    if (impact.classification === 'KNOWLEDGE_IMPACT') {
      process.stderr.write(`✓ 下一步：只更新受影响的 product/developer，再运行 npx codewiki generate${target ? ` ${target}` : ''} --module ${moduleName} --finalize\n`)
    } else {
      process.stderr.write(`✓ 无需改写语义文档；直接运行 npx codewiki generate${target ? ` ${target}` : ''} --module ${moduleName} --finalize\n`)
    }
    return {
      module: moduleName,
      output: options.outputPath,
      source_units: sourceUnits.map(({ abs_path: _absPath, ...unit }) => unit),
      impact,
    }
  } catch (error) {
    const rolledBack = rollbackGenerationTransaction(options.projectRoot, moduleName, error.message)
    if (rolledBack) process.stderr.write(`[codewiki] 生成失败，已恢复生成前知识库；失败现场保留在 ${rolledBack.failed_dir}\n`)
    throw error
  }
}

function buildIndexes(module = options.module) {
  const indexes = buildProjectIndex({ ...options, module, projectRoot: options.projectRoot })
  for (const index of indexes) {
    const warnings = index.warnings.length ? `，${index.warnings.length} 条警告` : ''
    process.stdout.write(`[codewiki] ${index.metadata.module}: ${index.knowledge.length} 篇知识文档，${index.nav_nodes.length} 个导航节点，${index.bindings.length} 条绑定${warnings}\n`)
  }
  return indexes
}

function evaluateCases(module) {
  const projectRoot = resolve(options.projectRoot)
  const cases = loadEvalCases(projectRoot, module).filter(item => item.status === 'active')
  if (cases.length === 0) {
    process.stdout.write(`[codewiki] ${module}: 暂无 active Eval Case，跳过回归\n`)
    return null
  }
  const evaluation = evaluateKnowledgeBase({ ...options, projectRoot, module, cases })
  const moduleDir = moduleDirs(projectRoot, module)[0]
  const casesPath = moduleDir
    ? relative(projectRoot, join(moduleDir, 'retrieval-cases.json')).replace(/\\/g, '/')
    : `${knowledgeRootRelative(projectRoot)}/${module}/retrieval-cases.json`
  const run = recordEvaluationRun(projectRoot, evaluation, casesPath)
  process.stdout.write(`[codewiki] ${module}: Case ${evaluation.summary.passed}/${evaluation.summary.total} 通过，Top-3=${evaluation.summary.top3_knowledge_hit_rate}，证据召回=${evaluation.summary.evidence_recall}（run_id=${run.run_id}）\n`)
  return evaluation
}

function finalizeGeneration(target) {
  if (!options.module) fail('generate --finalize 需要 --module <name>', true)
  const dirs = moduleDirs(options.projectRoot, options.module)
  if (dirs.length !== 1) fail(`未找到唯一知识模块: ${options.module}`)
  let transaction = null
  try {
    transaction = assertGenerationUnchanged(options.projectRoot, options.module)
    assertKnowledgeImpactReviewed(options.projectRoot, options.module)
  } catch (error) {
    const rolledBack = rollbackGenerationTransaction(options.projectRoot, options.module, error.message)
    if (rolledBack) process.stderr.write(`[codewiki] 已恢复生成前知识库；失败现场保留在 ${rolledBack.failed_dir}\n`)
    throw error
  }
  const validationTarget = target
    ? resolve(options.projectRoot, target)
    : transaction?.target_dir || resolve(options.projectRoot)
  const result = spawnSync(process.execPath, [join(SCAN_DIR, 'deep-analyzer.mjs'), validationTarget, dirs[0], '--validate'], {
    cwd: options.projectRoot,
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    const rolledBack = rollbackGenerationTransaction(options.projectRoot, options.module, `evidence validation failed (${result.status})`)
    if (rolledBack) process.stderr.write(`[codewiki] 校验失败，已恢复生成前知识库；失败现场保留在 ${rolledBack.failed_dir}\n`)
    return result.status ?? 1
  }
  try {
    const indexes = buildIndexes(options.module)
    const evaluation = evaluateCases(options.module)
    if (evaluation?.summary.failed > 0) throw new Error(`Eval Case 回归失败: ${evaluation.summary.failed}`)
    completeGenerationTransaction(options.projectRoot, options.module, {
      graph_stats: indexes[0]?.graph_stats || null,
      knowledge_freshness: indexes[0]?.knowledge_freshness || null,
      evaluation: evaluation?.summary || null,
    })
    return 0
  } catch (error) {
    const rolledBack = rollbackGenerationTransaction(options.projectRoot, options.module, error.message)
    if (rolledBack) process.stderr.write(`[codewiki] Finalize 失败，已恢复生成前知识库；失败现场保留在 ${rolledBack.failed_dir}\n`)
    throw error
  }
}

function supplementKnowledge() {
  let knowledge = null
  const code = runKnowledgeAdd({ ...options, onResult: result => { knowledge = result } })
  if (code !== 0 || !knowledge) return code || 1
  buildIndexes(knowledge.module)
  const caseCode = runEvalAdd({ ...options, module: knowledge.module, knowledgeIds: [knowledge.id] })
  if (caseCode !== 0) return caseCode
  return evaluateCases(knowledge.module)?.summary.failed > 0 ? 1 : 0
}

try {
  if (command === 'init') {
    process.exit(runInit({ ...options, force: flags.force }))
  } else if (command === 'upgrade') {
    process.exit(runUpgrade(options))
  } else if (command === 'uninstall') {
    process.exit(runUninstall(options))
  } else if (command === 'generate') {
    if (options.title || options.answer || options.kind) process.exit(supplementKnowledge())
    if (flags.finalize) process.exit(finalizeGeneration(positional[0]))
    const generated = runPipeline(positional[0])
    if (options.json) process.stdout.write(`${JSON.stringify(generated, null, 2)}\n`)
  } else if (command === 'query') {
    const query = positional.join(' ') || options.query || ''
    if (!query.trim() && options.feedback) {
      let feedback = null
      const code = runFeedback({ ...options, rating: options.feedback, quiet: options.json, onResult: result => { feedback = result } })
      if (options.json && feedback) process.stdout.write(`${JSON.stringify(feedback, null, 2)}\n`)
      process.exit(code)
    }
    if (!query.trim()) fail('query 需要检索问题', true)
    const startedAt = performance.now()
    const result = exploreKnowledgeBase({ ...options, query })
    const at = new Date().toISOString()
    const retrievalId = createRetrievalId({ query, at, nonce: process.pid })
    const knowledgeIds = [...new Set(result.modules.flatMap(item => item.topics.map(topic => topic.id)))]
    const evidenceIds = [...new Set(result.modules.flatMap(item => item.evidence.map(evidence => evidence.id)))]
    const modules = result.modules.map(item => item.module)
    const module = options.module || modules[0] || null
    const gapId = result.found ? null : openGap(options.projectRoot, {
      module: module || 'unknown', query, kind: 'retrieval_miss', retrievalId, at,
    })
    appendJsonl(statePath(options.projectRoot, 'retrieval.jsonl'), {
      retrieval_id: retrievalId,
      at,
      query,
      module,
      modules,
      found: result.found,
      fallback: false,
      topic_count: result.modules.reduce((sum, item) => sum + item.topics.length, 0),
      evidence_count: result.modules.reduce((sum, item) => sum + item.evidence.length, 0),
      knowledge_ids: knowledgeIds,
      evidence_ids: evidenceIds,
      intent: result.intent,
      route: result.route,
      detail: options.detail || (result.intent === 'semantic' ? 'semantic' : 'evidence'),
      stale: result.modules.some(item => item.stale),
      latency_ms: Number((performance.now() - startedAt).toFixed(3)),
      ...(gapId ? { gap_id: gapId } : {}),
    })
    result.retrieval_id = retrievalId
    if (gapId) result.gap_id = gapId
    if (options.feedback) {
      let feedback = null
      const code = runFeedback({ ...options, rating: options.feedback, query, retrievalId, quiet: true, onResult: item => { feedback = item } })
      if (code !== 0) process.exit(code)
      result.feedback = feedback
    }
    process.stdout.write(options.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : `${formatExploreResult(result)}\n\n[codewiki] retrieval_id=${retrievalId}${gapId ? ` gap_id=${gapId}` : ''}${result.feedback ? ` feedback_id=${result.feedback.feedback_id}` : ''}\n`)
  } else if (command === 'confidence') {
    process.exit(await runConfidence(options))
  } else if (command === 'preview') {
    process.exit(await runPreview({ ...options, noOpen: flags['no-open'], export: flags.export }))
  } else if (command === 'mcp') {
    await import('./scan/mcp-server.mjs')
  } else if (flags.help || command === 'help' || command === '-h' || command === '') {
    process.stdout.write(`${usage}\n`)
  } else {
    fail(`未知命令: ${command}`, true)
  }
} catch (error) {
  process.stderr.write(`[codewiki] ${error.message}\n`)
  process.exit(1)
}
