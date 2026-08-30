import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { moduleDirs, moduleNameFromManifest, tokenize } from './scan/knowledge-retrieval.mjs'
import { statePath } from './config.mjs'
import {
  appendGapEvent,
  findRetrieval,
  normalizeQuery,
  readGapStates,
  readJsonlSince,
} from './quality-state.mjs'

function shortHash(value, length = 12) {
  return createHash('sha1').update(String(value)).digest('hex').slice(0, length)
}

function asList(value) {
  if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean)
  if (typeof value === 'string' && value.trim()) return [value.trim()]
  return []
}

function readJson(filePath, fallback = null) {
  try { return JSON.parse(readFileSync(filePath, 'utf8')) } catch { return fallback }
}

function stableEvalId(moduleName, query) {
  const module = String(moduleName || 'all').toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, '-')
  return `eval:${module || 'all'}:${shortHash(`${moduleName}\n${normalizeQuery(query)}`)}`
}

// 自动生成的题目只用于检索链路冒烟检查；只有真实来源的题目才是用户可见的 Case 资产。
const REAL_CASE_SOURCES = new Set(['feedback', 'curated', 'manual', 'prd', 'test', 'defect', 'incident', 'history', 'user'])

function isRealCase(item) {
  return REAL_CASE_SOURCES.has(String(item.source || '').toLowerCase())
}

export function loadEvalCases(projectRoot, requestedModule) {
  const output = []
  for (const moduleDir of moduleDirs(projectRoot, requestedModule)) {
    const module = moduleNameFromManifest(moduleDir)
    const filePath = join(moduleDir, 'retrieval-cases.json')
    const parsed = readJson(filePath, { cases: [] })
    const cases = Array.isArray(parsed) ? parsed : parsed?.cases
    for (const item of Array.isArray(cases) ? cases : []) {
      if (!item?.query) continue
      output.push({
        ...item,
        id: item.id || stableEvalId(item.module || module, item.query),
        module: item.module || module,
        status: item.status || 'active',
      expected_knowledge_ids: asList(item.expected_knowledge_ids || item.expectedKnowledgeIds),
      required_evidence_ids: asList(item.required_evidence_ids || item.requiredEvidenceIds),
      gap_ids: asList(item.gap_ids || item.gapIds),
      source: String(item.source || 'generated'),
      source_ref: item.source_ref || item.sourceRef || null,
      created_at: item.created_at || item.createdAt || null,
      _file: filePath,
        _generated_id: !item.id,
      })
    }
  }
  return output
}

function moduleDirectory(projectRoot, requestedModule) {
  const dirs = moduleDirs(projectRoot, requestedModule)
  if (dirs.length !== 1) throw new Error(dirs.length === 0 ? `未找到知识库模块: ${requestedModule}` : `模块不明确: ${requestedModule}`)
  return dirs[0]
}

