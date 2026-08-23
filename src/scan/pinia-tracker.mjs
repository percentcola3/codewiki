#!/usr/bin/env node
/**
 * pinia-tracker.mjs — 抽取 Pinia store 的 state/getters/actions 结构
 *
 * 输入：目标目录（.ts/.js/.mjs 源文件）
 * 输出：navigation/_intermediate/pinia-stores.json
 *
 * 用法：node pinia-tracker.mjs <target-dir> [--output <base-dir>]
 *
 * 首版能力：
 * - Options API：defineStore('id', { state, getters, actions })
 *   - state: () => ({ ... }) 或 state() { return {...} } → 抽字段名
 *   - actions: { foo() {...} } → 抽 action 名
 *   - getters: { foo: (state) => ... } → 抽 getter 名
 * - Setup Style：defineStore('id', () => { const x = ref(...); return { x } })
 *   - 抽 const x = ref/reactive/computed(...) 的字段名（type 首版留空，后续升级）
 *   - 抽 function xxx() 作为 action
 *
 * 不做（首版）：跨文件字段级读写点匹配（留给 field-lineage.mjs 融合阶段）
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import { join, resolve, extname, relative } from 'node:path'

const args = process.argv.slice(2)
const targetDir = args[0]
if (!targetDir) {
  console.error('Usage: node pinia-tracker.mjs <target-dir> [--output <base-dir>]')
  process.exit(1)
}
const outputFlagIdx = args.indexOf('--output')
const positionalOutput = args[1] && !args[1].startsWith('--') ? args[1] : null
const outputBaseDir = outputFlagIdx !== -1 ? args[outputFlagIdx + 1] : positionalOutput

const absTarget = resolve(targetDir)
if (!existsSync(absTarget)) {
  console.error(`Target directory not found: ${absTarget}`)
  process.exit(1)
}

const EXCLUDE_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.doc', 'coverage', '__tests__'])
const VALID_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs'])

let swc
async function initParser() {
  try {
    swc = await import('@swc/core')
    swc.parseSync('const x: number = 1', { syntax: 'typescript', target: 'es2022' })
  } catch {
    try {
      swc = await import('@swc/wasm')
      swc.parseSync('const x: number = 1', { syntax: 'typescript', target: 'es2022' })
    } catch {
      console.error('FATAL: Neither @swc/core nor @swc/wasm available')
      process.exit(1)
    }
  }
}

function parseScript(code, filePath) {
  const isTsx = filePath.endsWith('.tsx') || filePath.endsWith('.jsx')
  try {
    return swc.parseSync(code, { syntax: 'typescript', tsx: isTsx, target: 'es2022', comments: false })
  } catch { return null }
}

function collectFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (EXCLUDE_DIRS.has(entry)) continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) collectFiles(full, out)
    else if (VALID_EXTS.has(extname(entry))) out.push(full)
  }
  return out
}

// SWC span 是 byte offset 起点。项目里字段级溯源需要行号，一次性建 line map。
function buildLineMap(code) {
  const lines = [0]
  const bytes = Buffer.from(code, 'utf8')
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 10) lines.push(i + 1)
  }
  return lines
}
function offsetToLine(lineMap, offset, spanOffset = 0) {
  const target = offset - spanOffset
  let lo = 0, hi = lineMap.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1
    if (lineMap[mid] <= target) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

// SWC span 起点通常不是 0（Module 有个基准偏移），需要用 module.span.start 校正
function makeLineFn(code, moduleSpanStart) {
  const map = buildLineMap(code)
  return (span) => (span?.start != null ? offsetToLine(map, span.start, moduleSpanStart) : null)
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  visit(node)
  for (const key of Object.keys(node)) {
    const val = node[key]
    if (Array.isArray(val)) for (const child of val) walk(child, visit)
    else if (val && typeof val === 'object' && val.type) walk(val, visit)
  }
}

// 从 ObjectExpression 的 property list 里按 key 名拿 value 表达式
function getObjectProp(objExpr, keyName) {
  if (objExpr?.type !== 'ObjectExpression') return null
  for (const p of objExpr.properties || []) {
    if (p.type !== 'KeyValueProperty' && p.type !== 'MethodProperty') continue
    const k = p.key
    const kn = k?.value ?? k?.name ?? null
    if (kn === keyName) return { prop: p, value: p.value ?? null }
  }
  return null
}

// 抽取 state 返回的 ObjectExpression 里的字段
function extractStateFields(stateProp, lineOf) {
  const fields = []
  if (!stateProp) return fields
  // Case 1: state: () => ({...})
  const val = stateProp.value
  let objExpr = null
  if (val?.type === 'ArrowFunctionExpression') {
    // body 可能是 ObjectExpression 或 ParenthesisExpression 包裹
    let body = val.body
    if (body?.type === 'ParenthesisExpression') body = body.expression
    if (body?.type === 'ObjectExpression') objExpr = body
    else if (body?.type === 'BlockStatement') {
      // Case 2: state: () => { return {...} }
      for (const stmt of body.stmts || []) {
        if (stmt.type === 'ReturnStatement' && stmt.argument?.type === 'ObjectExpression') {
          objExpr = stmt.argument
          break
        }
      }
    }
  } else if (stateProp.prop?.type === 'MethodProperty') {
    // Case 3: state() { return {...} }
    const body = stateProp.prop.function?.body
    for (const stmt of body?.stmts || []) {
      if (stmt.type === 'ReturnStatement' && stmt.argument?.type === 'ObjectExpression') {
        objExpr = stmt.argument
        break
      }
    }
  }
  if (!objExpr) return fields
  for (const p of objExpr.properties || []) {
    if (p.type !== 'KeyValueProperty' && p.type !== 'MethodProperty') continue
    const name = p.key?.value ?? p.key?.name ?? null
    if (!name) continue
    fields.push({ name, line: lineOf(p.key?.span || p.span) })
  }
  return fields
}

// 抽取 actions/getters ObjectExpression 里的成员名
function extractMemberNames(prop, lineOf) {
  const out = []
  const objExpr = prop?.value
  if (objExpr?.type !== 'ObjectExpression') return out
  for (const p of objExpr.properties || []) {
    if (p.type !== 'KeyValueProperty' && p.type !== 'MethodProperty') continue
    const name = p.key?.value ?? p.key?.name ?? null
    if (!name) continue
    out.push({ name, line: lineOf(p.key?.span || p.span) })
  }
  return out
}

// Setup Style：从 ArrowFunction/FunctionExpression body 里抽 const x = ref/reactive/computed(...) 和 function 声明
const REACTIVE_HELPERS = new Set(['ref', 'reactive', 'shallowRef', 'shallowReactive', 'computed'])
function extractSetupStyle(configArg, lineOf) {
  const body = configArg.body
  if (!body) return { fields: [], getters: [], actions: [] }
  const stmts = body.type === 'BlockStatement' ? (body.stmts || []) : []
  const definitions = new Map()
  const returned = new Map()

  for (const stmt of stmts) {
    // const foo = ref(...) / computed(...)
    if (stmt.type === 'VariableDeclaration') {
      for (const d of stmt.declarations || []) {
        const varName = d.id?.value ?? d.id?.name ?? null
        if (!varName) continue
        const line = lineOf(d.id?.span || d.span)
        if (d.init?.type === 'CallExpression') {
          const calleeName = d.init.callee?.value ?? d.init.callee?.name ?? null
          if (REACTIVE_HELPERS.has(calleeName)) {
            const kind = calleeName === 'computed' ? 'getter' : 'field'
            definitions.set(varName, { kind, name: varName, line, ...(kind === 'field' && { reactive_kind: calleeName }) })
          }
        } else if (d.init?.type === 'ArrowFunctionExpression' || d.init?.type === 'FunctionExpression') {
          definitions.set(varName, { kind: 'action', name: varName, line })
        }
      }
    }
    // function xxx() {...}
    if (stmt.type === 'FunctionDeclaration') {
      const name = stmt.identifier?.value ?? stmt.identifier?.name ?? null
      if (name) definitions.set(name, { kind: 'action', name, line: lineOf(stmt.identifier?.span || stmt.span) })
    }
    if (stmt.type === 'ReturnStatement' && stmt.argument?.type === 'ObjectExpression') {
      for (const prop of stmt.argument.properties || []) {
        if (prop.type === 'Identifier') {
          returned.set(prop.value, prop.value)
        } else if (prop.type === 'KeyValueProperty' && prop.value?.type === 'Identifier') {
          const publicName = prop.key?.value ?? prop.key?.name ?? prop.value.value
          returned.set(prop.value.value, publicName)
        }
      }
    }
  }

  const fields = []
  const getters = []
  const actions = []
  for (const [sourceName, publicName] of returned) {
    const def = definitions.get(sourceName)
    if (!def) continue
    const item = { ...def, name: publicName }
    delete item.kind
    if (def.kind === 'field') fields.push(item)
    else if (def.kind === 'getter') getters.push(item)
    else if (def.kind === 'action') actions.push(item)
  }
  return { fields, getters, actions }
}

function analyzeFile(code, filePath, ast) {
  const stores = []
  const moduleOffset = ast.span?.start ?? 0
  const lineOf = makeLineFn(code, moduleOffset)
  walk(ast, (node) => {
    if (node.type !== 'CallExpression') return
    const calleeName = node.callee?.value ?? node.callee?.name ?? null
    if (calleeName !== 'defineStore') return
    const rawArgs = (node.arguments || []).map(a => a.expression || a)
    if (rawArgs.length < 2) return
    const idArg = rawArgs[0]
    const configArg = rawArgs[1]
    const storeId = idArg?.type === 'StringLiteral' ? idArg.value : null
    if (!storeId) return
    const line = lineOf(node.span)

    // Options API: config is ObjectExpression
    if (configArg?.type === 'ObjectExpression') {
      const stateProp = getObjectProp(configArg, 'state')
      const actionsProp = getObjectProp(configArg, 'actions')
      const gettersProp = getObjectProp(configArg, 'getters')
      stores.push({
        id: storeId,
        file: filePath,
        style: 'options',
        line,
        state_fields: extractStateFields(stateProp, lineOf),
        actions: extractMemberNames(actionsProp, lineOf),
        getters: extractMemberNames(gettersProp, lineOf),
      })
      return
    }
    // Setup Style: config is ArrowFunctionExpression / FunctionExpression
    if (configArg?.type === 'ArrowFunctionExpression' || configArg?.type === 'FunctionExpression') {
      const { fields, getters, actions } = extractSetupStyle(configArg, lineOf)
      stores.push({
        id: storeId,
        file: filePath,
        style: 'setup',
        line,
        state_fields: fields,
        actions,
        getters,
      })
      return
    }
    // Unknown config form
    stores.push({ id: storeId, file: filePath, style: 'unknown', line, state_fields: [], actions: [], getters: [] })
  })
  return stores
}

async function main() {
  await initParser()
  const files = collectFiles(absTarget)
  console.log(`[pinia-tracker] Scanning ${files.length} files under ${targetDir}`)
  const allStores = []
  let scanned = 0
  for (const abs of files) {
    scanned++
    let code
    try { code = readFileSync(abs, 'utf-8') } catch { continue }
    if (!code.includes('defineStore')) continue // fast reject
    const ast = parseScript(code, abs)
    if (!ast) continue
    const stores = analyzeFile(code, relative(absTarget, abs), ast)
    allStores.push(...stores)
  }
  const outBase = outputBaseDir ? join(resolve(outputBaseDir), 'navigation') : join(absTarget, '.doc', 'navigation')
  const intermediateDir = join(outBase, '_intermediate')
  mkdirSync(intermediateDir, { recursive: true })
  const output = {
    metadata: {
      generated_at: new Date().toISOString(),
      target_dir: targetDir,
      version: '1.0',
      producer: 'pinia-tracker',
      contract: 'candidate-evidence-only',
      scanned_files: scanned,
      matched_stores: allStores.length,
    },
    stores: allStores,
  }
  writeFileSync(join(intermediateDir, 'pinia-stores.json'), JSON.stringify(output, null, 2))
  console.log(`[pinia-tracker] Written ${allStores.length} store(s) to _intermediate/pinia-stores.json`)
}

main().catch(e => { console.error('[pinia-tracker] Failed:', e); process.exit(1) })
