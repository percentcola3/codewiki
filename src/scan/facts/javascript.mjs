import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { parse as parseSfc } from '@vue/compiler-sfc'
import {
  createFactCollector,
  evidence,
  factId,
  normalizePath,
  normalizeRoute,
  walkObject,
} from './common.mjs'

const EXCLUDED_DIRS = new Set(['.codewiki', '.git', '.next', '.nuxt', 'build', 'coverage', 'dist', 'node_modules'])
const SCRIPT_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx'])
const HTML_TAGS = new Set([
  'a', 'article', 'aside', 'audio', 'body', 'button', 'canvas', 'code', 'component', 'details', 'dialog',
  'div', 'em', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'html', 'iframe', 'img',
  'input', 'label', 'li', 'main', 'nav', 'ol', 'option', 'p', 'path', 'pre', 'section', 'select', 'slot',
  'span', 'strong', 'svg', 'table', 'tbody', 'td', 'template', 'textarea', 'th', 'thead', 'tr', 'ul', 'video',
])

let swcPromise = null

async function loadSwc() {
  if (!swcPromise) {
    swcPromise = import('@swc/core').catch(() => import('@swc/wasm'))
  }
  return swcPromise
}

function collectFiles(root, framework, output = []) {
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return output }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      collectFiles(join(root, entry.name), framework, output)
      continue
    }
    const extension = extname(entry.name)
    if (SCRIPT_EXTENSIONS.has(extension) || (framework === 'vue' && extension === '.vue')) output.push(join(root, entry.name))
  }
  return output
}

function identifierName(node) {
  return node?.value ?? node?.name ?? node?.id?.value ?? node?.id?.name ?? null
}

function propertyName(node) {
  return identifierName(node?.key) || node?.key?.value || node?.key?.name || null
}

function calleeName(node) {
  const callee = node?.callee
  if (!callee) return null
  if (callee.type === 'Identifier') return identifierName(callee)
  if (callee.type === 'MemberExpression') return identifierName(callee.property)
  return identifierName(callee)
}

function byteOffsetLine(content, span, moduleStart = 1, lineOffset = 0) {
  if (span?.start == null) return lineOffset + 1
  const byteOffset = Math.max(0, Number(span.start) - Number(moduleStart || 1))
  const prefix = Buffer.from(content, 'utf8').subarray(0, byteOffset).toString('utf8')
  return lineOffset + prefix.split('\n').length
}

async function parseScript(content, file) {
  const swc = await loadSwc()
  const extension = extname(file)
  const isTypeScript = ['.ts', '.tsx', '.vue'].includes(extension)
  try {
    return swc.parseSync(content, {
      syntax: isTypeScript ? 'typescript' : 'ecmascript',
      tsx: extension === '.tsx' || extension === '.jsx',
      jsx: extension === '.jsx',
      decorators: true,
      target: 'es2022',
      comments: false,
    })
  } catch {
    return null
  }
}

function localImportTarget(source, file, filePaths) {
  if (!source?.startsWith('.')) return null
  const base = resolve(dirname(file), source)
  const candidates = [
    base,
    ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue'].map(extension => `${base}${extension}`),
    ...['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.vue'].map(name => join(base, name)),
  ]
  return candidates.find(candidate => filePaths.has(candidate)) || null
}

function extractImports(ast) {
  const imports = []
  for (const item of ast?.body || []) {
    if (item.type !== 'ImportDeclaration') continue
    const source = item.source?.value
    if (source) imports.push({ source, span: item.span })
  }
  return imports
}

function extractFunctions(ast, content, lineOffset = 0) {
  const functions = []
  const moduleStart = ast?.span?.start || 1
  walkObject(ast, (node, parents) => {
    let name = null
    let kind = null
    if (node.type === 'FunctionDeclaration') {
      name = identifierName(node.identifier)
      kind = 'function'
    } else if (node.type === 'ClassDeclaration') {
      name = identifierName(node.identifier)
      kind = 'class'
    } else if (node.type === 'VariableDeclarator' && ['ArrowFunctionExpression', 'FunctionExpression'].includes(node.init?.type)) {
      name = identifierName(node.id)
      kind = 'function'
    } else if (['ClassMethod', 'PrivateMethod', 'MethodProperty'].includes(node.type)) {
      name = propertyName(node)
      kind = 'method'
    }
    if (!name) return
    const parentClass = [...parents].reverse().find(parent => parent.type === 'ClassDeclaration')
    functions.push({
      name,
      kind,
      container: identifierName(parentClass?.identifier),
      line: byteOffsetLine(content, node.span, moduleStart, lineOffset),
      calls: [],
    })
  })

  const callNames = []
  walkObject(ast, node => {
    if (node.type !== 'CallExpression') return
    const name = calleeName(node)
    if (name) callNames.push(name)
  })
  for (const fn of functions) fn.calls = [...new Set(callNames.filter(name => name !== fn.name))]
  return functions
}

