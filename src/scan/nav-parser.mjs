#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync, realpathSync } from 'node:fs'
import { join, relative, extname, basename, normalize, resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { parse as parseSFC } from '@vue/compiler-sfc'
import { computeStructuralFingerprint } from './fingerprint.mjs'

const projectRequire = createRequire(join(process.cwd(), 'package.json'))

// --- Parser initialization ---
let swc = null
let tsCompiler = null

async function initParser() {
  try {
    swc = await import('@swc/core')
    swc.parseSync('const x: number = 1', { syntax: 'typescript', target: 'es2022' })
    console.log('[nav-parser] Using SWC parser backend')
    return 'swc'
  } catch {
    try {
      swc = await import('@swc/wasm')
      swc.parseSync('const x: number = 1', { syntax: 'typescript', target: 'es2022' })
      console.log('[nav-parser] Using SWC WASM parser backend')
      return 'swc-wasm'
    } catch {
      // fall through to TypeScript compiler
    }
    try {
      tsCompiler = await loadTypeScriptCompiler()
      console.log('[nav-parser] Using TypeScript compiler backend (SWC unavailable)')
      return 'typescript'
    } catch {
      console.error('FATAL: Neither @swc/core nor typescript available')
      process.exit(1)
    }
  }
}

async function importTypeScriptCompiler() {
  const mod = await import('typescript')
  return normalizeTypeScriptCompiler(mod)
}

async function loadTypeScriptCompiler() {
  try {
    return normalizeTypeScriptCompiler(projectRequire('typescript'))
  } catch {
    return importTypeScriptCompiler()
  }
}

function normalizeTypeScriptCompiler(mod) {
  return typeof mod.default?.createSourceFile === 'function' ? mod.default : mod
}

// --- CLI args ---
const args = process.argv.slice(2)
const targetDir = args[0]
if (!targetDir) {
  console.error('Error: Target path is required.')
  console.error('Usage: node nav-parser.mjs <target-directory> [<output-base-dir>] [--incremental]')
  process.exit(1)
}
// Output base dir: second positional arg, or --output flag, or fallback
const outputFlagIdx = args.indexOf('--output')
const positionalOutput = args[1] && !args[1].startsWith('--') ? args[1] : null
const outputBaseDir = outputFlagIdx !== -1 ? args[outputFlagIdx + 1] : positionalOutput
const incremental = args.includes('--incremental')

// --- Constants ---
const EXCLUDE_DIRS = new Set(['node_modules', 'dist', '.doc', '.git', '__tests__', '__test__', 'mock', '__mocks__'])
const VALID_EXTS = new Set(['.vue', '.ts', '.js', '.tsx', '.jsx'])
const HTML_TAGS = new Set([
  'div','span','p','a','img','ul','ol','li','h1','h2','h3','h4','h5','h6',
  'table','thead','tbody','tr','td','th','form','input','button','select',
  'option','textarea','label','section','header','footer','main','nav',
  'article','aside','figure','figcaption','details','summary','dialog',
  'template','slot','component','transition','transition-group','keep-alive',
  'teleport','suspense','br','hr','pre','code','strong','em','b','i','u',
  'sub','sup','small','mark','del','ins','blockquote','iframe','video',
  'audio','source','canvas','svg','path','circle','rect','line','polygon',
  'polyline','ellipse','g','text','defs','clippath','lineargradient',
])

// --- Git helpers ---
function getCurrentCommitSha(dir) {
  try {
    return execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch { return null }
}

function getChangedFilesSinceCommit(baseCommit, dir) {
  try {
    const tracked = execSync(`git diff --name-only ${baseCommit}`, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
      .split('\n')
      .filter(Boolean)
    const untracked = execSync('git ls-files --others --exclude-standard', { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
      .split('\n')
      .filter(Boolean)
    return new Set([...tracked, ...untracked])
  } catch { return null }
}

function getChangedFileStatusesSinceCommit(baseCommit, dir) {
  try {
    const tracked = execSync(`git diff --name-status ${baseCommit}`, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const parts = line.split(/\t+/)
        const status = parts[0]
        if (status.startsWith('R')) {
          return { status: 'R', oldPath: parts[1], path: parts[2] }
        }
        return { status, path: parts[1] }
      })
    const untracked = execSync('git ls-files --others --exclude-standard', { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(path => ({ status: 'A', path }))
    return [...tracked, ...untracked].filter(item => item.path)
  } catch { return [] }
}

// --- File collection ---
function collectFiles(dir, baseDir = dir) {
  const results = []
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) }
  catch { return results }
  for (const entry of entries) {
    if (EXCLUDE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...collectFiles(fullPath, baseDir))
    } else if (VALID_EXTS.has(extname(entry.name))) {
      results.push({
        absPath: fullPath,
        relPath: relative(baseDir, fullPath),
        mtime: statSync(fullPath).mtimeMs,
      })
    }
  }
  return results
}

function inferNodeType(relPath) {
  return extname(relPath) === '.vue' ? 'component' : 'module'
}

function navigationId(kind, ...parts) {
  return `nav:${kind}:${parts
    .map(part => encodeURIComponent(String(part || '').replace(/\\/g, '/')))
    .join(':')}`
}

function ensureNode(fileNodes, nodeIds, relPath) {
  if (!relPath || nodeIds.has(relPath)) return
  nodeIds.add(relPath)
  fileNodes.push({ id: relPath, nav_id: navigationId('file', relPath), type: inferNodeType(relPath) })
}

function createEdge({
  source,
  target,
  type,
  subtype = null,
  channel = null,
  confidence = 1,
  weight = 1,
  evidence = [],
  resolver = null,
}) {
  const edgeId = createHash('sha1')
    .update([source, target, type, subtype || '', channel || ''].join('::'))
    .digest('hex')
    .slice(0, 16)
  return {
    id: navigationId('edge', edgeId),
    source,
    target,
    type,
    edge_type: type,
    ...(subtype && { subtype }),
    ...(channel && { channel }),
    confidence,
    weight,
    resolver: resolver || resolverForEdgeType(type),
    ...(evidence.length > 0 && { evidence }),
  }
}

function resolverForEdgeType(type) {
  return ({
    import: 'static-import',
    'async-import': 'dynamic-import-literal',
    'dynamic-require': 'require-literal',
    'dynamic-dispatch': 'runtime-dispatch-heuristic',
    ipc: 'ipc-channel-match',
    'webcontents-send': 'electron-webcontents-send',
    'store-call': 'pinia-store-name-match',
    'broadcast-channel': 'broadcast-channel-name-match',
  })[type] || 'unknown'
}

function addNavigationIds({ nodes, edges, funcDeps, componentRefs }) {
  const nextNodes = (nodes || []).map(node => ({
    ...node,
    nav_id: node.nav_id || navigationId('file', node.id),
  }))
  const nextEdges = (edges || []).map(edge => {
    if (edge.id) return edge
    const edgeId = createHash('sha1').update(edgeKey(edge)).digest('hex').slice(0, 16)
    return { ...edge, id: navigationId('edge', edgeId) }
  })
  const nextFunctions = (funcDeps?.functions || []).map(fn => ({
    ...fn,
    id: fn.id || navigationId('function', fn.file, fn.name, fn.type || 'unknown'),
  }))
  const nextComponents = (componentRefs?.components || []).map(component => ({
    ...component,
    id: component.id || navigationId('component', component.file),
    ...(component.event_bindings && {
      event_bindings: component.event_bindings.map(binding => ({
        ...binding,
        id: binding.id || navigationId(
          'ui-event',
          component.file,
          binding.event || binding.name || 'event',
          binding.handler || binding.expression || '',
        ),
      })),
    }),
    ...(component.template_bindings && {
      template_bindings: component.template_bindings.map(binding => ({
        ...binding,
        id: binding.id || navigationId('field', component.file, binding.path, binding.kind || 'binding'),
      })),
    }),
  }))
  return {
    nodes: nextNodes,
    edges: nextEdges,
    funcDeps: { functions: nextFunctions },
    componentRefs: { components: nextComponents },
  }
}

function edgeKey(edge) {
  return [
    edge.source,
    edge.target,
    edge.type,
    edge.subtype || '',
    edge.channel || '',
  ].join('::')
}

function fileHash(content) {
  return createHash('sha1').update(content).digest('hex')
}

function readExistingJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch {
    return null
  }
}

function expandImpactSet(changedRelPaths, existingEdges) {
  const impacted = new Set(changedRelPaths)
  for (let depth = 0; depth < 2; depth++) {
    const snapshot = new Set(impacted)
    for (const edge of existingEdges) {
      if (snapshot.has(edge.target)) impacted.add(edge.source)
    }
  }

  const impactedChannels = new Set()
  const impactedStores = new Set()
  for (const edge of existingEdges) {
    if (impacted.has(edge.source) || impacted.has(edge.target)) {
      if (edge.channel) impactedChannels.add(edge.channel)
      if (edge.type === 'store-call') impactedStores.add(edge.target)
    }
  }

  for (const edge of existingEdges) {
    if (
      (edge.channel && impactedChannels.has(edge.channel)) ||
      (edge.type === 'store-call' && impactedStores.has(edge.target))
    ) {
      impacted.add(edge.source)
      impacted.add(edge.target)
    }
  }

  return impacted
}

function isCoreGraphConfigChange(projectRelPath) {
  return /(^|\/)(package\.json|tsconfig[^/]*\.json|jsconfig[^/]*\.json|vite\.config\.[cm]?[jt]s|webpack\.config\.[cm]?[jt]s)$/.test(projectRelPath)
}

function buildGraphIndex({ nodes, edges, allFiles, contentCache, funcDeps, parserVersion, rawImportsByFile, componentRefs, previousGraphIndex }) {
  const fileByRelPath = new Map(allFiles.map(file => [file.relPath, file]))
  const exportsByFile = new Map()
  const funcsByFile = new Map()
  for (const fn of funcDeps.functions || []) {
    if (!exportsByFile.has(fn.file)) exportsByFile.set(fn.file, [])
    exportsByFile.get(fn.file).push({ name: fn.name, type: fn.type })
    if (!funcsByFile.has(fn.file)) funcsByFile.set(fn.file, [])
    funcsByFile.get(fn.file).push(fn)
  }
  const templateBindingsByFile = new Map()
  for (const c of componentRefs?.components || []) {
    if (c.template_bindings?.length) templateBindingsByFile.set(c.file, c.template_bindings)
  }
  const previousFiles = previousGraphIndex?.files || {}

  const files = {}
  for (const node of nodes) {
    const file = fileByRelPath.get(node.id)
    const content = contentCache.get(node.id) || (file?.absPath && existsSync(file.absPath) ? readFileSync(file.absPath, 'utf-8') : '')
    const outEdges = edges.filter(edge => edge.source === node.id)
    const inEdges = edges.filter(edge => edge.target === node.id)

    // T1: structuralFingerprint 只对本次 processed 的文件重算；未处理文件保留旧值
    let structuralFingerprint = null
    if (rawImportsByFile?.has(node.id)) {
      structuralFingerprint = computeStructuralFingerprint({
        imports: rawImportsByFile.get(node.id) || [],
        exports: exportsByFile.get(node.id) || [],
        functions: funcsByFile.get(node.id) || [],
        templateBindings: templateBindingsByFile.get(node.id) || [],
      })
    } else {
      structuralFingerprint = previousFiles[node.id]?.structuralFingerprint ?? null
    }
    // T1: fieldFingerprint 由 field-lineage.mjs 后置回填，nav-parser 阶段保留旧值
    const fieldFingerprint = previousFiles[node.id]?.fieldFingerprint ?? null

    files[node.id] = {
      hash: content ? fileHash(content) : null,
      mtime: file?.mtime || null,
      exports: exportsByFile.get(node.id) || [],
      imports: outEdges.filter(edge => edge.type === 'import').map(edge => edge.target),
      out_edges: outEdges.map(edgeKey),
      in_edges: inEdges.map(edgeKey),
      structuralFingerprint,
      fieldFingerprint,
      parser_version: parserVersion,
    }
  }

  // T1: fieldFingerprint 是页面级；graph-index.json 顶层新增 page_fingerprints 承载（回填时更新）
  const pageFingerprints = previousGraphIndex?.page_fingerprints || {}

  return {
    metadata: {
      generated_at: new Date().toISOString(),
      parser_version: parserVersion,
      alias_config: null,
      fingerprint_version: '1.0',
    },
    files,
    page_fingerprints: pageFingerprints,
  }
}

function buildGraphQuality({ nodes, edges, allFiles, targetDir, incrementalMeta }) {
  const nodeIds = new Set(nodes.map(node => node.id))
  const lowConfidenceEdges = edges
    .filter(edge => Number(edge.confidence ?? 1) < 0.7)
    .map(edge => ({
      source: edge.source,
      target: edge.target,
      type: edge.type,
      edge_type: edge.edge_type || edge.type,
      subtype: edge.subtype || null,
      channel: edge.channel || null,
      confidence: edge.confidence ?? null,
      resolver: edge.resolver || null,
      evidence_count: Array.isArray(edge.evidence) ? edge.evidence.length : 0,
    }))

  const unresolvedEdges = edges.filter(edge =>
    /unresolved/i.test(edge.subtype || '') ||
    (Number(edge.confidence ?? 1) <= 0.5 && edge.source === edge.target && ['ipc', 'async-import', 'dynamic-require', 'broadcast-channel'].includes(edge.type)))

  const degree = new Map(nodes.map(node => [node.id, 0]))
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) || 0) + 1)
    degree.set(edge.target, (degree.get(edge.target) || 0) + 1)
  }
  const isolatedNodes = [...degree.entries()]
    .filter(([, count]) => count === 0)
    .map(([id]) => id)

  const highRiskSignals = []
  if (edges.some(edge => edge.type === 'dynamic-dispatch')) {
    highRiskSignals.push({
      type: 'dynamic-dispatch',
      severity: 'WARN',
      message: '存在运行时 map/handler 动态分发，静态分析只能保留启发式自环边。',
    })
  }
  if (unresolvedEdges.some(edge => edge.type === 'ipc')) {
    highRiskSignals.push({
      type: 'ipc-unresolved',
      severity: 'WARN',
      message: '存在未匹配到 handler 的 IPC channel，需要人工确认 preload/main 链路。',
    })
  }
  if (unresolvedEdges.some(edge => edge.type === 'async-import' || edge.type === 'dynamic-require')) {
    highRiskSignals.push({
      type: 'path-unresolved',
      severity: 'WARN',
      message: '存在无法解析到目标文件的动态 import/require，可能受别名或运行时拼接影响。',
    })
  }
  if (isolatedNodes.length > 0) {
    highRiskSignals.push({
      type: 'isolated-node',
      severity: 'INFO',
      message: '存在孤立文件节点，可能是入口边界过窄、注册型文件或未被静态引用。',
      count: isolatedNodes.length,
    })
  }

  const coverage = {
    files_in_target: allFiles.length,
    files_with_nodes: nodes.filter(node => nodeIds.has(node.id)).length,
    edges_with_evidence: edges.filter(edge => Array.isArray(edge.evidence) && edge.evidence.length > 0).length,
    evidence_coverage: edges.length === 0 ? 1 : Math.round((edges.filter(edge => Array.isArray(edge.evidence) && edge.evidence.length > 0).length / edges.length) * 10000) / 10000,
  }

  const status = lowConfidenceEdges.length > 0 || unresolvedEdges.length > 0 ? 'WARN' : 'PASS'
  return {
    status,
    generated_at: new Date().toISOString(),
    target_dir: targetDir,
    summary: {
      total_nodes: nodes.length,
      total_edges: edges.length,
      low_confidence_edges: lowConfidenceEdges.length,
      unresolved_edges: unresolvedEdges.length,
      isolated_nodes: isolatedNodes.length,
    },
    coverage,
    ...(incrementalMeta && { incremental: incrementalMeta }),
    low_confidence_edges: lowConfidenceEdges,
    unresolved_edges: unresolvedEdges.map(edge => ({
      source: edge.source,
      target: edge.target,
      type: edge.type,
      subtype: edge.subtype || null,
      channel: edge.channel || null,
      confidence: edge.confidence ?? null,
      resolver: edge.resolver || null,
    })),
    isolated_nodes: isolatedNodes,
    high_risk_signals: highRiskSignals,
    known_limitations: [
      '本图是静态可发现依赖图，不承诺覆盖所有运行时路径。',
      '动态字符串 channel、运行时注册路由、全局组件、插件注入、别名路径解析失败、跨模块反向依赖需要结合源码证据复核。',
      '低置信边和 unresolved 边不能作为完整事实，只能作为后续分析入口。',
    ],
  }
}

