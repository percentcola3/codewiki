import { createRequire } from 'node:module'
import { readFileSync, readdirSync } from 'node:fs'
import { basename, extname, join, relative } from 'node:path'
import {
  createFactCollector,
  evidence,
  factId,
  normalizePath,
  normalizeRoute,
  walkTreeSitter,
} from './common.mjs'

const require = createRequire(import.meta.url)
const Parser = require('tree-sitter')
const Java = require('tree-sitter-java')
const Go = require('tree-sitter-go')

const EXCLUDED_DIRS = new Set(['.codewiki', '.git', 'build', 'dist', 'node_modules', 'target', 'vendor'])

function collectFiles(root, extension, output = []) {
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return output }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      collectFiles(join(root, entry.name), extension, output)
    } else if (extname(entry.name) === extension) output.push(join(root, entry.name))
  }
  return output
}

function nodeName(node) {
  return node?.childForFieldName?.('name')?.text || null
}

function nearestParent(parents, types) {
  const set = new Set(types)
  return [...parents].reverse().find(parent => set.has(parent.type)) || null
}

function mappingValue(text) {
  const quoted = String(text || '').match(/['"]([^'"]+)['"]/)?.[1]
  return normalizeRoute(quoted || '/')
}

function springMethodMapping(content, methodNode) {
  const start = methodNode.startIndex
  const header = methodNode.text.slice(0, Math.min(methodNode.text.length, 900))
  const matches = [...header.matchAll(/@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)\s*(?:\(([^)]*)\))?/g)]
  if (matches.length === 0) return null
  const last = matches[matches.length - 1]
  const kind = last[1]
  let method = ({ GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', DeleteMapping: 'DELETE', PatchMapping: 'PATCH' })[kind] || null
  if (!method && kind === 'RequestMapping') {
    method = last[2]?.match(/RequestMethod\.([A-Z]+)/)?.[1] || '*'
  }
  return { method, route: mappingValue(last[2]), snippet: last[0], offset: start + (last.index || 0) }
}

function springClassBase(content, classNode) {
  if (!classNode) return '/'
  const header = classNode.text.slice(0, Math.min(classNode.text.indexOf('{') >= 0 ? classNode.text.indexOf('{') : classNode.text.length, 700))
  const matches = [...header.matchAll(/@RequestMapping\s*(?:\(([^)]*)\))?/g)]
  return matches.length > 0 ? mappingValue(matches[matches.length - 1][1]) : '/'
}

function joinRoutes(base, route) {
  if (!base || base === '/') return normalizeRoute(route)
  if (!route || route === '/') return normalizeRoute(base)
  return normalizeRoute(`${base}/${route}`)
}

