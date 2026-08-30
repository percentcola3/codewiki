import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const GRAPH_SCHEMA_VERSION = 1
export const GRAPH_FILE = 'graph.jsonl'

const VOLATILE_FINGERPRINT_KEYS = new Set([
  'at',
  'evidence',
  'generated_at',
  'line',
  'line_end',
  'line_start',
  'source_location',
])

function stableValue(value, options = {}) {
  if (Array.isArray(value)) {
    const items = value.map(item => stableValue(item, options))
    return options.sortArrays === false ? items : items.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  }
  if (!value || typeof value !== 'object') return value
  const output = {}
  for (const key of Object.keys(value).sort()) {
    if (options.omitVolatile && VOLATILE_FINGERPRINT_KEYS.has(key)) continue
    const item = value[key]
    if (item === undefined) continue
    output[key] = stableValue(item, options)
  }
  return output
}

function stableStringify(value, options = {}) {
  return JSON.stringify(stableValue(value, options))
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

export function evidenceFingerprint(node) {
  if (!node?.id) return null
  return `sha256:${sha256(stableStringify(node, { omitVolatile: true }))}`
}

export function normalizeGraph(graph = {}) {
  const warnings = [...(graph.warnings || [])]
  const nodes = new Map()
  for (const raw of graph.nodes || []) {
    if (!raw?.id) {
      warnings.push('graph node 缺少 id，已跳过')
      continue
    }
    const node = stableValue(raw, { sortArrays: false })
    nodes.set(node.id, nodes.has(node.id) ? { ...nodes.get(node.id), ...node } : node)
  }

  const edges = new Map()
  for (const raw of graph.edges || []) {
    if (!raw?.from || !raw?.to || !raw?.type) {
      warnings.push('graph edge 缺少 from/to/type，已跳过')
      continue
    }
    if (!nodes.has(raw.from) || !nodes.has(raw.to)) {
      warnings.push(`graph edge 引用不存在节点: ${raw.from} -> ${raw.to}`)
      continue
    }
    const edge = stableValue(raw, { sortArrays: false })
    const key = edge.id || `${edge.from}\n${edge.to}\n${edge.type}`
    const existing = edges.get(key)
    if (!existing || Number(edge.confidence || 0) > Number(existing.confidence || 0)) edges.set(key, edge)
  }

  return {
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edges.values()].sort((a, b) => `${a.from}\n${a.type}\n${a.to}`.localeCompare(`${b.from}\n${b.type}\n${b.to}`)),
    fileIds: graph.fileIds || {},
    codeReferenceIds: graph.codeReferenceIds,
    warnings: [...new Set(warnings)],
  }
}

export function graphPath(moduleDir) {
  return join(moduleDir, 'navigation', GRAPH_FILE)
}

export function writeGraph(moduleDir, graph, metadata = {}) {
  const normalized = normalizeGraph(graph)
  const records = [
    {
      record: 'meta',
      schema_version: GRAPH_SCHEMA_VERSION,
      module: metadata.module || null,
      base_commit: metadata.base_commit || null,
      node_count: normalized.nodes.length,
      edge_count: normalized.edges.length,
    },
    ...normalized.nodes.map(node => ({ record: 'node', ...node })),
    ...normalized.edges.map(edge => ({ record: 'edge', ...edge })),
  ]
  writeFileSync(graphPath(moduleDir), `${records.map(record => stableStringify(record, { sortArrays: false })).join('\n')}\n`, 'utf8')
  return normalized
}

export function readGraph(moduleDir) {
  const filePath = graphPath(moduleDir)
  if (!existsSync(filePath)) return null
  const nodes = []
  const edges = []
  let metadata = null
  const warnings = []
  readFileSync(filePath, 'utf8').split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return
    try {
      const record = JSON.parse(line)
      if (record.record === 'meta') metadata = record
      else if (record.record === 'node') {
        const { record: _record, ...node } = record
        nodes.push(node)
      } else if (record.record === 'edge') {
        const { record: _record, ...edge } = record
        edges.push(edge)
      } else warnings.push(`${GRAPH_FILE}:${index + 1} record 非法`)
    } catch {
      warnings.push(`${GRAPH_FILE}:${index + 1} 不是合法 JSON`)
    }
  })
  if (metadata?.schema_version !== GRAPH_SCHEMA_VERSION) warnings.push(`${GRAPH_FILE} schema_version 不受支持: ${metadata?.schema_version ?? 'missing'}`)
  return { ...normalizeGraph({ nodes, edges, warnings }), metadata }
}

export function graphStats(graph) {
  const nodeTypes = {}
  const edgeTypes = {}
  for (const node of graph?.nodes || []) nodeTypes[node.type || 'unknown'] = (nodeTypes[node.type || 'unknown'] || 0) + 1
  for (const edge of graph?.edges || []) edgeTypes[edge.type || 'unknown'] = (edgeTypes[edge.type || 'unknown'] || 0) + 1
  return {
    nodes: graph?.nodes?.length || 0,
    edges: graph?.edges?.length || 0,
    node_types: nodeTypes,
    edge_types: edgeTypes,
  }
}