function upsertYamlScalar(content, key, value) {
  const line = `${key}: ${value}`
  const re = new RegExp(`^${key}:.*$`, 'm')
  if (re.test(content)) return content.replace(re, line)
  return `${content.replace(/\s*$/, '\n')}${line}\n`
}

function updateManifestGraphDraft(manifestPath, graphQuality) {
  if (!existsSync(manifestPath)) return
  if (graphQuality.status !== 'WARN') return
  let content
  try {
    content = readFileSync(manifestPath, 'utf-8')
  } catch {
    return
  }
  content = upsertYamlScalar(content, 'draft', 'true')
  content = upsertYamlScalar(content, 'draft_reason', '"navigation graph has low-confidence or unresolved edges"')
  content = upsertYamlScalar(content, 'graph_quality_status', `"${graphQuality.status}"`)
  content = upsertYamlScalar(content, 'graph_quality_low_confidence_edges', String(graphQuality.summary.low_confidence_edges))
  content = upsertYamlScalar(content, 'graph_quality_unresolved_edges', String(graphQuality.summary.unresolved_edges))
  writeFileSync(manifestPath, content)
}

function collectProjectRuntimeFiles(projectRoot, absTarget) {
  const runtimeDirs = ['electron', 'main', 'preload']
  const runtimeFiles = []
  const seen = new Set()
  for (const dirName of runtimeDirs) {
    const dir = join(projectRoot, dirName)
    if (!existsSync(dir)) continue
    for (const file of collectFiles(dir, projectRoot)) {
      if (file.absPath.startsWith(absTarget)) continue
      if (seen.has(file.absPath)) continue
      seen.add(file.absPath)
      runtimeFiles.push(file)
    }
  }
  return runtimeFiles
}

