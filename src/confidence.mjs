// codewiki confidence — 模块置信度评估 v1
//
// 输入信号（全部本地，不上报）:
//   1. docs/<module>/navigation/validation-report.json  逐文件证据分（scan --validate 产出）
//   2. navigation/{branch-routes,state-machines,timeout-recovery}.json 确定性场景用例
//   3. docs/<module>/product|frontend/*.md 场景用例是否被文档覆盖
//   4. .codewiki/retrieval.jsonl  MCP/查询命中记录（case 命中将作为置信度输入）
//
// 输出: 每模块 A–E 评级（50% 证据 / 30% 场景覆盖 / 20% Gap 闭环）+ 检索使用统计。
// 评估结果追加到 .codewiki/knowledge-health/<module>/confidence-history.jsonl。
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { calculateKnowledgeConfidence, deriveNavigationCases, gradeFromScore } from './scan/knowledge-confidence.mjs'

function readJson(filePath, fallback = null) {
  try { return JSON.parse(readFileSync(filePath, 'utf8')) } catch { return fallback }
}

function listMarkdown(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .map(entry => join(dir, entry.name))
}

function discoverModules(projectRoot, requestedModule) {
  const docsRoot = join(projectRoot, 'docs')
  if (!existsSync(docsRoot)) return []
  let dirs = readdirSync(docsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => join(docsRoot, entry.name))
    .filter(dir => existsSync(join(dir, 'manifest.yml')) || existsSync(join(dir, 'navigation')))
  if (requestedModule) dirs = dirs.filter(dir => basename(dir) === requestedModule)
  return dirs.map(dir => ({ dir, name: readManifestModule(dir) || basename(dir) }))
}