export function runEvalAdd(options) {
  const retrieval = findRetrieval(options.projectRoot, options.retrievalId)
  if (options.retrievalId && !retrieval) {
    process.stderr.write(`[codewiki] 未找到 --retrieval-id: ${options.retrievalId}\n`)
    return 1
  }
  const query = String(options.query || options.question || retrieval?.query || '').trim()
  const requestedModule = options.module || retrieval?.module || retrieval?.modules?.[0]
  if (!query || !requestedModule) {
    process.stderr.write('[codewiki] generate 创建 Eval Case 需要 --module 和 --question；也可以用 --retrieval-id 补全\n')
    return 1
  }
  const moduleDir = moduleDirectory(options.projectRoot, requestedModule)
  const module = moduleNameFromManifest(moduleDir)
  const explicitKnowledgeIds = asList(options.knowledgeIds)
  const explicitEvidenceIds = asList(options.evidenceIds)
  const expectedKnowledgeIds = explicitKnowledgeIds.length > 0 ? explicitKnowledgeIds : asList(retrieval?.knowledge_ids)
  const requiredEvidenceIds = explicitEvidenceIds.length > 0 ? explicitEvidenceIds : asList(retrieval?.evidence_ids)
  if (expectedKnowledgeIds.length === 0 && options.expectFound !== false) {
    process.stderr.write('[codewiki] generate 创建 Eval Case 缺少 Knowledge ID；无答案用例请传 --expect-not-found\n')
    return 1
  }

  const matchingGaps = readGapStates(options.projectRoot)
    .filter(gap => gap.module === module && normalizeQuery(gap.query) === normalizeQuery(query))
    .map(gap => gap.id)
  const gapIds = asList(options.gapIds).length > 0 ? asList(options.gapIds) : matchingGaps
  const knownGaps = new Map(readGapStates(options.projectRoot).map(gap => [gap.id, gap]))
  const invalidGaps = gapIds.filter(gapId => {
    const gap = knownGaps.get(gapId)
    return !gap || (gap.module && gap.module !== 'unknown' && gap.module !== module)
  })
  if (invalidGaps.length > 0) {
    process.stderr.write(`[codewiki] --gap-id 不存在或不属于模块 ${module}: ${invalidGaps.join(', ')}\n`)
    return 1
  }
  const id = options.evalCaseId || options.id || stableEvalId(module, query)
  const record = {
    id,
    status: 'active',
    module,
    query,
    source: options.retrievalId ? 'feedback' : 'curated',
    ...(options.retrievalId ? { source_ref: options.retrievalId } : {}),
    created_at: new Date().toISOString(),
    ...(options.expectFound === false ? { expect_found: false } : { expected_knowledge_ids: expectedKnowledgeIds }),
    ...(requiredEvidenceIds.length > 0 ? { required_evidence_ids: requiredEvidenceIds } : {}),
    ...(gapIds.length > 0 ? { gap_ids: gapIds } : {}),
    ...(asList(options.tags).length > 0 ? { tags: asList(options.tags) } : {}),
  }

  const filePath = join(moduleDir, 'retrieval-cases.json')
  const parsed = readJson(filePath, { cases: [] })
  const cases = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.cases) ? parsed.cases : []
  const existingIndex = cases.findIndex(item => item.id === id)
  let nextCases
  if (existingIndex >= 0) {
    const existing = cases[existingIndex]
    if (normalizeQuery(existing.query) !== normalizeQuery(query) || (existing.module && existing.module !== module)) {
      process.stderr.write(`[codewiki] Eval Case id 已被其他问题占用：${id}\n`)
      return 1
    }
    const merged = {
      ...existing,
      ...record,
      created_at: existing.created_at || existing.createdAt || record.created_at,
      expected_knowledge_ids: [...new Set([...asList(existing.expected_knowledge_ids), ...asList(record.expected_knowledge_ids)])],
      required_evidence_ids: [...new Set([...asList(existing.required_evidence_ids), ...asList(record.required_evidence_ids)])],
      gap_ids: [...new Set([...asList(existing.gap_ids), ...gapIds])],
      tags: [...new Set([...asList(existing.tags), ...asList(record.tags)])],
    }
    for (const key of ['expected_knowledge_ids', 'required_evidence_ids', 'gap_ids', 'tags']) {
      if (merged[key].length === 0) delete merged[key]
    }
    if (options.expectFound === false) delete merged.expected_knowledge_ids
    else delete merged.expect_found
    nextCases = [...cases]
    nextCases[existingIndex] = merged
  } else {
    nextCases = [...cases, record]
  }
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, `${JSON.stringify({ cases: nextCases }, null, 2)}\n`, 'utf8')
  for (const gapId of gapIds) appendGapEvent(options.projectRoot, { gap_id: gapId, event: 'linked_eval_case', module, eval_case_id: id })
  const result = { id, filePath, existing: existingIndex >= 0, module, source: record.source }
  options.onResult?.(result)
  if (!options.quiet) {
    process.stdout.write(`[codewiki] 已${existingIndex >= 0 ? '更新' : '新增'} Eval Case：${id}\n`)
    process.stdout.write(`[codewiki] 文件：${filePath}\n`)
  }
  return 0
}

export function recordEvaluationRun(projectRoot, evaluation, casesPath) {
  const generatedAt = new Date().toISOString()
  const runId = `evalrun_${shortHash(`${generatedAt}\n${casesPath}\n${JSON.stringify(evaluation.summary)}`, 16)}`
  const run = { run_id: runId, generated_at: generatedAt, cases_path: casesPath, ...evaluation }
  const outPath = statePath(projectRoot, 'evaluation-runs', `${runId}.json`)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8')

  const gaps = new Map(readGapStates(projectRoot).map(gap => [gap.id, gap]))
  for (const result of evaluation.cases || []) {
    for (const gapId of result.gap_ids || []) {
      const gap = gaps.get(gapId)
      if (gap && !gap.eval_case_ids.includes(result.id)) {
        appendGapEvent(projectRoot, { gap_id: gapId, event: 'linked_eval_case', eval_case_id: result.id })
        gap.eval_case_ids.push(result.id)
      }
    }
  }
  const resultsById = new Map((evaluation.cases || []).map(item => [item.id, item]))
  for (const gap of gaps.values()) {
    const linkedResults = gap.eval_case_ids.map(id => resultsById.get(id)).filter(Boolean)
    const allLinkedCasesPassed = gap.eval_case_ids.length > 0
      && linkedResults.length === gap.eval_case_ids.length
      && linkedResults.every(item => item.pass)
    if (gap.knowledge_ids.length > 0 && allLinkedCasesPassed && gap.status !== 'closed') {
      appendGapEvent(projectRoot, { gap_id: gap.id, event: 'closed', evaluation_run_id: runId })
    } else if (gap.status === 'closed' && linkedResults.some(item => !item.pass)) {
      appendGapEvent(projectRoot, { gap_id: gap.id, event: 'reopened', evaluation_run_id: runId })
    }
  }
  return run
}