// --- Unified script parsing ---
function parseScript(code, filePath) {
  if (swc) {
    try {
      const isTsx = filePath.endsWith('.tsx') || filePath.endsWith('.jsx')
      return { type: 'swc', ast: swc.parseSync(code, { syntax: 'typescript', tsx: isTsx, target: 'es2022', comments: false }) }
    } catch { /* fall through to TS */ }
  }
  if (tsCompiler) {
    try {
      const sf = tsCompiler.createSourceFile(filePath, code, tsCompiler.ScriptTarget.Latest, true)
      return { type: 'typescript', sourceFile: sf }
    } catch { /* fall through */ }
  }
  return null
}

// --- Vue SFC processing ---
function parseVueSFC(content, filePath) {
  const { descriptor, errors } = parseSFC(content, { filename: filePath })
  if (errors.length > 0) return null
  let scriptContent = null
  let isSetup = false
  if (descriptor.scriptSetup) {
    scriptContent = descriptor.scriptSetup.content
    isSetup = true
  } else if (descriptor.script) {
    scriptContent = descriptor.script.content
  }
  const templateContent = descriptor.template?.content || null
  const templateLineOffset = descriptor.template ? descriptor.template.loc.start.line - 1 : 0
  return { scriptContent, templateContent, templateLineOffset, isSetup }
}

// --- Import extraction from AST ---
function extractImportsFromSWC(ast) {
  const imports = []
  for (const item of ast.body) {
    if (item.type === 'ImportDeclaration') {
      const source = item.source.value
      const typeOnly = item.typeOnly || false
      const namedImports = []
      for (const spec of (item.specifiers || [])) {
        if (spec.type === 'ImportSpecifier') {
          namedImports.push({
            name: spec.imported?.value || spec.local.value,
            alias: spec.local.value,
          })
        } else if (spec.type === 'ImportDefaultSpecifier') {
          namedImports.push({ name: spec.local.value, isDefault: true })
        } else if (spec.type === 'ImportNamespaceSpecifier') {
          namedImports.push({ name: spec.local.value, isNamespace: true })
        }
      }
      imports.push({ source, namedImports, typeOnly })
    }
  }
  return imports
}

function extractImportsFromTS(sf) {
  const ts = tsCompiler
  const imports = []
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && stmt.moduleSpecifier) {
      const source = stmt.moduleSpecifier.text
      const typeOnly = stmt.importClause?.isTypeOnly || false
      const namedImports = []
      const clause = stmt.importClause
      if (clause) {
        if (clause.name) {
          namedImports.push({ name: clause.name.text, isDefault: true })
        }
        if (clause.namedBindings) {
          if (ts.isNamedImports(clause.namedBindings)) {
            for (const el of clause.namedBindings.elements) {
              namedImports.push({ name: el.propertyName?.text || el.name.text, alias: el.name.text })
            }
          } else if (ts.isNamespaceImport(clause.namedBindings)) {
            namedImports.push({ name: clause.namedBindings.name.text, isNamespace: true })
          }
        }
      }
      imports.push({ source, namedImports, typeOnly })
    }
  }
  return imports
}

function extractImports(parsed) {
  if (!parsed) return []
  if (parsed.type === 'swc') return extractImportsFromSWC(parsed.ast)
  if (parsed.type === 'typescript') return extractImportsFromTS(parsed.sourceFile)
  return []
}

// --- Export extraction from AST ---
function extractExportsFromSWC(ast, filePath) {
  const exports = []
  for (const item of ast.body) {
    switch (item.type) {
      case 'ExportDeclaration': {
        const decl = item.declaration
        if (!decl) break
        if (decl.type === 'FunctionDeclaration' && decl.identifier) {
          const params = extractParamsFromSWC(decl.params)
          const returnType = extractReturnTypeFromSWC(decl.returnType)
          exports.push({ name: decl.identifier.value, type: 'function', params, ...(returnType && { return_type: returnType }) })
        } else if (decl.type === 'VariableDeclaration') {
          for (const d of (decl.declarations || [])) {
            if (d.id?.type === 'Identifier') {
              exports.push({ name: d.id.value, type: 'variable' })
            }
          }
        } else if (decl.type === 'ClassDeclaration' && decl.identifier) {
          exports.push({ name: decl.identifier.value, type: 'class' })
        } else if (decl.type === 'TsEnumDeclaration' && decl.id) {
          exports.push({ name: decl.id.value, type: 'enum' })
        } else if (decl.type === 'TsInterfaceDeclaration' && decl.id) {
          exports.push({ name: decl.id.value, type: 'interface' })
        } else if (decl.type === 'TsTypeAliasDeclaration' && decl.id) {
          exports.push({ name: decl.id.value, type: 'type-alias' })
        }
        break
      }
      case 'ExportDefaultDeclaration':
      case 'ExportDefaultExpression':
        exports.push({ name: 'default', type: 'default' })
        break
      case 'ExportNamedDeclaration':
        for (const spec of (item.specifiers || [])) {
          if (spec.type === 'ExportSpecifier') {
            exports.push({
              name: spec.exported?.value || spec.orig.value,
              type: 're-export',
              ...(item.source && { from: item.source.value }),
            })
          }
        }
        break
    }
  }
  return exports
}

function extractExportsFromTS(sf) {
  const ts = tsCompiler
  const exports = []
  for (const stmt of sf.statements) {
    const mods = ts.canHaveModifiers?.(stmt) ? ts.getModifiers?.(stmt) : stmt.modifiers
    const hasExport = mods?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
    if (!hasExport) continue
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      exports.push({ name: stmt.name.text, type: 'function' })
    } else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) exports.push({ name: d.name.text, type: 'variable' })
      }
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      exports.push({ name: stmt.name.text, type: 'class' })
    } else if (ts.isEnumDeclaration(stmt)) {
      exports.push({ name: stmt.name.text, type: 'enum' })
    } else if (ts.isInterfaceDeclaration(stmt)) {
      exports.push({ name: stmt.name.text, type: 'interface' })
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      exports.push({ name: stmt.name.text, type: 'type-alias' })
    }
  }
  return exports
}

function extractExports(parsed, filePath) {
  if (!parsed) return []
  if (parsed.type === 'swc') return extractExportsFromSWC(parsed.ast, filePath)
  if (parsed.type === 'typescript') return extractExportsFromTS(parsed.sourceFile)
  return []
}

