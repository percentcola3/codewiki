import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { statePath } from './config.mjs'

export function normalizeQuery(value) {
  return String(value || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ' ').trim()
}

function shortHash(value, length = 12) {
  return createHash('sha1').update(String(value)).digest('hex').slice(0, length)
}

export function createGapId(moduleName, query, kind) {
  const module = String(moduleName || 'unknown').trim().toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown'
  return `gap:${module}:${shortHash(`${module}\n${normalizeQuery(query)}\n${kind || 'knowledge_gap'}`)}`
}

export function createFeedbackId({ retrievalId, query, rating, at }) {
  return `feedback:${shortHash(`${retrievalId || ''}\n${normalizeQuery(query)}\n${rating}\n${at}`, 16)}`
}

export function createRetrievalId({ query, at, nonce = '' }) {
  return `ret_${shortHash(`${normalizeQuery(query)}\n${at}\n${nonce}`, 16)}`
}

export function appendJsonl(filePath, record) {
  mkdirSync(dirname(filePath), { recursive: true })
  appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8')
}

export function readJsonl(filePath) {
  if (!existsSync(filePath)) return []
  return readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

export function readJsonlSince(filePath, days = 30) {
  const cutoff = Date.now() - Math.max(1, Number(days) || 30) * 24 * 60 * 60 * 1000
  return readJsonl(filePath).filter(record => !record.at || Date.parse(record.at) >= cutoff)
}

export function findRetrieval(projectRoot, retrievalId) {
  if (!retrievalId) return null
  return readJsonl(statePath(projectRoot, 'retrieval.jsonl')).find(item => item.retrieval_id === retrievalId) || null
}

export function appendGapEvent(projectRoot, event) {
  if (!event?.gap_id || !event?.event) throw new Error('Gap 事件缺少 gap_id 或 event')
  const record = { at: event.at || new Date().toISOString(), ...event }
  appendJsonl(statePath(projectRoot, 'gaps.jsonl'), record)
  return record
}

export function openGap(projectRoot, { module, query, kind, retrievalId, feedbackId, at }) {
  const gapId = createGapId(module, query, kind)
  appendGapEvent(projectRoot, {
    at,
    gap_id: gapId,
    event: 'opened',
    module: module || null,
    query,
    kind,
    ...(retrievalId ? { retrieval_id: retrievalId } : {}),
    ...(feedbackId ? { feedback_id: feedbackId } : {}),
  })
  return gapId
}

export function reduceGapEvents(events) {
  const gaps = new Map()
  for (const event of events) {
    if (!event?.gap_id) continue
    const gap = gaps.get(event.gap_id) || {
      id: event.gap_id,
      module: event.module || null,
      query: event.query || '',
      kind: event.kind || 'knowledge_gap',
      status: 'open',
      occurrences: 0,
      knowledge_ids: [],
      eval_case_ids: [],
      opened_at: event.at || null,
      updated_at: event.at || null,
    }
    if (event.module) gap.module = event.module
    if (event.query) gap.query = event.query
    if (event.kind) gap.kind = event.kind
    gap.updated_at = event.at || gap.updated_at
    if (event.event === 'opened') {
      gap.occurrences += 1
      gap.status = gap.status === 'closed' ? 'reopened' : 'open'
    } else if (event.event === 'linked_knowledge' && event.knowledge_id) {
      gap.knowledge_ids = [...new Set([...gap.knowledge_ids, event.knowledge_id])]
    } else if (event.event === 'linked_eval_case' && event.eval_case_id) {
      gap.eval_case_ids = [...new Set([...gap.eval_case_ids, event.eval_case_id])]
    } else if (event.event === 'closed') {
      gap.status = 'closed'
      gap.closed_at = event.at || null
      gap.evaluation_run_id = event.evaluation_run_id || null
    } else if (event.event === 'reopened') {
      gap.status = 'reopened'
      gap.evaluation_run_id = event.evaluation_run_id || gap.evaluation_run_id
    }
    gaps.set(event.gap_id, gap)
  }
  return [...gaps.values()].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
}

export function readGapStates(projectRoot) {
  return reduceGapEvents(readJsonl(statePath(projectRoot, 'gaps.jsonl')))
}
