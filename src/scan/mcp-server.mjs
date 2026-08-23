#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
import { exploreKnowledgeBase, formatExploreResult, tokenize, MODULES_ROOT } from './knowledge-retrieval.mjs'

const PROTOCOL_VERSION = '2024-11-05'
const EVIDENCE_QUERY_PATTERN = /怎么实现|如何实现|代码|调用链|字段.{0,20}(?:来源|从|哪个接口)|影响|如何修改|怎么改|改动/

const TOOL = {
  name: 'codewiki_explore',
  description: '优先检索 codewiki 的业务/技术语义文档，再沿 AST Navigation 扩展代码证据和相关语义。适合回答按钮行为、业务规则、状态、字段来源和改动影响。',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '用户问题或要检索的业务/技术概念' },
      module: { type: 'string', description: '可选，限定 docs/<module>' },
      detail: { type: 'string', enum: ['semantic', 'evidence'], description: '可选；省略时根据问题自动选择。实现、代码、调用链、字段来源和影响分析类问题使用 evidence，其余使用 semantic' },
      maxTopics: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
      projectPath: { type: 'string', description: '可选，项目根目录；默认 MCP 当前工作目录' },
    },
    required: ['query'],
    additionalProperties: false,
  },
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value })
}

function failure(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function fallbackRoots(projectRoot, moduleName) {
  const modulesRoot = join(projectRoot, MODULES_ROOT)
  if (moduleName) {
    const moduleDir = join(modulesRoot, moduleName)
    return existsSync(moduleDir) ? [moduleDir] : []
  }
  if (!existsSync(modulesRoot)) return []
  return readdirSync(modulesRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => join(modulesRoot, entry.name))
}

function fallbackFiles(root, output = []) {
  if (!existsSync(root)) return output
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const filePath = join(root, entry.name)
    if (entry.isDirectory()) fallbackFiles(filePath, output)
    else if (entry.name === 'index.yml' || entry.name.endsWith('.md')) output.push(filePath)
  }
  return output
}

function fallbackExplore({ query, module, projectRoot }) {
  const roots = fallbackRoots(projectRoot, module)
  if (roots.length === 0) return ''
  const patterns = [query, ...tokenize(query).filter(term => term.length >= 2)].slice(0, 8)
  try {
    const args = ['--line-number', '--ignore-case', '--max-count', '8', '--glob', '*.md', '--glob', 'index.yml']
    patterns.forEach(pattern => args.push('-e', pattern))
    args.push(...roots)
    const output = execFileSync('rg', args, { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1024 * 1024 }).trim()
    if (output) return `# codewiki 降级检索：${query}\n\n> MCP 结构化索引未命中，以下结果来自 navigation/index.yml 与 Markdown 文本检索。\n\n${output.slice(0, 12000)}`
  } catch {}

  const hits = []
  for (const filePath of roots.flatMap(root => fallbackFiles(root))) {
    const lines = readFileSync(filePath, 'utf8').split(/\r?\n/)
    lines.forEach((line, index) => {
      if (hits.length >= 40) return
      if (patterns.some(pattern => line.toLowerCase().includes(pattern.toLowerCase()))) hits.push(`${filePath}:${index + 1}:${line}`)
    })
  }
  return hits.length > 0
    ? `# codewiki 降级检索：${query}\n\n> MCP 结构化索引未命中，以下结果来自 navigation/index.yml 与 Markdown 文本检索。\n\n${hits.join('\n').slice(0, 12000)}`
    : ''
}

function validateToolArgs(args) {
  function invalid(message) {
    const error = new Error(message)
    error.code = 'INVALID_ARGUMENT'
    throw error
  }
  const allowed = new Set(['query', 'module', 'detail', 'maxTopics', 'projectPath'])
  const extra = Object.keys(args).filter(key => !allowed.has(key))
  if (extra.length > 0) invalid(`未知参数: ${extra.join(', ')}`)
  if (typeof args.query !== 'string' || !args.query.trim()) invalid('query 必须是非空字符串')
  if (args.module != null && typeof args.module !== 'string') invalid('module 必须是字符串')
  if (args.detail != null && !['semantic', 'evidence'].includes(args.detail)) invalid('detail 必须是 semantic 或 evidence')
  if (args.maxTopics != null && (!Number.isInteger(args.maxTopics) || args.maxTopics < 1 || args.maxTopics > 10)) invalid('maxTopics 必须是 1-10 的整数')
}

function resolveDetail(query, detail) {
  if (detail) return detail
  return EVIDENCE_QUERY_PATTERN.test(String(query || '')) ? 'evidence' : 'semantic'
}

function recordRetrieval(projectRoot, record) {
  try {
    const logPath = join(projectRoot, '.codewiki', 'retrieval.jsonl')
    mkdirSync(dirname(logPath), { recursive: true })
    appendFileSync(logPath, `${JSON.stringify(record)}\n`, 'utf8')
  } catch {}
}

