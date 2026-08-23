import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { parse as parseYaml } from 'yaml'

const INDEX_VERSION = 3
const MAX_OUTPUT_CHARS = 20000
const MAX_EVIDENCE_FILES = 8
const BINDING_ROLES = new Set(['entry', 'rule', 'implementation', 'state', 'data'])
const BINDING_CONFIDENCE = new Set(['verified', 'ast', 'candidate'])
const STOP_TERMS = new Set(['什么', '怎么', '如何', '为什么', '是否', '这个', '那个', '实现', '相关', '代码', '功能'])
const KNOWLEDGE_DIRS = ['product', 'frontend']
const INDEXED_NAVIGATION_FILES = [
  'file-graph.json',
  'func-dependencies.json',
  'component-refs.json',
  'clusters.json',
  'deep-analysis.json',
  'liveness.json',
  'dynamic-flows.jsonl',
]
const memoryIndexCache = new Map()

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/')
}

function encodeId(value) {
  return encodeURIComponent(normalizePath(value))
}

function navId(kind, ...parts) {
  return `nav:${kind}:${parts.map(encodeId).join(':')}`
}

function sha1(value) {
  return createHash('sha1').update(String(value)).digest('hex')
}

function readText(filePath, fallback = '') {
  try { return readFileSync(filePath, 'utf8') } catch { return fallback }
}

function readJson(filePath, fallback = null) {
  try { return JSON.parse(readFileSync(filePath, 'utf8')) } catch { return fallback }
}

function listFiles(dir, predicate, output = []) {
  if (!existsSync(dir)) return output
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.archive' || entry.name.startsWith('.')) continue
    const filePath = join(dir, entry.name)
    if (entry.isDirectory()) listFiles(filePath, predicate, output)
    else if (predicate(filePath)) output.push(filePath)
  }
  return output
}

function unique(input) {
  return [...new Set((input || []).filter(Boolean))]
}

function duplicateValues(values) {
  const seen = new Set()
  const duplicates = new Set()
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value)
    seen.add(value)
  }
  return [...duplicates]
}

function asStringArray(value) {
  if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean)
  if (typeof value === 'string' && value.trim()) return [value.trim()]
  return []
}

