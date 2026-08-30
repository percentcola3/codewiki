import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { buildProjectIndex, clearRetrievalMemoryCache, evaluateKnowledgeBase, exploreKnowledgeBase, inspectModuleIndex } from '../src/scan/knowledge-retrieval.mjs'

const root = join(import.meta.dirname, '..')

function write(filePath, content) {
  mkdirSync(join(filePath, '..'), { recursive: true })
  writeFileSync(filePath, content)
}

function fixture() {
  const projectDir = mkdtempSync(join(tmpdir(), 'codewiki-retrieval-'))
  const moduleDir = join(projectDir, '.codewiki', 'modules', 'orders')
  const navDir = join(moduleDir, 'navigation')
  write(join(moduleDir, 'manifest.yml'), 'version: "3.6"\nmodule: orders\ntarget_dirs: [src]\nbase_commit: ""\n')
  write(join(moduleDir, 'product', '01-订单导出-flow.md'), [
    '---',
    'id: kb:orders:product:export',
    'kind: business',
    'title: 订单导出',
    'aliases: [导出按钮, 批量导出]',
    'questions:',
    '  - 导出按钮怎么实现？',
    'entities: [订单, 导出]',
    '---',
    '',
    '# 订单导出',
    '',
    '点击导出按钮后调用批量导出接口，见 src/views/order/list.vue:12。',
  ].join('\n'))
  write(join(moduleDir, 'developer', '01-架构与调用图.md'), [
    '---',
    'id: kb:orders:developer:arch',
    'kind: architecture',
    'title: 订单模块架构',
    'aliases: [订单架构]',
    'questions:',
    '  - 订单模块的结构是什么？',
    'entities: [订单]',
    '---',
    '',
    '# 订单模块架构',
    '',
    '列表页依赖导出组件，见 src/views/order/list.vue:10。',
  ].join('\n'))
  write(join(navDir, 'file-graph.json'), JSON.stringify({
    data: {
      nodes: [{ id: 'src/views/order/list.vue' }, { id: 'src/api/order.ts' }],
      edges: [{ source: 'src/views/order/list.vue', target: 'src/api/order.ts', type: 'depends-on', confidence: 1 }],
    },
  }))
  write(join(navDir, 'func-dependencies.json'), JSON.stringify({
    data: {
      functions: [
        { id: 'nav:function:src/api/order.ts:exportOrders:function', name: 'exportOrders', file: 'src/api/order.ts', calls: [] },
        { id: 'nav:function:src/views/order/list.vue:handleExport:function', name: 'handleExport', file: 'src/views/order/list.vue', calls: ['exportOrders'] },
      ],
    },
  }))
  write(join(navDir, 'component-refs.json'), JSON.stringify({
    data: {
      components: [{
        id: 'nav:component:src/views/order/list.vue',
        file: 'src/views/order/list.vue',
        uses: [],
        event_bindings: [{ event: 'click', handler: 'handleExport', at: 'src/views/order/list.vue:12' }],
        template_bindings: [{ path: 'orderList', kind: 'prop', at: 'src/views/order/list.vue:8' }],
      }],
    },
  }))
  return { projectDir, moduleDir, navDir }
}

test('buildProjectIndex builds bindings and navigation graph from fixture', () => {
  const { projectDir } = fixture()
  try {
    const indexes = buildProjectIndex({ projectRoot: projectDir })
    assert.equal(indexes.length, 1)
    const index = indexes[0]
    assert.equal(index.metadata.module, 'orders')
    assert.equal(index.knowledge.length, 2)
    assert.ok(index.knowledge.some(doc => doc.id === 'kb:orders:developer:arch' && doc.layer === 'developer'))
    // code_refs in markdown body deterministically generate code-ref bindings
    const codeRefBindings = index.bindings.filter(binding => binding.source === 'code-ref')
    assert.ok(codeRefBindings.length > 0)
    assert.ok(index.nav_nodes.some(node => node.type === 'ui-event'))
    assert.ok(existsSync(join(projectDir, '.codewiki', 'cache', 'codewiki', 'orders', 'retrieval-index.json')))
  } finally {
    rmSync(projectDir, { recursive: true, force: true })
  }
})

test('legacy frontend knowledge remains readable as the developer layer', () => {
  const { projectDir, moduleDir } = fixture()
  try {
    const developerDir = join(moduleDir, 'developer')
    const frontendDir = join(moduleDir, 'frontend')
    renameSync(developerDir, frontendDir)
    const legacyDoc = join(frontendDir, '01-架构与调用图.md')
    writeFileSync(legacyDoc, readFileSync(legacyDoc, 'utf8').replace('kb:orders:developer:arch', 'kb:orders:frontend:arch'))

    const index = buildProjectIndex({ projectRoot: projectDir })[0]
    assert.ok(index.knowledge.some(doc => doc.id === 'kb:orders:frontend:arch' && doc.layer === 'developer'))
  } finally {
    clearRetrievalMemoryCache()
    rmSync(projectDir, { recursive: true, force: true })
  }
})

