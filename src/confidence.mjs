// codewiki confidence — 模块置信度评估 v1
//
// 输入信号（全部本地，不上报）:
//   1. .codewiki/modules/<module>/navigation/validation-report.json  逐文件证据分（scan --validate 产出）
//   2. navigation/{branch-routes,state-machines,timeout-recovery}.json 确定性场景用例
//   3. .codewiki/modules/<module>/product|frontend/*.md 场景用例是否被文档覆盖
//   4. .codewiki/knowledge-overlay/<module>.jsonl  用户确认后增补的知识（source=user）
//   5. .codewiki/retrieval.jsonl  MCP/查询命中记录（case 命中作为置信度输入）
//   6. .codewiki/feedback.jsonl   wiki-explore 的用户评级（差评形成 Gap）
//
// 输出: 每模块 A–E 评级（50% 证据 / 30% 场景覆盖 / 20% Gap 闭环）+ 检索使用统计。
// 评估结果追加到 .codewiki/knowledge-health/<module>/confidence-history.jsonl。
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { calculateKnowledgeConfidence, deriveNavigationCases, gradeFromScore } from './scan/knowledge-confidence.mjs'
import { MODULES_ROOT, moduleDirs, moduleNameFromManifest } from './scan/knowledge-retrieval.mjs'

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
  return moduleDirs(projectRoot, requestedModule).map(dir => ({ dir, name: moduleNameFromManifest(dir) }))
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

// 用户确认后增补的 overlay 知识（wiki-explore 差评反哺产物），source=user 参与场景覆盖。
function overlayCases(projectRoot, moduleName) {
  const overlayPath = join(projectRoot, '.codewiki', 'knowledge-overlay', `${encodeURIComponent(moduleName)}.jsonl`)
  if (!existsSync(overlayPath)) return []
  return readFileSync(overlayPath, 'utf8').split(/\r?\n/).filter(Boolean).flatMap(line => {
    try {
      const item = JSON.parse(line)
      if (item.status !== 'active' || !item.id) return []
      return [{ id: String(item.id), source: 'user', verified: item.verified === true }]
    } catch { return [] }
  })
}

function readJsonlSince(filePath, days) {
  if (!existsSync(filePath)) return []
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  const records = []
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line)
      if (!record.at || Date.parse(record.at) >= cutoff) records.push(record)
    } catch { /* 跳过损坏行 */ }
  }
  return records
}

function countByQuery(records, predicate) {
  const map = new Map()
  for (const record of records) {
    if (!predicate(record)) continue
    const key = String(record.query || '').toLowerCase().replace(/\s+/g, ' ').trim()
    if (!key) continue
    map.set(key, (map.get(key) || 0) + 1)
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1])
}

function usageStats(traces, feedbacks, moduleName) {
  const scoped = traces.filter(trace => trace.module === moduleName || (trace.modules || []).includes(moduleName))
  const total = scoped.length
  const found = scoped.filter(trace => trace.found).length
  const fallback = scoped.filter(trace => trace.fallback).length
  const stale = scoped.filter(trace => trace.stale).length
  const latencies = scoped.filter(trace => Number.isFinite(trace.latency_ms)).map(trace => trace.latency_ms)
  const ratedFeedbacks = feedbacks.filter(item => (item.module === moduleName || (item.modules || []).includes(moduleName)) && (item.rating === 'good' || item.rating === 'bad'))
  const rated = ratedFeedbacks.length
  const bad = ratedFeedbacks.filter(item => item.rating === 'bad').length
  return {
    query_count: total,
    found_rate: total > 0 ? Number((found / total).toFixed(3)) : null,
    fallback_rate: total > 0 ? Number((fallback / total).toFixed(3)) : null,
    stale_rate: total > 0 ? Number((stale / total).toFixed(3)) : null,
    avg_latency_ms: latencies.length > 0
      ? Number((latencies.reduce((sum, value) => sum + value, 0) / latencies.length).toFixed(1))
      : null,
    rated_count: rated,
    bad_rate: rated > 0 ? Number((bad / rated).toFixed(3)) : null,
    top_missed_queries: countByQuery(scoped, trace => !trace.found).slice(0, 5).map(([query, count]) => ({ query, count })),
    top_bad_rated_queries: countByQuery(ratedFeedbacks, item => item.rating === 'bad').slice(0, 5).map(([query, count]) => ({ query, count })),
  }
}

