import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { discoverSourceUnits } from '../src/scan/source-units.mjs'
import { extractModuleFacts } from '../src/scan/fact-extractor.mjs'
import { parseKnowledgeDocument } from '../src/scan/knowledge-retrieval.mjs'

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

function monorepoFixture() {
  const root = mkdtempSync(join(tmpdir(), 'codewiki-monorepo-'))
  write(join(root, 'codewiki.yml'), [
    'knowledge_root: .codewiki/modules',
    'state_root: .codewiki',
    'modules:',
    '  - name: orders',
    '    source_units:',
    '      - name: admin-vue2',
    '        path: apps/admin',
    '        framework: vue',
    '      - name: console-vue3',
    '        path: apps/console',
    '        framework: vue',
    '      - name: portal-react',
    '        path: apps/portal',
    '        framework: react',
    '      - name: order-java',
    '        path: services/order-java',
    '        language: java',
    '      - name: order-go',
    '        path: services/order-go',
    '        language: go',
  ].join('\n'))
  write(join(root, 'apps/admin/package.json'), JSON.stringify({ dependencies: { vue: '^2.6.14' } }))
  write(join(root, 'apps/console/package.json'), JSON.stringify({ dependencies: { vue: '^3.5.1' } }))
  write(join(root, 'apps/portal/package.json'), JSON.stringify({ dependencies: { react: '^18.3.1' } }))
  write(join(root, 'services/order-java/pom.xml'), '<dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>')
  write(join(root, 'services/order-go/go.mod'), 'module example/order\n\nrequire github.com/gin-gonic/gin v1.10.0\n')
  return root
}

