// codewiki confidence — 模块置信度评估 v2
//
// 输入信号（全部本地，不上报）:
//   1. <knowledge_root>/<module>/navigation/validation-report.json  逐文件证据分（scan --validate 产出）
//   2. navigation/{branch-routes,state-machines,timeout-recovery}.json 确定性场景用例
//   3. <knowledge_root>/<module>/product|developer|quality/**/*.md 场景用例是否被文档覆盖
//   4. <state_root>/gaps.jsonl     稳定 Gap 生命周期（发现、知识补充、回归闭环）
//   5. <state_root>/retrieval.jsonl 与 feedback.jsonl 检索使用统计
//
// 输出: 每模块 A–E 评级（50% 证据 / 30% 场景覆盖 / 20% Gap 闭环）+ 检索使用统计。
// 评估结果追加到 <state_root>/knowledge-health/<module>/confidence-history.jsonl。
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { calculateKnowledgeConfidence, deriveNavigationCases, gradeFromScore } from './scan/knowledge-confidence.mjs'
import { evaluateKnowledgeBase, inspectModuleIndex, moduleDirs, moduleNameFromManifest } from './scan/knowledge-retrieval.mjs'
import { knowledgeRootRelative, statePath } from './config.mjs'
import { readGapStates } from './quality-state.mjs'
import { buildUsageReport, loadEvalCases, recordEvaluationRun } from './report.mjs'

function readJson(filePath, fallback = null) {
  try { return JSON.parse(readFileSync(filePath, 'utf8')) } catch { return fallback }
}