function addJavaFileFacts({ collector, unit, projectRoot, absPath, content, tree, functionNames, pendingCalls }) {
  const file = normalizePath(relative(projectRoot, absPath))
  const fileId = collector.addFile(file, { parse_status: tree.rootNode.hasError ? 'partial' : 'ok' })
  if (tree.rootNode.hasError) collector.warnings.push(`${file}: Java AST 含 ERROR/MISSING 节点`)

  let packageName = ''
  walkTreeSitter(tree.rootNode, node => {
    if (node.type === 'package_declaration') packageName = node.text.replace(/^package\s+/, '').replace(/;$/, '').trim()
  })

  const declarationIds = new Map()
  const typeKinds = {
    class_declaration: 'class',
    interface_declaration: 'interface',
    enum_declaration: 'enum',
    record_declaration: 'record',
    annotation_type_declaration: 'annotation-type',
  }

  walkTreeSitter(tree.rootNode, (node, parents) => {
    if (typeKinds[node.type]) {
      const name = nodeName(node)
      if (!name) return
      const parentType = nearestParent(parents, Object.keys(typeKinds))
      const container = parentType ? nodeName(parentType) : null
      const qualifiedName = [packageName, container, name].filter(Boolean).join('.')
      const id = factId(typeKinds[node.type], unit.id, qualifiedName)
      declarationIds.set(`${node.startIndex}:${node.endIndex}`, id)
      collector.addNode({
        id, type: typeKinds[node.type], label: name, qualified_name: qualifiedName,
        package: packageName || null, file, line: node.startPosition.row + 1,
        evidence: [evidence(file, node.startPosition.row + 1, 'declaration', node.text.slice(0, 180))],
      })
      collector.addEdge(fileId, id, 'declares')
      if (parentType) {
        const parentKey = `${parentType.startIndex}:${parentType.endIndex}`
        const parentId = declarationIds.get(parentKey)
        if (parentId) collector.addEdge(parentId, id, 'contains')
      }
      return
    }

    if (['method_declaration', 'constructor_declaration'].includes(node.type)) {
      const name = nodeName(node)
      if (!name) return
      const parentType = nearestParent(parents, Object.keys(typeKinds))
      const typeName = nodeName(parentType) || basename(file, '.java')
      const qualifiedName = [packageName, typeName].filter(Boolean).join('.') + `#${name}`
      const id = factId(node.type === 'constructor_declaration' ? 'constructor' : 'method', unit.id, qualifiedName)
      collector.addNode({
        id, type: node.type === 'constructor_declaration' ? 'constructor' : 'method', label: name,
        qualified_name: qualifiedName, package: packageName || null, file, line: node.startPosition.row + 1,
        evidence: [evidence(file, node.startPosition.row + 1, 'declaration', node.text.slice(0, 180))],
      })
      const parentId = parentType && declarationIds.get(`${parentType.startIndex}:${parentType.endIndex}`)
      collector.addEdge(parentId || fileId, id, parentId ? 'contains' : 'declares')
      const list = functionNames.get(name) || []
      list.push(id)
      functionNames.set(name, list)

      const calls = []
      walkTreeSitter(node, child => {
        if (child.type !== 'method_invocation') return
        const callName = child.childForFieldName('name')?.text
        if (callName) calls.push(callName)
      })
      pendingCalls.push({ from: id, names: [...new Set(calls.filter(item => item !== name))], file, line: node.startPosition.row + 1 })

      const mapping = springMethodMapping(content, node)
      if (mapping) {
        const route = joinRoutes(springClassBase(content, parentType), mapping.route)
        const endpointId = factId('endpoint', unit.id, mapping.method, route, qualifiedName)
        const line = content.slice(0, mapping.offset).split('\n').length
        collector.addNode({
          id: endpointId, type: 'endpoint', label: `${mapping.method} ${route}`, method: mapping.method,
          route, protocol: 'http', handler: qualifiedName, file, line,
          evidence: [evidence(file, line, 'spring-mapping', mapping.snippet)],
        })
        collector.addEdge(endpointId, id, 'implemented-by')
      }
      return
    }

    if (node.type === 'import_declaration') {
      const imported = node.text.replace(/^import\s+(?:static\s+)?/, '').replace(/;$/, '').trim()
      const packageId = factId('package', imported)
      collector.addNode({ id: packageId, type: 'package', label: imported, package: imported, confidence: 1 })
      collector.addEdge(fileId, packageId, 'imports', { evidence: [evidence(file, node.startPosition.row + 1, 'import', node.text)] })
    }
  })
}

function goReceiverName(node) {
  const receiver = node.childForFieldName?.('receiver')
  if (!receiver) return null
  const text = receiver.text.replace(/[()*]/g, ' ').trim().split(/\s+/)
  return text[text.length - 1] || null
}

