#!/usr/bin/env node
/**
 * data-shape-tracer.mjs — 沿调用链追踪 payload 形状演变 + 抽取 API endpoints
 *
 * 输入：func-dependencies.json（nav-parser 已产出，含 params 类型）
 *       + 各源文件用于 endpoint 抽取（http / ipc / ws / broadcast）
 *
 * 输出：navigation/_intermediate/api-payload-shapes.json
 *       仅传入 --legacy-copy 时额外写 navigation/data-shapes.json
 *
 * v3.6 变化（T2c）：
 * - 输出目标从 data-shapes.json 迁移到 _intermediate/api-payload-shapes.json
 * - 新增 endpoints_by_file section：每个源文件里出现的 API 调用位置（含 protocol / method / endpoint / line）
 * - 供 field-lineage.mjs 融合"store action 所在文件 → 该文件调用的接口"，从而把接口原始字段接到组件字段
 *
 * 用法：node data-shape-tracer.mjs <target> [<output-base-dir>] [--legacy-copy]
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, statSync } from 'node:fs'
import { join, relative, extname, resolve } from 'node:path'

const args = process.argv.slice(2)
const targetDir = args[0]
if (!targetDir) {
  console.error('Usage: node data-shape-tracer.mjs <target-directory> [<output-base-dir>]')
  process.exit(1)
}
const absTarget = resolve(targetDir)
const outputFlagIdx = args.indexOf('--output')
const positionalArgs = args.slice(1).filter(arg => !arg.startsWith('--'))
const outputBaseDir = outputFlagIdx !== -1 ? resolve(args[outputFlagIdx + 1]) : positionalArgs[0] ? resolve(positionalArgs[0]) : null
const writeLegacyCopy = args.includes('--legacy-copy')
if (!existsSync(absTarget)) {
  console.error(`Target directory not found: ${absTarget}`)
  process.exit(1)
}

const navDir = outputBaseDir ? join(outputBaseDir, 'navigation') : join(absTarget, '.doc', 'navigation')
const intermediateDir = join(navDir, '_intermediate')

function loadJson(filename) {
  const p = join(navDir, filename)
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, 'utf-8'))
}

// --- Endpoint extraction (T2c) ---
// Fine-grained API call detection: http / ipc / ws / broadcast.
// Each pattern captures method + endpoint from a single line context.
const ENDPOINT_PATTERNS = [
  // axios / api / http helper style: axios.get('/api/x') / api.post('...')
  { protocol: 'http', re: /\b(?:axios|api|http|request)\.(get|post|put|delete|patch|head|options)\s*\(\s*['"`]([^'"`]+)['"`]/gi, kind: 'method_endpoint' },
  // fetch('/api/x', ...) — method defaults to GET unless body/init specifies
  { protocol: 'http', re: /\bfetch\s*\(\s*['"`]([^'"`]+)['"`]/g, kind: 'endpoint_only', defaultMethod: 'GET' },
  // Electron IPC renderer: ipcRenderer.invoke / send / sendSync
  { protocol: 'ipc', re: /\bipcRenderer\.(invoke|send|sendSync)\s*\(\s*['"`]([^'"`]+)['"`]/g, kind: 'method_endpoint' },
  // Electron IPC main: ipcMain.handle / on / handleOnce
  { protocol: 'ipc', re: /\bipcMain\.(handle|on|handleOnce|removeHandler)\s*\(\s*['"`]([^'"`]+)['"`]/g, kind: 'method_endpoint' },
  // Socket.io / eventemitter emit / on
  { protocol: 'ws', re: /\b(?:socket|ws|io)\.(emit|on|off|once)\s*\(\s*['"`]([^'"`]+)['"`]/gi, kind: 'method_endpoint' },
  // BroadcastChannel .postMessage — channel is the constructor arg (nav-parser tracks that)
  { protocol: 'broadcast', re: /\.postMessage\s*\(/g, kind: 'no_endpoint' },
]

function offsetToLine(code, offset) {
  let line = 1
  for (let i = 0; i < offset && i < code.length; i++) {
    if (code.charCodeAt(i) === 10) line++
  }
  return line
}

function extractEndpointsFromFile(absPath) {
  let code
  try { code = readFileSync(absPath, 'utf-8') } catch { return [] }
  const results = []
  for (const pattern of ENDPOINT_PATTERNS) {
    if (pattern.kind === 'no_endpoint') continue
    let m
    pattern.re.lastIndex = 0
    while ((m = pattern.re.exec(code)) !== null) {
      let method, endpoint
      if (pattern.kind === 'method_endpoint') {
        method = m[1].toUpperCase()
        endpoint = m[2]
      } else {
        method = pattern.defaultMethod || null
        endpoint = m[1]
      }
      if (!endpoint) continue
      // Skip obvious non-endpoint strings (logs, alerts, imports)
      if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
        // absolute URL — keep, but flag
      } else if (endpoint.length > 200) {
        continue
      }
      results.push({
        protocol: pattern.protocol,
        method,
        endpoint,
        line: offsetToLine(code, m.index),
      })
    }
  }
  // dedupe: same protocol + method + endpoint on same line collapses to one entry
  const seen = new Set()
  return results.filter(r => {
    const k = `${r.protocol}|${r.method}|${r.endpoint}|${r.line}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

const funcDeps = loadJson('func-dependencies.json')
if (!funcDeps) {
  console.error('Missing func-dependencies.json — run nav-parser first')
  process.exit(1)
}
const allFunctions = funcDeps.data?.functions || []
const fileGraph = loadJson('file-graph.json')
const byName = new Map(allFunctions.map(f => [f.name, f]))

const TRANSFORM_NAME_RE = /(?:^|[A-Z_])(format|normalize|pre[A-Z]|transform|serialize|deserialize|map|adapt|convert|sanitize|preFormat|encode|decode)/i
const ENTRY_HINTS = [
  // IPC/Bridge 提交侧
  /^(submit|invoke|send|dispatch|emit|fire|publish|notify|broadcast)/i,
  // HTTP API 侧
  /^(get|fetch|post|put|delete|query|load|request)/i,
  // WS/事件订阅侧
  /^(on[A-Z]|handle[A-Z])/,
]

function isEntry(fn) {
  if (!fn.name) return false
  if (fn.role === 'source') return true
  return ENTRY_HINTS.some(re => re.test(fn.name))
}

function shapeOf(fn) {
  // 用参数名+类型简略表达 payload shape
  const params = fn.params || []
  if (params.length === 0) return '()'
  return params.map(p => p.type ? `${p.name}: ${p.type}` : p.name).join(', ')
}

function classify(fn) {
  if (TRANSFORM_NAME_RE.test(fn.name)) return 'transform'
  if (fn.role === 'source') return 'source'
  if (/^on[A-Z]|handle[A-Z]/.test(fn.name)) return 'consumer'
  if (/(submit|invoke|send|dispatch|emit|fire|publish|broadcast)/i.test(fn.name)) return 'producer'
  return fn.role || 'unknown'
}

function traceFrom(entry, maxDepth = 4) {
  const hops = []
  const seen = new Set()
  function walk(name, depth) {
    if (depth > maxDepth) return
    const fn = byName.get(name)
    if (!fn || seen.has(name)) return
    seen.add(name)
    hops.push({
      step: hops.length + 1,
      function: fn.name,
      file: fn.file,
      role: classify(fn),
      shape: shapeOf(fn),
      depth,
    })
    const calls = fn.calls || []
    for (const callee of calls) {
      const cFn = byName.get(callee)
      if (!cFn) continue
      // 只追踪 transform / 状态写入 / 同模块下游
      const isTransform = TRANSFORM_NAME_RE.test(callee)
      const sameDir = cFn.file && fn.file && cFn.file.split('/').slice(0, -1).join('/') === fn.file.split('/').slice(0, -1).join('/')
      if (isTransform || sameDir || cFn.role === 'transform') {
        walk(callee, depth + 1)
      }
    }
  }
  walk(entry.name, 0)
  // 标注 shape 变化
  for (let i = 1; i < hops.length; i++) {
    if (hops[i].role === 'transform') {
      hops[i].shape_diff = `经 ${hops[i].function} 转换`
    } else if (hops[i].shape !== hops[i - 1].shape) {
      hops[i].shape_diff = `参数变化：${hops[i - 1].shape} → ${hops[i].shape}`
    }
  }
  return hops
}

function main() {
  const entries = allFunctions.filter(isEntry).filter(fn => fn.params && fn.params.length > 0)
  const shapes = []
  for (const entry of entries) {
    const hops = traceFrom(entry)
    if (hops.length < 2) continue
    shapes.push({
      entry_function: entry.name,
      entry_file: entry.file,
      entry_role: classify(entry),
      confidence: 'candidate',
      evidence_basis: 'func-dependencies.json params and call names',
      hops,
    })
  }

  // T2c: endpoints_by_file — 每个源文件里的 API 调用位置
  // field-lineage.mjs 融合时会用 store action 所在文件 → 调用的接口（由此接到组件字段绑定）
  // func-dependencies 只包含有可识别导出的文件；endpoint 也常出现在纯副作用
  // 模块或内联 store 中，因此以 file-graph 节点补全扫描集合。
  const filesInFuncDeps = new Set([
    ...allFunctions.map(f => f.file).filter(Boolean),
    ...(fileGraph?.data?.nodes || []).map(node => node.id).filter(Boolean),
  ])
  const endpointsByFile = {}
  for (const relPath of filesInFuncDeps) {
    const targetRelative = resolve(absTarget, relPath)
    const projectRelative = resolve(process.cwd(), relPath)
    const absPath = existsSync(targetRelative) ? targetRelative : projectRelative
    if (!existsSync(absPath)) continue
    const eps = extractEndpointsFromFile(absPath)
    if (eps.length > 0) endpointsByFile[relPath] = eps
  }

  const output = {
    metadata: {
      generated_at: new Date().toISOString(),
      target_dir: targetDir,
      base_commit: funcDeps.metadata?.base_commit || null,
      version: '2.0.0',
      producer: 'data-shape-tracer',
      signal_contract: 'candidate-evidence-only',
      total_entries: entries.length,
      shapes_with_chains: shapes.length,
      files_with_endpoints: Object.keys(endpointsByFile).length,
      total_endpoints: Object.values(endpointsByFile).reduce((sum, arr) => sum + arr.length, 0),
    },
    known_limitations: [
      'shape 仅基于函数参数名+类型，未做跨文件类型解析',
      'BFS 深度限制为 4 跳',
      '只追踪 transform 命名的函数和同目录下的 callee',
      '未识别匿名函数和闭包内的转换',
      'endpoints_by_file 精度到文件级（未按函数体归属，需 field-lineage.mjs 融合 pinia-stores.json 才能定位到 store action）',
      '正则匹配 API 调用不覆盖：动态 endpoint 拼接 `` `${base}/api/x` ``、包装函数 `myApi()` 内的隐式调用',
    ],
    shapes,
    endpoints_by_file: endpointsByFile,
  }

  mkdirSync(intermediateDir, { recursive: true })
  const primaryPath = join(intermediateDir, 'api-payload-shapes.json')
  writeFileSync(primaryPath, JSON.stringify(output, null, 2))
  console.log(`[data-shape-tracer] Written primary to ${primaryPath}`)
  console.log(`  Entry candidates: ${entries.length}`)
  console.log(`  Shape chains:     ${shapes.length}`)
  console.log(`  Files w/ endpoints: ${Object.keys(endpointsByFile).length}`)
  console.log(`  Total endpoints:  ${output.metadata.total_endpoints}`)

  if (writeLegacyCopy) {
    const legacyPath = join(navDir, 'data-shapes.json')
    writeFileSync(legacyPath, JSON.stringify({ ...output, _deprecated_note: 'moved to _intermediate/api-payload-shapes.json' }, null, 2))
    console.log(`[data-shape-tracer] Written legacy copy to ${legacyPath}`)
  }
}

main()