function gitFreshness(projectRoot, moduleDir) {
  try {
    const manifest = parseYaml(readFileSync(join(moduleDir, 'manifest.yml'), 'utf8')) || {}
    const base = String(manifest.base_commit || '').trim()
    if (!base) return { status: 'unknown', behind_commits: null, dirty_files: null }
    const run = args => execFileSync('git', ['-C', projectRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    execFileSync('git', ['-C', projectRoot, 'merge-base', '--is-ancestor', base, 'HEAD'], { stdio: 'ignore' })
    const behind = Number(run(['rev-list', '--count', `${base}..HEAD`]))
    const dirty = run(['status', '--porcelain']).split(/\r?\n/).filter(Boolean).length
    return { status: behind > 0 ? 'stale' : 'current', behind_commits: behind, dirty_files: dirty }
  } catch {
    return { status: 'unknown', behind_commits: null, dirty_files: null }
  }
}

function listMarkdown(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const filePath = join(dir, entry.name)
    if (entry.isDirectory()) return listMarkdown(filePath)
    return entry.isFile() && entry.name.endsWith('.md') ? [filePath] : []
  })
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
    frameworkFacts: readJson(join(navigationDir, 'framework-facts.json'), {}),
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

// 用户确认后增补的 overlay 知识（codewiki-query 差评反哺产物），source=user 参与场景覆盖。
function overlayCases(projectRoot, moduleName) {
  const overlayPath = statePath(projectRoot, 'knowledge-overlay', `${encodeURIComponent(moduleName)}.jsonl`)
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

function persistentGaps(projectRoot, moduleName) {
  return readGapStates(projectRoot)
    .filter(gap => gap.module === moduleName)
    .map(gap => ({
      id: gap.id,
      status: gap.status,
      evidence_refs: [...gap.knowledge_ids, ...gap.eval_case_ids],
      question: gap.query,
      count: gap.occurrences,
      kind: gap.kind,
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

export function assessModuleConfidence(projectRoot, module, traces, feedbacks, days) {
  const markdownContents = ['product', 'developer', 'quality', 'frontend'].flatMap(layer => listMarkdown(join(module.dir, layer)))
    .map(file => readFileSync(file, 'utf8'))
  const validation = evidenceFromValidationReport(module.dir)
  const coveredCases = [
    ...caseCoveredInDocs(navigationInputs(module.dir), markdownContents),
    ...overlayCases(projectRoot, module.name),
  ]
  const usage = usageStats(traces, feedbacks, module.name)
  const gaps = persistentGaps(projectRoot, module.name)
  let index = null
  try { index = inspectModuleIndex(projectRoot, module.dir) } catch { index = null }

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
    knowledge_freshness: index?.knowledge_freshness || {
      total: 0,
      current: 0,
      stale: 0,
      unverified: 0,
      current_rate: null,
      items: [],
    },
    git_freshness: gitFreshness(projectRoot, module.dir),
    graph: index?.graph_stats || null,
    overall_confidence: {
      ...confidence.overall_confidence,
      grade: gradeFromScore(confidence.overall_confidence.score),
      policy: 'codewiki-confidence-v2',
    },
    hints: [
      ...(validation == null ? ['缺少 validation-report.json — 使用 codewiki generate <target> --module <module> --finalize 完成证据校验'] : []),
      ...(coveredCases.length === 0 ? ['未发现确定性场景用例（分支、状态、超时、Endpoint 与跨语言链路均为空）'] : []),
      ...(usage.query_count === 0 ? ['暂无检索命中记录 — MCP/查询使用后，case 命中将参与置信度评估'] : []),
      ...(usage.rated_count === 0 && usage.query_count > 0 ? ['暂无用户评级 — 检索回答后邀请用户评级，并用 codewiki query --feedback 记录'] : []),
      ...(index?.knowledge_freshness?.stale > 0 ? [`${index.knowledge_freshness.stale} 条知识的代码证据已变化，需要 generate --update 后重新确认`] : []),
      ...(index?.knowledge_freshness?.unverified > 0 ? [`${index.knowledge_freshness.unverified} 条知识缺少可验证的图证据`] : []),
    ],
  }
}

function renderReport(result) {
  const lines = ['# CodeWiki 知识健康报告', '', `统计范围：最近 ${result.window_days} 天`]
  for (const module of result.modules) {
    lines.push(`\n## ${module.module}`)
    const cases = module.case_report
    const gaps = cases.gaps
    const git = module.git_freshness
    const knowledgeStatus = git.status === 'unknown'
      ? '无法判断'
      : git.behind_commits > 0 ? '需更新' : '当前'
    const gitDetail = git.status === 'unknown'
      ? '缺少可比较的 Git 生成基线'
      : `落后 ${git.behind_commits} 个提交${git.dirty_files ? `，${git.dirty_files} 个未提交改动` : ''}`
    const caseDetail = `已验证 ${cases.matched} 个，待补 ${cases.missing} 个${cases.candidate ? `，待复核 ${cases.candidate} 个` : ''}`
    lines.push('', '| 关注项 | 当前状态 | 说明 |', '| --- | --- | --- |')
    lines.push(`| 知识状态 | ${knowledgeStatus} | ${gitDetail} |`)
    lines.push(`| 历史检索问题 | ${cases.unique_queries} 个 | 去重后的真实用户问题 |`)
    lines.push(`| Case | ${cases.matched} 个已验证 | ${caseDetail} |`)
    lines.push(`| Gap | ${gaps.open} 个待处理 | 历史共 ${gaps.total} 个 |`)
  }
  return lines.join('\n')
}

export async function runConfidence(options = {}) {
  const projectRoot = resolve(options.projectRoot || process.cwd())
  const modules = discoverModules(projectRoot, options.module)
  if (modules.length === 0) {
    process.stderr.write(`[codewiki] 未找到知识库模块${options.module ? `: ${options.module}` : ''}（期望 ${knowledgeRootRelative(projectRoot)}/<module>/manifest.yml；先运行 npx codewiki init，再使用 codewiki-generate Skill）\n`)
    return 1
  }
  const days = Math.max(1, Number(options.days) || 30)
  for (const module of modules) {
    const cases = loadEvalCases(projectRoot, module.name).filter(item => item.status === 'active')
    if (cases.length === 0) continue
    const evaluation = evaluateKnowledgeBase({ ...options, projectRoot, module: module.name, cases })
    recordEvaluationRun(projectRoot, evaluation, `${knowledgeRootRelative(projectRoot)}/${module.name}/retrieval-cases.json`)
  }
  const traces = readJsonlSince(statePath(projectRoot, 'retrieval.jsonl'), days)
  const feedbacks = readJsonlSince(statePath(projectRoot, 'feedback.jsonl'), days)
  const assessed = modules.map(module => {
    const confidence = assessModuleConfidence(projectRoot, module, traces, feedbacks, days)
    const usage = buildUsageReport(projectRoot, { days, module: module.name })
    return {
      ...confidence,
      case_report: {
        active_cases: usage.case_coverage.active_cases,
        unique_queries: usage.usage.unique_query_count,
        matched: usage.case_coverage.matched,
        candidate: usage.case_coverage.candidate,
        missing: usage.case_coverage.missing,
        coverage_rate: usage.case_coverage.coverage_rate,
        helpful_rate: usage.usage.helpful_rate,
        matched_queries: usage.case_coverage.matched_queries,
        missing_queries: usage.case_coverage.missing_queries,
        candidate_queries: usage.case_coverage.candidate_queries,
        feedback: usage.feedback,
        gaps: usage.gaps,
        case_assets: usage.case_assets,
        optimization_candidates: usage.optimization_candidates,
        regression: usage.regression,
      },
    }
  })
  const result = {
    generated_at: new Date().toISOString(),
    project_root: projectRoot,
    window_days: days,
    modules: assessed,
  }

  // 追加审计历史（只增不改，供后续趋势分析）
  for (const module of assessed) {
    try {
      const dir = statePath(projectRoot, 'knowledge-health', module.module)
      mkdirSync(dir, { recursive: true })
      appendFileSync(join(dir, 'confidence-history.jsonl'), `${JSON.stringify({
        at: result.generated_at,
        overall: module.overall_confidence,
        evidence_score: module.evidence?.evidenceScore ?? null,
        knowledge_freshness: module.knowledge_freshness,
        usage: {
          query_count: module.retrieval_usage.query_count,
          found_rate: module.retrieval_usage.found_rate,
          bad_rate: module.retrieval_usage.bad_rate,
        },
        real_questions: {
          unique: module.case_report.unique_queries,
          matched: module.case_report.matched,
          candidate: module.case_report.candidate,
          missing: module.case_report.missing,
          rating_coverage_rate: module.case_report.feedback.rating_coverage_rate,
        },
        gaps: {
          total: module.case_report.gaps.total,
          open: module.case_report.gaps.open,
          closed: module.case_report.gaps.closed,
          linked_cases: module.case_report.gaps.linked_cases,
        },
        case_assets: module.case_report.case_assets,
      })}\n`, 'utf8')
    } catch { /* 历史写入失败不阻断评估 */ }
  }

  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  else process.stdout.write(`${renderReport(result)}\n`)
  return 0
}