// --- Setup script: all top-level bindings as exports ---
function extractSetupBindings(parsed) {
  if (!parsed) return []
  const bindings = []
  if (parsed.type === 'swc') {
    for (const item of parsed.ast.body) {
      if (item.type === 'VariableDeclaration') {
        for (const d of (item.declarations || [])) {
          if (d.id?.type === 'Identifier') {
            bindings.push({ name: d.id.value, type: 'variable' })
          }
        }
      } else if (item.type === 'FunctionDeclaration' && item.identifier) {
        const params = extractParamsFromSWC(item.params)
        const returnType = extractReturnTypeFromSWC(item.returnType)
        bindings.push({ name: item.identifier.value, type: 'function', params, ...(returnType && { return_type: returnType }) })
      } else if (item.type === 'ExportDeclaration' || item.type === 'ExportDefaultDeclaration' || item.type === 'ExportNamedDeclaration') {
        // Explicit exports in <script setup> are also bindings
        const exps = extractExportsFromSWC({ body: [item] })
        bindings.push(...exps)
      }
    }
  } else if (parsed.type === 'typescript') {
    const ts = tsCompiler
    const sf = parsed.sourceFile
    for (const stmt of sf.statements) {
      if (ts.isVariableStatement(stmt)) {
        for (const d of stmt.declarationList.declarations) {
          if (ts.isIdentifier(d.name)) bindings.push({ name: d.name.text, type: 'variable' })
        }
      } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
        bindings.push({ name: stmt.name.text, type: 'function' })
      }
    }
  }
  return bindings
}

// --- Type extraction helpers ---
function extractParamsFromSWC(params) {
  if (!params || !Array.isArray(params)) return []
  return params.map(p => {
    let name = 'unknown'
    let type = undefined
    if (p.type === 'Parameter' || p.pat) {
      const pat = p.pat || p
      if (pat.type === 'Identifier') {
        name = pat.value
        type = extractTypeAnnotation(pat.typeAnnotation)
      } else if (pat.type === 'AssignmentPattern' && pat.left?.type === 'Identifier') {
        name = pat.left.value
        type = extractTypeAnnotation(pat.left.typeAnnotation)
      }
    } else if (p.type === 'Identifier') {
      name = p.value
      type = extractTypeAnnotation(p.typeAnnotation)
    }
    return { name, ...(type && { type }) }
  }).filter(p => p.name !== 'unknown')
}

function extractReturnTypeFromSWC(returnType) {
  if (!returnType) return null
  return extractTypeAnnotation(returnType)
}

function extractTypeAnnotation(ann) {
  if (!ann) return null
  const ta = ann.typeAnnotation || ann
  if (!ta) return null
  if (ta.type === 'TsKeywordType') return ta.kind
  if (ta.type === 'TsTypeReference' && ta.typeName) {
    return ta.typeName.value || ta.typeName.type
  }
  if (ta.type === 'TsArrayType') {
    const inner = extractTypeAnnotation(ta.elemType)
    return inner ? `${inner}[]` : 'unknown[]'
  }
  if (ta.type === 'TsUnionType') {
    return (ta.types || []).map(t => extractTypeAnnotation(t) || 'unknown').join(' | ')
  }
  return null
}

// --- Call extraction from AST ---
function extractCallsFromSWC(ast, knownExports) {
  const calls = new Set()
  function visit(node) {
    if (!node || typeof node !== 'object') return
    if (node.type === 'CallExpression') {
      if (node.callee?.type === 'Identifier') {
        calls.add(node.callee.value)
      } else if (node.callee?.type === 'MemberExpression' && node.callee.property?.type === 'Identifier') {
        calls.add(node.callee.property.value)
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'span' || key === 'type') continue
      const child = node[key]
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item === 'object' && item.type) visit(item)
        }
      } else if (child && typeof child === 'object' && child.type) {
        visit(child)
      }
    }
  }
  visit(ast)
  return [...calls].filter(name => knownExports.has(name))
}

