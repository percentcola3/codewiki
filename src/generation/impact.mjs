import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { classifyChange } from '../scan/fingerprint.mjs'
import { evidenceFingerprint, readGraph } from '../graph/store.mjs'

function readJson(filePath, fallback = null) {
  try { return JSON.parse(readFileSync(filePath, 'utf8')) } catch { return fallback }
}

function graphIndex(moduleDir) {
  return readJson(join(moduleDir, 'navigation', 'graph-index.json'), null)
}

function readJsonl(filePath) {
  if (!existsSync(filePath)) return []
  return readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

function graphChanges(baselineDir, moduleDir) {
  const before = readGraph(baselineDir)
  const after = readGraph(moduleDir)
  if (!before || !after) return []
  const beforeNodes = new Map(before.nodes.map(node => [node.id, evidenceFingerprint(node)]))
  const afterNodes = new Map(after.nodes.map(node => [node.id, evidenceFingerprint(node)]))
  return [...new Set([...beforeNodes.keys(), ...afterNodes.keys()])]
    .filter(id => beforeNodes.get(id) !== afterNodes.get(id))
    .sort()
}

function impactedAssets(baselineDir, moduleDir, navigationIds) {
  const changed = new Set(navigationIds)
  const bindings = [
    ...readJsonl(join(baselineDir, 'navigation', 'bindings.jsonl')),
    ...readJsonl(join(moduleDir, 'navigation', 'bindings.jsonl')),
  ]
  const knowledgeIds = [...new Set(bindings.filter(binding => changed.has(binding.navigation_id)).map(binding => binding.knowledge_id).filter(Boolean))].sort()
  const caseFile = readJson(join(moduleDir, 'retrieval-cases.json'), { cases: [] })
  const cases = Array.isArray(caseFile) ? caseFile : caseFile?.cases || []
  const evalCaseIds = cases
    .filter(item => (item.expected_knowledge_ids || []).some(id => knowledgeIds.includes(id)) || (item.required_evidence_ids || []).some(id => changed.has(id)))
    .map(item => item.id)
    .filter(Boolean)
    .sort()
  return { knowledge_ids: knowledgeIds, eval_case_ids: evalCaseIds }
}

export function classifyGeneratedImpact(baselineDir, moduleDir) {
  const before = existsSync(baselineDir) ? graphIndex(baselineDir) : null
  const after = graphIndex(moduleDir)
  if (!before || !after) {
    const changedNavigationIds = graphChanges(baselineDir, moduleDir)
    const assets = impactedAssets(baselineDir, moduleDir, changedNavigationIds)
    return {
      classification: 'KNOWLEDGE_IMPACT',
      reason: !before ? 'initial-generation' : 'missing-current-graph-index',
      files: [],
      changed_navigation_ids: changedNavigationIds,
      ...assets,
      summary: { NONE: 0, COSMETIC: 0, STRUCTURAL: 0, FIELD_ONLY: 0 },
    }
  }

  const paths = [...new Set([...Object.keys(before.files || {}), ...Object.keys(after.files || {})])].sort()
  const files = paths.map(path => ({ path, change: classifyChange(before.files?.[path], after.files?.[path]) }))
  const pageIds = [...new Set([...Object.keys(before.page_fingerprints || {}), ...Object.keys(after.page_fingerprints || {})])].sort()
  for (const pageId of pageIds) {
    files.push({ path: `page:${pageId}`, change: classifyChange(before.page_fingerprints?.[pageId], after.page_fingerprints?.[pageId]) })
  }
  const summary = { NONE: 0, COSMETIC: 0, STRUCTURAL: 0, FIELD_ONLY: 0 }
  for (const item of files) summary[item.change] = (summary[item.change] || 0) + 1
  const changedNavigationIds = graphChanges(baselineDir, moduleDir)
  const assets = impactedAssets(baselineDir, moduleDir, changedNavigationIds)
  const knowledgeImpact = summary.STRUCTURAL > 0 || summary.FIELD_ONLY > 0 || assets.knowledge_ids.length > 0
  const indexOnly = !knowledgeImpact && summary.COSMETIC > 0
  return {
    classification: knowledgeImpact ? 'KNOWLEDGE_IMPACT' : indexOnly ? 'INDEX_ONLY' : 'NO_IMPACT',
    reason: knowledgeImpact ? 'semantic-evidence-change' : indexOnly ? 'content-only-change' : 'fingerprints-unchanged',
    files: files.filter(item => item.change !== 'NONE'),
    changed_navigation_ids: changedNavigationIds,
    ...assets,
    summary,
  }
}