function reactComponents(ast, content, fallbackName, lineOffset = 0) {
  const components = []
  const moduleStart = ast?.span?.start || 1
  walkObject(ast, node => {
    if (node.type === 'ClassDeclaration') {
      const name = identifierName(node.identifier)
      const superName = identifierName(node.superClass) || identifierName(node.superClass?.property)
      const source = content.slice(Math.max(0, (node.span?.start || 1) - moduleStart), Math.min(content.length, (node.span?.end || content.length) - moduleStart))
      if (name && (/Component|PureComponent/.test(String(superName)) || /extends\s+(?:React\.)?(?:Pure)?Component/.test(source))) {
        components.push({ name, style: 'class', line: byteOffsetLine(content, node.span, moduleStart, lineOffset) })
      }
    }
    if (node.type === 'FunctionDeclaration') {
      const name = identifierName(node.identifier)
      if (name && /^[A-Z]/.test(name)) components.push({ name, style: 'function', line: byteOffsetLine(content, node.span, moduleStart, lineOffset) })
    }
    if (node.type === 'VariableDeclarator' && ['ArrowFunctionExpression', 'FunctionExpression'].includes(node.init?.type)) {
      const name = identifierName(node.id)
      if (name && /^[A-Z]/.test(name)) components.push({ name, style: 'function', line: byteOffsetLine(content, node.span, moduleStart, lineOffset) })
    }
  })
  if (components.length === 0 && /<[A-Za-z][^>]*>/.test(content) && /^[A-Z]/.test(fallbackName)) {
    components.push({ name: fallbackName, style: 'function', line: 1 + lineOffset })
  }
  return [...new Map(components.map(component => [component.name, component])).values()]
}