function retrievalId(messageId, query, at) {
  const value = `${messageId}\0${query}\0${at}\0${process.pid}`
  return `ret_${createHash('sha1').update(value).digest('hex').slice(0, 16)}`
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0') return
  if (message.method === 'notifications/initialized' || message.method?.startsWith('notifications/')) return
  if (message.method === 'initialize') {
    result(message.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'codewiki', version: '1.0.0' },
    })
    return
  }
  if (message.method === 'ping') {
    result(message.id, {})
    return
  }
  if (message.method === 'tools/list') {
    result(message.id, { tools: [TOOL] })
    return
  }
  if (message.method === 'tools/call') {
    if (message.params?.name !== TOOL.name) {
      failure(message.id, -32602, `未知工具: ${message.params?.name || ''}`)
      return
    }
    try {
      const args = message.params.arguments || {}
      validateToolArgs(args)
      const projectRoot = resolve(args.projectPath || process.env.CODEWIKI_PROJECT_ROOT || process.cwd())
      const detail = resolveDetail(args.query, args.detail)
      const startedAt = performance.now()
      const explored = exploreKnowledgeBase({
        query: args.query,
        module: args.module,
        detail,
        maxTopics: args.maxTopics,
        projectRoot,
      })
      const fallback = explored.found ? '' : fallbackExplore({ query: args.query, module: args.module, projectRoot })
      const text = fallback || formatExploreResult(explored)
      const latencyMs = Number((performance.now() - startedAt).toFixed(3))
      const at = new Date().toISOString()
      const knowledgeIds = [...new Set(explored.modules.flatMap(item => item.topics.map(topic => topic.id)))]
      const evidenceIds = [...new Set(explored.modules.flatMap(item => item.evidence.map(evidence => evidence.id)))]
      const modules = explored.modules.map(item => item.module)
      const stale = explored.modules.some(item => item.stale)
      const traceId = retrievalId(message.id, args.query, at)
      const trace = {
        retrieval_id: traceId,
        at,
        query: args.query,
        module: args.module || modules[0] || null,
        modules,
        found: explored.found,
        fallback: Boolean(fallback),
        topic_count: explored.modules.reduce((sum, module) => sum + module.topics.length, 0),
        evidence_count: explored.modules.reduce((sum, module) => sum + module.evidence.length, 0),
        knowledge_ids: knowledgeIds,
        evidence_ids: evidenceIds,
        overlay_knowledge_ids: knowledgeIds.filter(id => id.startsWith('kb-case:')),
        detail,
        stale,
        latency_ms: latencyMs,
      }
      recordRetrieval(projectRoot, trace)
      result(message.id, {
        content: [{ type: 'text', text }],
        structuredContent: {
          retrieval_id: traceId,
          query: args.query,
          module: trace.module,
          modules,
          knowledge_ids: knowledgeIds,
          evidence_ids: evidenceIds,
          detail,
          stale,
          latency_ms: latencyMs,
          fallback: Boolean(fallback),
        },
      })
    } catch (error) {
      const args = message.params.arguments || {}
      const projectRoot = resolve(typeof args.projectPath === 'string' ? args.projectPath : process.env.CODEWIKI_PROJECT_ROOT || process.cwd())
      const fallback = error.code !== 'INVALID_ARGUMENT' && typeof args.query === 'string' && args.query.trim()
        ? fallbackExplore({ query: args.query, module: typeof args.module === 'string' ? args.module : '', projectRoot })
        : ''
      if (fallback) {
        const at = new Date().toISOString()
        const traceId = retrievalId(message.id, args.query, at)
        const detail = resolveDetail(args.query, args.detail)
        recordRetrieval(projectRoot, {
          retrieval_id: traceId,
          at,
          query: args.query,
          module: args.module || null,
          modules: args.module ? [args.module] : [],
          found: false,
          fallback: true,
          error: error.message,
          topic_count: 0,
          evidence_count: 0,
          knowledge_ids: [],
          evidence_ids: [],
          overlay_knowledge_ids: [],
          detail,
          stale: false,
        })
        result(message.id, {
          content: [{ type: 'text', text: fallback }],
          structuredContent: {
            retrieval_id: traceId,
            query: args.query,
            module: args.module || null,
            modules: args.module ? [args.module] : [],
            knowledge_ids: [],
            evidence_ids: [],
            detail,
            stale: false,
            fallback: true,
            degraded_from_error: true,
          },
        })
      } else {
        result(message.id, { content: [{ type: 'text', text: `codewiki 检索失败：${error.message}` }], isError: true })
      }
    }
    return
  }
  failure(message.id, -32601, `不支持的方法: ${message.method}`)
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (!line) continue
    try { Promise.resolve(handle(JSON.parse(line))).catch(error => process.stderr.write(`[codewiki-mcp] ${error.message}\n`)) }
    catch { failure(null, -32700, 'JSON 解析失败') }
  }
})
