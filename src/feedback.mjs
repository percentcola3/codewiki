// User feedback and confirmed knowledge promotion.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { moduleDirs, moduleNameFromManifest } from './scan/knowledge-retrieval.mjs'
import { statePath } from './config.mjs'
import {
  appendGapEvent,
  appendJsonl,
  createFeedbackId,
  findRetrieval,
  openGap,
  readJsonl,
  readGapStates,
} from './quality-state.mjs'
import { runEvalAdd } from './report.mjs'

const KNOWLEDGE_KINDS = new Set(['manual', 'feedback', 'defect', 'incident', 'decision'])
const EVIDENCE_TYPES = new Set(['code', 'commit', 'test', 'issue', 'document', 'user_confirmed'])
const KIND_DIRS = {
  manual: 'manual',
  feedback: 'manual',
  defect: 'defects',
  incident: 'incidents',
  decision: 'decisions',
}

function slug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
}

function asList(value) {
  if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean)
  if (typeof value === 'string') return value.split(/\r?\n|\s*,\s*/).map(item => item.trim()).filter(Boolean)
  return []
}

function parseEvidence(value) {
  const raw = String(value || '').trim()
  for (const type of EVIDENCE_TYPES) {
    if (raw.startsWith(`${type}:`)) {
      const ref = raw.slice(type.length + 1).trim()
      if (!ref) throw new Error(`${type}: 后缺少证据引用`)
      return { type, ref }
    }
  }
  if (/^.+:\d+$/.test(raw)) return { type: 'code', ref: raw }
  throw new Error(`无法识别证据类型: ${raw}；使用 code:、commit:、test:、issue:、document: 或 user_confirmed: 前缀`)
}

function moduleDirectory(projectRoot, requestedModule) {
  const dirs = moduleDirs(projectRoot, requestedModule)
  if (dirs.length === 0) throw new Error(`未找到知识库模块: ${requestedModule}`)
  if (dirs.length > 1) throw new Error(`模块不明确: ${requestedModule}`)
  return dirs[0]
}

function readKnowledgeFile(filePath) {
  const content = readFileSync(filePath, 'utf8')
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/)
  if (!match) return { content, match: null, data: {} }
  try { return { content, match, data: parseYaml(match[1]) || {} } } catch { return { content, match, data: {} } }
}

function findKnowledgeId(dir, id) {
  if (!existsSync(dir)) return null
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const filePath = join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = findKnowledgeId(filePath, id)
      if (nested) return nested
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      if (readKnowledgeFile(filePath).data.id === id) return filePath
    }
  }
  return null
}

export function runFeedback({ rating, query, retrievalId, module, comment, projectRoot, quiet = false, onResult }) {
  if (!['good', 'bad'].includes(rating)) {
    process.stderr.write('[codewiki] --feedback 必须是 good 或 bad\n')
    return 1
  }
  const retrieval = findRetrieval(projectRoot, retrievalId)
  if (retrievalId && !retrieval) {
    process.stderr.write(`[codewiki] 未找到 --retrieval-id: ${retrievalId}\n`)
    return 1
  }
  const resolvedQuery = String(query || retrieval?.query || '').trim()
  const resolvedModule = module || retrieval?.module || retrieval?.modules?.[0] || null
  if (!resolvedQuery) {
    process.stderr.write('[codewiki] --query 不能为空；也可以提供可定位查询的 --retrieval-id\n')
    return 1
  }
  const at = new Date().toISOString()
  const feedbackId = createFeedbackId({ retrievalId, query: resolvedQuery, rating, at })
  const record = {
    feedback_id: feedbackId,
    at,
    query: resolvedQuery,
    module: resolvedModule,
    rating,
    ...(retrievalId ? { retrieval_id: retrievalId } : {}),
    ...(comment ? { comment } : {}),
  }
  appendJsonl(statePath(projectRoot, 'feedback.jsonl'), record)
  let evalCase = null
  // 好评是用户对真实问题的显式确认；只有检索确实提供知识证据时才沉淀为 Case。
  if (rating === 'good' && retrieval && resolvedModule && retrieval.found && Array.isArray(retrieval.knowledge_ids) && retrieval.knowledge_ids.length > 0) {
    const code = runEvalAdd({
      projectRoot,
      retrievalId,
      module: resolvedModule,
      query: resolvedQuery,
      quiet: true,
      onResult: result => { evalCase = result },
    })
    if (code !== 0) process.stderr.write('[codewiki] 已保存好评，但未能沉淀 feedback Case\n')
  }
  let gapId = null
  if (rating === 'bad') {
    const gapKind = retrieval && retrieval.found === false ? 'retrieval_miss' : 'bad_rating'
    gapId = openGap(projectRoot, {
      module: resolvedModule,
      query: resolvedQuery,
      kind: gapKind,
      retrievalId,
      feedbackId,
      at,
    })
  }
  const result = { feedback_id: feedbackId, rating, query: resolvedQuery, module: resolvedModule, ...(evalCase ? { eval_case_id: evalCase.id } : {}), ...(gapId ? { gap_id: gapId } : {}) }
  onResult?.(result)
  if (!quiet) {
    process.stdout.write(`[codewiki] 已记录评级 ${rating}：${resolvedQuery.slice(0, 60)}（feedback_id=${feedbackId}）\n`)
    if (evalCase) process.stdout.write(`[codewiki] 已沉淀反馈确认 Case：${evalCase.id}\n`)
    if (gapId) process.stdout.write(`[codewiki] 已打开知识 Gap：${gapId}\n`)
  }
  return 0
}

