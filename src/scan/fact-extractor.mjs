#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverSourceUnits, sourceUnitSummary } from './source-units.mjs'
import { edgeId, factId, normalizeRoute } from './facts/common.mjs'
import { extractJavaScriptFacts } from './facts/javascript.mjs'
import { extractTreeSitterFacts } from './facts/tree-sitter.mjs'

function stableSort(items, key) {
  return [...items].sort((a, b) => String(key(a)).localeCompare(String(key(b))))
}

function dedupeNodes(nodes) {
  const result = new Map()
  for (const node of nodes) {
    const existing = result.get(node.id)
    result.set(node.id, existing ? { ...existing, ...node } : node)
  }
  return stableSort(result.values(), node => node.id)
}

function dedupeEdges(edges) {
  const result = new Map()
  for (const edge of edges) {
    const id = edge.id || edgeId(edge.from, edge.to, edge.type)
    const item = { ...edge, id }
    const existing = result.get(id)
    if (!existing || Number(item.confidence || 0) >= Number(existing.confidence || 0)) result.set(id, item)
  }
  return stableSort(result.values(), edge => `${edge.from}:${edge.type}:${edge.to}`)
}

function addSourceUnitFacts(moduleName, units, nodes, edges) {
  const moduleId = factId('module', moduleName)
  nodes.push({ id: moduleId, type: 'module', label: moduleName, confidence: 1 })
  for (const unit of units) {
    const id = factId('source-unit', moduleName, unit.id)
    nodes.push({
      id,
      type: 'source-unit',
      label: unit.name,
      path: unit.path,
      language: unit.language,
      framework: unit.framework,
      framework_version: unit.framework_version,
      version_source: unit.version_source,
      features: unit.features,
      confidence: unit.confidence === 'verified' ? 1 : 0.6,
    })
    edges.push({ id: edgeId(moduleId, id, 'contains'), from: moduleId, to: id, type: 'contains', confidence: 1 })
    for (const fileNode of nodes.filter(node => node.type === 'file' && node.source_unit === unit.id)) {
      edges.push({ id: edgeId(id, fileNode.id, 'contains'), from: id, to: fileNode.id, type: 'contains', confidence: 1 })
    }
  }
}

function linkHttpFacts(nodes, edges) {
  const calls = nodes.filter(node => node.type === 'api-call' && node.protocol === 'http')
  const endpoints = nodes.filter(node => node.type === 'endpoint' && node.protocol === 'http')
  for (const call of calls) {
    const callRoute = normalizeRoute(call.route)
    const matches = endpoints.filter(endpoint => {
      const methodMatches = endpoint.method === '*' || call.method === '*' || endpoint.method === call.method
      const endpointRoute = normalizeRoute(endpoint.route)
      const callParts = String(callRoute || '').split('/')
      const endpointParts = String(endpointRoute || '').split('/')
      const routeMatches = callParts.length === endpointParts.length && callParts.every((part, index) => (
        part === endpointParts[index] || part === ':param' || endpointParts[index] === ':param'
      ))
      return methodMatches && routeMatches
    })
    for (const endpoint of matches) {
      const exactMethod = endpoint.method === call.method
      const exactRoute = normalizeRoute(endpoint.route) === callRoute
      edges.push({
        id: edgeId(call.id, endpoint.id, 'calls-endpoint'),
        from: call.id,
        to: endpoint.id,
        type: 'calls-endpoint',
        confidence: exactMethod && exactRoute ? 1 : exactMethod ? 0.9 : 0.75,
        resolver: exactMethod && exactRoute
          ? 'http-method-route-exact'
          : exactMethod
            ? 'http-method-route-template'
            : 'http-route-exact-method-wildcard',
      })
    }
  }
}

function sha1(value) {
  return createHash('sha1').update(String(value)).digest('hex')
}

