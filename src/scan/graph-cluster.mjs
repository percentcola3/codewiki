#!/usr/bin/env node
// graph-cluster.mjs — community detection, PageRank, Brandes betweenness, hub analysis
// Usage: node graph-cluster.mjs <targetDir> [<output-base-dir>] [--output <base-dir>]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const targetDir = resolve(process.argv[2] || '.')
const outputFlagIdx = process.argv.indexOf('--output')
const positionalOutput = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : null
const outputBaseDir = outputFlagIdx !== -1 ? resolve(process.argv[outputFlagIdx + 1]) : positionalOutput ? resolve(positionalOutput) : null
const navDir = outputBaseDir ? join(outputBaseDir, 'navigation') : join(targetDir, '.doc', 'navigation')
const graphPath = join(navDir, 'file-graph.json')
const outPath = join(navDir, 'clusters.json')

// --- Load graph ---
let graph
try {
  graph = JSON.parse(readFileSync(graphPath, 'utf8'))
} catch {
  console.error(`[graph-cluster] Cannot read ${graphPath}`)
  process.exit(1)
}

const nodes = graph?.data?.nodes || []
const edges = graph?.data?.edges || []
const nodeIds = nodes.map(n => n.id)
const baseCommit = graph?.metadata?.base_commit || null

function effectiveWeight(edge) {
  return (edge.weight ?? 1) * (edge.confidence ?? 1)
}

if (nodeIds.length === 0) {
  writeResult({ clusters: [], hubs: [], critical_nodes: [], node_scores: {} })
  process.exit(0)
}

// --- Build adjacency lists ---
const adjOut = {}  // directed: source -> [targets]
const adjIn = {}   // directed: target -> [sources]
const adjUndirected = {}  // for community detection
const weightedOut = {}
const weightedIn = {}
for (const id of nodeIds) {
  adjOut[id] = []
  adjIn[id] = []
  adjUndirected[id] = []
  weightedOut[id] = []
  weightedIn[id] = []
}
for (const e of edges) {
  const weight = effectiveWeight(e)
  if (adjOut[e.source]) adjOut[e.source].push(e.target)
  if (adjIn[e.target]) adjIn[e.target].push(e.source)
  if (adjUndirected[e.source]) adjUndirected[e.source].push(e.target)
  if (adjUndirected[e.target]) adjUndirected[e.target].push(e.source)
  if (weightedOut[e.source]) weightedOut[e.source].push({ target: e.target, weight })
  if (weightedIn[e.target]) weightedIn[e.target].push({ source: e.source, weight })
}

// ============================================================
// 1. Louvain community detection
// ============================================================
let clusters = []
if (edges.length === 0) {
  clusters = nodeIds.map((id, index) => ({
    id: index,
    label: autoLabelCluster([id]),
    nodes: [id],
    size: 1,
  }))
} else try {
  const jlModule = await import('jlouvain')
  const jLouvainFn = jlModule.default?.jLouvain || jlModule.jLouvain || jlModule.default
  if (typeof jLouvainFn !== 'function') throw new Error('no jLouvain export found')
  const edgesForLouvain = edges.map(e => ({ source: e.source, target: e.target, weight: effectiveWeight(e) }))
  const community = jLouvainFn().nodes(nodeIds).edges(edgesForLouvain)
  const result = community()
  const clusterMap = {}
  for (const [nodeId, clusterId] of Object.entries(result)) {
    if (!clusterMap[clusterId]) clusterMap[clusterId] = []
    clusterMap[clusterId].push(nodeId)
  }
  clusters = Object.entries(clusterMap).map(([id, nodeList]) => ({
    id: Number(id),
    label: autoLabelCluster(nodeList),
    nodes: nodeList,
    size: nodeList.length
  }))
} catch (err) {
  console.warn(`[graph-cluster] Louvain failed (${err.message}), falling back to connected components`)
  clusters = bfsConnectedComponents()
}

// Build node -> cluster_id map
const nodeCluster = {}
for (const c of clusters) {
  for (const n of c.nodes) nodeCluster[n] = c.id
}