// 兼容旧版本：在好评尚未自动建 Case 时留下的真实确认，升级后一次性补齐。
export function promoteGoodFeedbackCases(projectRoot) {
  const feedbacks = readJsonl(statePath(projectRoot, 'feedback.jsonl')).filter(item => item.rating === 'good' && item.retrieval_id)
  let promoted = 0
  for (const feedback of feedbacks) {
    const retrieval = findRetrieval(projectRoot, feedback.retrieval_id)
    const module = feedback.module || retrieval?.module || retrieval?.modules?.[0]
    if (!retrieval?.found || !module || !Array.isArray(retrieval.knowledge_ids) || retrieval.knowledge_ids.length === 0) continue
    let result = null
    const code = runEvalAdd({ projectRoot, retrievalId: feedback.retrieval_id, module, query: retrieval.query, quiet: true, onResult: item => { result = item } })
    if (code === 0 && result && !result.existing) promoted++
  }
  return promoted
}

export function runKnowledgeAdd(options) {
  const { title, answer, projectRoot } = options
  const requestedModule = String(options.module || '').trim()
  const missing = [
    !requestedModule && 'module',
    !String(title || '').trim() && 'title',
    !String(options.question || options.query || '').trim() && 'question',
    !String(answer || '').trim() && 'answer',
  ].filter(Boolean)
  if (missing.length > 0) {
    process.stderr.write(`[codewiki] generate 补充知识缺少必填参数: ${missing.map(key => `--${key}`).join(' ')}\n`)
    return 1
  }

  const kind = String(options.kind || 'manual').trim().toLowerCase()
  if (!KNOWLEDGE_KINDS.has(kind)) {
    process.stderr.write(`[codewiki] --kind 必须是 ${[...KNOWLEDGE_KINDS].join('|')}\n`)
    return 1
  }

  let sources
  try { sources = asList(options.evidence).map(parseEvidence) } catch (error) {
    process.stderr.write(`[codewiki] ${error.message}\n`)
    return 1
  }
  if (sources.length === 0) {
    process.stderr.write('[codewiki] generate 补充知识至少需要一条 --evidence（知识必须可追证）\n')
    return 1
  }
  if (kind === 'defect' && !sources.some(source => ['code', 'commit', 'test'].includes(source.type))) {
    process.stderr.write('[codewiki] defect 至少需要 code、commit 或 test 证据之一\n')
    return 1
  }

  const moduleDir = moduleDirectory(projectRoot, requestedModule)
  const moduleName = moduleNameFromManifest(moduleDir)
  const questions = asList(options.question || options.query)
  const gaps = asList(options.gapIds)
  const knownGaps = new Map(readGapStates(projectRoot).map(gap => [gap.id, gap]))
  const invalidGaps = gaps.filter(gapId => {
    const gap = knownGaps.get(gapId)
    return !gap || (gap.module && gap.module !== 'unknown' && gap.module !== moduleName)
  })
  if (invalidGaps.length > 0) {
    process.stderr.write(`[codewiki] --gap-id 不存在或不属于模块 ${moduleName}: ${invalidGaps.join(', ')}\n`)
    return 1
  }
  const topicHash = createHash('sha1').update(`${moduleName}\n${kind}\n${title}\n${questions.join('\n')}`).digest('hex').slice(0, 10)
  const id = options.id || `kb:${moduleName}:quality:${kind}:${topicHash}`
  if (!id.startsWith(`kb:${moduleName}:quality:`)) {
    process.stderr.write(`[codewiki] generate --id 必须以 kb:${moduleName}:quality: 开头\n`)
    return 1
  }
  const dir = join(moduleDir, 'quality', KIND_DIRS[kind])
  const filePath = join(dir, `${slug(title) || kind}-${topicHash}.md`)
  const existingIdPath = findKnowledgeId(moduleDir, id)
  if (existingIdPath) {
    const existing = readKnowledgeFile(existingIdPath)
    if (existing.data.title && existing.data.title !== String(title).trim()) {
      process.stderr.write(`[codewiki] knowledge id 已被其他标题占用：${id}（${existing.data.title}）\n`)
      return 1
    }
    const nextGaps = [...new Set([...asList(existing.data.closes_gaps), ...gaps])]
    if (existing.match && nextGaps.length !== asList(existing.data.closes_gaps).length) {
      const nextFrontmatter = { ...existing.data, closes_gaps: nextGaps }
      const nextContent = `---\n${stringifyYaml(nextFrontmatter).trim()}\n---\n\n${existing.content.slice(existing.match[0].length)}`
      writeFileSync(existingIdPath, nextContent, 'utf8')
    }
    for (const gapId of gaps) appendGapEvent(projectRoot, { gap_id: gapId, event: 'linked_knowledge', module: moduleName, knowledge_id: id })
    options.onResult?.({ id, filePath: existingIdPath, existing: true, module: moduleName })
    process.stdout.write(`[codewiki] knowledge 已存在：${id}\n`)
    process.stdout.write(`[codewiki] 文件：${existingIdPath}\n`)
    return 0
  }
  if (existsSync(filePath)) {
    process.stderr.write(`[codewiki] 目标文件已存在但 knowledge id 不同：${filePath}\n`)
    return 1
  }

  const frontmatter = {
    id,
    kind,
    title: String(title).trim(),
    status: 'active',
    aliases: asList(options.aliases).length > 0 ? asList(options.aliases) : [String(title).trim()],
    questions,
    entities: asList(options.entities).length > 0 ? asList(options.entities) : [moduleName],
    source: 'user',
    ...(options.sourceRef ? { source_ref: options.sourceRef } : {}),
    ...(gaps.length > 0 ? { closes_gaps: gaps } : {}),
    sources,
  }
  const evidenceLines = sources.map(source => `- ${source.type}: ${source.ref}`).join('\n')
  const content = `---\n${stringifyYaml(frontmatter).trim()}\n---\n\n# ${String(title).trim()}\n\n## 结论\n\n${String(answer).trim()}\n\n## 证据\n\n${evidenceLines}\n`
  mkdirSync(dir, { recursive: true })
  writeFileSync(filePath, content, 'utf8')

  for (const gapId of gaps) appendGapEvent(projectRoot, { gap_id: gapId, event: 'linked_knowledge', module: moduleName, knowledge_id: id })
  options.onResult?.({ id, filePath, existing: false, module: moduleName })
  process.stdout.write(`[codewiki] 已新增共享知识：${id}\n`)
  process.stdout.write(`[codewiki] 文件：${filePath}\n`)
  process.stdout.write('[codewiki] 知识文件可提交 Git 供团队共享。\n')
  return 0
}