test('Source Units detect framework versions and capabilities per workspace', () => {
  const root = monorepoFixture()
  try {
    const units = discoverSourceUnits({ projectRoot: root, moduleName: 'orders' })
    assert.equal(units.length, 5)
    const byId = new Map(units.map(unit => [unit.id, unit]))
    assert.equal(byId.get('admin-vue2').framework_version, '^2.6.14')
    assert.ok(byId.get('admin-vue2').features.includes('legacy-v-model'))
    assert.ok(!byId.get('admin-vue2').features.includes('script-setup'))
    assert.ok(byId.get('console-vue3').features.includes('reactive-props-destructure'))
    assert.ok(byId.get('portal-react').features.includes('create-root'))
    assert.equal(byId.get('order-java').framework, 'spring')
    assert.equal(byId.get('order-go').framework, 'gin')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Vue 2.7 and common React majors select different capability Profiles', () => {
  const root = mkdtempSync(join(tmpdir(), 'codewiki-version-profiles-'))
  try {
    write(join(root, 'codewiki.yml'), [
      'modules:',
      '  - name: ui-platform',
      '    source_units:',
      '      - { name: vue27, path: apps/vue27, framework: vue }',
      '      - { name: react16, path: apps/react16, framework: react }',
      '      - { name: react17, path: apps/react17, framework: react }',
      '      - { name: react19, path: apps/react19, framework: react }',
    ].join('\n'))
    write(join(root, 'apps/vue27/package.json'), JSON.stringify({ dependencies: { vue: '2.7.16' } }))
    write(join(root, 'apps/react16/package.json'), JSON.stringify({ dependencies: { react: '16.8.6' } }))
    write(join(root, 'apps/react17/package.json'), JSON.stringify({ dependencies: { react: '17.0.2' } }))
    write(join(root, 'apps/react19/package.json'), JSON.stringify({ dependencies: { react: '19.2.0' } }))
    const byId = new Map(discoverSourceUnits({ projectRoot: root, moduleName: 'ui-platform' }).map(unit => [unit.id, unit]))
    assert.ok(byId.get('vue27').features.includes('composition-api'))
    assert.ok(byId.get('vue27').features.includes('script-setup'))
    assert.ok(byId.get('react16').features.includes('hooks'))
    assert.ok(byId.get('react16').features.includes('classic-jsx-runtime'))
    assert.ok(byId.get('react17').features.includes('automatic-jsx-runtime'))
    assert.ok(byId.get('react19').features.includes('actions'))
    assert.ok(byId.get('react19').features.includes('server-components'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('unified facts link Vue/React API calls to Java and Go endpoints', async () => {
  const root = monorepoFixture()
  try {
    write(join(root, 'apps/admin/src/OrderForm.vue'), [
      '<template><form @submit="submit"><input v-model="orderNo" /></form></template>',
      '<script>',
      'export default { props: { orderNo: String }, methods: { submit() { return api.post("/api/orders") } } }',
      '</script>',
    ].join('\n'))
    write(join(root, 'apps/console/src/OrderList.vue'), [
      '<script setup lang="ts">',
      'const props = defineProps<{ orderNo: string }>()',
      'const emit = defineEmits(["selected"])',
      '</script>',
      '<template><button @click="emit(\'selected\')">{{ props.orderNo }}</button></template>',
    ].join('\n'))
    write(join(root, 'apps/portal/src/OrderPage.tsx'), [
      'import React, { useState } from "react"',
      'export function OrderPage({ orderNo }: { orderNo: string }) {',
      '  const [saving, setSaving] = useState(false)',
      '  const submit = () => fetch("/api/orders", { method: "POST" })',
      '  const load = () => fetch("/api/orders/42")',
      '  return <button onClick={submit}>{orderNo}</button>',
      '}',
      'export class LegacyPanel extends React.Component {',
      '  state = { open: false }',
      '  render() { return <aside>{this.state.open}</aside> }',
      '}',
    ].join('\n'))
    write(join(root, 'services/order-java/src/main/java/com/example/OrderController.java'), [
      'package com.example;',
      'import org.springframework.web.bind.annotation.*;',
      '@RestController',
      '@RequestMapping("/api")',
      'class OrderController {',
      '  @PostMapping("/orders")',
      '  public void create() { save(); }',
      '  void save() {}',
      '}',
    ].join('\n'))
    write(join(root, 'services/order-go/order.go'), [
      'package order',
      'import "github.com/gin-gonic/gin"',
      'func Register(router *gin.Engine) { router.GET("/api/orders/:id", GetOrder) }',
      'func GetOrder(c *gin.Context) {}',
    ].join('\n'))

    const outputDir = join(root, '.codewiki/modules/orders')
    const result = await extractModuleFacts({ projectRoot: root, moduleName: 'orders', outputDir })
    assert.equal(result.source_units.length, 5)
    assert.ok(result.nodes.some(node => node.type === 'component' && node.framework === 'vue' && node.label === 'OrderForm'))
    assert.ok(result.nodes.some(node => node.type === 'component' && node.framework === 'react' && node.label === 'OrderPage'))
    assert.ok(result.nodes.some(node => node.type === 'state' && node.label === 'saving'))
    assert.ok(result.nodes.some(node => node.type === 'state' && node.label === 'open' && node.state_style === 'class'))
    assert.ok(result.nodes.some(node => node.type === 'model-binding' && node.syntax === 'vue2' && node.prop === 'value' && node.event === 'input'))
    assert.ok(result.nodes.some(node => node.type === 'endpoint' && node.language === 'java' && node.method === 'POST' && node.route === '/api/orders'))
    assert.ok(result.nodes.some(node => node.type === 'endpoint' && node.language === 'go' && node.method === 'GET' && node.route === '/api/orders/:param'))
    assert.ok(result.edges.some(edge => edge.type === 'calls-endpoint' && edge.confidence === 1))
    assert.ok(result.edges.some(edge => edge.type === 'calls-endpoint' && edge.resolver === 'http-method-route-template' && edge.confidence === 0.9))

    const sourceUnits = JSON.parse(readFileSync(join(outputDir, 'navigation/source-units.json'), 'utf8'))
    assert.equal(sourceUnits.source_units.length, 5)
    assert.ok(readFileSync(join(outputDir, 'navigation/framework-facts.json'), 'utf8').includes('calls-endpoint'))
    assert.ok(readFileSync(join(outputDir, 'navigation/graph-index.json'), 'utf8').includes('source-unit-profile-v1'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI generates one graph for a configured multi-Source-Unit module', () => {
  const root = monorepoFixture()
  try {
    write(join(root, 'apps/portal/src/App.tsx'), 'export function App() { return <main>Orders</main> }\n')
    write(join(root, 'services/order-java/src/main/java/OrderService.java'), 'class OrderService { void create() {} }\n')
    const bin = join(import.meta.dirname, '..', 'bin', 'codewiki.js')
    const output = execFileSync(process.execPath, [bin, 'generate', '--module', 'orders', '--json'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120000,
    })
    const generated = JSON.parse(output)
    assert.equal(generated.source_units.length, 5)
    assert.equal(generated.impact.classification, 'KNOWLEDGE_IMPACT')
    const navigationDir = join(root, '.codewiki/modules/orders/navigation')
    for (const file of ['source-units.json', 'framework-facts.json', 'graph-index.json', 'graph.jsonl']) {
      assert.ok(readFileSync(join(navigationDir, file), 'utf8').length > 0, `missing ${file}`)
    }
    const graph = readFileSync(join(navigationDir, 'graph.jsonl'), 'utf8')
    assert.match(graph, /"language":"java"/)
    assert.match(graph, /"framework":"react"/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Java and Go file:line references become knowledge evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'codewiki-code-refs-'))
  try {
    const moduleDir = join(root, '.codewiki/modules/orders')
    const document = join(moduleDir, 'developer/01-架构与调用图.md')
    write(document, [
      '---',
      'id: kb:orders:developer:architecture',
      'title: 架构',
      'aliases: [订单架构]',
      'questions: [订单如何实现]',
      'entities: [订单]',
      '---',
      '# 架构',
      '入口见 services/orders/OrderController.java:12，下游见 services/payment/order.go:8。',
    ].join('\n'))
    const parsed = parseKnowledgeDocument(document, moduleDir, 'orders')
    assert.deepEqual(parsed.code_refs, [
      { file: 'services/orders/OrderController.java', line: 12 },
      { file: 'services/payment/order.go', line: 8 },
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