// ============================================================
// 2. PageRank
// ============================================================
function computePageRank(ids, outAdj, inAdj, { damping = 0.85, iterations = 40, tolerance = 1e-6 } = {}) {
  const N = ids.length
  if (N === 0) return {}
  let pr = {}
  for (const id of ids) pr[id] = 1 / N

  for (let iter = 0; iter < iterations; iter++) {
    const newPr = {}
    let diff = 0
    // Dangling mass
    let danglingMass = 0
    for (const id of ids) {
      if (!outAdj[id] || outAdj[id].length === 0) danglingMass += pr[id]
    }
    for (const id of ids) {
      let rank = (1 - damping) / N + damping * (danglingMass / N)
      for (const incoming of (inAdj[id] || [])) {
        const src = incoming.source
        const srcOutEdges = outAdj[src] || []
        const totalWeight = srcOutEdges.reduce((sum, edge) => sum + edge.weight, 0)
        if (totalWeight > 0) {
          rank += damping * (pr[src] * (incoming.weight / totalWeight))
        }
      }
      newPr[id] = rank
      diff += Math.abs(rank - (pr[id] || 0))
    }
    pr = newPr
    if (diff < tolerance) {
      console.log(`[graph-cluster] PageRank converged at iteration ${iter + 1}`)
      break
    }
  }
  return pr
}

const pagerank = computePageRank(nodeIds, weightedOut, weightedIn)

// ============================================================
// 3. Betweenness centrality (Brandes or sampling)
// ============================================================
function brandesBetweenness(ids, adj) {
  const bc = {}
  for (const id of ids) bc[id] = 0
  for (const s of ids) {
    const stack = []
    const pred = {}
    const sigma = {}
    const dist = {}
    const delta = {}
    for (const v of ids) {
      pred[v] = []
      sigma[v] = 0
      dist[v] = -1
      delta[v] = 0
    }
    sigma[s] = 1
    dist[s] = 0
    const queue = [s]
    while (queue.length > 0) {
      const v = queue.shift()
      stack.push(v)
      for (const w of (adj[v] || [])) {
        if (dist[w] < 0) {
          queue.push(w)
          dist[w] = dist[v] + 1
        }
        if (dist[w] === dist[v] + 1) {
          sigma[w] += sigma[v]
          pred[w].push(v)
        }
      }
    }
    while (stack.length > 0) {
      const w = stack.pop()
      for (const v of pred[w]) {
        delta[v] += (sigma[v] / sigma[w]) * (1 + delta[w])
      }
      if (w !== s) bc[w] += delta[w]
    }
  }
  // Normalize for undirected
  for (const id of ids) bc[id] /= 2
  return bc
}

function sampledBetweenness(ids, adj, sampleSize = 500) {
  const bc = {}
  for (const id of ids) bc[id] = 0
  const actualSamples = Math.min(sampleSize, Math.floor(ids.length * (ids.length - 1) / 2))
  for (let i = 0; i < actualSamples; i++) {
    const a = ids[Math.floor(Math.random() * ids.length)]
    const b = ids[Math.floor(Math.random() * ids.length)]
    if (a === b) continue
    const path = bfsPath(a, b, adj)
    if (path) {
      for (const node of path.slice(1, -1)) {
        bc[node] = (bc[node] || 0) + 1
      }
    }
  }
  return bc
}

const N = nodeIds.length
console.log(`[graph-cluster] Computing betweenness for ${N} nodes (${N > 500 ? 'sampling' : 'Brandes'})`)
const betweenness = N > 500
  ? sampledBetweenness(nodeIds, adjUndirected)
  : brandesBetweenness(nodeIds, adjUndirected)

// ============================================================
// 4. Hub detection
// ============================================================
const inDeg = {}, outDeg = {}
const weightedInDeg = {}, weightedOutDeg = {}
const edgeTypeStats = {}
for (const e of edges) {
  const weight = effectiveWeight(e)
  outDeg[e.source] = (outDeg[e.source] || 0) + 1
  inDeg[e.target] = (inDeg[e.target] || 0) + 1
  weightedOutDeg[e.source] = (weightedOutDeg[e.source] || 0) + weight
  weightedInDeg[e.target] = (weightedInDeg[e.target] || 0) + weight
  edgeTypeStats[e.type] = (edgeTypeStats[e.type] || 0) + 1
}
const degrees = nodeIds.map(id => (weightedInDeg[id] || 0) + (weightedOutDeg[id] || 0))
const mean = degrees.reduce((a, b) => a + b, 0) / degrees.length
const stddev = Math.sqrt(degrees.reduce((a, b) => a + (b - mean) ** 2, 0) / degrees.length)