function goRoutes(content) {
  const routes = []
  for (const match of content.matchAll(/\b(?:\w+\.)?(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s*\(\s*['"]([^'"]+)['"]\s*,\s*([A-Za-z_$][\w$.]*)/g)) {
    routes.push({ method: match[1], route: match[2], handler: match[3].split('.').pop(), offset: match.index, snippet: match[0] })
  }
  for (const match of content.matchAll(/\b(?:http\.)?HandleFunc\s*\(\s*['"]([^'"]+)['"]\s*,\s*([A-Za-z_$][\w$.]*)/g)) {
    routes.push({ method: '*', route: match[1], handler: match[2].split('.').pop(), offset: match.index, snippet: match[0] })
  }
  for (const match of content.matchAll(/\.HandleFunc\s*\(\s*['"]([^'"]+)['"]\s*,\s*([A-Za-z_$][\w$.]*)\s*\)([\s\S]{0,160}?\.Methods\s*\(\s*['"]([A-Z]+)['"]\s*\))?/g)) {
    routes.push({ method: match[4] || '*', route: match[1], handler: match[2].split('.').pop(), offset: match.index, snippet: match[0] })
  }
  return routes
}

function addGoFileFacts({ collector, unit, projectRoot, absPath, content, tree, functionNames, pendingCalls, pendingEndpoints }) {
  const file = normalizePath(relative(projectRoot, absPath))
  const fileId = collector.addFile(file, { parse_status: tree.rootNode.hasError ? 'partial' : 'ok' })
  if (tree.rootNode.hasError) collector.warnings.push(`${file}: Go AST 含 ERROR/MISSING 节点`)
  let packageName = ''
  walkTreeSitter(tree.rootNode, node => {
    if (node.type === 'package_clause') packageName = node.namedChild(0)?.text || ''
  })

  const typeIds = new Map()
  walkTreeSitter(tree.rootNode, (node, parents) => {
    if (node.type === 'type_spec') {
      const name = nodeName(node)
      const value = node.childForFieldName('type') || node.namedChild(1)
      const kind = value?.type === 'interface_type' ? 'interface' : value?.type === 'struct_type' ? 'struct' : 'type'
      if (!name) return
      const qualifiedName = [packageName, name].filter(Boolean).join('.')
      const id = factId(kind, unit.id, qualifiedName)
      typeIds.set(name, id)
      collector.addNode({
        id, type: kind, label: name, qualified_name: qualifiedName, package: packageName || null,
        file, line: node.startPosition.row + 1,
        evidence: [evidence(file, node.startPosition.row + 1, 'declaration', node.text.slice(0, 180))],
      })
      collector.addEdge(fileId, id, 'declares')
      return
    }

    if (['function_declaration', 'method_declaration'].includes(node.type)) {
      const name = nodeName(node)
      if (!name) return
      const receiver = node.type === 'method_declaration' ? goReceiverName(node) : null
      const qualifiedName = [packageName, receiver, name].filter(Boolean).join('.')
      const id = factId(node.type === 'method_declaration' ? 'method' : 'function', unit.id, qualifiedName)
      collector.addNode({
        id, type: node.type === 'method_declaration' ? 'method' : 'function', label: name,
        qualified_name: qualifiedName, receiver, package: packageName || null, file, line: node.startPosition.row + 1,
        evidence: [evidence(file, node.startPosition.row + 1, 'declaration', node.text.slice(0, 180))],
      })
      collector.addEdge(receiver && typeIds.get(receiver) ? typeIds.get(receiver) : fileId, id, receiver ? 'contains' : 'declares')
      const list = functionNames.get(name) || []
      list.push(id)
      functionNames.set(name, list)
      const calls = []
      walkTreeSitter(node, child => {
        if (child.type !== 'call_expression') return
        const fn = child.childForFieldName('function')
        const callName = fn?.type === 'selector_expression' ? fn.childForFieldName('field')?.text : fn?.text
        if (callName) calls.push(callName)
      })
      pendingCalls.push({ from: id, names: [...new Set(calls.filter(item => item !== name))], file, line: node.startPosition.row + 1 })
      return
    }

    if (node.type === 'import_spec') {
      const imported = node.childForFieldName('path')?.text?.replace(/^['"]|['"]$/g, '') || node.text.match(/['"]([^'"]+)['"]/)?.[1]
      if (!imported) return
      const packageId = factId('package', imported)
      collector.addNode({ id: packageId, type: 'package', label: imported, package: imported, confidence: 1 })
      collector.addEdge(fileId, packageId, 'imports', { evidence: [evidence(file, node.startPosition.row + 1, 'import', node.text)] })
    }
  })

  for (const route of goRoutes(content)) pendingEndpoints.push({ ...route, file, fileId })
}

export async function extractTreeSitterFacts({ unit, projectRoot }) {
  const collector = createFactCollector(unit)
  const parser = new Parser()
  const isJava = unit.language === 'java'
  parser.setLanguage(isJava ? Java : Go)
  const files = collectFiles(unit.abs_path, isJava ? '.java' : '.go')
  const functionNames = new Map()
  const pendingCalls = []
  const pendingEndpoints = []

  for (const absPath of files) {
    const content = readFileSync(absPath, 'utf8')
    const tree = parser.parse(content)
    if (isJava) addJavaFileFacts({ collector, unit, projectRoot, absPath, content, tree, functionNames, pendingCalls })
    else addGoFileFacts({ collector, unit, projectRoot, absPath, content, tree, functionNames, pendingCalls, pendingEndpoints })
  }

  for (const call of pendingCalls) {
    for (const name of call.names) {
      const targets = functionNames.get(name) || []
      for (const target of targets) {
        collector.addEdge(call.from, target, 'calls', {
          confidence: targets.length === 1 ? 0.9 : 0.45,
          resolver: targets.length === 1 ? 'name-unique' : 'name-ambiguous',
          evidence: [evidence(call.file, call.line, 'call', name)],
        })
      }
    }
  }

  for (const route of pendingEndpoints) {
    const normalizedRoute = normalizeRoute(route.route)
    const line = readFileSync(join(projectRoot, route.file), 'utf8').slice(0, route.offset).split('\n').length
    const endpointId = factId('endpoint', unit.id, route.method, normalizedRoute, route.handler)
    collector.addNode({
      id: endpointId, type: 'endpoint', label: `${route.method} ${normalizedRoute}`, method: route.method,
      route: normalizedRoute, protocol: 'http', handler: route.handler, file: route.file, line,
      evidence: [evidence(route.file, line, 'go-route', route.snippet)],
    })
    const handlers = functionNames.get(route.handler) || []
    if (handlers.length === 0) collector.addEdge(route.fileId, endpointId, 'declares-endpoint', { confidence: 0.7 })
    for (const handler of handlers) collector.addEdge(endpointId, handler, 'implemented-by', { confidence: handlers.length === 1 ? 0.95 : 0.45 })
  }

  return collector.result()
}