function extractCallsFromTS(sf, knownExports) {
  const ts = tsCompiler
  const calls = new Set()
  function visit(node) {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression)) {
        calls.add(node.expression.text)
      } else if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.name)) {
        calls.add(node.expression.name.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return [...calls].filter(name => knownExports.has(name))
}

function extractCalls(parsed, knownExports) {
  if (!parsed) return []
  if (parsed.type === 'swc') return extractCallsFromSWC(parsed.ast, knownExports)
  if (parsed.type === 'typescript') return extractCallsFromTS(parsed.sourceFile, knownExports)
  return []
}

// --- Template AST processing via @vue/compiler-dom ---
let compilerDom = null
async function loadCompilerDom() {
  if (compilerDom) return compilerDom
  try {
    compilerDom = await import('@vue/compiler-dom')
    return compilerDom
  } catch {
    return null
  }
}

// --- Field path extraction from template expression strings ---
// Reserved / built-in identifiers that must NOT be captured as field paths.
const TPL_EXPR_IGNORED_IDENTS = new Set([
  'true', 'false', 'null', 'undefined', 'this', 'new', 'typeof', 'instanceof',
  'in', 'of', 'return', 'if', 'else', 'switch', 'case', 'break', 'continue',
  'void', 'delete', 'yield', 'await', 'async', 'function', 'let', 'const', 'var',
  'try', 'catch', 'finally', 'throw', 'do', 'while', 'for',
  'Math', 'Number', 'String', 'Boolean', 'Array', 'Object', 'JSON', 'Date',
  'Symbol', 'Promise', 'RegExp', 'Error', 'console', 'window', 'document',
  't', '$t', 'i18n', '$i18n', 'moment', 'dayjs',
])

// Extract candidate field paths from a Vue template expression string.
// Regex-based first pass; captures `a.b.c`, `a?.b`, `a['x']`, `a["x"]` chains.
// Filters out reserved keywords, common i18n / util names, and function-call callees.
function extractPathsFromExpression(exprString) {
  if (!exprString || typeof exprString !== 'string') return []
  const paths = new Set()
  const cleaned = exprString.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""') // strip string literals
  const re = /\b([a-zA-Z_$][\w$]*(?:\??\.[a-zA-Z_$][\w$]*|\['[\w-]+'\]|\["[\w-]+"\])*)/g
  let m
  while ((m = re.exec(cleaned)) !== null) {
    const path = m[1]
    const head = path.split(/[.?[]/, 1)[0]
    if (TPL_EXPR_IGNORED_IDENTS.has(head)) continue
    if (TPL_EXPR_IGNORED_IDENTS.has(path)) continue
    // Skip if this token is immediately followed by `(` (function call callee — not a field)
    const after = cleaned.slice(m.index + path.length)
    if (/^\s*\(/.test(after) && !path.includes('.')) continue
    paths.add(path)
  }
  return [...paths]
}

function extractTemplateInfo(templateContent, dom, lineOffset = 0) {
  if (!templateContent || !dom) {
    return { components: [], conditions: [], eventBindings: [], slotUsage: [], templateBindings: [] }
  }
  let ast
  try { ast = dom.parse(templateContent) }
  catch { return { components: [], conditions: [], eventBindings: [], slotUsage: [], templateBindings: [] } }

  const components = new Set()
  const conditions = []
  const eventBindings = []
  const slotUsage = []
  const templateBindings = []

  function pushBindings(paths, meta) {
    for (const path of paths) {
      templateBindings.push({ path, ...meta })
    }
  }

  function absoluteLine(line) {
    return line == null ? null : line + lineOffset
  }

  function walkNode(node) {
    // Interpolation node: type === 5, e.g. `{{ order.status }}`
    if (node.type === 5 && node.content?.content) {
      const line = absoluteLine(node.loc?.start?.line)
      const paths = extractPathsFromExpression(node.content.content)
      pushBindings(paths, { kind: 'interpolation', ...(line && { line }) })
      return
    }
    // Element node: type === 1
    if (node.type === 1) {
      const tag = node.tag
      const nodeLine = node.loc?.start?.line
      const visibleText = (node.children || [])
        .filter(child => child.type === 2 && child.content?.trim())
        .map(child => child.content.trim())
        .join(' ')
      // Component detection: PascalCase or hyphenated non-HTML
      if (/^[A-Z]/.test(tag) || (tag.includes('-') && !HTML_TAGS.has(tag.toLowerCase()))) {
        components.add(tag)
      }
      for (const prop of (node.props || [])) {
        // Directive: type === 7
        if (prop.type === 7) {
          const propLine = absoluteLine(prop.loc?.start?.line || nodeLine)
          const expText = prop.exp?.content || ''

          if (prop.name === 'if' || prop.name === 'else-if' || prop.name === 'show') {
            conditions.push({
              element: tag,
              directive: `v-${prop.name}`,
              expression: expText,
            })
            const paths = extractPathsFromExpression(expText)
            pushBindings(paths, {
              kind: prop.name === 'show' ? 'v_show' : 'v_if',
              element: tag,
              ...(propLine && { line: propLine }),
            })
          }
          if (prop.name === 'on' && prop.exp) {
            eventBindings.push({
              element: tag,
              event: prop.arg?.content || '',
              handler: prop.exp.content,
              ...(visibleText && { text: visibleText }),
              ...(propLine && { line: propLine }),
            })
            // Fields referenced in event handlers (e.g. `@click="submit(order.id)"`)
            const paths = extractPathsFromExpression(prop.exp.content)
            pushBindings(paths, {
              kind: 'event_arg',
              element: tag,
              event: prop.arg?.content || '',
              ...(propLine && { line: propLine }),
            })
          }
          if (prop.name === 'slot') {
            slotUsage.push({
              component: tag,
              slotName: prop.arg?.content || 'default',
            })
          }
          if (prop.name === 'bind' && prop.exp) {
            // `:prop="expr"` binding
            const attr = prop.arg?.content || null
            const paths = extractPathsFromExpression(expText)
            pushBindings(paths, {
              kind: 'prop_bind',
              element: tag,
              ...(attr && { attribute: attr }),
              ...(propLine && { line: propLine }),
            })
          }
          if (prop.name === 'model' && prop.exp) {
            // `v-model="path"` two-way binding — path is editable
            const paths = extractPathsFromExpression(expText)
            pushBindings(paths, {
              kind: 'v_model',
              element: tag,
              editable: true,
              ...(propLine && { line: propLine }),
            })
          }
          if (prop.name === 'for' && prop.exp) {
            // `v-for="(item, i) in list.data"` — capture the source expression (right of `in`/`of`)
            const forExp = expText
            const m = forExp.match(/\b(?:in|of)\b\s+(.+)$/)
            const source = m ? m[1].trim() : forExp
            const paths = extractPathsFromExpression(source)
            pushBindings(paths, {
              kind: 'v_for',
              element: tag,
              ...(propLine && { line: propLine }),
            })
          }
        }
      }
      for (const child of (node.children || [])) walkNode(child)
      return
    }
    // Fallback: recurse into any container that may hold children
    if (node.children?.length) {
      for (const child of node.children) walkNode(child)
    }
  }

  for (const child of (ast.children || [])) walkNode(child)
  return { components: [...components], conditions, eventBindings, slotUsage, templateBindings }
}

// --- Role classification (same logic) ---
function classifyRole(name) {
  if (/^(fetch|get|load|query|post|put|delete|request)/i.test(name)) return 'source'
  if (/^(transform|convert|parse|map|build|normalize|enrich|aggregate)/i.test(name)) return 'transform'
  if (/^(calculate|compute|format|aggregate|toSafe)/i.test(name)) return 'calculation'
  if (/^(validate|check|verify|should)/i.test(name)) return 'validation'
  if (/^(handle|on[A-Z]|process|before|after)/i.test(name)) return 'handler'
  if (/^(create|init|setup|reset|clear|open|close|toggle)/i.test(name)) return 'lifecycle'
  return null
}

// --- Event extraction (regex-based — appropriate for string patterns) ---
function extractEvents(content) {
  const subscribes_to = []
  const emits_events = []
  const subPatterns = [
    /emitter\.on\(\s*['"]([^'"]+)['"]/g,
    /\$bus\.on\(\s*['"]([^'"]+)['"]/g,
    /SUBSCRIPT_KEYS\.(\w+)/g,
    /\.on\(\s*['"]([^'"]+)['"]/g,
  ]
  const emitPatterns = [
    /emitter\.emit\(\s*['"]([^'"]+)['"]/g,
    /\$bus\.emit\(\s*['"]([^'"]+)['"]/g,
  ]
  for (const re of subPatterns) {
    let m
    while ((m = re.exec(content)) !== null) subscribes_to.push(m[1] || m[0])
  }
  for (const re of emitPatterns) {
    let m
    while ((m = re.exec(content)) !== null) emits_events.push(m[1])
  }
  return { subscribes_to: [...new Set(subscribes_to)], emits_events: [...new Set(emits_events)] }
}

function extractRuntimeSignals(content) {
  const rendererCalls = []
  const mainHandlers = []
  const webContentsSends = []
  const dispatches = []
  const asyncImports = []
  const dynamicRequires = []
  const storeCalls = []
  const broadcastSenders = []
  const broadcastReceivers = []

  const rendererRe = /ipcRenderer\.(invoke|send|on)\(\s*['"`]([^'"`]+)['"`]/g
  const mainRe = /ipcMain\.(handle|on)\(\s*['"`]([^'"`]+)['"`]/g
  const webContentsRe = /webContents\.send\(\s*['"`]([^'"`]+)['"`]/g
  const dispatchRe = /([A-Za-z_$][\w$]*)\s*\[\s*[^\]]+\s*\]\s*\(/g
  const asyncImportRe = /import\(\s*['"`]([^'"`]+)['"`]\s*\)/g
  const dynamicRequireRe = /require\(\s*['"`]([^'"`]+)['"`]\s*\)/g
  const storeCallRe = /\b(use[A-Z]\w*Store)\s*\(/g
  const broadcastVarRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+BroadcastChannel\(\s*['"`]([^'"`]+)['"`]\s*\)/g

  let match
  while ((match = rendererRe.exec(content)) !== null) {
    rendererCalls.push({ method: match[1], channel: match[2], snippet: match[0] })
  }
  while ((match = mainRe.exec(content)) !== null) {
    mainHandlers.push({ method: match[1], channel: match[2], snippet: match[0] })
  }
  while ((match = webContentsRe.exec(content)) !== null) {
    webContentsSends.push({ channel: match[1], snippet: match[0] })
  }
  while ((match = dispatchRe.exec(content)) !== null) {
    dispatches.push({ mapName: match[1], snippet: match[0] })
  }
  while ((match = asyncImportRe.exec(content)) !== null) {
    asyncImports.push({ source: match[1], snippet: match[0] })
  }
  while ((match = dynamicRequireRe.exec(content)) !== null) {
    dynamicRequires.push({ source: match[1], snippet: match[0] })
  }
  while ((match = storeCallRe.exec(content)) !== null) {
    storeCalls.push({ storeName: match[1], snippet: match[0] })
  }

  const channelsByVar = []
  while ((match = broadcastVarRe.exec(content)) !== null) {
    channelsByVar.push({ varName: match[1], channel: match[2], snippet: match[0] })
  }
  for (const channelRef of channelsByVar) {
    const senderRe = new RegExp(`${channelRef.varName}\\.postMessage\\(`, 'g')
    const receiverRe = new RegExp(`${channelRef.varName}\\.(?:addEventListener\\(\\s*['"\`]message['"\`]|onmessage\\s*=)`, 'g')
    let senderMatch
    let receiverMatch
    while ((senderMatch = senderRe.exec(content)) !== null) {
      broadcastSenders.push({
        channel: channelRef.channel,
        snippet: senderMatch[0],
      })
    }
    while ((receiverMatch = receiverRe.exec(content)) !== null) {
      broadcastReceivers.push({
        channel: channelRef.channel,
        snippet: receiverMatch[0],
      })
    }
  }

  return {
    rendererCalls,
    mainHandlers,
    webContentsSends,
    dispatches,
    asyncImports,
    dynamicRequires,
    storeCalls,
    broadcastSenders,
    broadcastReceivers,
  }
}

function extractStoreDefinitions(content) {
  const definitions = []
  const storeDefRe = /(?:export\s+)?(?:const|let|var)\s+(use[A-Z]\w*Store)\s*=\s*defineStore\(\s*['"`]([^'"`]+)['"`]/g
  let match
  while ((match = storeDefRe.exec(content)) !== null) {
    definitions.push({ name: match[1], storeId: match[2], snippet: match[0] })
  }
  return definitions
}

// --- Validation extraction (regex-based) ---
function extractValidations(content) {
  const validations = []
  let m
  const reqRe = /(\w+):\s*\{[^}]*required:\s*true/g
  while ((m = reqRe.exec(content)) !== null) validations.push({ field: m[1], type: 'required' })
  const msgRe = /Message\(\s*\{\s*type:\s*['"]error['"]\s*,\s*message:\s*([^}]+)\}/g
  while ((m = msgRe.exec(content)) !== null) validations.push({ type: 'error_message', message: m[1].trim() })
  const patRe = /(\w+):\s*\{[^}]*pattern:\s*(\/[^/]+\/\w*)/g
  while ((m = patRe.exec(content)) !== null) validations.push({ field: m[1], type: 'pattern', pattern: m[2] })
  return validations
}

// --- Import source resolution ---
function resolveImportSource(source, fromFile, allRelPaths) {
  if (source.startsWith('.')) {
    const lastSlash = fromFile.lastIndexOf('/')
    const dir = lastSlash === -1 ? '.' : fromFile.substring(0, lastSlash)
    const resolved = normalize(join(dir, source)).replace(/^[/\\]/, '')
    for (const suffix of ['', '.ts', '.js', '.vue', '/index.ts', '/index.js', '/index.vue', '.tsx', '.jsx']) {
      if (allRelPaths.has(resolved + suffix)) return resolved + suffix
    }
  }
  return null
}

// Detect defineStore calls from AST
function extractStoreNames(parsed) {
  const stores = []
  if (!parsed) return stores
  if (parsed.type === 'swc') {
    function visit(node) {
      if (!node || typeof node !== 'object') return
      if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.value === 'defineStore') {
        const firstArg = node.arguments?.[0]
        if (firstArg?.expression?.type === 'StringLiteral') {
          stores.push(firstArg.expression.value)
        } else if (firstArg?.type === 'StringLiteral') {
          stores.push(firstArg.value)
        }
      }
      for (const key of Object.keys(node)) {
        if (key === 'span' || key === 'type') continue
        const child = node[key]
        if (Array.isArray(child)) {
          for (const item of child) {
            if (item && typeof item === 'object' && item.type) visit(item)
          }
        } else if (child && typeof child === 'object' && child.type) {
          visit(child)
        }
      }
    }
    visit(parsed.ast)
  }
  return stores
}

// === Main ===
async function run() {
  const parserBackend = await initParser()
  const dom = await loadCompilerDom()

  const projectRoot = realpathSync(process.cwd())
  const absTarget = realpathSync(resolve(targetDir))
  if (!existsSync(absTarget)) {
    console.error(`Target directory not found: ${absTarget}`)
    process.exit(1)
  }

  const outBase = outputBaseDir ? join(resolve(outputBaseDir), 'navigation') : join(absTarget, '.doc', 'navigation')
  mkdirSync(outBase, { recursive: true })
  const intermediateDir = join(outBase, '_intermediate')
  mkdirSync(intermediateDir, { recursive: true })

  // Git commit tracking
  const baseCommit = getCurrentCommitSha(process.cwd())

  const allFiles = collectFiles(absTarget)
  const runtimeSupportFiles = collectProjectRuntimeFiles(projectRoot, absTarget)
  const allRelPaths = new Set(allFiles.map(f => f.relPath))
  console.log(`[nav-parser] Scanning ${allFiles.length} files in ${targetDir}`)
  console.log(`[nav-parser] Base commit: ${baseCommit || 'unknown'}`)

  // Incremental mode
  let previousCommit = null
  const manifestPath = outputBaseDir ? join(resolve(outputBaseDir), 'manifest.yml') : join(absTarget, '.doc', 'manifest.yml')
  if (incremental && existsSync(manifestPath)) {
    const manifestContent = readFileSync(manifestPath, 'utf-8')
    const commitMatch = manifestContent.match(/base_commit:\s*['"]?([a-f0-9]+)['"]?/)
    if (commitMatch) previousCommit = commitMatch[1]
  }

  let filesToProcess = allFiles
  let incrementalMeta = null
  let deletedSet = new Set()
  if (incremental && previousCommit) {
    const changedFiles = getChangedFilesSinceCommit(previousCommit, projectRoot)
    const changedStatuses = getChangedFileStatusesSinceCommit(previousCommit, projectRoot)
    if (changedFiles) {
      const changedRelPaths = new Set()
      const deletedRelPaths = new Set()
      const renamedFromRelPaths = new Set()
      let coreConfigChanged = false

      for (const item of changedStatuses) {
        if (isCoreGraphConfigChange(item.path) || (item.oldPath && isCoreGraphConfigChange(item.oldPath))) {
          coreConfigChanged = true
        }
        for (const file of allFiles) {
          const projectRelPath = relative(projectRoot, file.absPath)
          if (item.path === projectRelPath || item.path === file.relPath) {
            changedRelPaths.add(file.relPath)
          }
        }
        if (item.status === 'D' || item.status === 'R') {
          const removedPath = item.status === 'R' ? item.oldPath : item.path
          const relFromTarget = relative(absTarget, resolve(projectRoot, removedPath)).replace(/\\/g, '/')
          if (relFromTarget && !relFromTarget.startsWith('..')) {
            deletedRelPaths.add(relFromTarget)
            if (item.status === 'R') renamedFromRelPaths.add(relFromTarget)
          }
        }
      }

      if (changedRelPaths.size === 0) {
        for (const file of allFiles) {
          const projectRelPath = relative(projectRoot, file.absPath)
          if (changedFiles.has(projectRelPath) || changedFiles.has(file.relPath)) changedRelPaths.add(file.relPath)
        }
      }

      const existingGraph = readExistingJson(join(outBase, 'file-graph.json'))
      const existingEdges = existingGraph?.data?.edges || []
      const impactedRelPaths = expandImpactSet(changedRelPaths, existingEdges)
      const impactRatio = allFiles.length === 0 ? 0 : impactedRelPaths.size / allFiles.length
      const fullReparse = coreConfigChanged || impactRatio > 0.2
      filesToProcess = fullReparse
        ? allFiles
        : allFiles.filter(f => impactedRelPaths.has(f.relPath))
      deletedSet = new Set([...deletedRelPaths, ...renamedFromRelPaths])
      incrementalMeta = {
        previous_commit: previousCommit,
        current_commit: baseCommit,
        comparison: 'base_commit..working-tree',
        changed_files: [...changedRelPaths].sort(),
        impacted_files: [...new Set(filesToProcess.map(f => f.relPath))].sort(),
        deleted_files: [...deletedSet].sort(),
        full_reparse: fullReparse,
        reason: fullReparse
          ? (coreConfigChanged ? 'core-config-change' : 'impact-ratio-threshold')
          : 'impact-set',
      }
      console.log(`[nav-parser] Incremental: ${filesToProcess.length} impacted files (${changedRelPaths.size} changed) since ${previousCommit.slice(0, 8)}`)
    }
  }

  const fileNodes = []
  const nodeIds = new Set()
  const fileEdges = []
  const funcDeps = { functions: [] }
  const componentRefs = { components: [] }
  const contentCache = new Map()
  const storeDefinitionMap = new Map()
  // T1: 保存 file-level raw imports 供 buildGraphIndex 计算 structuralFingerprint
  const rawImportsByFile = new Map()

  // Phase 1: Parse all files, extract imports/exports/components
  for (const file of filesToProcess) {
    const content = readFileSync(file.absPath, 'utf-8')
    contentCache.set(file.relPath, content)
    const isVue = extname(file.relPath) === '.vue'
    ensureNode(fileNodes, nodeIds, file.relPath)

    let parsed = null
    let templateInfo = null
    let isSetup = false

    if (isVue) {
      const sfc = parseVueSFC(content, file.relPath)
      if (sfc?.scriptContent) {
        parsed = parseScript(sfc.scriptContent, file.relPath.replace('.vue', '.ts'))
        isSetup = sfc.isSetup
      }
      if (sfc?.templateContent && dom) {
        templateInfo = extractTemplateInfo(sfc.templateContent, dom, sfc.templateLineOffset)
      }
    } else {
      parsed = parseScript(content, file.relPath)
    }

    // Extract imports
    const imports = extractImports(parsed)
    rawImportsByFile.set(file.relPath, imports)
    for (const imp of imports) {
      if (imp.typeOnly) continue // skip type-only imports for dependency graph
      const resolvedTarget = resolveImportSource(imp.source, file.relPath, allRelPaths)
      if (resolvedTarget) {
        ensureNode(fileNodes, nodeIds, resolvedTarget)
        fileEdges.push(createEdge({
          source: file.relPath,
          target: resolvedTarget,
          type: 'import',
          confidence: 1,
          weight: 1,
          evidence: [{ file: file.relPath, kind: 'import', snippet: imp.source }],
        }))
      }
    }

    // Extract exports (or setup bindings for <script setup>)
    let fileExports
    if (isVue && isSetup) {
      // In <script setup>, top-level bindings + imports are auto-exported
      fileExports = extractSetupBindings(parsed)
      // Also add imported components (they're registered automatically)
      for (const imp of imports) {
        for (const named of imp.namedImports) {
          if (named.isDefault && /^[A-Z]/.test(named.name)) {
            // Default import of PascalCase = component registration
            fileExports.push({ name: named.name, type: 'component' })
          }
        }
      }
    } else {
      fileExports = extractExports(parsed, file.relPath)
    }

    // Detect store definitions
    const storeNames = extractStoreNames(parsed)
    for (const storeName of storeNames) {
      fileExports.push({ name: storeName, type: 'store' })
    }
    const storeDefinitions = extractStoreDefinitions(content)
    for (const storeDef of storeDefinitions) {
      storeDefinitionMap.set(storeDef.name, { file: file.relPath, storeId: storeDef.storeId })
      if (!fileExports.some(exp => exp.name === storeDef.name)) {
        fileExports.push({ name: storeDef.name, type: 'store' })
      }
    }

    for (const exp of fileExports) {
      if (exp.type === 'interface' || exp.type === 'type-alias') continue // skip type exports
      const role = classifyRole(exp.name)
      const validations = extractValidations(content)
      const funcEntry = {
        id: navigationId('function', file.relPath, exp.name, exp.type || 'unknown'),
        name: exp.name,
        type: exp.type,
        file: file.relPath,
        ...(role && { role }),
        ...(exp.params?.length > 0 && { params: exp.params }),
        ...(exp.return_type && { return_type: exp.return_type }),
        ...(validations.length > 0 && { validations }),
      }
      funcDeps.functions.push(funcEntry)
    }

    // Component refs
    if (isVue) {
      const uses = templateInfo?.components || []
      const importedComponents = imports
        .flatMap(i => i.namedImports.filter(n => !n.isNamespace && /^[A-Z]/.test(n.alias || n.name)).map(n => n.alias || n.name))
      const conditions = templateInfo?.conditions || []
      const events = extractEvents(content)
      const compEntry = {
        id: navigationId('component', file.relPath),
        file: file.relPath,
        uses,
        ...(importedComponents.length > 0 && { imports: importedComponents }),
        ...(conditions.length > 0 && { conditions }),
        ...(templateInfo?.eventBindings?.length > 0 && { event_bindings: templateInfo.eventBindings }),
        ...(templateInfo?.slotUsage?.length > 0 && { slot_usage: templateInfo.slotUsage }),
        ...(templateInfo?.templateBindings?.length > 0 && { template_bindings: templateInfo.templateBindings }),
        ...(events.subscribes_to.length > 0 && { subscribes_to: events.subscribes_to }),
        ...(events.emits_events.length > 0 && { emits_events: events.emits_events }),
      }
      componentRefs.components.push(compEntry)
    }
  }

  const runtimeFiles = [...filesToProcess, ...runtimeSupportFiles]
  const ipcRendererByChannel = new Map()
  const ipcMainByChannel = new Map()
  const webContentsSends = []
  const broadcastSendersByChannel = new Map()
  const broadcastReceiversByChannel = new Map()

  for (const file of runtimeFiles) {
    const cacheKey = file.relPath
    const content = contentCache.has(cacheKey)
      ? contentCache.get(cacheKey)
      : readFileSync(file.absPath, 'utf-8')
    contentCache.set(cacheKey, content)
    const signals = extractRuntimeSignals(content)

    if (
      signals.rendererCalls.length === 0 &&
      signals.mainHandlers.length === 0 &&
      signals.webContentsSends.length === 0 &&
      signals.dispatches.length === 0 &&
      signals.asyncImports.length === 0 &&
      signals.dynamicRequires.length === 0 &&
      signals.storeCalls.length === 0 &&
      signals.broadcastSenders.length === 0 &&
      signals.broadcastReceivers.length === 0
    ) {
      continue
    }

    ensureNode(fileNodes, nodeIds, file.relPath)

    for (const call of signals.rendererCalls) {
      if (!ipcRendererByChannel.has(call.channel)) ipcRendererByChannel.set(call.channel, [])
      ipcRendererByChannel.get(call.channel).push({ file: file.relPath, ...call })
    }

    for (const handler of signals.mainHandlers) {
      if (!ipcMainByChannel.has(handler.channel)) ipcMainByChannel.set(handler.channel, [])
      ipcMainByChannel.get(handler.channel).push({ file: file.relPath, ...handler })
    }

    for (const send of signals.webContentsSends) {
      webContentsSends.push({ file: file.relPath, ...send })
      fileEdges.push(createEdge({
        source: file.relPath,
        target: file.relPath,
        type: 'webcontents-send',
        channel: send.channel,
        confidence: 0.9,
        weight: 1.3,
        evidence: [{ file: file.relPath, kind: 'webcontents-send', snippet: send.snippet }],
      }))
    }

    for (const asyncImport of signals.asyncImports) {
      const resolvedTarget = resolveImportSource(asyncImport.source, file.relPath, allRelPaths)
      const target = resolvedTarget || file.relPath
      ensureNode(fileNodes, nodeIds, target)
      fileEdges.push(createEdge({
        source: file.relPath,
        target,
        type: 'async-import',
        confidence: resolvedTarget ? 0.95 : 0.5,
        weight: 1.1,
        evidence: [{ file: file.relPath, kind: 'async-import', snippet: asyncImport.snippet }],
      }))
    }

    for (const dynamicRequire of signals.dynamicRequires) {
      const resolvedTarget = resolveImportSource(dynamicRequire.source, file.relPath, allRelPaths)
      const target = resolvedTarget || file.relPath
      ensureNode(fileNodes, nodeIds, target)
      fileEdges.push(createEdge({
        source: file.relPath,
        target,
        type: 'dynamic-require',
        confidence: resolvedTarget ? 0.85 : 0.5,
        weight: 1.05,
        evidence: [{ file: file.relPath, kind: 'dynamic-require', snippet: dynamicRequire.snippet }],
      }))
    }

    for (const dispatch of signals.dispatches) {
      fileEdges.push(createEdge({
        source: file.relPath,
        target: file.relPath,
        type: 'dynamic-dispatch',
        subtype: dispatch.mapName,
        confidence: 0.6,
        weight: 1.2,
        evidence: [{ file: file.relPath, kind: 'dynamic-dispatch', snippet: dispatch.snippet }],
      }))
    }

    for (const storeCall of signals.storeCalls) {
      const storeDef = storeDefinitionMap.get(storeCall.storeName)
      if (!storeDef) continue
      ensureNode(fileNodes, nodeIds, storeDef.file)
      fileEdges.push(createEdge({
        source: file.relPath,
        target: storeDef.file,
        type: 'store-call',
        subtype: storeDef.storeId,
        confidence: 0.95,
        weight: 1.15,
        evidence: [{ file: file.relPath, kind: 'store-call', snippet: storeCall.snippet }],
      }))
    }

    for (const sender of signals.broadcastSenders) {
      if (!broadcastSendersByChannel.has(sender.channel)) broadcastSendersByChannel.set(sender.channel, [])
      broadcastSendersByChannel.get(sender.channel).push({ file: file.relPath, ...sender })
    }

    for (const receiver of signals.broadcastReceivers) {
      if (!broadcastReceiversByChannel.has(receiver.channel)) broadcastReceiversByChannel.set(receiver.channel, [])
      broadcastReceiversByChannel.get(receiver.channel).push({ file: file.relPath, ...receiver })
    }
  }

  for (const [channel, rendererCalls] of ipcRendererByChannel) {
    const mainHandlers = ipcMainByChannel.get(channel) || []
    if (mainHandlers.length > 0) {
      for (const call of rendererCalls) {
        for (const handler of mainHandlers) {
          ensureNode(fileNodes, nodeIds, call.file)
          ensureNode(fileNodes, nodeIds, handler.file)
          fileEdges.push(createEdge({
            source: call.file,
            target: handler.file,
            type: 'ipc',
            subtype: `${call.method}-${handler.method}`,
            channel,
            confidence: 0.95,
            weight: 1.4,
            evidence: [
              { file: call.file, kind: 'ipc-renderer', snippet: call.snippet },
              { file: handler.file, kind: 'ipc-main', snippet: handler.snippet },
            ],
          }))
        }
      }
    } else {
      for (const call of rendererCalls) {
        fileEdges.push(createEdge({
          source: call.file,
          target: call.file,
          type: 'ipc',
          subtype: `${call.method}-unresolved`,
          channel,
          confidence: 0.5,
          weight: 1.1,
          evidence: [{ file: call.file, kind: 'ipc-renderer', snippet: call.snippet }],
        }))
      }
    }
  }

  for (const [channel, senders] of broadcastSendersByChannel) {
    const receivers = broadcastReceiversByChannel.get(channel) || []
    if (receivers.length > 0) {
      for (const sender of senders) {
        for (const receiver of receivers) {
          ensureNode(fileNodes, nodeIds, sender.file)
          ensureNode(fileNodes, nodeIds, receiver.file)
          fileEdges.push(createEdge({
            source: sender.file,
            target: receiver.file,
            type: 'broadcast-channel',
            channel,
            confidence: 0.8,
            weight: 1.05,
            evidence: [
              { file: sender.file, kind: 'broadcast-send', snippet: sender.snippet },
              { file: receiver.file, kind: 'broadcast-receive', snippet: receiver.snippet },
            ],
          }))
        }
      }
    } else {
      for (const sender of senders) {
        fileEdges.push(createEdge({
          source: sender.file,
          target: sender.file,
          type: 'broadcast-channel',
          channel,
          confidence: 0.5,
          weight: 1,
          evidence: [{ file: sender.file, kind: 'broadcast-send', snippet: sender.snippet }],
        }))
      }
    }
  }

  const dedupedEdges = []
  const seenEdgeKeys = new Set()
  for (const edge of fileEdges) {
    const key = edgeKey(edge)
    if (seenEdgeKeys.has(key)) continue
    seenEdgeKeys.add(key)
    dedupedEdges.push(edge)
  }

  // Phase 2: Build call graph (callers + calls)
  const knownExports = new Set(funcDeps.functions.map(f => f.name))
  const funcByName = new Map()
  for (const fn of funcDeps.functions) funcByName.set(fn.name, fn)

  for (const file of filesToProcess) {
    const content = contentCache.get(file.relPath)
    const isVue = extname(file.relPath) === '.vue'
    let parsed
    if (isVue) {
      const sfc = parseVueSFC(content, file.relPath)
      parsed = sfc?.scriptContent ? parseScript(sfc.scriptContent, file.relPath.replace('.vue', '.ts')) : null
    } else {
      parsed = parseScript(content, file.relPath)
    }
    const fileCalls = extractCalls(parsed, knownExports)

    for (const [name, fn] of funcByName) {
      if (fn.file === file.relPath && fn.type === 'function') {
        const relevantCalls = fileCalls.filter(c => c !== name)
        if (relevantCalls.length > 0) fn.calls = relevantCalls
      }
      if (fn.file !== file.relPath && fileCalls.includes(name)) {
        if (!fn.callers) fn.callers = []
        if (!fn.callers.includes(file.relPath)) fn.callers.push(file.relPath)
      }
    }

    // Event extraction for non-.vue files
    if (!isVue) {
      const events = extractEvents(content)
      const funcsInFile = funcDeps.functions.filter(f => f.file === file.relPath)
      if (events.subscribes_to.length > 0 || events.emits_events.length > 0) {
        for (const fn of funcsInFile) {
          if (events.subscribes_to.length > 0) fn.subscribes_to = events.subscribes_to
          if (events.emits_events.length > 0) fn.emits_events = events.emits_events
        }
      }
    }
  }

  // --- Output ---
  const metadata = {
    generated_at: new Date().toISOString(),
    target_dir: targetDir,
    base_commit: baseCommit,
    parser_backend: parserBackend,
    navigation_id_version: 1,
    file_count: allFiles.length,
    parsed_count: filesToProcess.length,
    parser_version: '2.1.0',
    ...(incrementalMeta && { incremental: incrementalMeta }),
  }

  let finalNodes = fileNodes
  let finalEdges = dedupedEdges
  let finalFuncDeps = funcDeps
  let finalComponentRefs = componentRefs

  if (incremental && previousCommit) {
    const processedSet = new Set(filesToProcess.map(f => f.relPath))
    // Merge into existing files
    const fgPath = join(outBase, 'file-graph.json')
    if (existsSync(fgPath)) {
      const existing = JSON.parse(readFileSync(fgPath, 'utf-8'))
      const nextNodeMap = new Map()
      for (const node of existing.data.nodes || []) {
        if (processedSet.has(node.id) || deletedSet.has(node.id)) continue
        nextNodeMap.set(node.id, node)
      }
      for (const node of fileNodes) nextNodeMap.set(node.id, node)

      const nextEdgeMap = new Map()
      for (const edge of existing.data.edges || []) {
        if (processedSet.has(edge.source)) continue
        if (deletedSet.has(edge.source) || deletedSet.has(edge.target)) continue
        nextEdgeMap.set(edgeKey(edge), edge)
      }
      for (const edge of dedupedEdges) {
        if (deletedSet.has(edge.source) || deletedSet.has(edge.target)) continue
        nextEdgeMap.set(edgeKey(edge), edge)
      }

      finalNodes = [...nextNodeMap.values()]
      finalEdges = [...nextEdgeMap.values()]
    }
    const fdPath = join(outBase, 'func-dependencies.json')
    if (existsSync(fdPath)) {
      const existing = JSON.parse(readFileSync(fdPath, 'utf-8'))
      const functions = (existing.data.functions || [])
        .filter(f => !processedSet.has(f.file) && !deletedSet.has(f.file))
        .concat(funcDeps.functions)
      finalFuncDeps = { functions }
    }
    const crPath = join(outBase, 'component-refs.json')
    if (existsSync(crPath)) {
      const existing = JSON.parse(readFileSync(crPath, 'utf-8'))
      const components = (existing.data.components || [])
        .filter(c => !processedSet.has(c.file) && !deletedSet.has(c.file))
        .concat(componentRefs.components)
      finalComponentRefs = { components }
    }
  }

  const navigationData = addNavigationIds({
    nodes: finalNodes,
    edges: finalEdges,
    funcDeps: finalFuncDeps,
    componentRefs: finalComponentRefs,
  })
  finalNodes = navigationData.nodes
  finalEdges = navigationData.edges
  finalFuncDeps = navigationData.funcDeps
  finalComponentRefs = navigationData.componentRefs
  writeFileSync(join(outBase, 'file-graph.json'), JSON.stringify({ metadata, data: { nodes: finalNodes, edges: finalEdges } }, null, 2))
  writeFileSync(join(outBase, 'func-dependencies.json'), JSON.stringify({ metadata, data: finalFuncDeps }, null, 2))
  writeFileSync(join(outBase, 'component-refs.json'), JSON.stringify({ metadata, data: finalComponentRefs }, null, 2))

  // T2a: field-level candidates from component template bindings
  // Consumed by field-lineage.mjs (T2d) alongside pinia-stores.json and api-payload-shapes.json.
  const fieldCandidatesSource = finalComponentRefs || componentRefs
  const fieldCandidates = {
    metadata: {
      generated_at: metadata.generated_at,
      base_commit: metadata.base_commit,
      version: '1.0',
      producer: 'nav-parser',
      contract: 'candidate-evidence-only',
    },
    components: (fieldCandidatesSource.components || [])
      .filter(c => c.template_bindings?.length > 0)
      .map(c => ({ file: c.file, template_bindings: c.template_bindings })),
  }
  writeFileSync(join(intermediateDir, 'field-candidates.json'), JSON.stringify(fieldCandidates, null, 2))

  // T1: 读旧 graph-index.json，未处理文件的 structuralFingerprint 保留、pageFingerprints 承载给 field-lineage 回填
  const graphIndexPath = join(outBase, 'graph-index.json')
  let previousGraphIndex = null
  if (existsSync(graphIndexPath)) {
    try { previousGraphIndex = JSON.parse(readFileSync(graphIndexPath, 'utf-8')) } catch { previousGraphIndex = null }
  }
  const graphIndex = buildGraphIndex({
    nodes: finalNodes,
    edges: finalEdges,
    allFiles,
    contentCache,
    funcDeps: finalFuncDeps,
    parserVersion: metadata.parser_version,
    rawImportsByFile,
    componentRefs: finalComponentRefs || componentRefs,
    previousGraphIndex,
  })
  writeFileSync(graphIndexPath, JSON.stringify(graphIndex, null, 2))

  const graphQuality = buildGraphQuality({
    nodes: finalNodes,
    edges: finalEdges,
    allFiles,
    targetDir,
    incrementalMeta,
  })
  writeFileSync(join(outBase, 'graph-quality.json'), JSON.stringify(graphQuality, null, 2))
  updateManifestGraphDraft(manifestPath, graphQuality)

  console.log(`[nav-parser] Generated Layer 3 data in ${outBase}`)
  console.log(`  file-graph.json: ${finalNodes.length} nodes, ${finalEdges.length} edges`)
  console.log(`  func-dependencies.json: ${finalFuncDeps.functions.length} exports`)
  console.log(`  component-refs.json: ${finalComponentRefs.components.length} components`)
  console.log(`  graph-quality.json: ${graphQuality.status}`)
}

run().catch(err => {
  console.error('[nav-parser] Failed:', err)
  process.exit(1)
})