function readManifestModule(moduleDir) {
  try {
    const manifest = readFileSync(join(moduleDir, 'manifest.yml'), 'utf8')
    return manifest.match(/^module:\s*["']?([^\n"']+)/m)?.[1]?.trim() || ''
  } catch { return '' }
}

function navigationInputs(moduleDir) {
  const navigationDir = join(moduleDir, 'navigation')
  return deriveNavigationCases({
    branchRoutes: readJson(join(navigationDir, 'branch-routes.json'), {}),
    stateMachines: readJson(join(navigationDir, 'state-machines.json'), {}),
    timeoutRecovery: readJson(join(navigationDir, 'timeout-recovery.json'), {}),
  })
}

// 与 deep-analyzer --validate 相同口径：case id 的各片段出现在文档正文即视为已覆盖。
function caseCoveredInDocs(cases, markdownContents) {
  return cases.map(item => {
    const terms = item.id.split(/[:>-]+/).slice(1).filter(term => term && term !== 'undefined')
    const verified = terms.length > 0 && markdownContents.some(content => terms.every(term => content.includes(term)))
    return { ...item, verified }
  })
}

function readRetrievalTraces(projectRoot, days) {
  const logPath = join(projectRoot, '.codewiki', 'retrieval.jsonl')
  if (!existsSync(logPath)) return []
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  const traces = []
  for (const line of readFileSync(logPath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line)
      if (!record.at || Date.parse(record.at) >= cutoff) traces.push(record)
    } catch { /* 跳过损坏行 */ }
  }
  return traces
}

function usageStats(traces, moduleName) {
  const scoped = traces.filter(trace => trace.module === moduleName || (trace.modules || []).includes(moduleName))
  const total = scoped.length
  const found = scoped.filter(trace => trace.found).length
  const fallback = scoped.filter(trace => trace.fallback).length
  const stale = scoped.filter(trace => trace.stale).length
  const latencies = scoped.filter(trace => Number.isFinite(trace.latency_ms)).map(trace => trace.latency_ms)
  const misses = new Map()
  for (const trace of scoped) {
    if (trace.found) continue
    const key = String(trace.query || '').toLowerCase().replace(/\s+/g, ' ').trim()
    if (!key) continue
    misses.set(key, (misses.get(key) || 0) + 1)
  }
  return {
    query_count: total,
    found_rate: total > 0 ? Number((found / total).toFixed(3)) : null,
    fallback_rate: total > 0 ? Number((fallback / total).toFixed(3)) : null,
    stale_rate: total > 0 ? Number((stale / total).toFixed(3)) : null,
    avg_latency_ms: latencies.length > 0
      ? Number((latencies.reduce((sum, value) => sum + value, 0) / latencies.length).toFixed(1))
      : null,
    top_missed_queries: [...misses.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([query, count]) => ({ query, count })),
  }
}

// 未命中的真实检索构成 Gap：evidence_refs 为空视为开放，命中过语义文档视为已闭环。
function gapsFromMisses(usage) {
  return usage.top_missed_queries.map((miss, index) => ({
    id: `retrieval-miss:${index + 1}:${miss.query.slice(0, 40)}`,
    status: 'open',
    evidence_refs: [],
    question: miss.query,
    count: miss.count,
  }))
}

function evidenceFromValidationReport(moduleDir) {
  const report = readJson(join(moduleDir, 'navigation', 'validation-report.json'), null)
  if (!report || !Array.isArray(report.per_file_confidence)) return null
  const scored = report.per_file_confidence.filter(item => Number.isFinite(item.ratio))
  const evidenceScore = scored.length > 0
    ? Number((scored.reduce((sum, item) => sum + item.ratio, 0) / scored.length).toFixed(3))
    : null
  return {
    generated_at: report.generated_at || null,
    status: report.status || null,
    files: report.per_file_confidence.length,
    failed_files: report.per_file_confidence.filter(item => item.grade === 'E' || item.grade === 'D').length,
    evidenceScore,
  }
}

export function assessModuleConfidence(projectRoot, module, traces, days) {
  const markdownContents = [...listMarkdown(join(module.dir, 'product')), ...listMarkdown(join(module.dir, 'frontend'))]
    .map(file => readFileSync(file, 'utf8'))
  const validation = evidenceFromValidationReport(module.dir)
  const coveredCases = caseCoveredInDocs(navigationInputs(module.dir), markdownContents)
  const usage = usageStats(traces, module.name)
  const gaps = gapsFromMisses(usage)

  const confidence = calculateKnowledgeConfidence({
    evidenceScore: validation?.evidenceScore ?? null,
    expectedCases: coveredCases,
    gaps,
  })

  return {
    module: module.name,
    dir: module.dir,
    evidence: validation,
    scenario_coverage: confidence.scenario_coverage,
    gap_closure: confidence.gap_closure,
    retrieval_usage: usage,
    overall_confidence: {
      ...confidence.overall_confidence,
      grade: gradeFromScore(confidence.overall_confidence.score),
      policy: 'codewiki-confidence-v1',
    },
    hints: [
      ...(validation == null ? ['缺少 validation-report.json — 先运行 codewiki scan <target> docs/<module> --validate'] : []),
      ...(coveredCases.length === 0 ? ['未发现确定性场景用例（branch-routes / state-machines / timeout-recovery 均为空）'] : []),
      ...(usage.query_count === 0 ? ['暂无检索命中记录 — MCP/查询使用后，case 命中将参与置信度评估'] : []),
    ],
  }
}

function renderReport(result) {
  const lines = ['# codewiki 置信度评估']
  for (const module of result.modules) {
    lines.push(`\n## 模块：${module.module}`)
    const evidence = module.evidence
    lines.push(`- 证据分：${evidence?.evidenceScore ?? 'N/A'}（${evidence ? `${evidence.files} 篇文档，校验 ${evidence.status ?? '未知'}` : '未运行 --validate'}）`)
    lines.push(`- 场景覆盖：${module.scenario_coverage.verified}/${module.scenario_coverage.applicable}${module.scenario_coverage.score != null ? `（score=${module.scenario_coverage.score}）` : ''}`)
    lines.push(`- Gap 闭环：${module.gap_closure.closed}/${module.gap_closure.discovered}`)
    const usage = module.retrieval_usage
    lines.push(`- 检索命中记录（${result.window_days} 天）：${usage.query_count} 次查询，found_rate=${usage.found_rate ?? 'N/A'}，fallback_rate=${usage.fallback_rate ?? 'N/A'}，avg=${usage.avg_latency_ms ?? 'N/A'}ms`)
    for (const miss of usage.top_missed_queries) lines.push(`  - 未命中：${miss.query} ×${miss.count}`)
    lines.push(`- 综合评级：${module.overall_confidence.grade}${module.overall_confidence.score != null ? `（score=${module.overall_confidence.score}）` : ''}`)
    for (const hint of module.hints) lines.push(`- 提示：${hint}`)
  }
  return lines.join('\n')
}

export async function runConfidence(options = {}) {
  const projectRoot = resolve(options.projectRoot || process.cwd())
  const modules = discoverModules(projectRoot, options.module)
  if (modules.length === 0) {
    process.stderr.write(`[codewiki] 未找到知识库模块${options.module ? `: ${options.module}` : ''}（期望 docs/<module>/manifest.yml）\n`)
    return 1
  }
  const days = Math.max(1, Number(options.days) || 30)
  const traces = readRetrievalTraces(projectRoot, days)
  const assessed = modules.map(module => assessModuleConfidence(projectRoot, module, traces, days))
  const result = {
    generated_at: new Date().toISOString(),
    project_root: projectRoot,
    window_days: days,
    modules: assessed,
  }

  // 追加审计历史（只增不改，供后续趋势分析）
  for (const module of assessed) {
    try {
      const dir = join(projectRoot, '.codewiki', 'knowledge-health', module.module)
      mkdirSync(dir, { recursive: true })
      appendFileSync(join(dir, 'confidence-history.jsonl'), `${JSON.stringify({
        at: result.generated_at,
        overall: module.overall_confidence,
        evidence_score: module.evidence?.evidenceScore ?? null,
        usage: { query_count: module.retrieval_usage.query_count, found_rate: module.retrieval_usage.found_rate },
      })}\n`, 'utf8')
    } catch { /* 历史写入失败不阻断评估 */ }
  }

  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  else process.stdout.write(`${renderReport(result)}\n`)
  return 0
}