function writeGraphIndex(navigationDir, projectRoot, nodes, edges) {
  const files = {}
  for (const fileNode of nodes.filter(node => node.type === 'file' && node.file)) {
    const absPath = join(projectRoot, fileNode.file)
    const content = existsSync(absPath) ? readFileSync(absPath, 'utf8') : ''
    const relatedNodes = nodes
      .filter(node => node.file === fileNode.file && node.type !== 'file')
      .map(node => ({
        id: node.id,
        type: node.type,
        qualified_name: node.qualified_name || null,
        method: node.method || null,
        route: node.route || null,
        observed_features: node.observed_features || [],
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
    const relatedNodeIds = new Set(relatedNodes.map(node => node.id))
    const relatedEdges = edges
      .filter(edge => edge.from === fileNode.id || edge.to === fileNode.id || relatedNodeIds.has(edge.from) || relatedNodeIds.has(edge.to))
      .map(edge => `${edge.from}:${edge.type}:${edge.to}`)
      .sort()
    files[fileNode.file] = {
      hash: content ? sha1(content) : null,
      mtime: existsSync(absPath) ? statSync(absPath).mtimeMs : null,
      structuralFingerprint: sha1(JSON.stringify({ nodes: relatedNodes, edges: relatedEdges })),
      fieldFingerprint: null,
      parser_version: 'source-unit-profile-v1',
    }
  }
  writeFileSync(join(navigationDir, 'graph-index.json'), `${JSON.stringify({
    metadata: {
      generated_at: new Date().toISOString(),
      parser_version: 'source-unit-profile-v1',
      fingerprint_version: '1.0',
    },
    files,
    page_fingerprints: {},
  }, null, 2)}\n`)
}

export async function extractModuleFacts({ projectRoot = process.cwd(), moduleName, target = null, outputDir }) {
  const root = resolve(projectRoot)
  const units = discoverSourceUnits({ projectRoot: root, moduleName, target })
  if (units.length === 0) throw new Error(`未发现可分析的 Source Unit${target ? `: ${target}` : ''}`)
  const nodes = []
  const edges = []
  const warnings = []

  for (const unit of units) {
    let result
    if (['typescript', 'javascript'].includes(unit.language)) {
      result = await extractJavaScriptFacts({ unit, projectRoot: root })
    } else if (['java', 'go'].includes(unit.language)) {
      result = await extractTreeSitterFacts({ unit, projectRoot: root })
    } else {
      warnings.push(`${unit.id}: 暂不支持语言 ${unit.language}`)
      continue
    }
    nodes.push(...result.nodes)
    edges.push(...result.edges)
    warnings.push(...result.warnings)
  }

  addSourceUnitFacts(moduleName, units, nodes, edges)
  linkHttpFacts(nodes, edges)
  const normalizedNodes = dedupeNodes(nodes)
  const normalizedEdges = dedupeEdges(edges)
  const navigationDir = join(resolve(outputDir), 'navigation')
  mkdirSync(navigationDir, { recursive: true })
  const generatedAt = new Date().toISOString()
  const metadata = {
    version: 1,
    generated_at: generatedAt,
    module: moduleName,
    parser: 'source-unit-profile',
    source_unit_count: units.length,
    node_count: normalizedNodes.length,
    edge_count: normalizedEdges.length,
    warning_count: warnings.length,
  }
  writeFileSync(join(navigationDir, 'source-units.json'), `${JSON.stringify({ metadata, source_units: units.map(({ abs_path: _absPath, ...unit }) => unit) }, null, 2)}\n`)
  writeFileSync(join(navigationDir, 'framework-facts.json'), `${JSON.stringify({ metadata, data: { nodes: normalizedNodes, edges: normalizedEdges }, warnings }, null, 2)}\n`)
  writeGraphIndex(navigationDir, root, normalizedNodes, normalizedEdges)
  return { metadata, source_units: units, nodes: normalizedNodes, edges: normalizedEdges, warnings }
}

async function main() {
  const args = process.argv.slice(2)
  const target = args[0] && !args[0].startsWith('--') ? args[0] : null
  const outputIndex = args.indexOf('--output')
  const moduleIndex = args.indexOf('--module')
  const projectIndex = args.indexOf('--project')
  const outputDir = outputIndex >= 0 ? args[outputIndex + 1] : null
  const moduleName = moduleIndex >= 0 ? args[moduleIndex + 1] : basename(resolve(target || '.'))
  const projectRoot = projectIndex >= 0 ? args[projectIndex + 1] : process.cwd()
  if (!outputDir) throw new Error('--output is required')
  const result = await extractModuleFacts({ projectRoot, moduleName, target, outputDir })
  process.stdout.write(`[fact-extractor] ${result.source_units.map(sourceUnitSummary).join(', ')}\n`)
  process.stdout.write(`[fact-extractor] ${result.nodes.length} nodes, ${result.edges.length} edges, ${result.warnings.length} warnings\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    process.stderr.write(`[fact-extractor] Failed: ${error.message}\n`)
    process.exit(1)
  })
}