function stripMarkdown(value) {
  return String(value || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}[#>*+-]\s*/gm, '')
    .replace(/[*_~|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function markdownHeadings(body) {
  return [...String(body || '').matchAll(/^#{1,4}\s+(.+)$/gm)].map(match => stripMarkdown(match[1]))
}

function codeReferences(body) {
  const refs = []
  const pattern = /(?<![\w:/.-])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:vue|ts|js|tsx|jsx|mjs|cjs)):(\d+)\b/g
  let match
  while ((match = pattern.exec(body)) !== null) {
    refs.push({ file: normalizePath(match[1]), line: Number(match[2]) })
  }
  return refs
}

function parseFrontmatter(content) {
  const match = String(content || '').match(/^---\s*\n([\s\S]*?)\n---\s*\n?/)
  if (!match) return { data: {}, body: String(content || '') }
  try {
    return { data: parseYaml(match[1]) || {}, body: content.slice(match[0].length) }
  } catch {
    return { data: {}, body: String(content || '') }
  }
}

function knowledgeFallbackId(moduleName, layer, relPath) {
  const stem = normalizePath(relPath).replace(/\.md$/i, '').replace(/^[0-9]+-/, '')
  return `kb:${encodeId(moduleName)}:${encodeId(layer)}:${encodeId(stem)}`
}

export function parseKnowledgeDocument(filePath, moduleDir, moduleName) {
  const content = readText(filePath)
  const { data, body } = parseFrontmatter(content)
  const relPath = normalizePath(relative(moduleDir, filePath))
  const layer = relPath.split('/')[0] || 'overview'
  const heading = body.match(/^#\s+(.+)$/m)?.[1]
  const title = String(data.title || heading || basename(filePath, extname(filePath))).trim()
  const evidence = Array.isArray(data.evidence || data.evidence_refs)
    ? (data.evidence || data.evidence_refs).map(item => typeof item === 'string' ? { id: item } : item).filter(Boolean)
    : []
  const headings = markdownHeadings(body)
  const plain = stripMarkdown(body)
  return {
    id: String(data.id || knowledgeFallbackId(moduleName, layer, relPath)),
    module: moduleName,
    kind: String(data.kind || layer),
    layer,
    title,
    aliases: asStringArray(data.aliases),
    questions: asStringArray(data.questions),
    entities: asStringArray(data.entities),
    related: asStringArray(data.related),
    evidence,
    code_refs: codeReferences(body),
    path: relPath,
    headings,
    body,
    plain,
    generated_id: !data.id,
    frontmatter_fields: Object.keys(data),
  }
}

function cjkTerms(value) {
  const terms = []
  for (const match of String(value || '').matchAll(/[\u3400-\u9fff]+/g)) {
    const text = match[0]
    if (text.length <= 8) terms.push(text)
    for (let i = 0; i < text.length - 1; i++) terms.push(text.slice(i, i + 2))
  }
  return terms
}

export function tokenize(value) {
  const text = String(value || '').toLowerCase()
  const ascii = text.match(/[a-z0-9_$.-]{2,}/g) || []
  return unique([...ascii, ...cjkTerms(text)]).filter(term => !STOP_TERMS.has(term))
}

function parseCaseKnowledge(item, moduleName, sourcePath) {
  if (!item || item.status !== 'active' || String(item.module || moduleName) !== moduleName) return null
  const answer = String(item.answer || item.body || '').trim()
  if (!item.id || !answer) return null
  const evidenceRefs = asStringArray(item.evidence_refs)
  const codeRefs = evidenceRefs.flatMap(reference => {
    const match = reference.match(/^(.+):(\d+)$/)
    return match ? [{ file: normalizePath(match[1]), line: Number(match[2]) }] : []
  })
  const body = `# ${String(item.title || item.questions?.[0] || '反馈知识').trim()}\n\n${answer}\n\n${evidenceRefs.length ? `技术证据：${evidenceRefs.join('、')}\n` : ''}`
  return {
    id: String(item.id),
    module: moduleName,
    kind: String(item.kind || 'feedback'),
    layer: 'cases',
    title: String(item.title || item.questions?.[0] || '反馈知识').trim(),
    aliases: asStringArray(item.aliases),
    questions: asStringArray(item.questions),
    entities: asStringArray(item.entities),
    related: asStringArray(item.related),
    supersedes: asStringArray(item.supersedes),
    // file:line 形式的 evidence 走 code_refs（绑定层可解析到文件节点）；
    // evidence 只保留已是 nav:* ID 的引用，避免 strict 绑定校验误报。
    evidence: evidenceRefs.filter(id => id.startsWith('nav:')).map(id => ({ id })),
    code_refs: codeRefs,
    path: sourcePath,
    headings: [],
    body,
    plain: stripMarkdown(body),
    generated_id: false,
    frontmatter_fields: [],
    overlay: sourcePath.startsWith('.codewiki/'),
  }
}

function readCaseKnowledge(filePath, moduleName, sourcePath) {
  if (!existsSync(filePath)) return []
  return readText(filePath).split(/\r?\n/).filter(Boolean).flatMap(line => {
    try {
      const doc = parseCaseKnowledge(JSON.parse(line), moduleName, sourcePath)
      return doc ? [doc] : []
    } catch { return [] }
  })
}

function caseKnowledgeFiles(projectRoot, moduleDir, moduleName) {
  return [
    { file: join(moduleDir, 'cases', 'index.jsonl'), path: 'cases/index.jsonl' },
    { file: join(projectRoot, '.codewiki', 'knowledge-overlay', `${encodeId(moduleName)}.jsonl`), path: `.codewiki/knowledge-overlay/${encodeId(moduleName)}.jsonl` },
  ]
}

function collectKnowledge(projectRoot, moduleDir, moduleName) {
  const files = []
  const readme = join(moduleDir, 'README.md')
  if (existsSync(readme)) files.push(readme)
  for (const dirName of KNOWLEDGE_DIRS) {
    listFiles(join(moduleDir, dirName), file => file.endsWith('.md'), files)
  }
  const knowledge = files.map(file => parseKnowledgeDocument(file, moduleDir, moduleName))
  for (const source of caseKnowledgeFiles(projectRoot, moduleDir, moduleName)) {
    knowledge.push(...readCaseKnowledge(source.file, moduleName, source.path))
  }
  return knowledge
}

function confidenceValue(value) {
  if (typeof value === 'number') return value
  return ({ verified: 1, A: 1, ast: 0.9, B: 0.85, C: 0.6, candidate: 0.45, D: 0.3, E: 0.1 })[value] || 0.5
}

function expressionFunctionNames(value) {
  const expression = String(value || '').trim()
  if (!expression) return []
  const names = []
  if (/^[A-Za-z_$][\w$]*$/.test(expression)) names.push(expression)
  for (const match of expression.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) names.push(match[1])
  return unique(names).filter(name => !['if', 'for', 'while', 'switch', 'function'].includes(name))
}

function locationFromAt(value) {
  const text = String(value || '')
  const match = text.match(/^(.*?):(\d+)$/)
  return { file: normalizePath(match?.[1] || text), line: Number(match?.[2]) || null }
}

function navigationGraph(moduleDir) {
  const navDir = join(moduleDir, 'navigation')
  const nodes = new Map()
  const edges = []
  const fileIds = new Map()
  const functionsByName = new Map()
  const warnings = []

  function addNode(node) {
    if (!node?.id) return null
    const existing = nodes.get(node.id)
    nodes.set(node.id, existing ? { ...existing, ...node } : node)
    return node.id
  }

  function addEdge(from, to, type, options = {}) {
    if (!from || !to) return
    if (!nodes.has(from)) addNode({ id: from, label: from, type: 'unknown' })
    if (!nodes.has(to)) addNode({ id: to, label: to, type: 'unknown' })
    edges.push({
      id: options.id || navId('edge', sha1([from, to, type].join('::')).slice(0, 16)),
      from,
      to,
      type,
      confidence: confidenceValue(options.confidence),
      evidence: options.evidence || [],
    })
  }

  function fileNodeId(file) {
    const normalized = normalizePath(file)
    if (!normalized) return null
    if (fileIds.has(normalized)) return fileIds.get(normalized)
    const id = navId('file', normalized)
    fileIds.set(normalized, id)
    addNode({ id, legacy_id: normalized, label: normalized, type: 'file', file: normalized, confidence: 1 })
    return id
  }

  const fileGraph = readJson(join(navDir, 'file-graph.json'), { data: { nodes: [], edges: [] } })
  for (const node of fileGraph?.data?.nodes || []) {
    const file = normalizePath(node.id || node.file)
    const id = node.nav_id || navId('file', file)
    fileIds.set(file, id)
    addNode({ ...node, id, legacy_id: file, label: file, file, confidence: 1 })
  }
  for (const edge of fileGraph?.data?.edges || []) {
    addEdge(fileNodeId(edge.source), fileNodeId(edge.target), edge.type || edge.edge_type || 'depends-on', {
      id: edge.id,
      confidence: edge.confidence,
      evidence: edge.evidence,
    })
  }

  const funcDeps = readJson(join(navDir, 'func-dependencies.json'), { data: { functions: [] } })
  for (const fn of funcDeps?.data?.functions || []) {
    const id = fn.id || navId('function', fn.file, fn.name, fn.type || 'unknown')
    addNode({ ...fn, id, label: fn.name, type: fn.type || 'function', file: normalizePath(fn.file), confidence: 1 })
    addEdge(fileNodeId(fn.file), id, 'declares', { confidence: 1 })
    const ids = functionsByName.get(fn.name) || []
    ids.push(id)
    functionsByName.set(fn.name, ids)
  }
  for (const fn of funcDeps?.data?.functions || []) {
    const from = fn.id || navId('function', fn.file, fn.name, fn.type || 'unknown')
    for (const name of fn.calls || []) {
      const targets = functionsByName.get(name) || []
      for (const to of targets) addEdge(from, to, 'calls', { confidence: targets.length === 1 ? 0.9 : 0.45 })
    }
    for (const caller of fn.callers || []) addEdge(fileNodeId(caller), from, 'calls', { confidence: 0.7 })
  }

  const componentRefs = readJson(join(navDir, 'component-refs.json'), { data: { components: [] } })
  const componentNameIds = new Map()
  for (const component of componentRefs?.data?.components || []) {
    const id = component.id || navId('component', component.file)
    const name = basename(component.file || '', extname(component.file || ''))
    addNode({ ...component, id, label: name || component.file, type: 'component', file: normalizePath(component.file), confidence: 1 })
    addEdge(fileNodeId(component.file), id, 'declares', { confidence: 1 })
    const ids = componentNameIds.get(name) || []
    ids.push(id)
    componentNameIds.set(name, ids)
  }
  for (const component of componentRefs?.data?.components || []) {
    const id = component.id || navId('component', component.file)
    for (const name of component.uses || []) {
      const candidates = componentNameIds.get(name) || []
      if (candidates.length === 1) addEdge(id, candidates[0], 'uses', { confidence: 0.8 })
      else {
        const usedId = navId('component-name', name)
        addNode({ id: usedId, label: name, type: 'component-reference', confidence: candidates.length > 1 ? 0.45 : 0.7 })
        addEdge(id, usedId, 'uses', { confidence: candidates.length > 1 ? 0.45 : 0.7 })
        for (const candidate of candidates) addEdge(usedId, candidate, 'may-resolve-to', { confidence: 0.4 })
      }
    }
    for (const binding of component.event_bindings || []) {
      const eventId = binding.id || navId('ui-event', component.file, binding.event || binding.name, binding.handler || binding.expression)
      addNode({ ...binding, id: eventId, label: binding.event || binding.name || binding.expression || 'event', type: 'ui-event', file: component.file, confidence: 1 })
      addEdge(id, eventId, 'binds-event', { confidence: 1 })
      const handler = binding.handler || binding.expression
      for (const handlerName of expressionFunctionNames(handler)) {
        const targets = functionsByName.get(handlerName) || []
        for (const target of targets) addEdge(eventId, target, 'triggers', { confidence: targets.length === 1 ? 0.9 : 0.45 })
      }
    }
    for (const binding of component.template_bindings || []) {
      const fieldId = binding.id || navId('field', component.file, binding.path, binding.kind || 'binding')
      addNode({ ...binding, id: fieldId, label: binding.path, type: 'field', file: component.file, confidence: 1 })
      addEdge(id, fieldId, 'renders-field', { confidence: 1 })
    }
    for (const event of component.subscribes_to || []) {
      const eventId = navId('event', event)
      addNode({ id: eventId, label: event, type: 'event', confidence: 0.7 })
      addEdge(eventId, id, 'subscribes', { confidence: 0.7 })
    }
    for (const event of component.emits_events || []) {
      const eventId = navId('event', event)
      addNode({ id: eventId, label: event, type: 'event', confidence: 0.7 })
      addEdge(id, eventId, 'emits', { confidence: 0.7 })
    }
  }

  const lineageIndex = readJson(join(navDir, 'field-lineage', 'index.json'), { pages: [] })
  for (const pageRef of lineageIndex?.pages || []) {
    const page = readJson(join(navDir, 'field-lineage', 'pages', `${pageRef.page_id}.json`), null)
    if (!page) continue
    const pageId = page.nav_id || pageRef.nav_id || navId('page', page.page_id)
    addNode({ id: pageId, label: page.chinese_name || page.page_id, type: 'page', file: page.page_file, confidence: 1 })
    addEdge(fileNodeId(page.page_file), pageId, 'declares-page', { confidence: 1 })
    for (const field of page.fields || []) {
      const fieldId = field.nav_id || navId('field-lineage', field.id || `${page.page_id}.${field.path}`)
      addNode({ ...field, id: fieldId, legacy_id: field.id, label: field.display_name || field.path || field.id, type: 'field-lineage', file: page.page_file, confidence: confidenceValue(field.confidence) })
      addEdge(pageId, fieldId, 'contains-field', { confidence: field.confidence })
      for (const source of field.source_apis || []) {
        const apiId = navId('api', source.protocol, source.method, source.endpoint)
        addNode({ ...source, id: apiId, label: `${source.method || ''} ${source.endpoint || ''}`.trim(), type: 'api', file: String(source.at || '').split(':')[0] || null, confidence: confidenceValue(source.confidence) })
        addEdge(apiId, fieldId, 'provides-field', { confidence: source.confidence })
      }
      if (field.upstream_store) {
        const location = locationFromAt(field.upstream_store.at)
        const storeId = navId('store-field', field.upstream_store.store_id, field.upstream_store.state_field, location.file)
        addNode({
          ...field.upstream_store,
          ...location,
          id: storeId,
          label: [field.upstream_store.store_id, field.upstream_store.state_field].filter(Boolean).join('.'),
          type: 'store-field',
          confidence: confidenceValue(field.confidence),
        })
        addEdge(storeId, fieldId, 'provides-field', { confidence: field.confidence })
      }
      for (const binding of field.component_bindings || []) {
        const location = locationFromAt(binding.at)
        const bindingId = navId('component-binding', fieldId, binding.expr, binding.kind, location.line)
        addNode({ ...binding, ...location, id: bindingId, label: binding.expr || binding.attribute || binding.kind, type: 'component-binding', confidence: 1 })
        addEdge(bindingId, fieldId, 'renders-field', { confidence: 1 })
      }
      for (const [type, values, relation] of [
        ['transform', field.transforms || [], 'transforms-with'],
        ['display-condition', field.display_conditions || [], 'visible-when'],
        ['abnormal-state', field.abnormal_states || [], 'abnormal-when'],
      ]) {
        for (const value of values) {
          const objectValue = value && typeof value === 'object' ? value : { value }
          const label = objectValue.expression || objectValue.condition || objectValue.state || objectValue.value || JSON.stringify(objectValue)
          const location = locationFromAt(objectValue.at)
          const valueId = navId(type, fieldId, sha1(JSON.stringify(objectValue)).slice(0, 12))
          addNode({ ...objectValue, ...location, id: valueId, label: String(label), type, confidence: confidenceValue(objectValue.confidence || field.confidence) })
          addEdge(fieldId, valueId, relation, { confidence: objectValue.confidence || field.confidence })
        }
      }
      for (const evidenceAt of field.evidence || []) {
        const location = locationFromAt(evidenceAt)
        if (!location.file) continue
        const evidenceId = navId('field-evidence', fieldId, location.file, location.line)
        addNode({ ...location, id: evidenceId, label: evidenceAt, type: 'field-evidence', confidence: confidenceValue(field.confidence) })
        addEdge(evidenceId, fieldId, 'evidence-at', { confidence: field.confidence, evidence: [evidenceAt] })
      }
    }
  }

  const clusters = readJson(join(navDir, 'clusters.json'), null)
  for (const [legacyId, score] of Object.entries(clusters?.node_scores || {})) {
    const id = fileIds.get(normalizePath(legacyId))
    if (id && nodes.has(id)) nodes.set(id, { ...nodes.get(id), importance: Number(score.pagerank || 0) + Number(score.betweenness || 0) })
  }

  function indexGenericEvidence(fileName, value, jsonPath = '$') {
    if (Array.isArray(value)) {
      value.forEach((item, index) => indexGenericEvidence(fileName, item, `${jsonPath}[${index}]`))
      return
    }
    if (!value || typeof value !== 'object') return
    const file = normalizePath(value.file || String(value.at || '').split(':')[0])
    const line = Number(value.line || String(value.at || '').match(/:(\d+)$/)?.[1]) || null
    const label = value.title || value.name || value.entity || value.message || value.endpoint || value.trigger || value.state
    if (label || file) {
      const stableKey = [fileName, value.id || label || '', file || '', value.kind || value.type || ''].join('::')
      const id = navId('evidence', fileName, sha1(stableKey).slice(0, 12))
      addNode({ ...value, id, label: String(label || `${fileName} ${jsonPath}`), type: fileName.replace(/\.jsonl?$/, ''), file: file || null, line, confidence: confidenceValue(value.confidence || 'candidate') })
      if (file) addEdge(fileNodeId(file), id, 'has-evidence', { confidence: value.confidence || 'candidate' })
    }
    for (const [key, item] of Object.entries(value)) {
      if (item && typeof item === 'object') indexGenericEvidence(fileName, item, `${jsonPath}.${key}`)
    }
  }

  for (const fileName of INDEXED_NAVIGATION_FILES.filter(name => !['file-graph.json', 'func-dependencies.json', 'component-refs.json', 'clusters.json'].includes(name))) {
    const filePath = join(navDir, fileName)
    if (!existsSync(filePath)) continue
    if (fileName.endsWith('.jsonl')) {
      readText(filePath).split(/\r?\n/).filter(Boolean).forEach((line, index) => {
        try { indexGenericEvidence(fileName, JSON.parse(line), `$[${index}]`) } catch { warnings.push(`${fileName}:${index + 1} 不是合法 JSON`) }
      })
    } else {
      const data = readJson(filePath, null)
      if (data) indexGenericEvidence(fileName, data)
    }
  }

  // Dynamic chains are source-verified semantic notes today. Project them into
  // graph nodes at index time so the committed Markdown is not copied again.
  for (const fileName of ['dynamic-flows.md', 'ipc-flows.md']) {
    const content = readText(join(navDir, fileName))
    if (!content) continue
    const sections = content.split(/(?=^#{1,4}\s+)/m).filter(section => section.trim())
    for (const section of sections) {
      const refs = codeReferences(section)
      if (refs.length === 0) continue
      const label = stripMarkdown(section.match(/^#{1,4}\s+(.+)$/m)?.[1] || fileName)
      const id = navId('dynamic-flow', fileName, sha1(`${label}\n${section}`).slice(0, 16))
      const confidence = section.includes('⚠️') ? 0.45 : 1
      addNode({
        id,
        label,
        type: 'dynamic-flow',
        file: refs[0].file,
        line: refs[0].line,
        evidence: refs,
        confidence,
      })
      for (const ref of refs) {
        addEdge(id, fileNodeId(ref.file), 'evidence-at', { confidence, evidence: [`${ref.file}:${ref.line}`] })
      }
    }
  }

  return { nodes: [...nodes.values()], edges, fileIds: Object.fromEntries(fileIds), warnings }
}

function addKnowledgeCodeReferenceNodes(graph, knowledge) {
  const nodeIds = new Set(graph.nodes.map(node => node.id))
  const edgeIds = new Set(graph.edges.map(edge => edge.id))
  const codeReferenceIds = new Map()
  for (const doc of knowledge) {
    for (const ref of doc.code_refs) {
      const refPath = normalizePath(ref.file)
      const fileId = graph.fileIds[refPath] || Object.entries(graph.fileIds)
        .find(([file]) => refPath.endsWith(`/${file}`) || file.endsWith(`/${refPath}`))?.[1]
      if (!fileId) continue
      const id = navId('code-ref', doc.id, refPath, ref.line)
      codeReferenceIds.set(`${doc.id}\n${refPath}\n${ref.line}`, id)
      if (!nodeIds.has(id)) {
        graph.nodes.push({
          id,
          label: `${refPath}:${ref.line}`,
          type: 'code-reference',
          file: refPath,
          line: ref.line,
          confidence: 1,
        })
        nodeIds.add(id)
      }
      const edgeId = navId('edge', sha1([fileId, id, 'evidence-at'].join('::')).slice(0, 16))
      if (!edgeIds.has(edgeId)) {
        graph.edges.push({ id: edgeId, from: fileId, to: id, type: 'evidence-at', confidence: 1, evidence: [`${refPath}:${ref.line}`] })
        edgeIds.add(edgeId)
      }
    }
  }
  graph.codeReferenceIds = codeReferenceIds
}

function parseBindings(filePath) {
  if (!existsSync(filePath)) return { bindings: [], warnings: [] }
  const bindings = []
  const warnings = []
  readText(filePath).split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return
    try {
      const binding = JSON.parse(line)
      if (!binding || typeof binding !== 'object' || Array.isArray(binding)) warnings.push(`bindings.jsonl:${index + 1} 必须是 JSON 对象`)
      else bindings.push(binding)
    } catch {
      warnings.push(`bindings.jsonl:${index + 1} 不是合法 JSON`)
    }
  })
  return { bindings, warnings }
}

function normalizeBindings({ moduleDir, knowledge, graph }) {
  const bindingPath = join(moduleDir, 'navigation', 'bindings.jsonl')
  const parsed = parseBindings(bindingPath)
  const knowledgeIds = new Set(knowledge.map(item => item.id))
  const navIds = new Set(graph.nodes.map(item => item.id))
  const legacyNavIds = new Map(graph.nodes.map(item => [item.legacy_id, item.id]).filter(([id]) => id))
  const bindings = []
  const warnings = [...parsed.warnings]
  const errors = [...parsed.warnings]

  function add(binding, strict = false) {
    const knowledgeId = String(binding.knowledge_id || '')
    const navigationId = legacyNavIds.get(binding.navigation_id) || String(binding.navigation_id || '')
    if (!knowledgeIds.has(knowledgeId)) {
      const message = `binding 的 knowledge_id 不存在: ${knowledgeId}`
      warnings.push(message)
      if (strict) errors.push(message)
      return
    }
    if (!navIds.has(navigationId)) {
      const message = `binding 的 navigation_id 不存在: ${navigationId}`
      warnings.push(message)
      if (strict) errors.push(message)
      return
    }
    const role = binding.role || 'implementation'
    const confidence = binding.confidence || 'verified'
    if (!BINDING_ROLES.has(role)) {
      const message = `binding role 非法: ${role}`
      warnings.push(message)
      if (strict) errors.push(message)
      return
    }
    if (!BINDING_CONFIDENCE.has(confidence)) {
      const message = `binding confidence 非法: ${confidence}`
      warnings.push(message)
      if (strict) errors.push(message)
      return
    }
    bindings.push({
      knowledge_id: knowledgeId,
      navigation_id: navigationId,
      role,
      confidence,
      source: binding.source || 'declared',
    })
  }

  // Only user-authored bindings survive between builds. Frontmatter and code-ref
  // bindings are deterministic projections and must be regenerated so deleted
  // Markdown evidence cannot leave stale edges behind.
  parsed.bindings
    .filter(binding => !binding.source || binding.source === 'declared')
    .forEach(binding => add(binding, true))
  for (const doc of knowledge) {
    for (const evidence of doc.evidence) add({
      knowledge_id: doc.id,
      navigation_id: evidence.id || evidence.navigation_id,
      role: evidence.role || 'implementation',
      confidence: evidence.confidence || 'verified',
      source: 'frontmatter',
    }, true)
    for (const ref of doc.code_refs) {
      const refPath = normalizePath(ref.file)
      const navigationId = graph.codeReferenceIds?.get(`${doc.id}\n${refPath}\n${ref.line}`)
        || graph.fileIds[refPath]
        || Object.entries(graph.fileIds).find(([file]) => refPath.endsWith(`/${file}`) || file.endsWith(`/${refPath}`))?.[1]
      if (navigationId) add({
        knowledge_id: doc.id,
        navigation_id: navigationId,
        role: 'implementation',
        confidence: 'verified',
        source: 'code-ref',
      })
    }
  }
  const deduped = new Map()
  for (const binding of bindings) {
    const key = [binding.knowledge_id, binding.navigation_id, binding.role].join('::')
    const existing = deduped.get(key)
    if (!existing || confidenceValue(binding.confidence) > confidenceValue(existing.confidence)) deduped.set(key, binding)
  }
  return { bindings: [...deduped.values()], warnings: unique(warnings), errors: unique(errors), bindingPath }
}

function indexTerms(knowledge) {
  const postings = {}
  for (const doc of knowledge) {
    const indexedText = [doc.title, ...doc.aliases, ...doc.questions, ...doc.entities, ...doc.headings, doc.plain.slice(0, 4000)].join(' ')
    for (const term of tokenize(indexedText)) {
      if (!postings[term]) postings[term] = []
      postings[term].push(doc.id)
    }
  }
  for (const term of Object.keys(postings)) postings[term] = unique(postings[term])
  return postings
}

function sourceFiles(moduleDir) {
  const files = []
  for (const name of ['manifest.yml', 'README.md']) {
    const file = join(moduleDir, name)
    if (existsSync(file)) files.push(file)
  }
  for (const dirName of [...KNOWLEDGE_DIRS, 'navigation']) {
    listFiles(join(moduleDir, dirName), file => ['.md', '.json', '.jsonl', '.yml', '.yaml'].includes(extname(file)), files)
  }
  return unique(files).sort()
}

function sourceFingerprint(projectRoot, moduleDir, moduleName) {
  const extra = caseKnowledgeFiles(projectRoot, moduleDir, moduleName).map(item => item.file).filter(existsSync)
  const parts = unique([...sourceFiles(moduleDir), ...extra]).sort().map(file => {
    const stat = statSync(file)
    return `${normalizePath(relative(projectRoot, file))}:${stat.size}:${Math.round(stat.mtimeMs)}`
  })
  return sha1(parts.join('\n'))
}

export function moduleNameFromManifest(moduleDir) {
  const manifest = readText(join(moduleDir, 'manifest.yml'))
  const match = manifest.match(/^module:\s*["']?([^\n"']+)/m)
  return String(match?.[1] || basename(moduleDir)).trim()
}

function currentCommit(projectRoot) {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return '' }
}

function workingTreeChanges(projectRoot) {
  try {
    return execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => normalizePath(line.slice(3).split(' -> ').pop()))
  } catch {
    return []
  }
}

function projectGitState(projectRoot) {
  return {
    project_root: projectRoot,
    head_commit: currentCommit(projectRoot),
    dirty_files: workingTreeChanges(projectRoot),
    committed_changes_by_base: new Map(),
  }
}

function committedChangesSince(gitState, baseCommit) {
  if (!baseCommit || !gitState.head_commit || baseCommit === gitState.head_commit) return { files: [], valid: true }
  if (gitState.committed_changes_by_base.has(baseCommit)) return gitState.committed_changes_by_base.get(baseCommit)
  let result = { files: [], valid: true }
  try {
    const files = execFileSync('git', ['diff', '--name-only', `${baseCommit}..${gitState.head_commit}`, '--'], {
      cwd: gitState.project_root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).split(/\r?\n/).filter(Boolean).map(normalizePath)
    result = { files, valid: true }
  } catch {
    result = { files: [], valid: false }
  }
  gitState.committed_changes_by_base.set(baseCommit, result)
  return result
}

function moduleFreshness(index, gitState) {
  const moduleDir = normalizePath(index.metadata.module_dir)
  const targetPaths = (index.metadata.target_paths || []).map(normalizePath)
  const graphFiles = new Set(index.nav_nodes.map(node => normalizePath(node.file)).filter(Boolean))
  function isRelevant(file) {
    if (file === '.codewiki' || file.startsWith('.codewiki/')) return false
    if (moduleDir && (file === moduleDir || file.startsWith(`${moduleDir}/`))) return false
    if (targetPaths.length === 0) return true
    return graphFiles.has(file) || targetPaths.some(target => file === target || file.startsWith(`${target}/`))
  }
  const dirtyFiles = gitState.dirty_files.filter(isRelevant)
  const baseCommit = index.metadata.base_commit || ''
  const committedChanges = committedChangesSince(gitState, baseCommit)
  const committedFiles = committedChanges.files.filter(isRelevant)
  return {
    base_commit: baseCommit,
    head_commit: gitState.head_commit,
    dirty_files: dirtyFiles,
    committed_files: committedFiles,
    freshness_unknown: !committedChanges.valid,
    stale: Boolean((gitState.head_commit && !baseCommit) || !committedChanges.valid || committedFiles.length > 0 || dirtyFiles.length > 0),
  }
}

function manifestBaseCommit(moduleDir) {
  return readText(join(moduleDir, 'manifest.yml')).match(/^base_commit:\s*["']?([a-f0-9]+)/m)?.[1] || ''
}

function manifestTargetPaths(moduleDir) {
  try {
    const manifest = parseYaml(readText(join(moduleDir, 'manifest.yml'))) || {}
    return unique([
      ...asStringArray(manifest.target_dirs),
      ...asStringArray(manifest.expanded_dirs),
      ...(Array.isArray(manifest.expanded_targets)
        ? manifest.expanded_targets.map(item => typeof item === 'string' ? item : item?.path)
        : []),
    ].map(normalizePath))
  } catch {
    return []
  }
}

export const MODULES_ROOT = '.codewiki/modules'

export function moduleDirs(projectRoot, requestedModule) {
  const modulesRoot = join(projectRoot, MODULES_ROOT)
  if (requestedModule) {
    const direct = resolve(projectRoot, requestedModule)
    if (existsSync(direct) && statSync(direct).isDirectory()) return [direct]
    const underModules = join(modulesRoot, requestedModule)
    return existsSync(underModules) ? [underModules] : []
  }
  if (!existsSync(modulesRoot)) return []
  return readdirSync(modulesRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => join(modulesRoot, entry.name))
    .filter(dir => existsSync(join(dir, 'manifest.yml')) || KNOWLEDGE_DIRS.some(name => existsSync(join(dir, name))))
}

function assertUniqueModuleNames(dirs) {
  const names = dirs.map(moduleNameFromManifest)
  const duplicates = duplicateValues(names)
  if (duplicates.length > 0) throw new Error(`manifest.module 重复，会导致检索缓存冲突: ${duplicates.join(', ')}`)
}

function cachePath(projectRoot, moduleName) {
  return join(projectRoot, '.codewiki', 'cache', 'codewiki', encodeId(moduleName), 'retrieval-index.json')
}

function writeBindings(result) {
  mkdirSync(join(result.moduleDir, 'navigation'), { recursive: true })
  const content = result.bindings.map(binding => JSON.stringify(binding)).join('\n')
  writeFileSync(result.bindingPath, content ? `${content}\n` : '', 'utf8')
}

function validateKnowledgeDocuments(knowledge, options = {}) {
  const errors = []
  const warnings = []
  const duplicateIds = duplicateValues(knowledge.map(doc => doc.id))
  if (duplicateIds.length > 0) errors.push(`knowledge id 重复: ${duplicateIds.join(', ')}`)

  const knowledgeIds = new Set(knowledge.map(doc => doc.id))
  for (const doc of knowledge) {
    const requiresStableId = KNOWLEDGE_DIRS.includes(doc.layer)
    if (doc.generated_id && requiresStableId) {
      const message = `${doc.path} 缺少稳定 frontmatter id`
      if (options.strictIds) errors.push(message)
      else warnings.push(`${message}，当前使用路径派生兼容 ID`)
    }
    const idMatch = doc.id.match(/^kb:([^:]+):(product|frontend):([^:]+)$/)
    if (requiresStableId && !doc.generated_id && !idMatch) {
      const message = `${doc.path} 的 knowledge id 不符合 kb:<module>:<product|frontend>:<topic>: ${doc.id}`
      if (options.strictIds) errors.push(message)
      else warnings.push(message)
    }
    if (requiresStableId && idMatch && (idMatch[1] !== options.moduleName || idMatch[2] !== doc.layer)) {
      const message = `${doc.path} 的 knowledge id 必须匹配 module=${options.moduleName} 和 layer=${doc.layer}: ${doc.id}`
      if (options.strictIds) errors.push(message)
      else warnings.push(message)
    }
    if (requiresStableId) {
      for (const field of ['aliases', 'questions', 'entities']) {
        if (doc[field].length > 0) continue
        const message = `${doc.path} 缺少非空 ${field}`
        if (options.strictIds) errors.push(message)
        else warnings.push(message)
      }
    }
    for (const relatedId of doc.related || []) {
      if (knowledgeIds.has(relatedId)) continue
      const message = `${doc.path} 的 related id 不存在: ${relatedId}`
      if (options.strictIds) errors.push(message)
      else warnings.push(message)
    }
  }
  return { errors: unique(errors), warnings: unique(warnings) }
}

function buildModuleIndex(projectRoot, moduleDir, options = {}) {
  const moduleName = moduleNameFromManifest(moduleDir)
  const knowledge = collectKnowledge(projectRoot, moduleDir, moduleName)
  const knowledgeValidation = validateKnowledgeDocuments(knowledge, { strictIds: options.strictIds, moduleName })
  if (knowledgeValidation.errors.length > 0) {
    throw new Error(`语义文档校验失败:\n- ${knowledgeValidation.errors.join('\n- ')}`)
  }
  const graph = navigationGraph(moduleDir)
  addKnowledgeCodeReferenceNodes(graph, knowledge)
  const normalizedBindings = normalizeBindings({ moduleDir, knowledge, graph })
  const result = {
    moduleDir,
    bindingPath: normalizedBindings.bindingPath,
    bindings: normalizedBindings.bindings,
  }
  if (options.writeBindings && normalizedBindings.errors.length > 0) {
    throw new Error(`bindings 校验失败:\n- ${normalizedBindings.errors.join('\n- ')}`)
  }
  if (options.strictIds) {
    const stronglyBound = new Set(normalizedBindings.bindings
      .filter(binding => binding.confidence === 'verified' || binding.confidence === 'ast')
      .map(binding => binding.knowledge_id))
    const ungrounded = knowledge
      .filter(doc => KNOWLEDGE_DIRS.includes(doc.layer) && !stronglyBound.has(doc.id))
      .map(doc => doc.path)
    if (ungrounded.length > 0) throw new Error(`语义文档缺少 verified/ast 代码证据:\n- ${ungrounded.join('\n- ')}`)
  }
  if (options.writeBindings) writeBindings(result)
  const fingerprint = sourceFingerprint(projectRoot, moduleDir, moduleName)
  const baseCommit = manifestBaseCommit(moduleDir)
  const headCommit = currentCommit(projectRoot)
  const index = {
    metadata: {
      version: INDEX_VERSION,
      generated_at: new Date().toISOString(),
      module: moduleName,
      module_dir: normalizePath(relative(projectRoot, moduleDir)),
      target_paths: manifestTargetPaths(moduleDir),
      source_fingerprint: fingerprint,
      base_commit: baseCommit,
      head_commit: headCommit,
      stale: Boolean(baseCommit && headCommit && baseCommit !== headCommit),
    },
    knowledge,
    postings: indexTerms(knowledge),
    nav_nodes: graph.nodes,
    nav_edges: graph.edges,
    bindings: normalizedBindings.bindings,
    warnings: unique([...graph.warnings, ...normalizedBindings.warnings, ...knowledgeValidation.warnings]),
  }
  const outPath = cachePath(projectRoot, moduleName)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, `${JSON.stringify(index)}\n`, 'utf8')
  memoryIndexCache.set(outPath, { fingerprint, index })
  return index
}

function loadModuleIndex(projectRoot, moduleDir, options = {}) {
  const moduleName = moduleNameFromManifest(moduleDir)
  const outPath = cachePath(projectRoot, moduleName)
  const fingerprint = sourceFingerprint(projectRoot, moduleDir, moduleName)
  if (!options.rebuild) {
    const memoryCached = memoryIndexCache.get(outPath)
    if (memoryCached?.fingerprint === fingerprint) return memoryCached.index
    const cached = readJson(outPath, null)
    if (cached?.metadata?.version === INDEX_VERSION && cached.metadata.source_fingerprint === fingerprint) {
      memoryIndexCache.set(outPath, { fingerprint, index: cached })
      return cached
    }
  }
  return buildModuleIndex(projectRoot, moduleDir, options)
}

export function buildProjectIndex(options = {}) {
  const projectRoot = resolve(options.projectRoot || process.cwd())
  const dirs = moduleDirs(projectRoot, options.module)
  if (dirs.length === 0) throw new Error(`未找到 codewiki 知识库: ${options.module || join(projectRoot, MODULES_ROOT)}`)
  assertUniqueModuleNames(dirs)
  return dirs.map(moduleDir => buildModuleIndex(projectRoot, moduleDir, {
    writeBindings: options.writeBindings !== false,
    strictIds: options.strictIds !== false,
  }))
}

export function clearRetrievalMemoryCache() {
  memoryIndexCache.clear()
}

function fieldScore(query, queryTerms, value, weight) {
  const text = String(value || '').toLowerCase()
  if (!text) return 0
  let score = text.includes(query.toLowerCase()) ? weight * 4 : 0
  let hits = 0
  for (const term of queryTerms) if (text.includes(term)) hits++
  score += Math.min(hits, 8) * weight
  return score
}

function knowledgeScore(doc, query, terms) {
  return (doc.layer === 'cases' ? 30 : 0)
    + fieldScore(query, terms, doc.title, 12)
    + fieldScore(query, terms, doc.aliases.join(' '), 10)
    + fieldScore(query, terms, doc.questions.join(' '), 8)
    + fieldScore(query, terms, doc.entities.join(' '), 6)
    + fieldScore(query, terms, doc.headings.join(' '), 4)
    + Math.min(fieldScore(query, terms, doc.plain, 1), 20)
}

function nodeScore(node, query, terms) {
  const searchable = [node.label, node.name, node.text, node.file, node.endpoint, node.path, node.message].filter(Boolean).join(' ')
  return fieldScore(query, terms, searchable, 3) + Number(node.importance || 0)
}

function excerpt(doc, query) {
  const sections = String(doc.body || '').split(/(?=^##?\s+)/m).filter(Boolean)
  const terms = tokenize(query)
  const ranked = sections
    .map((section, index) => ({ section, index, score: fieldScore(query, terms, stripMarkdown(section), 1) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
  const selected = ranked.filter(item => item.score > 0).slice(0, 2)
  if (selected.length === 0 && ranked.length > 0) selected.push(ranked.sort((a, b) => a.index - b.index)[0])
  return selected.sort((a, b) => a.index - b.index).map(item => item.section.trim()).join('\n\n').slice(0, 5000)
}

function exploreModule(index, query, options = {}, freshness = {}) {
  const terms = tokenize(query)
  const candidateIds = unique(terms.flatMap(term => index.postings[term] || []))
  const candidates = candidateIds.length > 0
    ? index.knowledge.filter(doc => candidateIds.includes(doc.id))
    : index.knowledge
  let rankedKnowledge = candidates
    .map(doc => ({ doc, score: knowledgeScore(doc, query, terms), graph_score: 0 }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
  const navById = new Map(index.nav_nodes.map(node => [node.id, node]))
  const bindingsByKnowledge = new Map()
  const bindingsByNavigation = new Map()
  for (const binding of index.bindings) {
    const byKnowledge = bindingsByKnowledge.get(binding.knowledge_id) || []
    byKnowledge.push(binding)
    bindingsByKnowledge.set(binding.knowledge_id, byKnowledge)
    const byNavigation = bindingsByNavigation.get(binding.navigation_id) || []
    byNavigation.push(binding)
    bindingsByNavigation.set(binding.navigation_id, byNavigation)
  }
  const adjacency = new Map()
  for (const edge of index.nav_edges) {
    const forward = adjacency.get(edge.from) || []
    forward.push({ node: edge.to, edge, direction: 'out' })
    adjacency.set(edge.from, forward)
    const backward = adjacency.get(edge.to) || []
    backward.push({ node: edge.from, edge, direction: 'in' })
    adjacency.set(edge.to, backward)
  }

  const navHits = index.nav_nodes
    .map(node => ({ node, score: nodeScore(node, query, terms) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
  const technicalRootIds = navHits.map(hit => hit.node.id)
  const strongTechnicalRootIds = navHits.filter(hit => hit.score >= 12).slice(0, 3).map(hit => hit.node.id)
  const knowledgeScores = new Map()
  for (const hit of navHits) {
    const seen = new Set([hit.node.id])
    const navQueue = [{ id: hit.node.id, depth: 0 }]
    while (navQueue.length > 0) {
      const current = navQueue.shift()
      for (const binding of bindingsByNavigation.get(current.id) || []) {
        const score = hit.score / (current.depth + 1)
        knowledgeScores.set(binding.knowledge_id, Math.max(knowledgeScores.get(binding.knowledge_id) || 0, score))
      }
      if (current.depth >= 2) continue
      for (const next of adjacency.get(current.id) || []) {
        if (next.edge.confidence < 0.4 || seen.has(next.node)) continue
        seen.add(next.node)
        navQueue.push({ id: next.node, depth: current.depth + 1 })
      }
    }
  }
  const rankedById = new Map(rankedKnowledge.map(item => [item.doc.id, item]))
  for (const doc of index.knowledge) {
    const graphScore = knowledgeScores.get(doc.id)
    if (!graphScore) continue
    const existing = rankedById.get(doc.id)
    if (existing) existing.graph_score = Math.max(existing.graph_score, graphScore)
    else rankedById.set(doc.id, { doc, score: 0, graph_score: graphScore })
  }
  rankedKnowledge = [...rankedById.values()].sort((a, b) => (b.score + b.graph_score) - (a.score + a.graph_score))

  const maxTopics = Math.max(1, Math.min(Number(options.maxTopics) || 5, 10))
  const directTopics = rankedKnowledge.slice(0, maxTopics)
  const supersededIds = new Set(directTopics.flatMap(item => item.doc.supersedes || []))
  const roots = unique([
    ...directTopics.flatMap(item => (bindingsByKnowledge.get(item.doc.id) || []).map(binding => binding.navigation_id)),
    ...(directTopics.length === 0 ? technicalRootIds : strongTechnicalRootIds),
  ])
  const maxDepth = options.detail === 'evidence' || /实现|调用|链路|代码|影响/.test(query) ? 3 : 2
  const visited = new Map()
  const queue = roots.map(id => ({ id, depth: 0, path: [] }))
  while (queue.length > 0 && visited.size < 100) {
    const current = queue.shift()
    if (visited.has(current.id) && visited.get(current.id).depth <= current.depth) continue
    visited.set(current.id, current)
    if (current.depth >= maxDepth) continue
    for (const next of adjacency.get(current.id) || []) {
      if (next.edge.confidence < 0.4) continue
      queue.push({
        id: next.node,
        depth: current.depth + 1,
        path: [...current.path, { from: current.id, to: next.node, type: next.edge.type, direction: next.direction }],
      })
    }
  }

  const knowledgeById = new Map(index.knowledge.map(doc => [doc.id, doc]))
  const relatedScores = new Map(directTopics.map(item => [item.doc.id, item.score + item.graph_score]))
  for (const item of directTopics) {
    for (const relatedId of item.doc.related || []) {
      if (knowledgeById.has(relatedId)) relatedScores.set(relatedId, (relatedScores.get(relatedId) || 0) + Math.max(item.score + item.graph_score, 4) / 2)
    }
    for (const doc of index.knowledge) {
      if ((doc.related || []).includes(item.doc.id)) relatedScores.set(doc.id, (relatedScores.get(doc.id) || 0) + Math.max(item.score + item.graph_score, 4) / 2)
    }
  }
  for (const [navigationId, visit] of visited) {
    for (const binding of bindingsByNavigation.get(navigationId) || []) {
      relatedScores.set(binding.knowledge_id, (relatedScores.get(binding.knowledge_id) || 0) + (8 / (visit.depth + 1)))
    }
  }
  const topics = [...relatedScores.entries()]
    .map(([id, score]) => ({ doc: knowledgeById.get(id), score }))
    .filter(item => item.doc && !supersededIds.has(item.doc.id))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxTopics)
    .map(item => ({
      id: item.doc.id,
      module: item.doc.module,
      title: item.doc.title,
      kind: item.doc.kind,
      path: item.doc.path,
      source: item.doc.overlay ? 'local-overlay' : item.doc.layer === 'cases' ? 'shared-case' : 'generated-doc',
      score: Number(item.score.toFixed(2)),
      content: excerpt(item.doc, query),
    }))

  const evidenceLimit = options.detail === 'evidence' ? 30 : 15
  const evidenceCandidates = [...visited.values()]
    .map(visit => ({ node: navById.get(visit.id), ...visit }))
    .filter(item => item.node && (item.node.file || item.node.line || item.node.evidence))
    .sort((a, b) => a.depth - b.depth || confidenceValue(b.node.confidence) - confidenceValue(a.node.confidence) || Number(b.node.importance || 0) - Number(a.node.importance || 0))
  const evidence = []
  const evidenceFiles = new Set()
  for (const item of evidenceCandidates) {
    const file = normalizePath(item.node.file)
    if (file && !evidenceFiles.has(file) && evidenceFiles.size >= MAX_EVIDENCE_FILES) continue
    if (file) evidenceFiles.add(file)
    evidence.push({
      id: item.node.id,
      type: item.node.type,
      label: item.node.label,
      file: item.node.file || null,
      line: item.node.line || null,
      confidence: item.node.confidence,
      depth: item.depth,
    })
    if (evidence.length >= evidenceLimit) break
  }

  const paths = [...visited.values()]
    .filter(item => item.path.length > 0)
    .sort((a, b) => a.depth - b.depth)
    .slice(0, options.detail === 'evidence' ? 12 : 6)
    .map(item => item.path.map(step => ({
      from: navById.get(step.from)?.label || step.from,
      relation: step.direction === 'out' ? step.type : `被${step.type}`,
      to: navById.get(step.to)?.label || step.to,
    })))

  return {
    module: index.metadata.module,
    topics,
    paths,
    evidence,
    stale: freshness.stale ?? index.metadata.stale,
    base_commit: freshness.base_commit ?? index.metadata.base_commit,
    head_commit: freshness.head_commit ?? index.metadata.head_commit,
    dirty_files: freshness.dirty_files || [],
    committed_files: freshness.committed_files || [],
    freshness_unknown: Boolean(freshness.freshness_unknown),
    warnings: unique([
      ...index.warnings,
      ...(directTopics.length === 0 && technicalRootIds.length > 0 ? ['命中代码证据，但缺少对应语义文档'] : []),
    ]),
  }
}

export function exploreKnowledgeBase(options = {}) {
  const query = String(options.query || '').trim()
  if (!query) throw new Error('query 不能为空')
  const projectRoot = resolve(options.projectRoot || process.cwd())
  const dirs = moduleDirs(projectRoot, options.module)
  if (dirs.length === 0) throw new Error(`未找到 codewiki 知识库: ${options.module || join(projectRoot, MODULES_ROOT)}`)
  assertUniqueModuleNames(dirs)
  const gitState = projectGitState(projectRoot)
  const moduleResults = dirs
    .map(moduleDir => {
      const index = loadModuleIndex(projectRoot, moduleDir, { rebuild: options.rebuild })
      return exploreModule(index, query, options, moduleFreshness(index, gitState))
    })
    .filter(result => result.topics.length > 0 || result.evidence.length > 0)
    .sort((a, b) => (b.topics[0]?.score || 0) - (a.topics[0]?.score || 0))
    .slice(0, options.module ? 1 : 3)
  return {
    query,
    project_root: projectRoot,
    generated_at: new Date().toISOString(),
    modules: moduleResults,
    found: moduleResults.length > 0,
  }
}

function percentile(values, ratio) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)]
}

export function evaluateKnowledgeBase(options = {}) {
  const cases = Array.isArray(options.cases) ? options.cases : []
  if (cases.length === 0) throw new Error('评测 cases 不能为空')
  const repeat = Math.max(1, Math.min(Number(options.repeat) || 1, 20))
  const durations = []
  const warmDurations = []
  const results = []
  let expectedKnowledgeTotal = 0
  let expectedKnowledgeTop3Hits = 0
  let requiredEvidenceTotal = 0
  let requiredEvidenceHits = 0

  for (const [caseIndex, item] of cases.entries()) {
    if (!item?.query) throw new Error(`评测 case[${caseIndex}] 缺少 query`)
    let explored
    const caseDurations = []
    for (let run = 0; run < repeat; run++) {
      const startedAt = performance.now()
      explored = exploreKnowledgeBase({
        ...options,
        query: item.query,
        module: item.module || options.module,
        detail: item.detail || options.detail || 'evidence',
        rebuild: Boolean(options.rebuild && run === 0),
      })
      const duration = Number((performance.now() - startedAt).toFixed(3))
      caseDurations.push(duration)
      durations.push(duration)
      if (run > 0) warmDurations.push(duration)
    }

    const knowledgeIds = unique(explored.modules.flatMap(module => module.topics.map(topic => topic.id)))
    const evidenceIds = unique(explored.modules.flatMap(module => module.evidence.map(evidence => evidence.id)))
    const expectedKnowledgeIds = item.expected_knowledge_ids || item.expectedKnowledgeIds || []
    const requiredEvidenceIds = item.required_evidence_ids || item.requiredEvidenceIds || []
    const forbiddenText = item.forbidden_text || item.forbiddenText || []
    const formatted = formatExploreResult(explored)
    const missingKnowledgeIds = expectedKnowledgeIds.filter(id => !knowledgeIds.includes(id))
    const missingEvidenceIds = requiredEvidenceIds.filter(id => !evidenceIds.includes(id))
    const forbiddenHits = forbiddenText.filter(text => formatted.includes(text))
    const expectedFound = item.expect_found ?? item.expectFound
    const foundMismatch = expectedFound == null ? false : Boolean(expectedFound) !== explored.found
    expectedKnowledgeTotal += expectedKnowledgeIds.length
    expectedKnowledgeTop3Hits += expectedKnowledgeIds.filter(id => knowledgeIds.slice(0, 3).includes(id)).length
    requiredEvidenceTotal += requiredEvidenceIds.length
    requiredEvidenceHits += requiredEvidenceIds.length - missingEvidenceIds.length
    results.push({
      name: item.name || `case-${caseIndex + 1}`,
      query: item.query,
      pass: missingKnowledgeIds.length === 0 && missingEvidenceIds.length === 0 && forbiddenHits.length === 0 && !foundMismatch,
      found: explored.found,
      knowledge_ids: knowledgeIds,
      evidence_ids: evidenceIds,
      missing_knowledge_ids: missingKnowledgeIds,
      missing_evidence_ids: missingEvidenceIds,
      forbidden_hits: forbiddenHits,
      found_mismatch: foundMismatch,
      cold_ms: caseDurations[0],
      warm_p95_ms: Number(percentile(caseDurations.slice(1), 0.95).toFixed(3)),
    })
  }

  const passed = results.filter(item => item.pass).length
  return {
    summary: {
      total: results.length,
      passed,
      failed: results.length - passed,
      pass_rate: Number((passed / results.length).toFixed(4)),
      top3_knowledge_hit_rate: expectedKnowledgeTotal > 0 ? Number((expectedKnowledgeTop3Hits / expectedKnowledgeTotal).toFixed(4)) : 1,
      evidence_recall: requiredEvidenceTotal > 0 ? Number((requiredEvidenceHits / requiredEvidenceTotal).toFixed(4)) : 1,
      repeat,
      avg_ms: Number((durations.reduce((sum, value) => sum + value, 0) / durations.length).toFixed(3)),
      p95_ms: Number(percentile(durations, 0.95).toFixed(3)),
      warm_p95_ms: Number(percentile(warmDurations, 0.95).toFixed(3)),
    },
    cases: results,
  }
}

export function formatExploreResult(result) {
  if (!result.found) return `没有在 codewiki 知识库中找到与“${result.query}”相关的内容。`
  const lines = [`# codewiki 检索：${result.query}`]
  for (const module of result.modules) {
    lines.push(`\n## 模块：${module.module}`)
    if (module.stale) {
      const dirty = module.dirty_files?.length ? `，工作区变更=${module.dirty_files.slice(0, 5).join(', ')}${module.dirty_files.length > 5 ? '…' : ''}` : ''
      const committed = module.committed_files?.length ? `，已提交源码变更=${module.committed_files.slice(0, 5).join(', ')}${module.committed_files.length > 5 ? '…' : ''}` : ''
      const unknown = module.freshness_unknown ? '，base commit 无法校验' : ''
      lines.push(`\n> ⚠️ 知识库可能过期：base=${module.base_commit || 'unknown'}，HEAD=${module.head_commit || 'unknown'}${unknown}${committed}${dirty}`)
    }
    if (module.topics.length > 0) {
      lines.push('\n### 语义文档')
      for (const topic of module.topics) {
        lines.push(`\n#### ${topic.title}（${topic.id}）`)
        lines.push(`来源：${topic.path}`)
        if (topic.content) lines.push(topic.content)
      }
    }
    if (module.paths.length > 0) {
      lines.push('\n### 关联路径')
      for (const path of module.paths) lines.push(`- ${path.map(step => `${step.from} --${step.relation}→ ${step.to}`).join('；')}`)
    }
    if (module.evidence.length > 0) {
      lines.push('\n### 代码证据')
      for (const item of module.evidence) {
        const location = item.file ? `${item.file}${item.line ? `:${item.line}` : ''}` : '无直接文件位置'
        lines.push(`- ${item.label || item.id} — ${location}；${item.type}；confidence=${item.confidence}`)
      }
    }
    if (module.warnings.length > 0) {
      lines.push('\n### 检索警告')
      module.warnings.slice(0, 8).forEach(warning => lines.push(`- ${warning}`))
    }
  }
  const output = lines.join('\n')
  if (output.length <= MAX_OUTPUT_CHARS) return output
  const cut = output.slice(0, MAX_OUTPUT_CHARS)
  const boundary = Math.max(cut.lastIndexOf('\n## '), cut.lastIndexOf('\n### '), cut.lastIndexOf('\n'))
  return `${cut.slice(0, boundary > 0 ? boundary : MAX_OUTPUT_CHARS)}\n\n...（已按 20,000 字符预算裁剪，请缩小 module 或使用更具体的问题）`
}
