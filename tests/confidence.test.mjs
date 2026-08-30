import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { calculateKnowledgeConfidence, deriveNavigationCases, gradeFromScore } from '../src/scan/knowledge-confidence.mjs'
import { assessModuleConfidence } from '../src/confidence.mjs'
import { openGap } from '../src/quality-state.mjs'
import { buildUsageReport } from '../src/report.mjs'

test('gradeFromScore maps score bands to grades', () => {
  assert.equal(gradeFromScore(0.95), 'A')
  assert.equal(gradeFromScore(0.75), 'B')
  assert.equal(gradeFromScore(0.55), 'C')
  assert.equal(gradeFromScore(0.35), 'D')
  assert.equal(gradeFromScore(0.1), 'E')
  assert.equal(gradeFromScore(null), 'N_A')
})

test('deriveNavigationCases produces deterministic branch/state/timeout cases', () => {
  const cases = deriveNavigationCases({
    branchRoutes: { routes: [{ field: 'payChannel', branches: [{ value: 'cash' }, { value: 'card' }] }] },
    stateMachines: { machines: [{ entity: 'order', transitions: [{ from: 'pending', to: 'paid' }] }] },
    timeoutRecovery: { handlers: [{ name: 'retryPay' }] },
  })
  assert.deepEqual(cases.map(item => item.id).sort(), [
    'branch:payChannel:card',
    'branch:payChannel:cash',
    'state:order:pending->paid',
    'timeout:retryPay',
  ])
  assert.ok(cases.every(item => item.source === 'deterministic'))
})

test('deriveNavigationCases includes backend endpoints and verified cross-language HTTP chains', () => {
  const cases = deriveNavigationCases({
    frameworkFacts: {
      data: {
        nodes: [
          { id: 'nav:api', type: 'api-call', method: 'POST', route: '/api/orders' },
          { id: 'nav:endpoint', type: 'endpoint', method: 'POST', route: '/api/orders' },
        ],
        edges: [{ from: 'nav:api', to: 'nav:endpoint', type: 'calls-endpoint', confidence: 1 }],
      },
    },
  })
  assert.ok(cases.some(item => item.id === 'endpoint:POST:/api/orders'))
  assert.ok(cases.some(item => item.id === 'cross-http:POST:/api/orders'))
})

test('calculateKnowledgeConfidence weights evidence/scenario/gap as 50/30/20', () => {
  const result = calculateKnowledgeConfidence({
    evidenceScore: 1,
    expectedCases: [
      { id: 'case-a', source: 'deterministic', verified: true },
      { id: 'case-b', source: 'deterministic', verified: false },
    ],
    gaps: [
      { id: 'gap-a', status: 'filled', evidence_refs: ['src/a.ts:1'] },
      { id: 'gap-b', status: 'open', evidence_refs: [] },
    ],
  })
  assert.equal(result.evidence_confidence.grade, 'A')
  assert.equal(result.scenario_coverage.score, 0.5)
  assert.equal(result.gap_closure.score, 0.5)
  // 1*0.5 + 0.5*0.3 + 0.5*0.2 = 0.75 → B
  assert.equal(result.overall_confidence.score, 0.75)
  assert.equal(result.overall_confidence.grade, 'B')
  assert.deepEqual(result.scenario_coverage.missing_case_ids, ['case-b'])
  assert.deepEqual(result.gap_closure.open_gap_ids, ['gap-b'])
})

test('ai-only candidate cases do not enter scenario coverage denominator', () => {
  const result = calculateKnowledgeConfidence({
    evidenceScore: 0.8,
    expectedCases: [{ id: 'ai-guess', source: 'ai', verified: false }],
  })
  assert.equal(result.scenario_coverage.applicable, 0)
  assert.equal(result.scenario_coverage.score, null)
  assert.deepEqual(result.scenario_coverage.candidate_case_ids, ['ai-guess'])
})

