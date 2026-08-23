#!/usr/bin/env node
/**
 * field-lineage.mjs — 融合中间产物，产出字段级溯源
 *
 * 输入（顺序，缺失时降级）：
 *   navigation/_intermediate/field-candidates.json    组件 template_bindings（nav-parser 产）
 *   navigation/_intermediate/pinia-stores.json        store 结构（pinia-tracker 产）
 *   navigation/_intermediate/api-payload-shapes.json  endpoints_by_file（data-shape-tracer 产）
 *   navigation/_intermediate/flows.json               业务流字段引用（Step 2.7 产，可选）
 *
 * 输出：
 *   navigation/field-lineage/index.json            页面元信息 + 全模块字段计数
 *   navigation/field-lineage/pages/<page-id>.json  每页面字段级完整链路
 *   navigation/field-lineage/reverse-index.json    接口 endpoint → [页面.字段] 反查表
 *
 * 用法：node field-lineage.mjs <target-dir> [--output <base-dir>] [--reindex]
 *
 * 首版策略（脚本层保守，LLM 补证由主 skill 触发）：
 * - store 归属：组件源码里 use<X>Store() 使用点作为候选，binding.root 弱匹配 state_field 时提升信心
 * - source_apis：从组件所用 store 的 file 反查 endpoints_by_file，首版是"文件级候选"，LLM 精确归属
 * - coverage 判定：full（v_model / 状态类字段 / 有 store 且有 endpoints）→ short（有 store 无 endpoints）→ static（其他）
 * - confidence：脚本候选只产 C/D；LLM 补证后升为 A/B，再用 --reindex 重建权威反向索引
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join, resolve, basename, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { computeFieldFingerprint } from './fingerprint.mjs'

const args = process.argv.slice(2)
const targetDir = args[0]
if (!targetDir) {
  console.error('Usage: node field-lineage.mjs <target-dir> [--output <base-dir>]')
  process.exit(1)
}
const outputFlagIdx = args.indexOf('--output')
const reindexOnly = args.includes('--reindex')
const positionalOutput = args[1] && !args[1].startsWith('--') ? args[1] : null
const outputBaseDir = outputFlagIdx !== -1 ? args[outputFlagIdx + 1] : positionalOutput

const absTarget = resolve(targetDir)
const navDir = outputBaseDir ? join(resolve(outputBaseDir), 'navigation') : join(absTarget, '.doc', 'navigation')
const intermediateDir = join(navDir, '_intermediate')
const outDir = join(navDir, 'field-lineage')
const pagesDir = join(outDir, 'pages')

function navigationId(kind, ...parts) {
  const encoded = parts.map(part => encodeURIComponent(String(part || '').replace(/\\/g, '/')))
  return `nav:${kind}:${encoded.join(':')}`
}

function loadIntermediate(name) {
  const p = join(intermediateDir, name)
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf-8')) } catch { return null }
}

const fieldCandidates = loadIntermediate('field-candidates.json')
const piniaStores = loadIntermediate('pinia-stores.json')
const apiShapes = loadIntermediate('api-payload-shapes.json')
const flows = loadIntermediate('flows.json') // 首版可选，Step 2.7 后续会写

if (!reindexOnly && !fieldCandidates) {
  console.error('[field-lineage] Missing field-candidates.json — run nav-parser first')
  process.exit(1)
}

const stores = piniaStores?.stores || []
const endpointsByFile = apiShapes?.endpoints_by_file || {}
const flowsFieldRefs = new Set()
for (const flow of flows?.main_flow || []) {
  for (const step of flow.steps || []) {
    for (const ref of step.fields_referenced || []) flowsFieldRefs.add(ref)
  }
}

// --- 页面 id 生成 ---
// Basename 唯一时保留简短 ID；同名页面用相对路径消歧，避免 index.vue 互相覆盖。
function basePageIdFromFile(file) {
  const base = basename(file).replace(/\.vue$/, '')
  return base.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

const pageBaseCounts = new Map()
for (const comp of fieldCandidates?.components || []) {
  if (!comp.template_bindings?.length) continue
  const base = basePageIdFromFile(comp.file)
  pageBaseCounts.set(base, (pageBaseCounts.get(base) || 0) + 1)
}

function pathPageIdFromFile(file) {
  return file
    .replace(/\.vue$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
}

const pageIdByFile = new Map()
const pageFileById = new Map()
for (const comp of fieldCandidates?.components || []) {
  if (!comp.template_bindings?.length) continue
  const base = basePageIdFromFile(comp.file)
  let pageId = pageBaseCounts.get(base) === 1 ? base : pathPageIdFromFile(comp.file)
  if (pageFileById.has(pageId) && pageFileById.get(pageId) !== comp.file) {
    const suffix = createHash('sha1').update(comp.file).digest('hex').slice(0, 8)
    pageId = `${pageId}-${suffix}`
  }
  pageIdByFile.set(comp.file, pageId)
  pageFileById.set(pageId, comp.file)
}

function pageIdFromFile(file) {
  return pageIdByFile.get(file) || pathPageIdFromFile(file)
}

// --- 状态类字段名判定 ---
const STATE_FIELD_HINT = /(?:^|\.)(status|state|phase|stage|zhuang(?:tai)?)$/i

// --- store 归属：读组件源码找 use<X>Store() 调用点 ---
const USE_STORE_RE = /\buse([A-Z]\w*?)Store\s*\(/g
function findUsedStoresInComponent(componentFile) {
  const abs = resolve(absTarget, componentFile)
  if (!existsSync(abs)) return []
  let code
  try { code = readFileSync(abs, 'utf-8') } catch { return [] }
  const usedIds = new Set()
  let m
  while ((m = USE_STORE_RE.exec(code)) !== null) {
    // useOrderStore -> order（首字符转小写）
    const rawId = m[1]
    usedIds.add(rawId.charAt(0).toLowerCase() + rawId.slice(1))
  }
  return stores.filter(s => usedIds.has(s.id))
}

// --- 从 binding.path 找可能的 store 匹配 ---
function matchStoreForBinding(binding, usedStores) {
  const rootPath = binding.path.split(/[.?[]/, 1)[0]
  // 1) 直接同名（如 template 里 orderStore.xxx，root=orderStore）
  const idMatch = usedStores.find(s => rootPath.toLowerCase().startsWith(s.id.toLowerCase()))
  if (idMatch) return { store: idMatch, matchKind: 'root_id' }
  // 2) rootPath 命中某 store 的 state_field 名（如 rootPath=currentOrder）
  for (const s of usedStores) {
    const hit = s.state_fields?.find(f => f.name === rootPath)
    if (hit) return { store: s, matchKind: 'state_field', field: hit }
  }
  // 3) rootPath 是通用命名（order/user/task），组件用了唯一 store，弱归属
  if (usedStores.length === 1) return { store: usedStores[0], matchKind: 'sole_store' }
  return null
}

// import 语句正则；匹配 default / namespace / named 三种形式，仅捕获 source
const IMPORT_SOURCE_RE = /import\s+(?:type\s+)?(?:[^'"]+?\s+from\s+)?['"]([^'"]+)['"]/g

// 从 spec (@/api/order 或 ./api/order 或 ../api/order) 反向匹配 endpoints_by_file 里的 relative path
function resolveImportSpec(spec, fromFile) {
  if (!spec) return null
  if (spec.startsWith('@/')) return 'src/' + spec.slice(2)
  if (spec.startsWith('./') || spec.startsWith('../')) {
    const parts = join(dirname(fromFile), spec).split('/').filter(p => p !== '')
    return parts.join('/')
  }
  return null // node_modules 之类跳过
}

function findEndpointsViaImports(storeFile) {
  const abs = resolve(absTarget, storeFile)
  if (!existsSync(abs)) return []
  let code
  try { code = readFileSync(abs, 'utf-8') } catch { return [] }
  const collected = []
  let m
  IMPORT_SOURCE_RE.lastIndex = 0
  while ((m = IMPORT_SOURCE_RE.exec(code)) !== null) {
    const candidate = resolveImportSpec(m[1], storeFile)
    if (!candidate) continue
    // endpoints_by_file 的 key 是相对路径 + 扩展名，用前缀匹配容错
    for (const [file, list] of Object.entries(endpointsByFile)) {
      if (file === storeFile) continue
      const fileNoExt = file.replace(/\.(ts|tsx|js|jsx|mjs|vue)$/, '')
      if (fileNoExt === candidate) {
        collected.push(...list.map(e => ({ ...e, via_import: file })))
      }
    }
  }
  return collected
}

function deriveSourceApis(store) {
  const direct = endpointsByFile[store.file] || []
  const viaImports = findEndpointsViaImports(store.file)
  const merged = [...direct, ...viaImports]
  const seen = new Set()
  const unique = merged.filter(e => {
    const k = `${e.protocol}|${e.method || ''}|${e.endpoint}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  return unique.map(e => ({
    protocol: e.protocol,
    ...(e.method && { method: e.method }),
    endpoint: e.endpoint,
    raw_field: null, // 首版留空；LLM 补证或 T2c+ 升级抽真实 payload 时填入
    at: `${e.via_import || store.file}:${e.line}`,
    confidence: 'C', // 文件级 endpoint 候选，逐 API 补证前不可进入权威反向索引
    ...(e.via_import && { via: 'store_import' }),
  }))
}

function computeCoverage(binding, matched, apis) {
  if (binding.editable) return 'full'
  if (STATE_FIELD_HINT.test(binding.path)) return 'full'
  if (flowsFieldRefs.has(binding.path)) return 'full'
  if (matched && apis.length > 0) return 'full'
  if (matched) return 'short'
  return 'static'
}

function computeConfidence(matched, apis) {
  // endpoints_by_file 只是文件级候选，未经逐 action/field 补证不能升为 A/B。
  if (matched && apis.length > 0) return 'C'
  if (matched) return 'C'
  return 'D'
}

// --- 组装每个组件的 fields ---
function loadExistingPages() {
  const indexPath = join(outDir, 'index.json')
  if (!existsSync(indexPath)) {
    console.error('[field-lineage] Missing field-lineage/index.json — run full field-lineage first')
    process.exit(1)
  }
  let index
  try { index = JSON.parse(readFileSync(indexPath, 'utf-8')) }
  catch (e) {
    console.error(`[field-lineage] Invalid field-lineage/index.json: ${e.message}`)
    process.exit(1)
  }
  const loaded = []
  for (const pageRef of index.pages || []) {
    const pagePath = join(pagesDir, `${pageRef.page_id}.json`)
    try { loaded.push(JSON.parse(readFileSync(pagePath, 'utf-8'))) }
    catch (e) {
      console.error(`[field-lineage] Cannot reindex ${pagePath}: ${e.message}`)
      process.exit(1)
    }
  }
  return loaded
}

const pages = reindexOnly ? loadExistingPages() : []
const reverseHttp = new Map()
const reverseIpc = new Map()
const reverseWs = new Map()
const reverseBroadcast = new Map()

function pushReverse(map, keyParts, fieldId) {
  const key = JSON.stringify(keyParts)
  if (!map.has(key)) map.set(key, new Set())
  map.get(key).add(fieldId)
}

if (!reindexOnly) for (const comp of fieldCandidates.components || []) {
  if (!comp.template_bindings?.length) continue
  const pageId = pageIdFromFile(comp.file)
  const usedStores = findUsedStoresInComponent(comp.file)
  const fields = []

  // 同一 path 会有多个 kind（interpolation + prop_bind），按 path 归并展示
  const byPath = new Map()
  for (const b of comp.template_bindings) {
    if (!byPath.has(b.path)) byPath.set(b.path, [])
    byPath.get(b.path).push(b)
  }

  for (const [path, bindings] of byPath) {
    const primary = bindings[0]
    const editable = bindings.some(b => b.editable)
    const kinds = [...new Set(bindings.map(b => b.kind))]
    const matched = matchStoreForBinding(primary, usedStores)
    const apis = matched ? deriveSourceApis(matched.store) : []
    const coverage = computeCoverage({ ...primary, editable, path }, matched, apis)
    const confidence = computeConfidence(matched, apis)
    const evidence = bindings.map(b => `${comp.file}:${b.line}`).filter(Boolean)
    if (matched) evidence.push(`${matched.store.file}:${matched.store.line}`)
    for (const a of apis) evidence.push(a.at)

    const fieldId = `${pageId}.${path.replace(/[.?[]/g, '_').replace(/[\]]/g, '')}`

    fields.push({
      id: fieldId,
      nav_id: navigationId('field-lineage', fieldId),
      path,
      display_name: null,
      display_position: null,
      coverage,
      binding_kinds: kinds,
      component_bindings: bindings.map(b => ({
        expr: b.path,
        kind: b.kind,
        at: `${comp.file}:${b.line}`,
        ...(b.attribute && { attribute: b.attribute }),
        ...(b.element && { element: b.element }),
        ...(b.event && { event: b.event }),
      })),
      upstream_store: matched ? {
        store_id: matched.store.id,
        state_field: matched.field?.name || null,
        match_kind: matched.matchKind,
        at: `${matched.store.file}:${matched.store.line}`,
      } : null,
      source_apis: apis,
      transforms: [],       // 留给 LLM 补证
      display_conditions: [],
      abnormal_states: [],
      editable,
      confidence,
      evidence,
    })

  }

  pages.push({
    page_id: pageId,
    nav_id: navigationId('page', pageId),
    page_file: comp.file,
    chinese_name: null,
    fields,
  })
}

// --reindex must also upgrade legacy page files without changing their domain IDs.
for (const page of pages) {
  page.nav_id ||= navigationId('page', page.page_id)
  for (const field of page.fields || []) {
    field.nav_id ||= navigationId('field-lineage', field.id)
  }
}

// 只有 A/B 级已验证关系才能进入权威反向索引。--reindex 用于 LLM patch 后重建。
for (const page of pages) {
  for (const field of page.fields || []) {
    if (field.confidence !== 'A' && field.confidence !== 'B') continue
    for (const api of field.source_apis || []) {
      if (api.confidence !== 'A' && api.confidence !== 'B') continue
      const proto = api.protocol
      const target = proto === 'http' ? reverseHttp : proto === 'ipc' ? reverseIpc : proto === 'ws' ? reverseWs : reverseBroadcast
      const keyParts = proto === 'http'
        ? [api.method || 'GET', api.endpoint, api.raw_field ?? null]
        : [api.endpoint, api.raw_field ?? null]
      pushReverse(target, keyParts, field.id)
    }
  }
}

// --- 写产物 ---
mkdirSync(outDir, { recursive: true })
const generatedAt = new Date().toISOString()
const producer = 'field-lineage.mjs'
const tempPagesDir = join(outDir, `.pages.tmp-${process.pid}-${Date.now()}`)
const backupPagesDir = join(outDir, `.pages.backup-${process.pid}-${Date.now()}`)
mkdirSync(tempPagesDir, { recursive: true })
try {
  for (const page of pages) {
    writeFileSync(join(tempPagesDir, `${page.page_id}.json`), JSON.stringify({
      ...page,
      generated_at: generatedAt,
      producer,
    }, null, 2))
  }
  if (existsSync(pagesDir)) renameSync(pagesDir, backupPagesDir)
  try {
    renameSync(tempPagesDir, pagesDir)
  } catch (err) {
    if (existsSync(backupPagesDir)) renameSync(backupPagesDir, pagesDir)
    throw err
  }
  rmSync(backupPagesDir, { recursive: true, force: true })
} catch (err) {
  rmSync(tempPagesDir, { recursive: true, force: true })
  throw err
}

const totalFields = pages.reduce((sum, p) => sum + p.fields.length, 0)
const coverageStats = { full: 0, short: 0, static: 0 }
const confidenceStats = { A: 0, B: 0, C: 0, D: 0, E: 0 }
let pendingLlmVerification = 0
for (const p of pages) {
  for (const f of p.fields) {
    coverageStats[f.coverage] = (coverageStats[f.coverage] || 0) + 1
    confidenceStats[f.confidence] = (confidenceStats[f.confidence] || 0) + 1
    const fieldPending = f.confidence === 'C' || f.confidence === 'D' || f.confidence === 'E'
    const apiPending = (f.source_apis || []).some(api => api.confidence !== 'A' && api.confidence !== 'B')
    if (fieldPending || apiPending) pendingLlmVerification++
  }
}

writeFileSync(join(outDir, 'index.json'), JSON.stringify({
  metadata: {
    generated_at: generatedAt,
    producer,
    version: '1.0',
    contract: 'candidate-evidence-only',
    total_pages: pages.length,
    total_fields: totalFields,
    coverage_stats: coverageStats,
    confidence_stats: confidenceStats,
    pending_llm_verification: pendingLlmVerification,
  },
  pages: pages.map(p => ({
    page_id: p.page_id,
    nav_id: p.nav_id,
    page_file: p.page_file,
    field_count: p.fields.length,
  })),
}, null, 2))

// 反向索引：结构化数组格式（P6 优化：避免 # 混合 key）
function toReverseArray(map, kind) {
  return [...map.entries()].map(([key, fieldSet]) => {
    const parts = JSON.parse(key)
    const entry = { used_by: [...fieldSet] }
    if (kind === 'http') {
      entry.method = parts[0]
      entry.endpoint = parts[1]
      entry.raw_field = parts[2]
    } else {
      entry.endpoint = parts[0]
      entry.raw_field = parts[1]
    }
    return entry
  })
}

writeFileSync(join(outDir, 'reverse-index.json'), JSON.stringify({
  metadata: { generated_at: generatedAt, producer, version: '1.0' },
  http: toReverseArray(reverseHttp, 'http'),
  ipc: toReverseArray(reverseIpc, 'ipc'),
  ws: toReverseArray(reverseWs, 'ws'),
  broadcast: toReverseArray(reverseBroadcast, 'broadcast'),
}, null, 2))

console.log(`[field-lineage] Written ${pages.length} pages / ${totalFields} fields`)
console.log(`  coverage: full=${coverageStats.full} short=${coverageStats.short} static=${coverageStats.static}`)
console.log(`  confidence: A=${confidenceStats.A} B=${confidenceStats.B} C=${confidenceStats.C} D=${confidenceStats.D} E=${confidenceStats.E}`)
console.log(`  pending_llm_verification: ${pendingLlmVerification}`)

// T1b: 回填 fieldFingerprint 到 graph-index.json 的 page_fingerprints
const graphIndexPath = join(navDir, 'graph-index.json')
if (existsSync(graphIndexPath)) {
  try {
    const graphIndex = JSON.parse(readFileSync(graphIndexPath, 'utf-8'))
    graphIndex.page_fingerprints = {}
    for (const file of Object.values(graphIndex.files || {})) {
      file.fieldFingerprint = null
    }
    let backfilled = 0
    for (const page of pages) {
      const fp = computeFieldFingerprint(page.fields)
      graphIndex.page_fingerprints[page.page_id] = {
        fingerprint: fp,
        page_file: page.page_file,
        field_count: page.fields.length,
      }
      // 同时把 fieldFingerprint 写到该页面文件对应的 files entry（方便 file 级判定）
      if (graphIndex.files?.[page.page_file]) {
        graphIndex.files[page.page_file].fieldFingerprint = fp
      }
      backfilled++
    }
    writeFileSync(graphIndexPath, JSON.stringify(graphIndex, null, 2))
    console.log(`[field-lineage] Backfilled ${backfilled} page fingerprints to graph-index.json`)
  } catch (e) {
    console.warn(`[field-lineage] Failed to backfill graph-index.json: ${e.message}`)
  }
} else {
  console.warn(`[field-lineage] graph-index.json not found at ${graphIndexPath}, skip backfill`)
}