function vueProperties(content, api) {
  const values = new Set()
  if (api === 'props') {
    for (const match of content.matchAll(/\bprops\s*:\s*\[([^\]]*)]/g)) {
      for (const name of match[1].match(/['"]([\w$-]+)['"]/g) || []) values.add(name.slice(1, -1))
    }
    for (const match of content.matchAll(/\bprops\s*:\s*\{([\s\S]{0,1600}?)\n?\s*}/g)) {
      for (const item of match[1].matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)) values.add(item[1])
    }
    for (const match of content.matchAll(/defineProps(?:<([\s\S]{0,1200}?)>|\s*\(\s*\{([\s\S]{0,1200}?)\}\s*\))/g)) {
      for (const item of String(match[1] || match[2] || '').matchAll(/(?:^|[;,{\n])\s*([A-Za-z_$][\w$]*)\??\s*[:;]/g)) values.add(item[1])
    }
  }
  if (api === 'emits') {
    for (const match of content.matchAll(/(?:\$emit|\bemit)\s*\(\s*['"]([^'"]+)['"]/g)) values.add(match[1])
    for (const match of content.matchAll(/\bemits\s*:\s*\[([^\]]*)]/g)) {
      for (const name of match[1].match(/['"]([^'"]+)['"]/g) || []) values.add(name.slice(1, -1))
    }
  }
  return [...values]
}

function reactProps(content) {
  const props = new Set()
  for (const match of content.matchAll(/\b(?:props|this\.props)\.([A-Za-z_$][\w$]*)/g)) props.add(match[1])
  for (const match of content.matchAll(/(?:function\s+[A-Z]\w*|const\s+[A-Z]\w*\s*=)\s*\(\s*\{([^}]*)}/g)) {
    for (const item of match[1].split(',')) {
      const name = item.trim().match(/^([A-Za-z_$][\w$]*)/)?.[1]
      if (name) props.add(name)
    }
  }
  return [...props]
}

function componentTags(content) {
  const tags = new Set()
  for (const match of content.matchAll(/<([A-Za-z][\w.-]*)\b/g)) {
    const name = match[1]
    if (!HTML_TAGS.has(name.toLowerCase()) && (name.includes('-') || /^[A-Z]/.test(name))) tags.add(name)
  }
  return [...tags]
}

function httpCalls(content) {
  const calls = []
  for (const match of content.matchAll(/\b(?:axios|api|http|request)\.(get|post|put|delete|patch|head|options)\s*\(\s*(['"`])([^'"`]+)\2/gi)) {
    calls.push({ method: match[1].toUpperCase(), route: match[3], offset: match.index, snippet: match[0] })
  }
  for (const match of content.matchAll(/\bfetch\s*\(\s*(['"`])([^'"`]+)\1([\s\S]{0,240}?)(?:\)|$)/g)) {
    const method = match[3].match(/\bmethod\s*:\s*['"]([A-Za-z]+)['"]/)?.[1]?.toUpperCase() || 'GET'
    calls.push({ method, route: match[2], offset: match.index, snippet: match[0] })
  }
  return calls
}

function routeDefinitions(content) {
  const routes = []
  for (const match of content.matchAll(/\bpath\s*:\s*['"]([^'"]+)['"]/g)) {
    routes.push({ route: match[1], offset: match.index, snippet: match[0] })
  }
  for (const match of content.matchAll(/<Route\b[^>]*\bpath\s*=\s*(?:\{)?['"]([^'"]+)['"]/g)) {
    routes.push({ route: match[1], offset: match.index, snippet: match[0] })
  }
  return routes
}

function hookFacts(content) {
  const states = []
  for (const match of content.matchAll(/\bconst\s*\[\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*]\s*=\s*useState\b/g)) {
    states.push({ name: match[1], setter: match[2], offset: match.index, hook: 'useState' })
  }
  const hooks = new Set()
  for (const match of content.matchAll(/\b(use[A-Z][A-Za-z0-9_$]*)\s*\(/g)) hooks.add(match[1])
  return { states, hooks: [...hooks] }
}

function reactClassState(content) {
  const states = new Set()
  for (const match of content.matchAll(/\bthis\.state\.([A-Za-z_$][\w$]*)/g)) states.add(match[1])
  for (const match of content.matchAll(/\bstate\s*=\s*\{([\s\S]{0,1400}?)\n?\s*}/g)) {
    for (const item of match[1].matchAll(/(?:^|[,\n])\s*([A-Za-z_$][\w$]*)\s*:/g)) states.add(item[1])
  }
  return [...states]
}

function vueModelBindings(template, frameworkVersion) {
  const major = Number(String(frameworkVersion || '').match(/(\d+)\./)?.[1] || 3)
  const bindings = []
  for (const match of template.matchAll(/v-model(?::([A-Za-z_$][\w$-]*))?(?:\.[\w.-]+)*\s*=\s*['"]([^'"]+)['"]/g)) {
    const argument = match[1] || null
    bindings.push({
      expression: match[2],
      prop: argument || (major === 2 ? 'value' : 'modelValue'),
      event: major === 2 ? (argument ? `update:${argument}` : 'input') : `update:${argument || 'modelValue'}`,
      offset: match.index,
      syntax: major === 2 ? 'vue2' : 'vue3',
    })
  }
  return bindings
}

function observedVueFeatures(content, template) {
  const features = []
  if (/export\s+default\s+\{|Vue\.extend\s*\(/.test(content)) features.push('options-api')
  if (/\bsetup\s*\(|\b(?:ref|reactive|computed|watch)\s*\(/.test(content)) features.push('composition-api')
  if (/defineProps|defineEmits|defineExpose/.test(content)) features.push('script-setup')
  if (/defineModel\s*</.test(content) || /defineModel\s*\(/.test(content)) features.push('define-model')
  if (/\bmixins\s*:/.test(content)) features.push('mixins')
  if (/\|\s*[A-Za-z_$][\w$]*(?:\([^)]*\))?\s*(?:}}|$)/m.test(template)) features.push('filters')
  if (/\.sync\b/.test(template)) features.push('legacy-sync')
  return [...new Set(features)]
}

function observedReactFeatures(content) {
  const features = []
  if (/extends\s+(?:React\.)?(?:Pure)?Component/.test(content)) features.push('class-components')
  if (/\buse[A-Z][A-Za-z0-9_$]*\s*\(/.test(content)) features.push('hooks')
  if (/\bcreateRoot\s*\(/.test(content)) features.push('create-root')
  if (/['"]use client['"]|['"]use server['"]/.test(content)) features.push('server-components')
  if (/\b(?:useActionState|useOptimistic)\s*\(/.test(content)) features.push('actions')
  return [...new Set(features)]
}

function addHttpFacts(collector, unit, content, file, ownerId) {
  for (const call of httpCalls(content)) {
    const line = content.slice(0, call.offset).split('\n').length
    const route = normalizeRoute(call.route)
    const id = factId('api-call', unit.id, file, line, call.method, route)
    collector.addNode({
      id, type: 'api-call', label: `${call.method} ${route}`, file, line,
      method: call.method, route, protocol: 'http',
      evidence: [evidence(file, line, 'http-call', call.snippet)],
    })
    collector.addEdge(ownerId, id, 'calls-api', { evidence: [evidence(file, line, 'http-call', call.snippet)] })
  }
}

export async function extractJavaScriptFacts({ unit, projectRoot }) {
  const collector = createFactCollector(unit)
  const root = unit.abs_path
  const files = collectFiles(root, unit.framework)
  const filePaths = new Set(files)
  const functionsByName = new Map()
  const pendingCalls = []
  const componentsByName = new Map()
  const pendingComponentUses = []

  for (const absPath of files) {
    const file = normalizePath(relative(projectRoot, absPath))
    const content = readFileSync(absPath, 'utf8')
    const extension = extname(absPath)
    const fileId = collector.addFile(file)
    let scripts = [{ content, file: absPath, lineOffset: 0 }]
    let template = ''
    let templateLine = 1

    if (extension === '.vue') {
      try {
        const descriptor = parseSfc(content, { filename: absPath }).descriptor
        scripts = [descriptor.script, descriptor.scriptSetup].filter(Boolean).map(block => ({
          content: block.content,
          file: `${absPath}.${block.lang || 'js'}`,
          lineOffset: Math.max(0, Number(block.loc?.start?.line || 1) - 1),
        }))
        template = descriptor.template?.content || ''
        templateLine = Number(descriptor.template?.loc?.start?.line || 1)
      } catch (error) {
        collector.warnings.push(`${file}: Vue SFC 解析失败: ${error.message}`)
        scripts = []
      }
    }

    const astEntries = []
    for (const script of scripts) {
      const ast = await parseScript(script.content, script.file)
      if (!ast) {
        collector.warnings.push(`${file}: JavaScript/TypeScript AST 解析失败`)
        continue
      }
      astEntries.push({ ...script, ast })

      for (const item of extractImports(ast)) {
        const target = localImportTarget(item.source, absPath, filePaths)
        const line = byteOffsetLine(script.content, item.span, ast.span?.start || 1, script.lineOffset)
        const targetId = target
          ? collector.addFile(normalizePath(relative(projectRoot, target)))
          : factId('package', item.source)
        if (!target) collector.addNode({ id: targetId, type: 'package', label: item.source, package: item.source, confidence: 1 })
        collector.addEdge(fileId, targetId, 'imports', { evidence: [evidence(file, line, 'import', item.source)] })
      }

      for (const fn of extractFunctions(ast, script.content, script.lineOffset)) {
        const qualifiedName = fn.container ? `${fn.container}.${fn.name}` : fn.name
        const id = factId(fn.kind, unit.id, file, qualifiedName)
        collector.addNode({
          id, type: fn.kind, label: qualifiedName, qualified_name: qualifiedName, file, line: fn.line,
          evidence: [evidence(file, fn.line, 'declaration', qualifiedName)],
        })
        collector.addEdge(fileId, id, 'declares')
        const list = functionsByName.get(fn.name) || []
        list.push(id)
        functionsByName.set(fn.name, list)
        pendingCalls.push({ from: id, names: fn.calls, file, line: fn.line })
      }
    }

    let ownerId = fileId
    if (unit.framework === 'vue' && extension === '.vue') {
      const name = basename(file, '.vue')
      const componentId = factId('component', unit.id, file)
      const scriptContent = scripts.map(item => item.content).join('\n')
      const observedFeatures = observedVueFeatures(scriptContent, template)
      collector.addNode({
        id: componentId, type: 'component', label: name, qualified_name: name, file, line: 1,
        api_style: observedFeatures.includes('composition-api') ? 'composition' : 'options',
        observed_features: observedFeatures,
        evidence: [evidence(file, 1, 'vue-component')],
      })
      collector.addEdge(fileId, componentId, 'declares')
      componentsByName.set(name, componentId)
      ownerId = componentId

      for (const prop of vueProperties(scriptContent, 'props')) {
        const id = factId('prop', unit.id, file, prop)
        collector.addNode({ id, type: 'prop', label: prop, file, line: 1, confidence: 0.9 })
        collector.addEdge(componentId, id, 'accepts-prop', { confidence: 0.9 })
      }
      for (const eventName of vueProperties(scriptContent, 'emits')) {
        const id = factId('event', unit.id, file, eventName)
        collector.addNode({ id, type: 'event', label: eventName, file, line: 1, confidence: 0.9 })
        collector.addEdge(componentId, id, 'emits', { confidence: 0.9 })
      }
      for (const binding of vueModelBindings(template, unit.framework_version)) {
        const line = templateLine + template.slice(0, binding.offset).split('\n').length - 1
        const id = factId('model-binding', unit.id, file, line, binding.expression)
        collector.addNode({
          id, type: 'model-binding', label: binding.expression, file, line,
          expression: binding.expression, prop: binding.prop, event: binding.event, syntax: binding.syntax,
          evidence: [evidence(file, line, 'v-model', `${binding.prop} / ${binding.event}`)],
        })
        collector.addEdge(componentId, id, 'binds-model')
      }
      pendingComponentUses.push({ from: componentId, names: componentTags(template), file, line: templateLine })
    }

    if (unit.framework === 'react' && extension !== '.vue') {
      const ast = astEntries[0]?.ast
      const components = reactComponents(ast, content, basename(file, extension), 0)
      for (const component of components) {
        const componentId = factId('component', unit.id, file, component.name)
        collector.addNode({
          id: componentId, type: 'component', label: component.name, qualified_name: component.name,
          file, line: component.line, api_style: component.style,
          observed_features: observedReactFeatures(content),
          evidence: [evidence(file, component.line, 'react-component', component.name)],
        })
        collector.addEdge(fileId, componentId, 'declares')
        componentsByName.set(component.name, componentId)
        ownerId = componentId
        for (const prop of reactProps(content)) {
          const id = factId('prop', unit.id, file, component.name, prop)
          collector.addNode({ id, type: 'prop', label: prop, file, line: component.line, confidence: 0.85 })
          collector.addEdge(componentId, id, 'accepts-prop', { confidence: 0.85 })
        }
        const hooks = hookFacts(content)
        for (const state of hooks.states) {
          const line = content.slice(0, state.offset).split('\n').length
          const id = factId('state', unit.id, file, component.name, state.name)
          collector.addNode({ id, type: 'state', label: state.name, setter: state.setter, hook: state.hook, file, line })
          collector.addEdge(componentId, id, 'owns-state')
        }
        for (const stateName of reactClassState(content)) {
          const id = factId('state', unit.id, file, component.name, stateName)
          collector.addNode({ id, type: 'state', label: stateName, state_style: 'class', file, line: component.line, confidence: 0.9 })
          collector.addEdge(componentId, id, 'owns-state', { confidence: 0.9 })
        }
        pendingComponentUses.push({ from: componentId, names: componentTags(content), file, line: component.line })
      }
    }

    addHttpFacts(collector, unit, content, file, ownerId)
    const frameworkRoutes = /(?:from\s+['"](?:vue-router|react-router|react-router-dom)['"]|\bcreateRouter\s*\(|<Route\b)/.test(content)
      ? routeDefinitions(content)
      : []
    for (const routeInfo of frameworkRoutes) {
      const line = content.slice(0, routeInfo.offset).split('\n').length
      const route = normalizeRoute(routeInfo.route)
      const id = factId('route', unit.id, file, line, route)
      collector.addNode({ id, type: 'route', label: route, route, file, line, confidence: 0.8 })
      collector.addEdge(ownerId, id, 'renders-route', { confidence: 0.8, evidence: [evidence(file, line, 'route', routeInfo.snippet)] })
    }
  }

  for (const call of pendingCalls) {
    for (const name of call.names) {
      const targets = functionsByName.get(name) || []
      for (const target of targets) {
        collector.addEdge(call.from, target, 'calls', {
          confidence: targets.length === 1 ? 0.9 : 0.45,
          resolver: targets.length === 1 ? 'name-unique' : 'name-ambiguous',
          evidence: [evidence(call.file, call.line, 'call', name)],
        })
      }
    }
  }

  for (const use of pendingComponentUses) {
    for (const name of use.names) {
      const target = componentsByName.get(name) || componentsByName.get(name.replace(/-([a-z])/g, (_, char) => char.toUpperCase()))
      if (target) collector.addEdge(use.from, target, 'renders-component', { confidence: 0.9 })
      else {
        const referenceId = factId('component-reference', unit.id, name)
        collector.addNode({ id: referenceId, type: 'component-reference', label: name, confidence: 0.6 })
        collector.addEdge(use.from, referenceId, 'renders-component', { confidence: 0.6 })
      }
    }
  }

  return collector.result()
}