test('Evidence fingerprint marks bound knowledge stale until finalize accepts the new evidence', () => {
  const { projectDir, moduleDir, navDir } = fixture()
  const evidenceId = 'nav:function:src/api/order.ts:exportOrders:function'
  try {
    write(join(navDir, 'bindings.jsonl'), `${JSON.stringify({
      knowledge_id: 'kb:orders:product:export',
      navigation_id: evidenceId,
      role: 'rule',
      confidence: 'verified',
      source: 'declared',
    })}\n`)
    buildProjectIndex({ projectRoot: projectDir })
    const depsPath = join(navDir, 'func-dependencies.json')
    const deps = JSON.parse(readFileSync(depsPath, 'utf8'))
    deps.data.functions.find(item => item.id === evidenceId).calls = ['changedHelper']
    writeFileSync(depsPath, JSON.stringify(deps))
    clearRetrievalMemoryCache()
    const stale = inspectModuleIndex(projectDir, moduleDir)
    assert.equal(stale.knowledge_freshness.stale, 1)
    assert.equal(stale.bindings.find(item => item.navigation_id === evidenceId).freshness, 'stale')

    const finalized = buildProjectIndex({ projectRoot: projectDir })[0]
    assert.equal(finalized.knowledge_freshness.stale, 0)
    assert.equal(finalized.bindings.find(item => item.navigation_id === evidenceId).freshness, 'current')
  } finally {
    clearRetrievalMemoryCache()
    rmSync(projectDir, { recursive: true, force: true })
  }
})

test('exploreKnowledgeBase hits semantic docs and expands code evidence', () => {
  const { projectDir } = fixture()
  try {
    const result = exploreKnowledgeBase({ projectRoot: projectDir, query: '导出按钮怎么实现', detail: 'evidence' })
    assert.equal(result.found, true)
    const module = result.modules[0]
    assert.ok(module.topics.some(topic => topic.id === 'kb:orders:product:export'))
    assert.ok(module.evidence.some(item => item.type === 'ui-event' || item.file?.includes('list.vue')))
  } finally {
    clearRetrievalMemoryCache()
    rmSync(projectDir, { recursive: true, force: true })
  }
})

test('evaluateKnowledgeBase reports pass rate and top-3 hit rate', () => {
  const { projectDir } = fixture()
  try {
    const evaluation = evaluateKnowledgeBase({
      projectRoot: projectDir,
      cases: [
        {
          name: 'UI 入口',
          query: '导出按钮怎么实现',
          expected_intent: 'chain',
          expected_knowledge_ids: ['kb:orders:product:export'],
          required_evidence_ids: ['nav:function:src/api/order.ts:exportOrders:function'],
        },
        {
          name: '无答案',
          query: '知识库明确不包含的问题',
          expect_found: false,
        },
      ],
    })
    assert.equal(evaluation.summary.total, 2)
    assert.equal(evaluation.summary.passed, 2)
    assert.equal(evaluation.summary.top3_knowledge_hit_rate, 1)
    assert.equal(evaluation.cases[0].intent_mismatch, false)
  } finally {
    rmSync(projectDir, { recursive: true, force: true })
  }
})

test('MCP server records retrieval hit traces locally (case 命中记录)', () => {
  const { projectDir } = fixture()
  try {
    buildProjectIndex({ projectRoot: projectDir })
    const request = message => `${JSON.stringify(message)}\n`
    const input = [
      request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }),
      request({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      request({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      request({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'codewiki_explore', arguments: { query: '导出按钮怎么实现', projectPath: projectDir } } }),
      request({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'codewiki_explore', arguments: { query: '知识库完全不存在的售后规则', module: 'orders', projectPath: projectDir } } }),
    ].join('')
    const output = execFileSync(process.execPath, [join(root, 'src', 'scan', 'mcp-server.mjs')], {
      input,
      encoding: 'utf8',
      timeout: 30000,
    })
    const lines = output.split('\n').filter(Boolean).map(line => JSON.parse(line))
    assert.ok(lines.some(line => line.id === 1 && line.result?.serverInfo?.name === 'codewiki'))
    assert.ok(lines.some(line => line.id === 2 && line.result?.tools?.[0]?.name === 'codewiki_explore'))
    const explore = lines.find(line => line.id === 3)
    assert.ok(explore.result.structuredContent.knowledge_ids.includes('kb:orders:product:export'))
    assert.equal(explore.result.structuredContent.feedback_request.required, true)
    assert.match(explore.result.structuredContent.feedback_request.prompt, /有帮助/)
    assert.match(explore.result.content[0].text, /有帮助/)
    const missed = lines.find(line => line.id === 4)
    assert.match(missed.result.structuredContent.gap_id, /^gap:orders:/)

    // 命中记录落盘：本地 jsonl，无任何上报
    const tracePath = join(projectDir, '.codewiki', 'retrieval.jsonl')
    assert.ok(existsSync(tracePath))
    const traces = readFileSync(tracePath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(traces.length, 2)
    assert.equal(traces[0].found, true)
    assert.ok(traces[0].retrieval_id.startsWith('ret_'))
    assert.ok(Array.isArray(traces[0].knowledge_ids) && traces[0].knowledge_ids.length > 0)
    const gaps = readFileSync(join(projectDir, '.codewiki', 'gaps.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(gaps[0].gap_id, missed.result.structuredContent.gap_id)
    assert.equal(gaps[0].kind, 'retrieval_miss')
  } finally {
    rmSync(projectDir, { recursive: true, force: true })
  }
})