function latestEvaluationRun(projectRoot, module) {
  const dir = statePath(projectRoot, 'evaluation-runs')
  if (!existsSync(dir)) return null
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => readJson(join(dir, entry.name), null))
    .filter(Boolean)
    .filter(run => !module || run.cases?.some(item => item.module === module))
    .sort((a, b) => String(b.generated_at).localeCompare(String(a.generated_at)))[0] || null
}

function overlap(left, right) {
  const a = new Set(left)
  const b = new Set(right)
  const union = new Set([...a, ...b])
  if (union.size === 0) return 0
  let intersection = 0
  for (const item of a) if (b.has(item)) intersection++
  return intersection / union.size
}

function matchTraceToCases(trace, cases) {
  const scoped = cases.filter(item => isRealCase(item) && item.status === 'active' && (!item.module || item.module === trace.module || trace.modules?.includes(item.module)))
  const explicit = scoped.find(item => asList(trace.eval_case_ids).includes(item.id) || item.source_ref === trace.retrieval_id)
  if (explicit) return { status: 'matched', case_id: explicit.id, reason: 'explicit' }
  const normalized = normalizeQuery(trace.query)
  const exact = scoped.find(item => normalizeQuery(item.query) === normalized)
  if (exact) return { status: 'matched', case_id: exact.id, reason: 'exact' }
  const terms = tokenize(trace.query)
  const candidate = scoped
    .map(item => ({ item, score: overlap(terms, tokenize(item.query)) }))
    .filter(item => item.score >= 0.6)
    .sort((a, b) => b.score - a.score)[0]
  return candidate
    ? { status: 'candidate', case_id: candidate.item.id, reason: 'token', score: Number(candidate.score.toFixed(3)) }
    : { status: 'missing', case_id: null, reason: 'none' }
}

function sourceStats(cases, days) {
  const cutoff = Date.now() - Math.max(1, Number(days) || 30) * 24 * 60 * 60 * 1000
  const bySource = {}
  let addedInWindow = 0
  let undated = 0
  const active = cases.filter(item => item.status === 'active')
  for (const item of active.filter(isRealCase)) {
    const source = item.source || 'generated'
    bySource[source] = (bySource[source] || 0) + 1
    if (!item.created_at) undated++
    else if (Date.parse(item.created_at) >= cutoff) addedInWindow++
  }
  return {
    active: active.filter(isRealCase).length,
    smoke_cases: active.filter(item => !isRealCase(item)).length,
    by_source: bySource,
    added_in_window: addedInWindow,
    undated,
  }
}

function feedbackStats(queries, feedbacks) {
  const ratedRetrievalIds = new Set(feedbacks.map(item => item.retrieval_id).filter(Boolean))
  const ratedQueries = new Set(feedbacks.map(item => normalizeQuery(item.query)).filter(Boolean))
  const rated = queries.filter(trace => ratedRetrievalIds.has(trace.retrieval_id) || ratedQueries.has(normalizeQuery(trace.query)))
  const good = feedbacks.filter(item => item.rating === 'good').length
  const bad = feedbacks.filter(item => item.rating === 'bad').length
  return {
    rated_queries: rated.length,
    unrated_queries: Math.max(0, queries.length - rated.length),
    rating_coverage_rate: queries.length > 0 ? Number((rated.length / queries.length).toFixed(3)) : null,
    good,
    bad,
    helpful_rate: good + bad > 0 ? Number((good / (good + bad)).toFixed(3)) : null,
  }
}