const hubs = nodeIds
  .filter(id => (weightedInDeg[id] || 0) + (weightedOutDeg[id] || 0) > mean + 2 * stddev)
  .map(id => ({
    file: id,
    in_degree: inDeg[id] || 0,
    out_degree: outDeg[id] || 0,
    total_degree: (inDeg[id] || 0) + (outDeg[id] || 0),
    weighted_in_degree: weightedInDeg[id] || 0,
    weighted_out_degree: weightedOutDeg[id] || 0,
    weighted_total_degree: (weightedInDeg[id] || 0) + (weightedOutDeg[id] || 0),
    pagerank: pagerank[id] || 0,
    weighted_pagerank: pagerank[id] || 0,
    betweenness: betweenness[id] || 0,
    role: classifyHubRole(id)
  }))
  .sort((a, b) => b.weighted_total_degree - a.weighted_total_degree)

// ============================================================
// 5. Critical nodes (top betweenness)
// ============================================================
const criticalNodes = Object.entries(betweenness)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10)
  .filter(([, v]) => v > 0)
  .map(([node]) => node)

// ============================================================
// 6. Build node_scores (consumed by deep-analyzer)
// ============================================================
const nodeScores = {}
for (const id of nodeIds) {
  nodeScores[id] = {
    pagerank: pagerank[id] || 0,
    weighted_pagerank: pagerank[id] || 0,
    betweenness: betweenness[id] || 0,
    betweenness_mode: 'unweighted',
    in_degree: inDeg[id] || 0,
    out_degree: outDeg[id] || 0,
    weighted_in_degree: weightedInDeg[id] || 0,
    weighted_out_degree: weightedOutDeg[id] || 0,
    weighted_degree: (weightedInDeg[id] || 0) + (weightedOutDeg[id] || 0),
    cluster_id: nodeCluster[id] ?? -1,
  }
}

writeResult({ clusters, hubs, critical_nodes: criticalNodes, node_scores: nodeScores, edge_type_stats: edgeTypeStats })

// --- Helpers ---

function autoLabelCluster(nodeList) {
  const dirs = nodeList.map(n => {
    const parts = n.split('/')
    return parts.length > 1 ? parts.slice(0, -1).join('/') : parts[0]
  })
  const counts = {}
  dirs.forEach(d => { counts[d] = (counts[d] || 0) + 1 })
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
  return top ? top[0].split('/').pop() : 'unknown'
}

function classifyHubRole(file) {
  if (/store/i.test(file)) return 'state'
  if (/util|helper/i.test(file)) return 'utility'
  if (/service|api/i.test(file)) return 'service'
  if (/composable/i.test(file)) return 'composable'
  if (/component/i.test(file)) return 'component'
  return 'other'
}

function bfsPath(start, end, adj) {
  const visited = new Set([start])
  const queue = [[start, [start]]]
  while (queue.length) {
    const [node, path] = queue.shift()
    if (node === end) return path
    for (const nb of (adj[node] || [])) {
      if (!visited.has(nb)) {
        visited.add(nb)
        queue.push([nb, [...path, nb]])
      }
    }
  }
  return null
}

function bfsConnectedComponents() {
  const visited = new Set()
  const components = []
  for (const id of nodeIds) {
    if (visited.has(id)) continue
    const comp = []
    const q = [id]
    visited.add(id)
    while (q.length) {
      const cur = q.shift()
      comp.push(cur)
      for (const nb of (adjUndirected[cur] || [])) {
        if (!visited.has(nb)) { visited.add(nb); q.push(nb) }
      }
    }
    components.push(comp)
  }
  return components.map((nodes, i) => ({
    id: i, label: autoLabelCluster(nodes), nodes, size: nodes.length
  }))
}

function writeResult({ clusters, hubs, critical_nodes, node_scores, edge_type_stats }) {
  const result = {
    metadata: {
      generated_at: new Date().toISOString(),
      target_dir: targetDir,
      base_commit: baseCommit,
      version: '2.1.0'
    },
    clusters,
    hubs,
    critical_nodes,
    node_scores,
    edge_type_stats,
  }
  mkdirSync(navDir, { recursive: true })
  writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n')
  console.log(`[graph-cluster] Wrote ${outPath}`)
  console.log(`  Clusters: ${clusters.length}, Hubs: ${hubs.length}, Critical nodes: ${critical_nodes.length}`)
  console.log(`  PageRank range: [${Math.min(...Object.values(node_scores).map(s => s.pagerank)).toFixed(6)}, ${Math.max(...Object.values(node_scores).map(s => s.pagerank)).toFixed(6)}]`)
}