test('assessModuleConfidence combines validation report, doc coverage and retrieval traces', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'codewiki-confidence-'))
  try {
    const moduleDir = join(projectRoot, '.codewiki', 'modules', 'orders')
    const navDir = join(moduleDir, 'navigation')
    mkdirSync(join(navDir, 'field-lineage'), { recursive: true })
    mkdirSync(join(moduleDir, 'product'), { recursive: true })
    writeFileSync(join(moduleDir, 'manifest.yml'), 'module: orders\n')
    writeFileSync(join(navDir, 'validation-report.json'), JSON.stringify({
      status: 'PASS',
      per_file_confidence: [
        { doc: '.codewiki/modules/orders/product/01-a.md', ratio: 0.95 },
        { doc: '.codewiki/modules/orders/product/02-b.md', ratio: 0.85 },
      ],
    }))
    writeFileSync(join(navDir, 'branch-routes.json'), JSON.stringify({
      routes: [{ field: 'payChannel', branches: ['cash', 'card'] }],
    }))
    // 文档提到 cash 分支，未提到 card 分支 → 场景覆盖 1/2
    writeFileSync(join(moduleDir, 'product', '01-导出-flow.md'), '# 导出\n\npayChannel 为 cash 时走现金分支。')
    const at = new Date().toISOString()
    const traces = [
      { at, query: '退款什么情况下允许', module: 'orders', modules: ['orders'], found: true, fallback: false, stale: false, latency_ms: 5 },
      { at, query: '退款什么情况下允许', module: 'orders', modules: ['orders'], found: false, fallback: true, stale: false, latency_ms: 3 },
      { at, query: '不相关的问题', module: 'other', modules: ['other'], found: false, fallback: false, stale: false, latency_ms: 1 },
    ]
    openGap(projectRoot, { module: 'orders', query: '退款什么情况下允许', kind: 'retrieval_miss' })
    const assessment = assessModuleConfidence(projectRoot, { dir: moduleDir, name: 'orders' }, traces, [], 30)
    assert.equal(assessment.evidence.evidenceScore, 0.9)
    assert.equal(assessment.scenario_coverage.applicable, 2)
    assert.equal(assessment.scenario_coverage.verified, 1)
    assert.equal(assessment.retrieval_usage.query_count, 2)
    assert.equal(assessment.retrieval_usage.found_rate, 0.5)
    assert.equal(assessment.gap_closure.discovered >= 1, true)
    assert.ok(['A', 'B', 'C', 'D', 'E'].includes(assessment.overall_confidence.grade))
    assert.equal(assessment.overall_confidence.policy, 'codewiki-confidence-v2')
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('usage report only counts explicit or exact Case mappings as reliable coverage', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'codewiki-usage-'))
  try {
    const moduleDir = join(projectRoot, '.codewiki', 'modules', 'orders')
    mkdirSync(moduleDir, { recursive: true })
    writeFileSync(join(moduleDir, 'manifest.yml'), 'module: orders\n')
    writeFileSync(join(moduleDir, 'retrieval-cases.json'), JSON.stringify({ cases: [
      {
        id: 'eval:orders:refund', status: 'active', module: 'orders', query: '什么情况下允许退款',
        expected_knowledge_ids: ['kb:orders:product:refund'], source: 'curated', created_at: new Date().toISOString(),
      },
      {
        id: 'eval:orders:coupon', status: 'active', module: 'orders', query: '优惠券怎么叠加',
        expected_knowledge_ids: ['kb:orders:product:coupon'], source: 'feedback', source_ref: 'ret_feedback', created_at: new Date().toISOString(),
      },
    ] }, null, 2))
    const at = new Date().toISOString()
    mkdirSync(join(projectRoot, '.codewiki'), { recursive: true })
    writeFileSync(join(projectRoot, '.codewiki', 'retrieval.jsonl'), [
      { retrieval_id: 'ret_exact', at, query: '什么情况下允许退款', module: 'orders', found: true, knowledge_ids: ['kb:orders:product:refund'] },
      { retrieval_id: 'ret_feedback', at, query: '优惠券什么时候能用', module: 'orders', found: true, knowledge_ids: ['kb:orders:product:coupon'] },
      // 同样命中退款知识，但问题无关，不能因 Knowledge 重叠被误判为 Case 命中。
      { retrieval_id: 'ret_shared_doc', at, query: '订单列表如何排序', module: 'orders', found: true, knowledge_ids: ['kb:orders:product:refund'] },
      { retrieval_id: 'ret_candidate', at, query: '什么情况下允许退款啊', module: 'orders', found: true, knowledge_ids: [] },
    ].map(item => JSON.stringify(item)).join('\n') + '\n')
    writeFileSync(join(projectRoot, '.codewiki', 'feedback.jsonl'), `${JSON.stringify({ at, retrieval_id: 'ret_shared_doc', query: '订单列表如何排序', module: 'orders', rating: 'bad' })}\n`)

    const report = buildUsageReport(projectRoot, { module: 'orders', days: 30 })
    assert.equal(report.case_coverage.matched, 2)
    assert.equal(report.case_coverage.candidate, 1)
    assert.equal(report.case_coverage.missing, 1)
    assert.deepEqual(report.case_coverage.matched_queries.map(item => [item.retrieval_id, item.reason]), [
      ['ret_exact', 'exact'],
      ['ret_feedback', 'explicit'],
    ])
    assert.equal(report.feedback.rated_queries, 1)
    assert.equal(report.feedback.unrated_queries, 3)
    assert.equal(report.case_assets.by_source.curated, 1)
    assert.equal(report.case_assets.by_source.feedback, 1)
    assert.equal(report.case_assets.smoke_cases, 0)
    assert.ok(report.optimization_candidates.some(item => item.query === '订单列表如何排序' && item.bad_feedback))
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
  }
})