function optimizationCandidates(mappings, rawTraces, feedbacks) {
  const occurrences = new Map()
  for (const trace of rawTraces) {
    const key = normalizeQuery(trace.query)
    if (key) occurrences.set(key, (occurrences.get(key) || 0) + 1)
  }
  const badQueries = new Set(feedbacks.filter(item => item.rating === 'bad').map(item => normalizeQuery(item.query)))
  return mappings
    .filter(item => item.status !== 'matched' || badQueries.has(normalizeQuery(item.query)))
    .map(item => ({
      query: item.query,
      module: item.module,
      occurrences: occurrences.get(normalizeQuery(item.query)) || 1,
      status: item.status,
      ...(item.case_id ? { case_id: item.case_id } : {}),
      reason: item.reason,
      ...(badQueries.has(normalizeQuery(item.query)) ? { bad_feedback: true } : {}),
      suggested_action: item.status === 'missing' ? 'add_case' : item.status === 'candidate' ? 'review_case_mapping' : 'review_bad_feedback',
    }))
    .sort((a, b) => Number(Boolean(b.bad_feedback)) - Number(Boolean(a.bad_feedback)) || b.occurrences - a.occurrences || a.query.localeCompare(b.query))
}

function uniqueQueries(traces) {
  const map = new Map()
  for (const trace of traces) {
    const module = trace.module || trace.modules?.[0] || 'unknown'
    const key = `${module}\n${normalizeQuery(trace.query)}`
    if (!normalizeQuery(trace.query)) continue
    const current = map.get(key)
    if (!current || String(trace.at) > String(current.at)) map.set(key, { ...trace, module })
  }
  return [...map.values()]
}

export function buildUsageReport(projectRoot, { days = 30, module } = {}) {
  const traces = readJsonlSince(statePath(projectRoot, 'retrieval.jsonl'), days)
    .filter(item => !module || item.module === module || item.modules?.includes(module))
  const feedbacks = readJsonlSince(statePath(projectRoot, 'feedback.jsonl'), days)
    .filter(item => !module || item.module === module || item.modules?.includes(module))
  const cases = loadEvalCases(projectRoot, module)
  const queries = uniqueQueries(traces)
  const mappings = queries.map(trace => ({ retrieval_id: trace.retrieval_id || null, query: trace.query, module: trace.module, found: Boolean(trace.found), ...matchTraceToCases(trace, cases) }))
  const matched = mappings.filter(item => item.status === 'matched')
  const candidates = mappings.filter(item => item.status === 'candidate')
  const missing = mappings.filter(item => item.status === 'missing')
  const rated = feedbacks.filter(item => ['good', 'bad'].includes(item.rating))
  const good = rated.filter(item => item.rating === 'good').length
  const gaps = readGapStates(projectRoot).filter(item => !module || item.module === module)
  const recentGapEvents = readJsonlSince(statePath(projectRoot, 'gaps.jsonl'), days).filter(item => !module || item.module === module)
  const latestEvaluation = latestEvaluationRun(projectRoot, module)
  return {
    generated_at: new Date().toISOString(),
    window_days: Math.max(1, Number(days) || 30),
    module: module || null,
    usage: {
      query_count: traces.length,
      unique_query_count: queries.length,
      found_rate: traces.length > 0 ? Number((traces.filter(item => item.found).length / traces.length).toFixed(3)) : null,
      rated_count: rated.length,
      helpful_rate: rated.length > 0 ? Number((good / rated.length).toFixed(3)) : null,
    },
    feedback: feedbackStats(queries, feedbacks),
    case_coverage: {
      active_cases: cases.filter(item => item.status === 'active' && isRealCase(item)).length,
      matched: matched.length,
      candidate: candidates.length,
      missing: missing.length,
      coverage_rate: queries.length > 0 ? Number((matched.length / queries.length).toFixed(3)) : null,
      matched_queries: matched,
      candidate_queries: candidates,
      missing_queries: missing,
    },
    case_assets: sourceStats(cases, days),
    regression: latestEvaluation ? {
      run_id: latestEvaluation.run_id,
      generated_at: latestEvaluation.generated_at,
      ...latestEvaluation.summary,
    } : null,
    gaps: {
      total: gaps.length,
      open: gaps.filter(item => item.status !== 'closed').length,
      closed: gaps.filter(item => item.status === 'closed').length,
      reopened: gaps.filter(item => item.status === 'reopened').length,
      linked_cases: gaps.filter(item => item.eval_case_ids.length > 0).length,
      unlinked_cases: gaps.filter(item => item.eval_case_ids.length === 0).length,
      opened_in_window: recentGapEvents.filter(item => item.event === 'opened').length,
      closed_in_window: recentGapEvents.filter(item => item.event === 'closed').length,
      reopened_in_window: recentGapEvents.filter(item => item.event === 'reopened').length,
      items: gaps,
    },
    optimization_candidates: optimizationCandidates(mappings, traces, feedbacks),
  }
}
