import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'

const root = join(import.meta.dirname, '..')
const bin = join(root, 'bin', 'codewiki.js')

function write(filePath, content) {
  mkdirSync(join(filePath, '..'), { recursive: true })
  writeFileSync(filePath, content)
}

function vueFixture() {
  const projectDir = mkdtempSync(join(tmpdir(), 'codewiki-cli-'))
  write(join(projectDir, 'src', 'views', 'order', 'list.vue'), `<template>
  <div>
    <button @click="handleExport">导出</button>
    <span>{{ orderCount }}</span>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { fetchOrders, exportOrders } from '../../../src/api/order'

const orderCount = ref(0)

async function load() {
  const res = await fetchOrders()
  orderCount.value = res.total
}

async function handleExport() {
  await exportOrders()
  load()
}
</script>
`)
  write(join(projectDir, 'src', 'api', 'order.ts'), `import { http } from './client'

export interface Order { id: string; total: number }

export async function fetchOrders(): Promise<{ total: number; items: Order[] }> {
  return http.get('/api/orders')
}

export async function exportOrders(): Promise<void> {
  return http.post('/api/orders/export', { format: 'csv' })
}
`)
  write(join(projectDir, 'src', 'api', 'client.ts'), `export const http = {
  get: (url: string) => fetch(url).then(r => r.json()),
  post: (url: string, body: unknown) => fetch(url, { method: 'POST', body: JSON.stringify(body) }),
}
`)
  write(join(projectDir, 'package.json'), JSON.stringify({ name: 'fixture', private: true }))
  return projectDir
}

function runCli(args, cwd) {
  return execFileSync(process.execPath, [bin, ...args], { encoding: 'utf8', cwd, timeout: 120000 })
}

test('codewiki scan runs the full AST pipeline and produces navigation outputs', { timeout: 120000 }, () => {
  const projectDir = vueFixture()
  try {
    const output = runCli(['scan', 'src', '--output', 'docs/order'], projectDir)
    assert.ok(output.length >= 0)
    const navDir = join(projectDir, 'docs', 'order', 'navigation')
    for (const file of ['file-graph.json', 'func-dependencies.json', 'component-refs.json', 'clusters.json', 'deep-analysis.json']) {
      assert.ok(existsSync(join(navDir, file)), `missing ${file}`)
    }
    const fileGraph = JSON.parse(readFileSync(join(navDir, 'file-graph.json'), 'utf8'))
    assert.ok(fileGraph.data.nodes.some(node => node.id?.includes('list.vue')))
    const componentRefs = JSON.parse(readFileSync(join(navDir, 'component-refs.json'), 'utf8'))
    const component = componentRefs.data.components.find(item => item.file?.includes('list.vue'))
    assert.ok(component, 'list.vue component not indexed')
    assert.ok(component.event_bindings.some(binding => binding.handler === 'handleExport'))
    const funcDeps = JSON.parse(readFileSync(join(navDir, 'func-dependencies.json'), 'utf8'))
    assert.ok(funcDeps.data.functions.some(fn => fn.name === 'handleExport'))
  } finally {
    rmSync(projectDir, { recursive: true, force: true })
  }
})

test('codewiki scan --validate writes validation report with per-file confidence', { timeout: 120000 }, () => {
  const projectDir = vueFixture()
  try {
    runCli(['scan', 'src', '--output', 'docs/order'], projectDir)
    write(join(projectDir, 'docs', 'order', 'product', '01-导出-flow.md'), [
      '---',
      'id: kb:order:product:export',
      'kind: business',
      'title: 导出',
      'aliases: [导出按钮]',
      'questions:',
      '  - 导出按钮怎么实现？',
      'entities: [订单]',
      '---',
      '',
      '# 导出',
      '',
      '点击导出按钮触发导出，见 src/views/order/list.vue:3。',
    ].join('\n'))
    const result = spawnSync(process.execPath, [bin, 'scan', 'src', 'docs/order', '--validate'], {
      cwd: projectDir,
      encoding: 'utf8',
      timeout: 120000,
    })
    assert.equal(result.status, 0, result.stderr)
    const reportPath = join(projectDir, 'docs', 'order', 'navigation', 'validation-report.json')
    assert.ok(existsSync(reportPath))
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    assert.ok(Array.isArray(report.per_file_confidence))
    assert.ok(report.per_file_confidence.some(item => item.doc.includes('01-导出-flow')))
    assert.ok(existsSync(join(projectDir, '.codewiki', 'knowledge-health', 'order', 'confidence-history.jsonl')))
  } finally {
    rmSync(projectDir, { recursive: true, force: true })
  }
})

test('codewiki confidence grades a module end to end', { timeout: 120000 }, () => {
  const projectDir = vueFixture()
  try {
    runCli(['scan', 'src', '--output', 'docs/order'], projectDir)
    write(join(projectDir, 'docs', 'order', 'product', '01-导出-flow.md'), [
      '---',
      'id: kb:order:product:export',
      'kind: business',
      'title: 导出',
      'aliases: [导出按钮]',
      'questions:',
      '  - 导出按钮怎么实现？',
      'entities: [订单]',
      '---',
      '',
      '# 导出',
      '',
      '见 src/views/order/list.vue:3。',
    ].join('\n'))
    write(join(projectDir, 'docs', 'order', 'manifest.yml'), 'module: order\n')
    spawnSync(process.execPath, [bin, 'scan', 'src', 'docs/order', '--validate'], { cwd: projectDir, encoding: 'utf8', timeout: 120000 })
    // 模拟两条检索命中记录：一条命中、一条未命中
    write(join(projectDir, '.codewiki', 'retrieval.jsonl'), [
      JSON.stringify({ at: new Date().toISOString(), query: '导出按钮怎么实现', module: 'order', modules: ['order'], found: true, fallback: false, stale: false, latency_ms: 4, knowledge_ids: [], evidence_ids: [] }),
      JSON.stringify({ at: new Date().toISOString(), query: '退款什么情况下允许', module: 'order', modules: ['order'], found: false, fallback: true, stale: false, latency_ms: 2, knowledge_ids: [], evidence_ids: [] }),
    ].join('\n') + '\n')
    const output = runCli(['confidence', '--json'], projectDir)
    const result = JSON.parse(output)
    assert.equal(result.modules.length, 1)
    const module = result.modules[0]
    assert.ok(module.evidence.evidenceScore != null)
    assert.equal(module.retrieval_usage.query_count, 2)
    assert.equal(module.retrieval_usage.found_rate, 0.5)
    assert.ok(module.retrieval_usage.top_missed_queries.some(miss => miss.query.includes('退款')))
    assert.ok(['A', 'B', 'C', 'D', 'E', 'N_A'].includes(module.overall_confidence.grade))
    // human 输出模式
    const text = runCli(['confidence'], projectDir)
    assert.ok(text.includes('模块：order'))
    assert.ok(text.includes('综合评级'))
  } finally {
    rmSync(projectDir, { recursive: true, force: true })
  }
})