// Gap 来源一：真实检索未命中；来源二：命中了但用户评价差（答案不够好）。
function collectGaps(usage) {
  const gaps = usage.top_missed_queries.map((miss, index) => ({
    id: `retrieval-miss:${index + 1}:${miss.query.slice(0, 40)}`,
    status: 'open',
    evidence_refs: [],
    question: miss.query,
    count: miss.count,
    kind: 'miss',
  }))
  usage.top_bad_rated_queries.forEach((miss, index) => {
    gaps.push({
      id: `feedback-bad:${index + 1}:${miss.query.slice(0, 40)}`,
      status: 'open',
      evidence_refs: [],
      question: miss.query,
      count: miss.count,
      kind: 'bad_rating',
    })
  })
  return gaps
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

export function assessModuleConfidence(projectRoot, module, traces, feedbacks, days) {
  const markdownContents = [...listMarkdown(join(module.dir, 'product')), ...listMarkdown(join(module.dir, 'frontend'))]
    .map(file => readFileSync(file, 'utf8'))
  const validation = evidenceFromValidationReport(module.dir)
  const coveredCases = [
    ...caseCoveredInDocs(navigationInputs(module.dir), markdownContents),
    ...overlayCases(projectRoot, module.name),
  ]
  const usage = usageStats(traces, feedbacks, module.name)
  const gaps = collectGaps(usage)

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
      ...(validation == null ? [`缺少 validation-report.json — 先运行 codewiki scan <target> ${MODULES_ROOT}/<module> --validate`] : []),
      ...(coveredCases.length === 0 ? ['未发现确定性场景用例（branch-routes / state-machines / timeout-recovery 均为空）'] : []),
      ...(usage.query_count === 0 ? ['暂无检索命中记录 — MCP/查询使用后，case 命中将参与置信度评估'] : []),
      ...(usage.rated_count === 0 && usage.query_count > 0 ? ['暂无用户评级 — 在 Claude Code 中用 /wiki-explore 回答后邀请用户评级'] : []),
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
    if (usage.rated_count > 0) lines.push(`- 用户评级：${usage.rated_count} 次，bad_rate=${usage.bad_rate}`)
    for (const miss of usage.top_missed_queries) lines.push(`  - 未命中：${miss.query} ×${miss.count}`)
    for (const miss of usage.top_bad_rated_queries) lines.push(`  - 差评：${miss.query} ×${miss.count}`)
    lines.push(`- 综合评级：${module.overall_confidence.grade}${module.overall_confidence.score != null ? `（score=${module.overall_confidence.score}）` : ''}`)
    for (const hint of module.hints) lines.push(`- 提示：${hint}`)
  }
  return lines.join('\n')
}

export async function runConfidence(options = {}) {
  const projectRoot = resolve(options.projectRoot || process.cwd())
  const modules = discoverModules(projectRoot, options.module)
  if (modules.length === 0) {
    process.stderr.write(`[codewiki] 未找到知识库模块${options.module ? `: ${options.module}` : ''}（期望 ${MODULES_ROOT}/<module>/manifest.yml；先运行 codewiki init 与 /wiki-scan）\n`)
    return 1
  }
  const days = Math.max(1, Number(options.days) || 30)
  const traces = readJsonlSince(join(projectRoot, '.codewiki', 'retrieval.jsonl'), days)
  const feedbacks = readJsonlSince(join(projectRoot, '.codewiki', 'feedback.jsonl'), days)
  const assessed = modules.map(module => assessModuleConfidence(projectRoot, module, traces, feedbacks, days))
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
        usage: {
          query_count: module.retrieval_usage.query_count,
          found_rate: module.retrieval_usage.found_rate,
          bad_rate: module.retrieval_usage.bad_rate,
        },
      })}\n`, 'utf8')
    } catch { /* 历史写入失败不阻断评估 */ }
  }

  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  else process.stdout.write(`${renderReport(result)}\n`)
  return 0
}
