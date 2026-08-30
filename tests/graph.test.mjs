import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evidenceFingerprint, readGraph, writeGraph } from '../src/graph/store.mjs'
import { classifyGeneratedImpact } from '../src/generation/impact.mjs'
import { edgeAllowed, routeQuery } from '../src/retrieval/query-router.mjs'

test('graph.jsonl is stable, readable, and de-duplicates nodes and edges', () => {
  const moduleDir = mkdtempSync(join(tmpdir(), 'codewiki-graph-'))
  mkdirSync(join(moduleDir, 'navigation'), { recursive: true })
  try {
    const graph = {
      nodes: [
        { id: 'nav:b', type: 'function', label: 'B', file: 'b.ts', line: 8 },
        { id: 'nav:a', type: 'function', label: 'A', file: 'a.ts', line: 2 },
        { id: 'nav:a', type: 'function', label: 'A', file: 'a.ts', line: 2 },
      ],
      edges: [
        { id: 'edge:1', from: 'nav:a', to: 'nav:b', type: 'calls', confidence: 0.4 },
        { id: 'edge:1', from: 'nav:a', to: 'nav:b', type: 'calls', confidence: 0.9 },
      ],
    }
    writeGraph(moduleDir, graph, { module: 'orders' })
    const first = readFileSync(join(moduleDir, 'navigation', 'graph.jsonl'), 'utf8')
    writeGraph(moduleDir, graph, { module: 'orders' })
    const second = readFileSync(join(moduleDir, 'navigation', 'graph.jsonl'), 'utf8')
    assert.equal(first, second)
    const loaded = readGraph(moduleDir)
    assert.equal(loaded.nodes.length, 2)
    assert.equal(loaded.edges.length, 1)
    assert.equal(loaded.edges[0].confidence, 0.9)
  } finally {
    rmSync(moduleDir, { recursive: true, force: true })
  }
})

test('evidence fingerprint ignores line-only movement but detects semantic changes', () => {
  const base = { id: 'nav:branch:refund', type: 'branch', label: 'unshipped', file: 'refund.ts', line: 8, condition: 'status === pending' }
  assert.equal(evidenceFingerprint(base), evidenceFingerprint({ ...base, line: 18 }))
  assert.notEqual(evidenceFingerprint(base), evidenceFingerprint({ ...base, condition: 'status !== shipped' }))
})

test('query router separates semantic, impact, chain, lineage, and hybrid questions', () => {
  assert.equal(routeQuery('什么情况下允许退款').intent, 'semantic')
  assert.equal(routeQuery('修改 orderStatus 影响哪些页面').intent, 'impact')
  assert.equal(routeQuery('按钮到退款接口的调用链').intent, 'chain')
  assert.equal(routeQuery('后端字段修改影响哪些前端字段').intent, 'lineage')
  assert.equal(routeQuery('修改退款规则会影响哪些业务功能').intent, 'hybrid')
  const chainRoute = routeQuery('按钮到后端接口的调用链')
  assert.ok(edgeAllowed(chainRoute, { type: 'calls-api' }))
  assert.ok(edgeAllowed(chainRoute, { type: 'calls-endpoint' }))
  assert.ok(edgeAllowed(chainRoute, { type: 'implemented-by' }))
})

test('impact classifier separates no-op, index-only, and knowledge changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'codewiki-impact-'))
  const baseline = join(root, 'baseline')
  const current = join(root, 'current')
  mkdirSync(join(baseline, 'navigation'), { recursive: true })
  mkdirSync(join(current, 'navigation'), { recursive: true })
  const writeIndex = (dir, file) => {
    const value = { files: { 'src/a.ts': file }, page_fingerprints: {} }
    requireWrite(join(dir, 'navigation', 'graph-index.json'), JSON.stringify(value))
  }
  try {
    const base = { hash: 'a', structuralFingerprint: 's', fieldFingerprint: 'f' }
    writeIndex(baseline, base)
    writeIndex(current, base)
    assert.equal(classifyGeneratedImpact(baseline, current).classification, 'NO_IMPACT')
    writeIndex(current, { ...base, hash: 'b' })
    assert.equal(classifyGeneratedImpact(baseline, current).classification, 'INDEX_ONLY')
    writeIndex(current, { ...base, hash: 'b', structuralFingerprint: 's2' })
    assert.equal(classifyGeneratedImpact(baseline, current).classification, 'KNOWLEDGE_IMPACT')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function requireWrite(filePath, content) {
  mkdirSync(join(filePath, '..'), { recursive: true })
  writeFileSync(filePath, content)
}
