import { createHash } from 'node:crypto'

export function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/')
}

export function encodeId(value) {
  return encodeURIComponent(normalizePath(value))
}

export function factId(kind, ...parts) {
  return `nav:${kind}:${parts.map(encodeId).join(':')}`
}

export function edgeId(from, to, type, detail = '') {
  const hash = createHash('sha1').update([from, to, type, detail].join('::')).digest('hex').slice(0, 16)
  return factId('edge', hash)
}

export function lineAt(content, offset) {
  let line = 1
  for (let index = 0; index < Math.max(0, offset) && index < content.length; index++) {
    if (content.charCodeAt(index) === 10) line++
  }
  return line
}

export function evidence(file, line, kind, snippet = null) {
  return {
    file: normalizePath(file),
    line: Number(line || 1),
    kind,
    ...(snippet ? { snippet: String(snippet).trim().slice(0, 240) } : {}),
  }
}

export function normalizeRoute(value) {
  let route = String(value || '').trim()
  if (!route) return null
  try {
    if (/^https?:\/\//i.test(route)) route = new URL(route).pathname
  } catch {
    // Preserve non-standard URLs as literals.
  }
  route = route
    .replace(/\$\{[^}]+}/g, ':param')
    .replace(/\{[^}/]+}/g, ':param')
    .replace(/:[^/]+/g, ':param')
    .replace(/\/+/g, '/')
  if (!route.startsWith('/')) route = `/${route}`
  if (route.length > 1) route = route.replace(/\/$/, '')
  return route
}

export function createFactCollector(unit) {
  const nodes = new Map()
  const edges = new Map()
  const warnings = []

  function addNode(raw) {
    if (!raw?.id) return null
    const node = {
      confidence: 1,
      language: unit.language,
      framework: unit.framework,
      framework_version: unit.framework_version || null,
      source_unit: unit.id,
      ...raw,
    }
    const existing = nodes.get(node.id)
    nodes.set(node.id, existing ? { ...existing, ...node } : node)
    return node.id
  }

  function addEdge(from, to, type, options = {}) {
    if (!from || !to) return null
    const id = options.id || edgeId(from, to, type, options.detail || '')
    const edge = {
      id,
      from,
      to,
      type,
      confidence: options.confidence ?? 1,
      source_unit: unit.id,
      ...(options.evidence?.length ? { evidence: options.evidence } : {}),
      ...(options.resolver ? { resolver: options.resolver } : {}),
    }
    const existing = edges.get(id)
    if (!existing || Number(edge.confidence) >= Number(existing.confidence)) edges.set(id, edge)
    return id
  }

  function addFile(file, options = {}) {
    // File IDs stay compatible with the existing navigation graph. A module graph
    // already provides the namespace, while source_unit remains node metadata.
    const id = factId('file', file)
    addNode({ id, type: 'file', label: file, file, line: 1, ...options })
    return id
  }

  return {
    unit,
    nodes,
    edges,
    warnings,
    addNode,
    addEdge,
    addFile,
    result() {
      return { nodes: [...nodes.values()], edges: [...edges.values()], warnings }
    },
  }
}

export function walkTreeSitter(node, visit, parents = []) {
  if (!node) return
  visit(node, parents)
  const nextParents = [...parents, node]
  for (let index = 0; index < node.namedChildCount; index++) {
    walkTreeSitter(node.namedChild(index), visit, nextParents)
  }
}

export function walkObject(node, visit, parents = []) {
  if (!node || typeof node !== 'object') return
  if (node.type) visit(node, parents)
  const nextParents = node.type ? [...parents, node] : parents
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) walkObject(child, visit, nextParents)
    } else if (value && typeof value === 'object') walkObject(value, visit, nextParents)
  }
}
