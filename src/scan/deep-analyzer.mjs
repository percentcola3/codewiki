#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, renameSync, unlinkSync, appendFileSync } from 'node:fs'
import { join, relative, extname, basename, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { calculateKnowledgeConfidence, deriveNavigationCases } from './knowledge-confidence.mjs'
import { knowledgeRootRelative, loadProjectConfig, statePath } from '../config.mjs'
import { buildUsageReport } from '../report.mjs'

const args = process.argv.slice(2)
const validateMode = args.includes('--validate')
const targetDir = args[0]
if (!targetDir) {
  console.error('Error: Target path is required.')
  console.error('Usage: node deep-analyzer.mjs <target-directory> [<output-base-dir>] [--validate]')
  process.exit(1)
}
const absTarget = resolve(targetDir)
const outputFlagIdx = args.indexOf('--output')
const positionalOutput = args[1] && !args[1].startsWith('--') ? args[1] : null
const outputBaseDir = outputFlagIdx !== -1 ? resolve(args[outputFlagIdx + 1]) : positionalOutput ? resolve(positionalOutput) : null
if (!existsSync(absTarget)) {
  console.error(`Target directory not found: ${absTarget}`)
  process.exit(1)
}

const EXCLUDE_DIRS = new Set(['node_modules', 'dist', '.doc', '.git', '__tests__', '__test__'])
const VALID_EXTS = new Set(['.vue', '.ts', '.js', '.tsx', '.jsx', '.java', '.go'])

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
      results.push({ absPath: fullPath, relPath: relative(baseDir, fullPath) })
    }
  }
  return results
}

// --- Load Layer 3 data ---
const navDir = outputBaseDir ? join(outputBaseDir, 'navigation') : join(absTarget, '.doc', 'navigation')
function loadJson(filename) {
  const p = join(navDir, filename)
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, 'utf-8'))
}

const fileGraph = loadJson('file-graph.json')
const funcDeps = loadJson('func-dependencies.json')
const compRefs = loadJson('component-refs.json')
const clustersData = loadJson('clusters.json')

if (!funcDeps) {
  console.error('Missing func-dependencies.json — run nav-parser first')
  process.exit(1)
}
if (!clustersData) {
  console.error('Missing clusters.json — run graph-cluster first (new order: nav-parser -> graph-cluster -> deep-analyzer)')
  process.exit(1)
}

// --- Source file cache ---
const sourceFiles = collectFiles(absTarget)
const sourceCache = new Map()
for (const f of sourceFiles) {
  try { sourceCache.set(f.relPath, readFileSync(f.absPath, 'utf-8')) }
  catch { /* skip unreadable files */ }
}

const allFunctions = funcDeps.data?.functions || []
const allComponents = compRefs?.data?.components || []
const nodeScores = clustersData?.node_scores || {}
const hubFiles = new Set((clustersData?.hubs || []).map(h => h.file))
const baseCommit = fileGraph?.metadata?.base_commit || null
const graphEdges = fileGraph?.data?.edges || []

// --- Helpers ---
function funcByName(name) { return allFunctions.find(f => f.name === name) }
function funcByFile(file) { return allFunctions.filter(f => f.file === file) }
function sourceOf(file) { return sourceCache.get(file) || '' }

function collectMarkdownFiles(dir) {
  const results = []
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) }
  catch { return results }
  for (const entry of entries) {
    if (EXCLUDE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...collectMarkdownFiles(fullPath))
    } else if (extname(entry.name) === '.md') {
      results.push(fullPath)
    }
  }
  return results
}

// ============================================================
// Per-file confidence scoring (Layer 1/Layer 2)
// ============================================================
const WEAK_PHRASES = ['通常', '一般而言', '一般来说', '应该是', '可能会', '推测', '大概', '也许', '估计', '或许', '貌似']
const PLACEHOLDER_PATTERNS = [
  /待业务确认/g, /待用户确认/g, /待确认/g, /\bTBD\b/g, /\bTODO\b/g, /未在代码中找到证据/g,
]
const UNVERIFIED_LINE_PATTERNS = [/⚠️\s*未验证调用链/, /未验证调用链/]
const CONFIDENCE_GRADES = [
  { grade: 'A', min: 0.90 },
  { grade: 'B', min: 0.70 },
  { grade: 'C', min: 0.50 },
  { grade: 'D', min: 0.30 },
  { grade: 'E', min: 0 },
]

function gradeFromRatio(ratio) {
  if (ratio == null) return 'N_A'
  for (const item of CONFIDENCE_GRADES) if (ratio >= item.min) return item.grade
  return 'E'
}

function lineFromOffset(content, offset) {
  return content.slice(0, offset).split(/\r?\n/).length
}

function analyzeMarkdownClaims(content) {
  const weakHits = []
  for (const phrase of WEAK_PHRASES) {
    const re = new RegExp(phrase, 'g')
    let match
    while ((match = re.exec(content)) !== null) {
      weakHits.push({ phrase, line: lineFromOffset(content, match.index) })
    }
  }
  const placeholders = []
  for (const pattern of PLACEHOLDER_PATTERNS) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(content)) !== null) {
      placeholders.push({ token: match[0], line: lineFromOffset(content, match.index) })
    }
  }
  const unverified = []
  const lines = content.split(/\r?\n/)
  lines.forEach((line, i) => {
    if (UNVERIFIED_LINE_PATTERNS.some(re => re.test(line))) {
      unverified.push({ text: line.trim().slice(0, 200), line: i + 1 })
    }
  })
  return { weakHits, placeholders, unverified }
}

function classifyLayer(relPath) {
  const parts = relPath.replace(/\\/g, '/').split('/')
  const known = parts.find(part => ['product', 'developer', 'frontend', 'quality', 'navigation', 'revisions'].includes(part))
  if (known) return known === 'frontend' ? 'developer' : known
  // fallback if relPath is like "product/foo.md"
  return parts[0] || 'other'
}

function moduleFromOutputDir(dir) {
  if (!dir) return null
  return basename(dir)
}

function extractFileLineReferences(content) {
  const refs = []
  const pattern = /(?<![\w:/.-])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:vue|ts|js|tsx|jsx|mjs|cjs|java|go|md|json|ya?ml)):(\d+)\b/g
  let match
  while ((match = pattern.exec(content)) !== null) {
    refs.push({ file: match[1], line: Number(match[2]), reference: `${match[1]}:${match[2]}` })
  }
  return refs
}

// 智能路径解析：尝试在多个常见目录中查找文件
function resolveFilePath(relativePath, projectRoot) {
  // 首先尝试直接从项目根目录解析
  const directPath = resolve(projectRoot, relativePath)
  if (existsSync(directPath)) {
    return { found: true, path: directPath, source: 'direct' }
  }

  // 常见的源代码目录前缀
  const commonPrefixes = ['src', 'lib', 'app', 'render', 'packages', 'electron', 'main', 'client', 'server']

  // 尝试在每个常见目录下查找
  for (const prefix of commonPrefixes) {
    const tryPath = resolve(projectRoot, prefix, relativePath)
    if (existsSync(tryPath)) {
      return { found: true, path: tryPath, source: `prefix:${prefix}` }
    }
  }

  // 尝试在 target 目录及其父目录中查找
  if (absTarget && absTarget !== projectRoot) {
    const tryPath = resolve(absTarget, relativePath)
    if (existsSync(tryPath)) {
      return { found: true, path: tryPath, source: 'target' }
    }

    // 尝试 target 的父目录
    const targetParent = resolve(absTarget, '..')
    const tryParentPath = resolve(targetParent, relativePath)
    if (existsSync(tryParentPath) && tryParentPath.startsWith(projectRoot)) {
      return { found: true, path: tryParentPath, source: 'target-parent' }
    }
  }

  // 尝试使用 glob 匹配查找（仅当文件名部分足够具体时）
  const fileName = basename(relativePath)
  if (fileName && !fileName.includes('*')) {
    try {
      const { readdirSync } = require('fs')
      const searchInDir = (dir, depth = 0) => {
        if (depth > 4) return null // 限制搜索深度
        try {
          const entries = readdirSync(dir, { withFileTypes: true })
          for (const entry of entries) {
            if (entry.name === fileName) {
              const fullPath = join(dir, fileName)
              if (fullPath.startsWith(projectRoot)) {
                return fullPath
              }
            }
            if (entry.isDirectory() && !entry.name.startsWith('.') && !EXCLUDE_DIRS.has(entry.name)) {
              const result = searchInDir(join(dir, entry.name), depth + 1)
              if (result) return result
            }
          }
        } catch { /* ignore permission errors */ }
        return null
      }

      const foundPath = searchInDir(projectRoot)
      if (foundPath) {
        return { found: true, path: foundPath, source: 'search' }
      }
    } catch { /* glob search failed, continue */ }
  }

  return { found: false, path: null, source: null }
}

// ============================================================
// _review.md generation — aggregate validation + manifest +
// pending confirmations + dynamic-flows ⚠️ + AI 检索缺口 (eval-log)
// ============================================================

// Tiny YAML extractor for a single named block — returns the block body as text
function extractYamlBlock(content, blockName) {
  const lines = content.split(/\r?\n/)
  const startRe = new RegExp(`^(\\s*)${blockName}:\\s*$`)
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(startRe)
    if (!m) continue
    const baseIndent = m[1].length
    const out = []
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]
      if (line.trim() === '') { out.push(line); continue }
      const indent = line.match(/^(\s*)/)[1].length
      if (indent <= baseIndent) break
      out.push(line)
    }
    return out.join('\n')
  }
  return null
}

// Lightweight YAML reader sufficient for eval-log retrieval_intents
// extraction. Mirrors src/eval-log.js parseYamlLite contract.
function parseYamlLite(raw) {
  const lines = raw.split(/\r?\n/)
    .map((text) => ({ indent: text.match(/^ */)[0].length, text: text.trim() }))
    .filter(line => line.text && !line.text.startsWith('#'))
  let index = 0
  function parseScalar(value) {
    const v = value.trim()
    if (v === 'null' || v === '~') return null
    if (v === 'true') return true
    if (v === 'false') return false
    if (v === '[]') return []
    if (v === '{}') return {}
    if (/^-?\d+(?:\.\d+)?$/.test(v)) return Number(v)
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      try { return JSON.parse(v) } catch { return v.slice(1, -1) }
    }
    return v
  }
  function parseBlock(indent) {
    if (index >= lines.length) return {}
    if (lines[index].text.startsWith('-')) return parseArray(indent)
    return parseObject(indent)
  }
  function parseObject(indent) {
    const out = {}
    while (index < lines.length) {
      const line = lines[index]
      if (line.indent < indent || line.text.startsWith('-')) break
      if (line.indent > indent) { index++; continue }
      const m = line.text.match(/^([^:]+):(.*)$/)
      if (!m) { index++; continue }
      const key = m[1].trim()
      const rest = m[2].trim()
      index++
      out[key] = rest === '' ? parseBlock(indent + 2) : parseScalar(rest)
    }
    return out
  }
  function parseArray(indent) {
    const out = []
    while (index < lines.length) {
      const line = lines[index]
      if (line.indent < indent || !line.text.startsWith('-')) break
      if (line.indent > indent) { index++; continue }
      const rest = line.text.slice(1).trim()
      index++
      out.push(rest === '' ? parseBlock(indent + 2) : parseScalar(rest))
    }
    return out
  }
  return parseBlock(0)
}

function collectEvalLogIntents(projectRoot, moduleName) {
  if (!moduleName) return []
  const root = statePath(projectRoot, 'eval-log')
  const configuredRoot = knowledgeRootRelative(projectRoot).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (!existsSync(root)) return []
  const intents = []
  let branches
  try { branches = readdirSync(root, { withFileTypes: true }) } catch { return [] }
  for (const entry of branches) {
    if (!entry.isDirectory()) continue
    const yamlPath = join(root, entry.name, 'eval-log.yaml')
    if (!existsSync(yamlPath)) continue
    let parsed
    try { parsed = parseYamlLite(readFileSync(yamlPath, 'utf-8')) } catch { continue }
    const stages = parsed?.stages || {}
    for (const [stageName, stage] of Object.entries(stages)) {
      const list = Array.isArray(stage?.retrieval_intents) ? stage.retrieval_intents : []
      for (const item of list) {
        if (!item || typeof item !== 'object') continue
        if (item.outcome !== 'not_found' && item.outcome !== 'partial') continue
        const kbSection = String(item.kb_section || '')
        const moduleMatch = kbSection.match(new RegExp(`^(?:${configuredRoot}|\\.codewiki/modules|docs)/([^/]+)/`))
        if (!moduleMatch || moduleMatch[1] !== moduleName) continue
        intents.push({
          question: String(item.question || '').trim(),
          outcome: item.outcome,
          stage: stageName,
          kb_section: kbSection,
          miss_reason: String(item.miss_reason || '').trim(),
          branch: entry.name,
        })
      }
    }
  }
  return intents
}

function aggregateIntents(intents) {
  const map = new Map()
  for (const item of intents) {
    const norm = item.question.toLowerCase().replace(/[\s　]+/g, ' ').trim()
    if (!norm) continue
    const slot = map.get(norm) || {
      question: item.question,
      count: 0,
      not_found: 0,
      partial: 0,
      stages: new Set(),
      miss_reasons: [],
    }
    slot.count += 1
    if (item.outcome === 'not_found') slot.not_found += 1
    else slot.partial += 1
    if (item.stage) slot.stages.add(item.stage)
    if (item.miss_reason && slot.miss_reasons.length < 3) slot.miss_reasons.push(item.miss_reason)
    map.set(norm, slot)
  }
  return [...map.values()]
    .map(s => ({ ...s, stages: [...s.stages].sort() }))
    .sort((a, b) => b.count - a.count)
}

function readJsonOr(filePath, fallback = {}) {
  try { return JSON.parse(readFileSync(filePath, 'utf-8')) }
  catch { return fallback }
}

function collectNamedFiles(dir, filename) {
  if (!existsSync(dir)) return []
  const out = []
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectNamedFiles(fullPath, filename))
    else if (entry.name === filename) out.push(fullPath)
  }
  return out
}

function collectQualityKnowledge(projectRoot, moduleName) {
  const reportsRoot = statePath(projectRoot, 'quality-report')
  const reports = collectNamedFiles(reportsRoot, 'quality-report-v2.json')
    .map(filePath => readJsonOr(filePath, null))
    .filter(Boolean)
  const cases = []
  const gaps = []
  for (const report of reports) {
    for (const item of report.cases || []) {
      if (item.module && item.module !== moduleName) continue
      const id = item.case_id || item.fingerprint
      if (!id) continue
      const normalized = {
        id,
        title: item.title || id,
        status: item.status,
        source: item.source || item.discovered_by || (item.status === 'candidate' ? 'ai' : 'history'),
        verified: item.status === 'verified',
        kb_refs: Array.isArray(item.kb_refs) ? item.kb_refs : [],
        evidence_refs: Array.isArray(item.evidence_refs) ? item.evidence_refs : [],
      }
      if (item.kind === 'knowledge_gap') gaps.push(normalized)
      else if (item.kind === 'quality') cases.push(normalized)
    }
  }
  return { cases, gaps }
}

function navigationInputs(moduleDir) {
  const navigationDir = join(moduleDir, 'navigation')
  return deriveNavigationCases({
    branchRoutes: readJsonOr(join(navigationDir, 'branch-routes.json')),
    stateMachines: readJsonOr(join(navigationDir, 'state-machines.json')),
    timeoutRecovery: readJsonOr(join(navigationDir, 'timeout-recovery.json')),
  })
}

function docMentionsNavigationCase(content, item) {
  const terms = item.id.split(/[:>-]+/).slice(1).filter(term => term && term !== 'undefined')
  return terms.length > 0 && terms.every(term => content.includes(term))
}

function referencesDoc(item, docRel, moduleName) {
  const normalizedDoc = docRel.replace(/\\/g, '/')
  return (item.kb_refs || []).some(ref => {
    const value = String(ref).replace(/\\/g, '/')
    return value.includes(normalizedDoc) || value.includes(`docs/${moduleName}/`)
  })
}

function knowledgeInputsForDoc({ docRel, content, moduleName, navigationCases, qualityKnowledge }) {
  const filename = basename(docRel)
  const expectedCases = qualityKnowledge.cases
    .filter(item => referencesDoc(item, docRel, moduleName) || filename.startsWith('03-'))
  for (const item of navigationCases) {
    const relevant = item.id.startsWith('branch:') ? filename.startsWith('02-') : filename.startsWith('03-')
    if (relevant) expectedCases.push({ ...item, verified: docMentionsNavigationCase(content, item) })
  }
  const gaps = qualityKnowledge.gaps
    .filter(item => referencesDoc(item, docRel, moduleName) || filename.startsWith('03-'))
  return { expectedCases, gaps }
}

function syncQualityConfidence(projectRoot, perFileConfidence) {
  let branch = 'unknown'
  try {
    branch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
      cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
    }).trim() || branch
  } catch {}
  const branchSlug = branch.replace(/[\\/:*?"<>|]+/g, '_').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown'
  const reportPath = statePath(projectRoot, 'quality-report', branchSlug, 'quality-report-v2.json')
  if (!existsSync(reportPath)) return false
  const report = readJsonOr(reportPath, null)
  if (!report) return false
  const byDoc = new Map((Array.isArray(report.knowledge_confidence) ? report.knowledge_confidence : []).map(item => [item.doc, item]))
  for (const item of perFileConfidence) {
    byDoc.set(item.doc, { doc: item.doc, ...item.confidence_v2, assessed_at: new Date().toISOString() })
  }
  report.knowledge_confidence = [...byDoc.values()].sort((a, b) => a.doc.localeCompare(b.doc))
  const tempPath = `${reportPath}.tmp-${process.pid}`
  try {
    writeFileSync(tempPath, JSON.stringify(report, null, 2) + '\n')
    renameSync(tempPath, reportPath)
    return true
  } catch {
    try { unlinkSync(tempPath) } catch {}
    return false
  }
}

function recordKnowledgeHealth(projectRoot, moduleName, perFileConfidence) {
  // Append-only audit history, consumed by `codewiki confidence`.
  try {
    const dir = statePath(projectRoot, 'knowledge-health', moduleName)
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'confidence-history.jsonl'), `${JSON.stringify({
      module: moduleName,
      target_path: relative(projectRoot, absTarget),
      assessed_at: new Date().toISOString(),
      per_file_confidence: perFileConfidence.map(item => ({ doc: item.doc, ...item.confidence_v2 })),
    })}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

function extractCoverageMissing(manifestText) {
  if (!manifestText) return []
  const block = extractYamlBlock(manifestText, 'coverage_assertions')
  if (!block) return []
  // Expect lines like "  user_story:" then nested "    status: MISSING" / "    reason: ..."
  const lines = block.split(/\r?\n/)
  const out = []
  let current = null
  for (const line of lines) {
    const topMatch = line.match(/^  (\S[^:]*):\s*$/)
    if (topMatch) {
      if (current && current.status === 'MISSING') out.push(current)
      current = { topic: topMatch[1].trim(), status: '', reason: '' }
      continue
    }
    if (!current) continue
    const statusMatch = line.match(/^\s+status:\s*(\S+)\s*$/)
    if (statusMatch) current.status = statusMatch[1]
    const reasonMatch = line.match(/^\s+reason:\s*(.*)$/)
    if (reasonMatch) {
      current.reason = reasonMatch[1].replace(/^["']|["']$/g, '').trim()
    }
  }
  if (current && current.status === 'MISSING') out.push(current)
  return out
}

function extractMustConfirmItems(manifestText) {
  if (!manifestText) return []
  const block = extractYamlBlock(manifestText, 'confirmation_checkpoint')
  if (!block) return []
  // Loose regex: each "  - ..." line is one item
  const out = []
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^\s*-\s+(.*)$/)
    if (m) out.push(m[1].replace(/^["']|["']$/g, '').trim())
  }
  return out
}

function extractUnverifiedCallChains(navDir) {
  const flowFile = join(navDir, 'dynamic-flows.md')
  if (!existsSync(flowFile)) return []
  let content
  try { content = readFileSync(flowFile, 'utf-8') } catch { return [] }
  const out = []
  const lines = content.split(/\r?\n/)
  lines.forEach((line, i) => {
    if (UNVERIFIED_LINE_PATTERNS.some(re => re.test(line))) {
      out.push({ text: line.trim().slice(0, 300), line: i + 1 })
    }
  })
  return out.slice(0, 50)
}

function gradePercent(ratio) {
  if (ratio == null) return 'N_A'
  return `${Math.round(ratio * 100)}%`
}

function summarizeFileIssues(item) {
  const parts = []
  if (item.failed_refs > 0) parts.push(`${item.failed_refs} 处引用失败`)
  if (item.placeholders > 0) parts.push(`${item.placeholders} 处占位符`)
  if (item.weak_phrases > 0) parts.push(`${item.weak_phrases} 处弱措辞`)
  if (item.unverified_flags > 0) parts.push(`${item.unverified_flags} 处未验证调用链`)
  return parts.length ? parts.join('；') : '—'
}

function aggregateLayerSummary(perFileConfidence) {
  const groups = new Map()
  for (const item of perFileConfidence) {
    if (!groups.has(item.layer)) groups.set(item.layer, [])
    groups.get(item.layer).push(item)
  }
  return [...groups.entries()].map(([layer, items]) => {
    const ratios = items.map(it => it.ratio).filter(r => r != null)
    const avg = ratios.length ? ratios.reduce((s, r) => s + r, 0) / ratios.length : null
    const issues = []
    let placeholdersTotal = 0
    let weakTotal = 0
    let unverifiedTotal = 0
    let failedRefs = 0
    for (const it of items) {
      placeholdersTotal += it.placeholders
      weakTotal += it.weak_phrases
      unverifiedTotal += it.unverified_flags
      failedRefs += it.failed_refs
    }
    if (failedRefs > 0) issues.push(`${failedRefs} 处引用失败`)
    if (placeholdersTotal > 0) issues.push(`${placeholdersTotal} 处占位符`)
    if (weakTotal > 0) issues.push(`${weakTotal} 处弱措辞`)
    if (unverifiedTotal > 0) issues.push(`${unverifiedTotal} 处未验证调用链`)
    return {
      layer,
      file_count: items.length,
      avg_ratio: avg,
      avg_grade: gradeFromRatio(avg),
      issues: issues.length ? issues.join('；') : '健康',
    }
  })
}

function generateReviewDoc({ docsRoot, perFileConfidence, references, projectRoot }) {
  const moduleDir = outputBaseDir || docsRoot
  const moduleName = moduleFromOutputDir(moduleDir) || 'unknown'
  const navDirLocal = join(moduleDir, 'navigation')

  // Static signals
  const layerSummary = aggregateLayerSummary(perFileConfidence)
  const manifestPath = join(moduleDir, 'manifest.yml')
  const manifestText = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf-8') : ''
  const mustConfirm = extractMustConfirmItems(manifestText)
  const coverageMissing = extractCoverageMissing(manifestText)
  const unverifiedChains = extractUnverifiedCallChains(navDirLocal)

  // Static "待业务补充" — derive from placeholders across files
  const pendingByDoc = perFileConfidence.flatMap(it => (it.issues?.placeholders || []).map(p => ({
    doc: it.doc,
    line: p.line,
    token: p.token,
  })))

  // Dynamic signals (Section 7)
  const usageReport = buildUsageReport(projectRoot, { module: moduleName, days: 30 })
  // mark which intents also exist in static pendingByDoc
  const pendingTexts = new Set(pendingByDoc.map(p => `${p.doc}:${p.line}`))

  const lines = []
  lines.push(`# ${moduleName} 知识库 Review`)
  lines.push('')
  lines.push(`> 提要：当前模块知识库整体健康状态，每次 codewiki 运行后自动重写。`)
  lines.push(`> 生成于 ${new Date().toISOString()} | 总文件数 ${perFileConfidence.length} | 总引用 ${references.length}`)
  lines.push('')

  lines.push('## 一、整体评分（按层）')
  lines.push('')
  lines.push('| 层 | 文件数 | 平均评分 | 主要问题 |')
  lines.push('|---|---|---|---|')
  for (const item of layerSummary) {
    const grade = item.avg_grade
    const pct = gradePercent(item.avg_ratio)
    lines.push(`| ${item.layer} | ${item.file_count} | ${grade} (${pct}) | ${item.issues} |`)
  }
  if (!layerSummary.length) lines.push('| — | 0 | N_A | 无 Layer 1/Layer 2 文件 |')
  lines.push('')

  lines.push('## 二、按文件细分')
  lines.push('')
  lines.push('| 文件 | 综合置信度 | 证据置信度 | 场景覆盖 | Gap 闭环 | 扣分点 |')
  lines.push('|---|---|---|---|---|---|')
  const sortedFiles = [...perFileConfidence].sort((a, b) => {
    const rA = a.ratio == null ? -1 : a.ratio
    const rB = b.ratio == null ? -1 : b.ratio
    return rA - rB
  })
  for (const item of sortedFiles) {
    const v2 = item.confidence_v2
    const overall = v2?.overall_confidence || { grade: item.grade, score: item.ratio }
    const scenario = v2?.scenario_coverage
    const gap = v2?.gap_closure
    lines.push(`| ${item.doc} | ${overall.grade} (${gradePercent(overall.score)}) | ${item.grade} (${gradePercent(item.ratio)}) | ${scenario?.verified || 0}/${scenario?.applicable || 0} (${gradePercent(scenario?.score)}) | ${gap?.closed || 0}/${gap?.discovered || 0} (${gradePercent(gap?.score)}) | ${summarizeFileIssues(item)} |`)
  }
  if (!sortedFiles.length) lines.push('| — | N_A | N_A | 0/0 | 0/0 | 无可评估文件 |')
  lines.push('')

  lines.push('### 缺失质量场景与未闭环 Gap')
  lines.push('')
  let confidenceIssueCount = 0
  for (const item of sortedFiles) {
    const scenario = item.confidence_v2?.scenario_coverage
    const gap = item.confidence_v2?.gap_closure
    for (const caseId of scenario?.missing_case_ids || []) {
      lines.push(`- [缺失场景] ${item.doc} — ${caseId}`)
      confidenceIssueCount++
    }
    for (const caseId of scenario?.candidate_case_ids || []) {
      lines.push(`- [AI 候选，未计分] ${item.doc} — ${caseId}`)
      confidenceIssueCount++
    }
    for (const gapId of gap?.open_gap_ids || []) {
      lines.push(`- [开放 Gap] ${item.doc} — ${gapId}`)
      confidenceIssueCount++
    }
  }
  if (!confidenceIssueCount) lines.push('- 无')
  lines.push('')

  lines.push('## 三、待用户确认 (MUST_CONFIRM)')
  lines.push('')
  lines.push('（来自 manifest.yml/confirmation_checkpoint）')
  lines.push('')
  if (mustConfirm.length) {
    for (const item of mustConfirm) lines.push(`- ${item}`)
  } else {
    lines.push('- 无')
  }
  lines.push('')

  lines.push('## 四、待业务补充（占位符位置）')
  lines.push('')
  lines.push('（来自含 待业务确认 / 待用户确认 / TBD / TODO 等占位符的文件位置）')
  lines.push('')
  if (pendingByDoc.length) {
    for (const item of pendingByDoc.slice(0, 50)) {
      lines.push(`- ${item.doc}:${item.line} — ${item.token}`)
    }
  } else {
    lines.push('- 无')
  }
  lines.push('')

  lines.push('## 五、未验证调用链')
  lines.push('')
  lines.push('（来自 navigation/dynamic-flows.md 的 ⚠️ 标记）')
  lines.push('')
  if (unverifiedChains.length) {
    for (const item of unverifiedChains) {
      lines.push(`- 行 ${item.line}: ${item.text}`)
    }
  } else {
    lines.push('- 无')
  }
  lines.push('')

  lines.push('## 六、Coverage Assertions Missing')
  lines.push('')
  lines.push('| topic | reason |')
  lines.push('|---|---|')
  if (coverageMissing.length) {
    for (const item of coverageMissing) {
      lines.push(`| ${item.topic} | ${item.reason || '（未填）'} |`)
    }
  } else {
    lines.push('| — | 无 MISSING 项 |')
  }
  lines.push('')

  lines.push('## 七、真实检索与 Case（最近 30 天）')
  lines.push('')
  lines.push('（来自 retrieval.jsonl；可靠命中仅限显式关联、反馈来源关联或问题完全一致。候选不计入覆盖率。）')
  lines.push('')
  const coverage = usageReport.case_coverage
  const feedback = usageReport.feedback
  lines.push(`- 唯一问题：${usageReport.usage.unique_query_count}；可靠命中：${coverage.matched}；候选：${coverage.candidate}；未覆盖：${coverage.missing}；可靠覆盖率：${coverage.coverage_rate ?? 'N/A'}`)
  lines.push(`- 用户评价：已评价 ${feedback.rated_queries}/${usageReport.usage.unique_query_count}；未评价 ${feedback.unrated_queries}；有帮助 ${feedback.good}；没帮助 ${feedback.bad}`)
  if (coverage.matched_queries.length || coverage.candidate_queries.length || coverage.missing_queries.length) {
    lines.push('')
    lines.push('| 状态 | 问题 | Case | 命中方式 |')
    lines.push('|---|---|---|---|')
    for (const item of coverage.matched_queries.slice(0, 10)) lines.push(`| matched | ${item.query} | ${item.case_id} | ${item.reason} |`)
    for (const item of coverage.candidate_queries.slice(0, 10)) lines.push(`| candidate | ${item.query} | ${item.case_id || '—'} | ${item.reason} |`)
    for (const item of coverage.missing_queries.slice(0, 10)) lines.push(`| missing | ${item.query} | — | ${item.reason} |`)
  } else {
    lines.push('- 暂无真实检索记录')
  }
  lines.push('')

  const reviewPath = join(moduleDir, '_review.md')
  writeFileSync(reviewPath, lines.join('\n'))
  console.log(`[deep-analyzer] _review.md written to ${reviewPath}`)
}

function validateFieldLineage() {
  const lineageDir = join(navDir, 'field-lineage')
  const indexPath = join(lineageDir, 'index.json')
  const manifestPath = outputBaseDir ? join(outputBaseDir, 'manifest.yml') : join(absTarget, '.doc', 'manifest.yml')
  const manifest = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf-8') : ''
  const requiresLineage = /version:\s*['"]?3\.6['"]?/.test(manifest) || existsSync(lineageDir)
  if (!requiresLineage) return { status: 'SKIP', pages_checked: 0, fields_checked: 0, issues: [] }

  const issues = []
  const addIssue = (code, message, location = null) => {
    issues.push({ status: 'FAIL', code, message, ...(location && { location }) })
  }
  const readJsonSafe = (filePath, code) => {
    if (!existsSync(filePath)) {
      addIssue(code, 'required field-lineage file is missing', relative(navDir, filePath))
      return null
    }
    try { return JSON.parse(readFileSync(filePath, 'utf-8')) }
    catch (err) {
      addIssue('invalid-json', err.message, relative(navDir, filePath))
      return null
    }
  }

  const index = readJsonSafe(indexPath, 'missing-index')
  const fieldIds = new Set()
  const verifiedSourceKeys = new Set()
  const normalizeProtocol = protocol => protocol === 'broadcast_channel' ? 'broadcast' : protocol
  const sourceKey = (protocol, method, endpoint, rawField, fieldId) => JSON.stringify([
    normalizeProtocol(protocol),
    normalizeProtocol(protocol) === 'http' ? (method || 'GET') : '',
    endpoint || '',
    rawField ?? null,
    fieldId,
  ])
  const validateEvidence = ref => {
    const match = String(ref || '').trim().match(/^(.+\.(?:vue|ts|js|tsx|jsx|mjs|cjs|java|go|md|json|ya?ml)):(\d+)$/)
    if (!match) return false
    const resolved = resolveFilePath(match[1], process.cwd())
    if (!resolved.found) return false
    const line = Number(match[2])
    const lineCount = readFileSync(resolved.path, 'utf-8').split(/\r?\n/).length
    return line >= 1 && line <= lineCount
  }
  let pagesChecked = 0
  let fieldsChecked = 0
  for (const pageRef of index?.pages || []) {
    const pagePath = join(lineageDir, 'pages', `${pageRef.page_id}.json`)
    const page = readJsonSafe(pagePath, 'missing-page')
    if (!page) continue
    pagesChecked++
    for (const field of page.fields || []) {
      fieldsChecked++
      const location = `${relative(navDir, pagePath)}#${field.id || field.path || fieldsChecked}`
      if (field.id) fieldIds.add(field.id)
      if (!Array.isArray(field.evidence) || field.evidence.length === 0) {
        addIssue('missing-evidence', 'field must contain at least one evidence reference', location)
      } else {
        for (const evidence of field.evidence) {
          if (!validateEvidence(evidence)) {
            addIssue('invalid-evidence', `invalid or unresolved evidence reference: ${evidence}`, location)
          }
        }
      }
      if (field.coverage === 'full' && (field.confidence === 'D' || field.confidence === 'E')) {
        addIssue('full-low-confidence', 'coverage=full cannot use confidence D/E', location)
      }
      for (const api of field.source_apis || []) {
        if (api.raw_field != null && !api.at) {
          addIssue('raw-field-missing-at', 'source_apis.raw_field requires an at evidence reference', location)
        }
        if (api.at && !validateEvidence(api.at)) {
          addIssue('invalid-evidence', `invalid or unresolved source_api.at: ${api.at}`, location)
        }
        if (api.confidence === 'A' || api.confidence === 'B') {
          verifiedSourceKeys.add(sourceKey(api.protocol, api.method, api.endpoint, api.raw_field, field.id))
        }
      }
      for (const transform of field.transforms || []) {
        if (transform.kind === 'unknown' && !String(transform.description || '').trim()) {
          addIssue('unknown-transform', 'unknown transform requires a description', location)
        }
      }
    }
  }

  const reversePath = join(lineageDir, 'reverse-index.json')
  const reverse = readJsonSafe(reversePath, 'missing-reverse-index')
  for (const protocol of ['http', 'ipc', 'ws', 'broadcast']) {
    for (const entry of reverse?.[protocol] || []) {
      for (const fieldId of entry.used_by || []) {
        if (!fieldIds.has(fieldId)) {
          addIssue('orphan-reverse-entry', `reverse index references unknown field: ${fieldId}`, `${relative(navDir, reversePath)}#${protocol}`)
        } else if (!verifiedSourceKeys.has(sourceKey(protocol, entry.method, entry.endpoint, entry.raw_field, fieldId))) {
          addIssue('reverse-source-mismatch', `reverse entry has no matching A/B source_api: ${fieldId}`, `${relative(navDir, reversePath)}#${protocol}`)
        }
      }
    }
  }

  return {
    status: issues.length > 0 ? 'FAIL' : 'PASS',
    pages_checked: pagesChecked,
    fields_checked: fieldsChecked,
    issues,
  }
}

function validateEvidenceReferences() {
  const docsRoot = outputBaseDir || join(absTarget, '.doc')
  const docs = collectMarkdownFiles(docsRoot)
  const references = []
  const projectRoot = process.cwd()
  const moduleName = moduleFromOutputDir(docsRoot) || 'unknown'
  const navigationCases = navigationInputs(docsRoot)
  const qualityKnowledge = collectQualityKnowledge(projectRoot, moduleName)

  for (const docPath of docs) {
    const content = readFileSync(docPath, 'utf-8')
    const docRel = relative(projectRoot, docPath)
    for (const ref of extractFileLineReferences(content)) {
      const resolved = resolveFilePath(ref.file, projectRoot)
      let status = 'PASS'
      let message = 'ok'
      let resolvedPath = ref.file

      if (!resolved.found) {
        status = 'FAIL'
        message = 'file not found (searched in project root and common source directories)'
      } else {
        resolvedPath = relative(projectRoot, resolved.path)
        const lineCount = readFileSync(resolved.path, 'utf-8').split(/\r?\n/).length
        if (ref.line < 1 || ref.line > lineCount) {
          status = 'FAIL'
          message = `line out of range: ${ref.line} > ${lineCount}`
        } else if (resolved.source !== 'direct') {
          message = `ok (found via ${resolved.source})`
        }
      }

      references.push({
        status,
        reference: ref.reference,
        file: ref.file,
        resolvedPath,
        line: ref.line,
        doc: docRel,
        message,
      })
    }
  }

  // -------- Per-file confidence (Layer 1/Layer 2 only) --------
  const docRefs = new Map()
  for (const ref of references) {
    if (!docRefs.has(ref.doc)) docRefs.set(ref.doc, [])
    docRefs.get(ref.doc).push(ref)
  }

  const perFileConfidence = []
  for (const docPath of docs) {
    const docRel = relative(projectRoot, docPath)
    const layer = classifyLayer(docRel)
    if (layer === 'navigation') continue
    if (basename(docPath) === '_review.md') continue
    let content
    try { content = readFileSync(docPath, 'utf-8') } catch { continue }
    const refs = docRefs.get(docRel) || []
    const passed = refs.filter(r => r.status === 'PASS').length
    const failed = refs.filter(r => r.status === 'FAIL').length
    const claims = analyzeMarkdownClaims(content)
    const weakCount = claims.weakHits.length
    const placeholderCount = claims.placeholders.length
    const unverifiedCount = claims.unverified.length
    const total = passed + failed + weakCount + placeholderCount + unverifiedCount
    const ratio = total > 0 ? passed / total : null
    const grade = gradeFromRatio(ratio)
    const knowledgeInputs = knowledgeInputsForDoc({
      docRel,
      content,
      moduleName,
      navigationCases,
      qualityKnowledge,
    })
    const confidenceV2 = calculateKnowledgeConfidence({
      evidenceScore: ratio,
      expectedCases: knowledgeInputs.expectedCases,
      gaps: knowledgeInputs.gaps,
    })
    perFileConfidence.push({
      doc: docRel,
      layer,
      grade,
      ratio: ratio == null ? null : Number(ratio.toFixed(3)),
      passed_refs: passed,
      failed_refs: failed,
      weak_phrases: weakCount,
      placeholders: placeholderCount,
      unverified_flags: unverifiedCount,
      confidence_v2: confidenceV2,
      issues: {
        weak_phrases: claims.weakHits.slice(0, 5),
        placeholders: claims.placeholders.slice(0, 5),
        unverified: claims.unverified.slice(0, 5),
      },
    })
  }

  const fieldLineage = validateFieldLineage()
  const qualityConfidenceSynced = syncQualityConfidence(projectRoot, perFileConfidence)
  const knowledgeHealthRecorded = recordKnowledgeHealth(projectRoot, moduleName, perFileConfidence)
  const report = {
    generated_at: new Date().toISOString(),
    status: references.some(item => item.status === 'FAIL') || fieldLineage.status === 'FAIL' ? 'FAIL' : 'PASS',
    docs_scanned: docs.length,
    reference_count: references.length,
    references,
    per_file_confidence: perFileConfidence,
    quality_report_synced: qualityConfidenceSynced,
    knowledge_health_recorded: knowledgeHealthRecorded,
    field_lineage: fieldLineage,
  }

  mkdirSync(navDir, { recursive: true })
  const reportPath = join(navDir, 'validation-report.json')
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  console.log(`[deep-analyzer] Validation report written to ${reportPath}`)
  console.log(`  Status:      ${report.status}`)
  console.log(`  Docs:        ${report.docs_scanned}`)
  console.log(`  References:  ${report.reference_count}`)
  console.log(`  Per-file confidence: ${perFileConfidence.length} 文件`)
  console.log(`  Field lineage: ${fieldLineage.status} (${fieldLineage.fields_checked} fields)`)

  // Always (re)generate _review.md after validation, regardless of PASS/FAIL.
  try {
    generateReviewDoc({ docsRoot, perFileConfidence, references, projectRoot })
  } catch (err) {
    console.warn(`[deep-analyzer] _review.md generation failed: ${err?.message || err}`)
  }

  if (report.status === 'FAIL') process.exitCode = 1
  return report
}

// ============================================================
// Node weight computation (PageRank 50% + Betweenness 30% + Degree 20%)
// ============================================================
function buildNormalizedScores() {
  const scores = Object.values(nodeScores)
  if (scores.length === 0) return { compute: () => 0.1 }
  const prMax = Math.max(...scores.map(s => s.pagerank)) || 1
  const btMax = Math.max(...scores.map(s => s.betweenness)) || 1
  const degMax = Math.max(...scores.map(s => s.in_degree + s.out_degree)) || 1
  return {
    compute(file) {
      const s = nodeScores[file]
      if (!s) return 0.01
      const prNorm = s.pagerank / prMax
      const btNorm = s.betweenness / btMax
      const degNorm = (s.in_degree + s.out_degree) / degMax
      return prNorm * 0.5 + btNorm * 0.3 + degNorm * 0.2
    }
  }
}
const weightCalculator = buildNormalizedScores()

// ============================================================
// 1. Pipeline Detection
// ============================================================
function detectPipelines() {
  const pipelines = []
  const visited = new Set()
  const callGraph = new Map()
  for (const fn of allFunctions) {
    if (fn.calls) callGraph.set(fn.name, fn.calls)
  }
  for (const fn of allFunctions) {
    if (!callGraph.has(fn.name)) {
      const calls = []
      for (const other of allFunctions) {
        if (other.name === fn.name || other.file === fn.file) continue
        const src = sourceOf(fn.file)
        const escaped = other.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        if (new RegExp(`\\b${escaped}\\s*\\(`).test(src)) calls.push(other.name)
      }
      if (calls.length) callGraph.set(fn.name, calls)
    }
  }

  function dfs(funcName, chain) {
    if (visited.has(funcName)) return
    visited.add(funcName)
    const fn = funcByName(funcName)
    if (fn) chain.push({ file: fn.file, function: fn.name, role: fn.role || 'unknown' })
    const calls = callGraph.get(funcName) || []
    for (const called of calls) {
      const calledFn = funcByName(called)
      if (calledFn && (calledFn.role === 'transform' || calledFn.role === 'calculation')) {
        dfs(called, chain)
      }
    }
  }

  const sources = allFunctions.filter(f => f.role === 'source')
  for (const src of sources) {
    const chain = []
    visited.clear()
    dfs(src.name, chain)
    if (chain.length > 1) {
      pipelines.push({
        name: chain.map(c => c.function).join(' -> '),
        chain,
        trigger: `Data sourced from ${src.name} in ${src.file}`,
      })
    }
  }

  const transforms = allFunctions.filter(f => f.role === 'transform')
  for (const t of transforms) {
    if (!t.callers) continue
    const vueCallers = t.callers.filter(c => c.endsWith('.vue'))
    if (vueCallers.length > 0) {
      const chain = [{ file: t.file, function: t.name, role: t.role }]
      const tCalls = callGraph.get(t.name) || []
      for (const called of tCalls) {
        const calledFn = funcByName(called)
        if (calledFn && (calledFn.role === 'transform' || calledFn.role === 'calculation')) {
          chain.push({ file: calledFn.file, function: calledFn.name, role: calledFn.role })
        }
      }
      pipelines.push({
        name: `${t.name} (UI-triggered)`,
        chain,
        trigger: `User interaction in ${vueCallers.join(', ')} triggers ${t.name}`,
      })
    }
  }
  return pipelines
}

// ============================================================
// 2. Rendering Matrix
// ============================================================
function detectRenderingMatrix() {
  const matrix = []
  for (const comp of allComponents) {
    if (!comp.conditions || comp.conditions.length === 0) continue
    const src = sourceOf(comp.file)
    for (const cond of comp.conditions) {
      const condStr = typeof cond === 'string' ? cond : (cond.expression || String(cond))
      const condDir = typeof cond === 'object' && cond.directive ? cond.directive : 'v-if'
      const condElem = typeof cond === 'object' && cond.element ? cond.element : ''
      const section = { element: condElem, directive: condDir, expression: condStr, inferred_types: [] }
      const enumRe = /\b(\w+Enum)\.(\w+)\b/g
      let enumMatch
      while ((enumMatch = enumRe.exec(condStr)) !== null) {
        section.inferred_types.push(enumMatch[2])
      }
      const boolRe = /shouldShow\w+|is\w+|has\w+|can\w+/g
      const bools = condStr.match(boolRe)
      if (bools) {
        for (const b of bools) {
          const assignRe = new RegExp(`${b}\\s*=\\s*[^;]*?(\\w+Enum)\\.(\\w+)`, 's')
          const assignMatch = src.match(assignRe)
          if (assignMatch) section.inferred_types.push(assignMatch[2])
        }
      }
      const presenceRe = /(\w+)\??\.(?:length|size)/g
      let presMatch
      while ((presMatch = presenceRe.exec(condStr)) !== null) {
        section.inferred_types.push(`has_${presMatch[1]}`)
      }
      matrix.push({ component: comp.file, sections: [section] })
    }
  }
  return matrix
}

// ============================================================
// 3. Calculation Chain Detection
// ============================================================
function detectCalculationChains() {
  const chains = []
  const calcFiles = new Set()
  const calcFuncs = allFunctions.filter(f => f.role === 'calculation')
  for (const fn of calcFuncs) calcFiles.add(fn.file)
  for (const f of sourceCache.keys()) {
    if (/culate|price|pricing/i.test(f)) calcFiles.add(f)
  }

  for (const file of calcFiles) {
    const src = sourceOf(file)
    if (!src) continue
    const fileFuncs = funcByFile(file).filter(f => f.role === 'calculation' || /calc|culate|price/i.test(f.name))
    for (const entry of fileFuncs) {
      const branches = []
      const switchRe = /switch\s*\([^)]*\)\s*\{([\s\S]*?)\n\s*\}/g
      let switchMatch
      while ((switchMatch = switchRe.exec(src)) !== null) {
        const switchBody = switchMatch[1]
        const switchCond = src.substring(switchMatch.index, switchMatch.index + 50).match(/switch\s*\(([^)]*)\)/)?.[1] || ''
        const caseRe = /case\s+([^:]+):/g
        let caseMatch
        while ((caseMatch = caseRe.exec(switchBody)) !== null) {
          const caseVal = caseMatch[1].trim()
          const caseStart = caseMatch.index + caseMatch[0].length
          const nextCase = switchBody.indexOf('case ', caseStart)
          const caseBlock = nextCase > -1 ? switchBody.substring(caseStart, nextCase) : switchBody.substring(caseStart)
          const callsInCase = []
          for (const other of allFunctions) {
            const escaped = other.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            if (new RegExp(`\\b${escaped}\\s*\\(`).test(caseBlock)) callsInCase.push(other.name)
          }
          branches.push({ condition: `${switchCond} === ${caseVal}`, type_value: caseVal.replace(/['"]/g, ''), calls: callsInCase, formula_description: '' })
        }
      }
      const ifRe = /if\s*\(([^)]+)\)\s*\{/g
      let ifMatch
      while ((ifMatch = ifRe.exec(src)) !== null) {
        const cond = ifMatch[1].trim()
        if (cond.length > 200) continue
        const typeValMatch = cond.match(/===\s*['"]?(\w+)['"]?/)
        const typeValue = typeValMatch ? typeValMatch[1] : ''
        const callsInIf = []
        for (const other of allFunctions) {
          const escaped = other.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          if (new RegExp(`\\b${escaped}\\s*\\(`).test(src.substring(ifMatch.index, ifMatch.index + 500))) {
            callsInIf.push(other.name)
          }
        }
        branches.push({ condition: cond, type_value: typeValue, calls: callsInIf, formula_description: '' })
      }
      const callers = entry.callers || []
      if (branches.length === 0 && callers.length === 0) continue
      chains.push({ entry_function: entry.name, file, branches: branches.slice(0, 20), called_by: callers })
    }
  }
  return chains
}

// ============================================================
// 4. Event Flow Detection
// ============================================================
function detectEventFlows() {
  const eventMap = new Map()
  for (const comp of allComponents) {
    if (comp.emits_events) {
      for (const evt of comp.emits_events) {
        if (!eventMap.has(evt)) eventMap.set(evt, { emitters: [], subscribers: [] })
        const src = sourceOf(comp.file)
        const funcRe = /(?:function\s+(\w+)|const\s+(\w+)\s*=).*?emit\s*\(\s*['"`]/
        const funcMatch = src.match(funcRe)
        eventMap.get(evt).emitters.push({ file: comp.file, function: funcMatch ? (funcMatch[1] || funcMatch[2]) : 'unknown' })
      }
    }
    const src = sourceOf(comp.file)
    const emitRe = /emit(?:ter)?\.(?:emit|fire)\s*\(\s*['"]([^'"]+)['"]/g
    let emitMatch
    while ((emitMatch = emitRe.exec(src)) !== null) {
      const evtKey = emitMatch[1]
      if (!eventMap.has(evtKey)) eventMap.set(evtKey, { emitters: [], subscribers: [] })
      const ctxStart = Math.max(0, emitMatch.index - 200)
      const ctx = src.substring(ctxStart, emitMatch.index)
      const fnRe = /(?:function\s+(\w+)|const\s+(\w+)\s*=)/
      const fnMatch = ctx.match(fnRe)
      eventMap.get(evtKey).emitters.push({ file: comp.file, function: fnMatch ? (fnMatch[1] || fnMatch[2]) : 'unknown' })
    }
    if (comp.subscribes_to) {
      for (const sub of comp.subscribes_to) {
        if (!eventMap.has(sub)) eventMap.set(sub, { emitters: [], subscribers: [] })
        const src2 = sourceOf(comp.file)
        const registration = src2.includes('onMounted') ? 'onMounted' : src2.includes('onBeforeMount') ? 'onBeforeMount' : 'setup'
        eventMap.get(sub).subscribers.push({ file: comp.file, registration, handler_function: 'unknown' })
      }
    }
  }
  const flows = []
  for (const [eventKey, { emitters, subscribers }] of eventMap) {
    if (emitters.length === 0 && subscribers.length === 0) continue
    const transport = /ipc/i.test(eventKey) ? 'ipcMain/ipcRenderer' : /socket|ws/i.test(eventKey) ? 'WebSocket' : 'mitt event bus'
    flows.push({ event_key: eventKey, emitters, subscribers, transport })
  }
  return flows
}

// ============================================================
// 5. Flow Analysis (Weight-based main flow + branch detection)
// ============================================================

function buildComponentNameMap() {
  const nameMap = new Map()
  for (const comp of allComponents) {
    const parts = comp.file.split('/')
    const dirName = parts[parts.length - 2] || ''
    const fileName = parts[parts.length - 1].replace(/\.vue$/, '')
    const pascal = dirName.replace(/(^|-)(\w)/g, (_, _s, c) => c.toUpperCase())
    const kebab = dirName
    nameMap.set(pascal, comp.file)
    nameMap.set(kebab, comp.file)
    if (fileName !== 'index') {
      const filePascal = fileName.replace(/(^|-)(\w)/g, (_, _s, c) => c.toUpperCase())
      nameMap.set(filePascal, comp.file)
      nameMap.set(fileName, comp.file)
    }
  }
  return nameMap
}

const componentNameMap = buildComponentNameMap()

function resolveComponentName(name) {
  if (componentNameMap.has(name)) return componentNameMap.get(name)
  const pascal = name.replace(/(^|-)(\w)/g, (_, _s, c) => c.toUpperCase())
  if (componentNameMap.has(pascal)) return componentNameMap.get(pascal)
  const kebab = name.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '')
  if (componentNameMap.has(kebab)) return componentNameMap.get(kebab)
  return null
}

function detectFlows() {
  // Build component hierarchy
  const edges = fileGraph?.data?.edges || []
  const childrenMap = new Map()
  const parentMap = new Map()

  function addChild(parent, child) {
    if (!childrenMap.has(parent)) childrenMap.set(parent, new Set())
    childrenMap.get(parent).add(child)
    parentMap.set(child, parent)
  }

  for (const edge of edges) {
    if (edge.type !== 'import') continue
    if (!edge.source.endsWith('.vue') || !edge.target.endsWith('.vue')) continue
    addChild(edge.source, edge.target)
  }

  for (const comp of allComponents) {
    if (comp.uses) {
      for (const childName of comp.uses) {
        const childFile = resolveComponentName(childName)
        if (childFile && comp.file !== childFile) addChild(comp.file, childFile)
      }
    }
  }

  // Entry points
  const allNodes = fileGraph?.data?.nodes || []
  const pageEntries = allNodes
    .filter(n => n.type === 'component' && (n.id.includes('pages/') || n.id.includes('pages\\')))
    .map(n => n.id)

  let entryPoint = pageEntries[0]
  if (!entryPoint) {
    let maxChildren = 0
    for (const [parent, children] of childrenMap) {
      if (children.size > maxChildren) { maxChildren = children.size; entryPoint = parent }
    }
  }

  // --- Weight-maximizing main flow via DFS ---
  function extractMainFlow(entry) {
    const allPaths = []
    const MAX_DEPTH = 8
    const MAX_PATHS = 500 // cap to avoid combinatorial explosion

    function dfs(current, path, totalWeight, visited, depth) {
      if (allPaths.length >= MAX_PATHS) return
      if (depth > MAX_DEPTH) {
        allPaths.push({ path: [...path], weight: totalWeight })
        return
      }
      const children = [...(childrenMap.get(current) || [])].filter(c => !visited.has(c))
      if (children.length === 0) {
        allPaths.push({ path: [...path], weight: totalWeight })
        return
      }
      // Sort by weight descending for better pruning
      children.sort((a, b) => weightCalculator.compute(b) - weightCalculator.compute(a))
      for (const child of children) {
        const w = weightCalculator.compute(child)
        visited.add(child)
        path.push(child)
        dfs(child, path, totalWeight + w, visited, depth + 1)
        path.pop()
        visited.delete(child)
      }
    }

    dfs(entry, [entry], weightCalculator.compute(entry), new Set([entry]), 0)

    // Main flow = path with highest average weight per node
    allPaths.sort((a, b) => {
      const avgA = a.weight / a.path.length
      const avgB = b.weight / b.path.length
      return avgB - avgA
    })

    const bestPath = allPaths[0]?.path || [entry]
    return bestPath.map(component => ({
      component,
      role: component === entry ? 'entry' : (hubFiles.has(component) ? 'core' : 'normal'),
      frequency: hubFiles.has(component) ? 'high' : 'normal',
      weight: weightCalculator.compute(component),
      pagerank: nodeScores[component]?.pagerank || 0,
    }))
  }

  // Decision points
  const scenarioConditions = []
  for (const comp of allComponents) {
    if (!comp.conditions) continue
    for (const cond of comp.conditions) {
      const condStr = typeof cond === 'string' ? cond : (cond.expression || '')
      const condElem = typeof cond === 'object' && cond.element ? cond.element : ''
      const enumMatches = [...condStr.matchAll(/(\w+Enum)\.(\w+)/g)]
      if (enumMatches.length > 0) {
        scenarioConditions.push({ component: comp.file, element: condElem, expression: condStr, enum_types: enumMatches.map(m => m[2]) })
      }
      const boolMatch = condStr.match(/^(shouldShow\w+|is\w+|has\w+|can\w+)/)
      if (boolMatch) {
        scenarioConditions.push({ component: comp.file, element: condElem, expression: condStr, enum_types: [], boolean_guard: boolMatch[1] })
      }
    }
  }

  const decisionsByComponent = new Map()
  for (const sc of scenarioConditions) {
    if (!decisionsByComponent.has(sc.component)) decisionsByComponent.set(sc.component, [])
    decisionsByComponent.get(sc.component).push(sc)
  }

  // Scenario frequency
  const typeFrequency = new Map()
  for (const comp of allComponents) {
    if (!comp.conditions) continue
    for (const cond of comp.conditions) {
      const condStr = typeof cond === 'string' ? cond : (cond.expression || '')
      const enumMatches = [...condStr.matchAll(/(\w+Enum)\.(\w+)/g)]
      for (const m of enumMatches) typeFrequency.set(m[2], (typeFrequency.get(m[2]) || 0) + 1)
    }
  }

  const freqValues = [...typeFrequency.values()]
  const avgFreq = freqValues.length > 0 ? freqValues.reduce((a, b) => a + b, 0) / freqValues.length : 1
  const stdFreq = freqValues.length > 0
    ? Math.sqrt(freqValues.reduce((sum, v) => sum + (v - avgFreq) ** 2, 0) / freqValues.length) : 0
  const scenarioFrequency = {}
  for (const [type, count] of typeFrequency) {
    let tier = 'secondary'
    if (count >= avgFreq + stdFreq) tier = 'primary'
    else if (count < avgFreq - stdFreq) tier = 'edge'
    scenarioFrequency[type] = { count, tier }
  }

  // Build main flow & branch flows
  const mainFlowComponents = new Set()
  const branchFlows = []

  for (const entry of pageEntries) {
    const mainSteps = extractMainFlow(entry)
    for (const step of mainSteps) mainFlowComponents.add(step.component)

    // Side branches
    for (const step of mainSteps) {
      const children = [...(childrenMap.get(step.component) || [])].filter(c => !mainFlowComponents.has(c))
      for (const child of children) {
        const decisions = decisionsByComponent.get(step.component) || []
        const relatedDecision = decisions.find(d => {
          const src = sourceOf(child)
          return src && src.includes(d.expression.split('.')[0])
        })
        const w = weightCalculator.compute(child)
        branchFlows.push({
          name: guessFlowName(child),
          entry: child,
          trigger: relatedDecision ? `${relatedDecision.expression}` : `conditional import from ${step.component}`,
          parent_component: step.component,
          scenario_type: 'branch',
          has_decisions: decisionsByComponent.has(child) || false,
          weight: w,
          pagerank: nodeScores[child]?.pagerank || 0,
        })
      }
    }
  }

  // Classify branch flows by weight thresholds
  const branchWeights = branchFlows.map(b => b.weight)
  const branchMean = branchWeights.length > 0 ? branchWeights.reduce((a, b) => a + b, 0) / branchWeights.length : 0
  const branchStd = branchWeights.length > 0
    ? Math.sqrt(branchWeights.reduce((s, w) => s + (w - branchMean) ** 2, 0) / branchWeights.length) : 0

  for (const branch of branchFlows) {
    if (branch.weight > branchMean + branchStd) branch.frequency = 'primary'
    else if (branch.weight < branchMean - branchStd) branch.frequency = 'edge'
    else branch.frequency = 'secondary'
  }

  // Decision points for main flow
  const mainDecisionPoints = []
  for (const entry of pageEntries) {
    const mainSteps = extractMainFlow(entry)
    for (const step of mainSteps) {
      const decisions = decisionsByComponent.get(step.component)
      if (!decisions || decisions.length === 0) continue
      const mainConditions = decisions.filter(d => d.enum_types.length > 0)
      const boolConditions = decisions.filter(d => d.boolean_guard)
      if (mainConditions.length > 0 || boolConditions.length > 0) {
        const sideChildren = [...(childrenMap.get(step.component) || [])].filter(c => !mainFlowComponents.has(c))
        mainDecisionPoints.push({
          at_component: step.component,
          conditions: mainConditions.map(c => ({ expression: c.expression, element: c.element, enum_types: c.enum_types })),
          boolean_guards: boolConditions.map(c => ({ expression: c.expression, guard_name: c.boolean_guard })),
          side_branches: sideChildren.map(c => ({ target: c, scenario: guessFlowName(c) }))
        })
      }
    }
  }

  return {
    entry_points: pageEntries,
    main_flow: pageEntries.length > 0 ? {
      name: guessMainFlowName(pageEntries[0]),
      total_weight: extractMainFlow(pageEntries[0]).reduce((s, step) => s + step.weight, 0),
      steps: extractMainFlow(pageEntries[0]),
      decision_points: mainDecisionPoints
    } : null,
    branch_flows: branchFlows,
    scenario_frequency: scenarioFrequency,
    weight_thresholds: {
      primary_min: branchMean + branchStd,
      secondary_range: [Math.max(0, branchMean - branchStd), branchMean + branchStd],
      edge_max: Math.max(0, branchMean - branchStd),
      mean: branchMean,
      stddev: branchStd,
    }
  }
}

function guessFlowName(file) {
  const parts = file.replace(/\.vue$/, '').replace(/\.ts$/, '').split('/')
  const name = parts[parts.length - 1] === 'index' ? parts[parts.length - 2] || parts[parts.length - 1] : parts[parts.length - 1]
  return name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function guessMainFlowName(entry) {
  const pathMatch = entry.match(/(?:pages|components)\/([^/]+)/)
  if (pathMatch) return `${pathMatch[1]} main flow`
  return 'Main flow'
}

// ============================================================
// 6. Validation Summary
// ============================================================
function detectValidationSummary() {
  const summaries = []
  const validFiles = new Set()
  for (const fn of allFunctions) {
    if (fn.role === 'validation') validFiles.add(fn.file)
  }
  for (const f of sourceCache.keys()) {
    if (/valid|form/i.test(f)) validFiles.add(f)
  }

  for (const file of validFiles) {
    const src = sourceOf(file)
    if (!src) continue
    const rules = []
    const reqRe = /(\w+)\s*:\s*\{[^}]*required\s*:\s*true/g
    let reqMatch
    while ((reqMatch = reqRe.exec(src)) !== null) {
      rules.push({ field: reqMatch[1], type: 'required', detail: 'field is required' })
    }
    const patRe = /(\w+)\s*:\s*\{[^}]*pattern\s*:\s*([^}]+)/g
    let patMatch
    while ((patMatch = patRe.exec(src)) !== null) {
      rules.push({ field: patMatch[1], type: 'pattern', detail: patMatch[2].trim().substring(0, 100) })
    }
    const minMaxRe = /(\w+)\s*:\s*\{[^}]*(min|max)\s*:\s*(\d+)/g
    let mmMatch
    while ((mmMatch = minMaxRe.exec(src)) !== null) {
      rules.push({ field: mmMatch[1], type: 'range', detail: `${mmMatch[2]}: ${mmMatch[3]}` })
    }
    const errRe = /Message\s*\(\s*\{[^}]*type\s*:\s*['"]error['"]/g
    const errorCalls = src.match(errRe)
    if (errorCalls) {
      rules.push({ field: '__global__', type: 'error_feedback', detail: `${errorCalls.length} error message(s)` })
    }
    const customRe = /(\w+)\s*:\s*\{[^}]*validator\s*:\s*(\w+)/g
    let customMatch
    while ((customMatch = customRe.exec(src)) !== null) {
      rules.push({ field: customMatch[1], type: 'custom', detail: `validator: ${customMatch[2]}` })
    }
    if (rules.length === 0) continue
    const formNameRe = /(?:const|let)\s+(\w*form\w*|\w*Form\w*)\s*=/
    const formMatch = src.match(formNameRe)
    summaries.push({ file, form: formMatch ? formMatch[1] : 'unknown', rules })
  }
  return summaries
}

function detectRuntimeFlows() {
  return graphEdges
    .filter(edge =>
      edge.type === 'ipc' ||
      edge.type === 'webcontents-send' ||
      edge.type === 'dynamic-dispatch' ||
      edge.type === 'async-import' ||
      edge.type === 'dynamic-require' ||
      edge.type === 'store-call' ||
      edge.type === 'broadcast-channel'
    )
    .map(edge => ({
      type: edge.type,
      ...(edge.channel && { channel: edge.channel }),
      ...(edge.subtype && { subtype: edge.subtype }),
      from: edge.source,
      to: edge.target,
      confidence: edge.confidence ?? 1,
      weight: edge.weight ?? 1,
    }))
}

// ============================================================
// Helpers for dynamic-view extractors
// ============================================================
function lineOf(src, offset) {
  if (offset == null || offset < 0) return 0
  let line = 1
  for (let i = 0; i < offset && i < src.length; i++) if (src.charCodeAt(i) === 10) line++
  return line
}

function enclosingFunctionName(src, offset) {
  // Walk back from offset and find the most recent function-defining pattern.
  const pre = src.substring(Math.max(0, offset - 800), offset)
  const patterns = [
    /(?:async\s+)?function\s+(\w+)\s*\(/g,
    /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/g,
    /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?function/g,
    /(\w+)\s*[:=]\s*(?:async\s*)?\(([^)]{0,80})\)\s*=>/g,
    /async\s+(\w+)\s*\(/g,
  ]
  let best = { name: '', pos: -1 }
  for (const re of patterns) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(pre)) !== null) {
      if (m.index > best.pos) best = { name: m[1], pos: m.index }
    }
  }
  return best.name || 'unknown'
}

function nearestCondition(src, offset) {
  const pre = src.substring(Math.max(0, offset - 400), offset)
  const ifM = [...pre.matchAll(/if\s*\(([^)]{1,160})\)\s*\{/g)].pop()
  if (ifM) return `if(${ifM[1].trim().slice(0, 120)})`
  const catchM = [...pre.matchAll(/catch\s*\(([^)]{0,80})\)\s*\{/g)].pop()
  if (catchM) return 'catch'
  const elseM = [...pre.matchAll(/\}\s*else\s*\{/g)].pop()
  if (elseM) return 'else'
  return ''
}

function extractI18nKey(callArgs) {
  // 提取 $t('key') / t('key') / i18n.t('key')，否则返回字面量
  const i18nM = callArgs.match(/(?:\$t|t|i18n\.t)\s*\(\s*['"]([^'"]+)['"]/)
  if (i18nM) return { i18nKey: i18nM[1], literal: '' }
  const litM = callArgs.match(/['"]([^'"]{1,140})['"]/)
  return { i18nKey: '', literal: litM ? litM[1] : '' }
}

// ============================================================
// 7. State Machine Detection (动态视角)
// ============================================================
function detectStateMachines() {
  // 实体识别：来自 TS 字符串联合类型 / enum / 状态字面量赋值的聚合
  const entityValues = new Map() // entityKey -> { values:Set, evidence:[{file,line}], assigns:[{file,line,value,context}] }

  function bumpEntity(key, value, file, line, role) {
    if (!entityValues.has(key)) entityValues.set(key, { values: new Set(), evidence: [], assigns: [] })
    const ent = entityValues.get(key)
    if (value) ent.values.add(value)
    if (role === 'declare') ent.evidence.push({ file, line })
    if (role === 'assign') ent.assigns.push({ file, line, value, context: '' })
  }

  // Pass 1: TS string union types (type X = 'a' | 'b' | ...) — 强信号
  const unionRe = /(?:export\s+)?type\s+(\w+)\s*=\s*((?:\s*['"][\w-]+['"]\s*\|?){2,})/g
  for (const [file, src] of sourceCache) {
    let m
    while ((m = unionRe.exec(src)) !== null) {
      const name = m[1]
      // 只保留 status/state/phase/stage/type 这类语义
      if (!/(Status|State|Phase|Stage|Step|Mode)$/i.test(name)) continue
      const literals = [...m[2].matchAll(/['"]([\w-]+)['"]/g)].map(x => x[1])
      const line = lineOf(src, m.index)
      for (const v of literals) bumpEntity(name, v, file, line, 'declare')
    }
  }

  // Pass 2: enum 声明
  const enumRe = /enum\s+(\w+)\s*\{([^}]+)\}/g
  for (const [file, src] of sourceCache) {
    let m
    while ((m = enumRe.exec(src)) !== null) {
      const name = m[1]
      if (!/(Status|State|Phase|Stage|Step|Mode)$/i.test(name)) continue
      const members = [...m[2].matchAll(/(\w+)\s*=\s*['"]?([\w-]+)['"]?/g)].map(x => x[2])
      const line = lineOf(src, m.index)
      for (const v of members) bumpEntity(name, v, file, line, 'declare')
    }
  }

  // Pass 3: 状态赋值收集（task.status = 'pending' / setStatus('xxx') / status: 'xxx'）
  const assignRe = /(\w+(?:\.\w+)?)\s*\.?\s*(?:status|state|phase|stage)\s*=\s*['"]([\w-]+)['"]/gi
  const setterRe = /\bset(Status|State|Phase|Stage)\s*\(\s*['"]([\w-]+)['"]/g
  const statusObjRe = /\bstatus\s*:\s*['"]([\w-]+)['"]/gi

  for (const [file, src] of sourceCache) {
    let m
    while ((m = assignRe.exec(src)) !== null) {
      bumpEntity(m[1] + '.status', m[2], file, lineOf(src, m.index), 'assign')
    }
    while ((m = setterRe.exec(src)) !== null) {
      bumpEntity(m[1], m[2], file, lineOf(src, m.index), 'assign')
    }
    while ((m = statusObjRe.exec(src)) !== null) {
      bumpEntity('status', m[1], file, lineOf(src, m.index), 'assign')
    }
  }

  // Pass 4: 从 assign 周边推断 transitions（最近的 if 条件 → 触发；当前函数名 → trigger）
  const machines = []
  for (const [entity, info] of entityValues) {
    if (info.values.size < 2) continue // 不是状态机
    const transitions = []
    const seen = new Set()
    for (const a of info.assigns) {
      const src = sourceOf(a.file)
      if (!src) continue
      // 求 offset（line→offset 反查）
      const lines = src.split('\n')
      const off = lines.slice(0, a.line - 1).join('\n').length + (a.line > 1 ? 1 : 0)
      const trigger = enclosingFunctionName(src, off)
      const cond = nearestCondition(src, off)
      const fromMatch = cond.match(/=== ?['"]?([\w-]+)['"]?/)
      const from = fromMatch ? fromMatch[1] : ''
      const key = `${from}->${a.value}@${a.file}:${a.line}`
      if (seen.has(key)) continue
      seen.add(key)
      transitions.push({ from, to: a.value, trigger, condition: cond, file: a.file, line: a.line })
    }
    machines.push({
      entity,
      states: [...info.values].sort(),
      transitions: transitions.slice(0, 60),
      evidence: info.evidence.slice(0, 6),
    })
  }
  return machines
}

// ============================================================
// 8. UI Feedback Detection (用户提醒/交互)
// ============================================================
function detectUIFeedback() {
  const feedbacks = []
  // 反馈 API 模式：Message.success / Message.warning / Notification.error / MessageBox / Toast / alert / confirm / Dialog
  const apiRe = /\b(Message|Notification|MessageBox|Toast|Dialog|notify|message)\s*\.\s*(success|warning|error|info|confirm|alert|open)\s*\(([\s\S]{0,400}?)\)/g
  const directRe = /\b(Message|Notification|notify)\s*\(\s*\{([\s\S]{0,400}?)\}\s*\)/g
  const alertRe = /\b(alert|confirm)\s*\(([\s\S]{0,300}?)\)/g

  for (const [file, src] of sourceCache) {
    let m
    while ((m = apiRe.exec(src)) !== null) {
      const [, api, level, args] = m
      const line = lineOf(src, m.index)
      const { i18nKey, literal } = extractI18nKey(args)
      feedbacks.push({
        api: `${api}.${level}`,
        level, file, line,
        i18n_key: i18nKey,
        literal: literal.slice(0, 140),
        function: enclosingFunctionName(src, m.index),
        condition: nearestCondition(src, m.index),
      })
    }
    while ((m = directRe.exec(src)) !== null) {
      const [, api, body] = m
      const line = lineOf(src, m.index)
      const { i18nKey, literal } = extractI18nKey(body)
      const typeM = body.match(/type\s*:\s*['"]([\w]+)['"]/)
      const durM = body.match(/duration\s*:\s*(\d+)/)
      feedbacks.push({
        api, level: typeM ? typeM[1] : 'unknown',
        file, line,
        i18n_key: i18nKey,
        literal: literal.slice(0, 140),
        duration_ms: durM ? Number(durM[1]) : null,
        function: enclosingFunctionName(src, m.index),
        condition: nearestCondition(src, m.index),
      })
    }
    while ((m = alertRe.exec(src)) !== null) {
      const [, api, args] = m
      // 跳过 export/import alert 这类误命中
      const ctxStart = Math.max(0, m.index - 30)
      const ctx = src.substring(ctxStart, m.index)
      if (/(?:import|export|from|const|let|var)\s*$/.test(ctx)) continue
      const line = lineOf(src, m.index)
      const { i18nKey, literal } = extractI18nKey(args)
      feedbacks.push({
        api, level: api === 'confirm' ? 'confirm' : 'alert',
        file, line, i18n_key: i18nKey, literal: literal.slice(0, 140),
        function: enclosingFunctionName(src, m.index),
        condition: nearestCondition(src, m.index),
      })
    }
  }

  // 按 file:line 去重
  const seen = new Set()
  return feedbacks.filter(fb => {
    const k = `${fb.file}:${fb.line}:${fb.api}`
    if (seen.has(k)) return false
    seen.add(k); return true
  })
}

// ============================================================
// 9. Timeout & Recovery Detection (超时常量与恢复行为)
// ============================================================
function detectTimeoutRecovery() {
  const constants = []
  // 超时/阈值常量命名
  const constRe = /(?:const|let)\s+([A-Z][A-Z0-9_]*(?:TIMEOUT|TIMEOUT_MS|MAX|THRESHOLD|INTERVAL|GRACE|HEARTBEAT|RETRY|FAILURE)[A-Z0-9_]*|\w*(?:TimeoutMs|TimeoutMS|Threshold|Interval|MaxRetries))\s*=\s*(\d+)/g
  for (const [file, src] of sourceCache) {
    let m
    while ((m = constRe.exec(src)) !== null) {
      constants.push({ name: m[1], value: Number(m[2]), file, line: lineOf(src, m.index) })
    }
  }

  // Handler 命名：handle*Timeout / on*Timeout / *Failed / handleHeartbeatTimeout
  const handlerRe = /(?:function\s+|(?:const|let)\s+)(\w*(?:Timeout|Failed|TimedOut|Failure|Crash|Resume|Retry|Recovery)\w*)\s*[=(]/g
  const handlers = []
  for (const [file, src] of sourceCache) {
    let m
    while ((m = handlerRe.exec(src)) !== null) {
      const name = m[1]
      const line = lineOf(src, m.index)
      // 截取 handler 函数体（粗略：到下一个同级 } 或 600 字符）
      const bodyStart = src.indexOf('{', m.index)
      const body = bodyStart > -1 ? src.substring(bodyStart, bodyStart + 1000) : ''
      const actions = []
      // 状态变迁
      const stateMutRe = /\b(?:status|state|phase)\s*=\s*['"]([\w-]+)['"]/g
      let mm
      while ((mm = stateMutRe.exec(body)) !== null) actions.push({ kind: 'state_mutation', detail: `→ ${mm[1]}` })
      // IPC send
      const sendRe = /\b(?:webContents\.send|ipcRenderer\.send|emit|broadcast)\s*\(\s*['"]([^'"]+)['"]/g
      while ((mm = sendRe.exec(body)) !== null) actions.push({ kind: 'ipc_send', detail: mm[1] })
      // UI 反馈
      const fbRe = /\b(?:Message|Notification|Toast|MessageBox)\s*\.\s*(?:success|warning|error|info)/g
      while ((mm = fbRe.exec(body)) !== null) actions.push({ kind: 'ui_feedback', detail: mm[0] })
      // setTimeout 重试
      if (/setTimeout|retry|reschedule/i.test(body)) actions.push({ kind: 'retry_or_reschedule', detail: 'setTimeout/retry detected' })
      handlers.push({ name, file, line, actions })
    }
  }

  // 关联：常量名包含的语义子串（如 RENDER_ACK） → handler 名包含同语义（handleRenderFailed）
  const associations = []
  for (const c of constants) {
    const sem = c.name.replace(/_?(MS|TIMEOUT|MAX|THRESHOLD|INTERVAL|GRACE|HEARTBEAT|RETRY|FAILURE)/gi, '').replace(/_/g, '').toLowerCase()
    if (!sem) { associations.push({ constant: c, handlers: [] }); continue }
    const matched = handlers.filter(h => {
      const hn = h.name.toLowerCase()
      return sem.length > 2 && hn.includes(sem.slice(0, Math.min(sem.length, 8)))
    })
    associations.push({ constant: c, handlers: matched.slice(0, 5) })
  }

  return { constants, handlers, associations }
}

// ============================================================
// 10. Branch Routes Detection (分支路由对比)
// ============================================================
function detectBranchRoutes() {
  const fieldBranches = new Map() // field -> Map(value -> Set('file:line'))

  function add(field, value, file, line) {
    if (!field || !value) return
    if (!fieldBranches.has(field)) fieldBranches.set(field, new Map())
    const m = fieldBranches.get(field)
    if (!m.has(value)) m.set(value, new Set())
    m.get(value).add(`${file}:${line}`)
  }

  // 来源1：源码中的 === 比较
  const eqRe = /\b([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)?)\s*===\s*(['"]?[\w-]+['"]?)/g
  for (const [file, src] of sourceCache) {
    let m
    while ((m = eqRe.exec(src)) !== null) {
      const field = m[1]
      const value = m[2].replace(/['"]/g, '')
      // 排除明显常量比较（typeof / null / undefined / true / false / 数字）
      if (/^(true|false|null|undefined)$/.test(value)) continue
      if (/^typeof$/.test(field)) continue
      add(field, value, file, lineOf(src, m.index))
    }
  }

  // 来源2：switch case
  const switchRe = /switch\s*\(\s*([\w.]+)\s*\)\s*\{([\s\S]*?)\n\s*\}/g
  for (const [file, src] of sourceCache) {
    let m
    while ((m = switchRe.exec(src)) !== null) {
      const field = m[1]
      const body = m[2]
      const baseLine = lineOf(src, m.index)
      const caseRe = /case\s+['"]?([\w-]+)['"]?\s*:/g
      let cm
      while ((cm = caseRe.exec(body)) !== null) {
        const lineInBody = (body.substring(0, cm.index).match(/\n/g) || []).length
        add(field, cm[1], file, baseLine + lineInBody)
      }
    }
  }

  // 来源3：Vue v-if 表达式（来自 component-refs.json）
  for (const comp of allComponents) {
    const conds = comp.conditions || []
    for (const c of conds) {
      const expr = c.expression || ''
      const eqM = expr.match(/([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)?)\s*===\s*['"]?([\w-]+)['"]?/)
      if (eqM) add(eqM[1], eqM[2], comp.file, 0) // 行号未知，记 0
    }
  }

  // 输出：只保留 ≥2 个不同分支值的字段
  const result = []
  for (const [field, valueMap] of fieldBranches) {
    if (valueMap.size < 2) continue
    const branches = []
    for (const [value, locs] of valueMap) {
      branches.push({ value, locations: [...locs].slice(0, 8), count: locs.size })
    }
    // 按命中频次排序，取 top 字段
    const total = branches.reduce((s, b) => s + b.count, 0)
    if (total < 3) continue // 噪声过滤
    result.push({ field, total_hits: total, branches: branches.sort((a, b) => b.count - a.count) })
  }
  return result.sort((a, b) => b.total_hits - a.total_hits).slice(0, 30)
}

// ============================================================
// 11. Product Limits Detection (产品限制与不可承诺项推导)
// ============================================================
function detectProductLimits() {
  const limits = []

  // 信号 1：try/catch 包裹 IPC/HTTP 调用 → 外部调用失败可能性
  const tryIpcRe = /try\s*\{[\s\S]{0,500}?\b(?:electronBridge|electronAPI|ipcRenderer|fetch|axios|request|http)\.[\w.]+\([\s\S]{0,200}?\}\s*catch/g
  for (const [file, src] of sourceCache) {
    let m
    while ((m = tryIpcRe.exec(src)) !== null) {
      const callM = m[0].match(/\b(electronBridge|electronAPI|ipcRenderer|fetch|axios|request|http)\.([\w.]+)/)
      if (!callM) continue
      limits.push({
        kind: 'external_call_may_fail',
        signal: 'try/catch around external call',
        target: `${callM[1]}.${callM[2]}`,
        file, line: lineOf(src, m.index),
        implication: '外部调用可能失败：网络/IPC/系统接口异常时本地状态可能与外部不一致',
      })
    }
  }

  // 信号 2：setTimeout 但同上下文无 retry/重新调度 → 时序敏感无兜底
  const setTimeoutRe = /\bsetTimeout\s*\(/g
  for (const [file, src] of sourceCache) {
    let m
    while ((m = setTimeoutRe.exec(src)) !== null) {
      const ctx = src.substring(m.index, Math.min(src.length, m.index + 600))
      const hasRetry = /retry|reschedule|setTimeout\s*\([^)]*setTimeout/i.test(ctx)
      if (hasRetry) continue
      // 排除 debounce/throttle 这种无副作用场景
      const ctxBefore = src.substring(Math.max(0, m.index - 80), m.index)
      if (/debounce|throttle|delay|wait/i.test(ctxBefore)) continue
      limits.push({
        kind: 'time_sensitive_no_fallback',
        signal: 'setTimeout without retry/reschedule',
        file, line: lineOf(src, m.index),
        implication: '时序敏感且无重试兜底：单次延时失败后流程可能中断',
      })
    }
  }

  // 信号 3：依赖 electronAPI / navigator / window.* 等运行环境
  const envDepRe = /\b(?:window\.(electronAPI|electron|navigator)|electronBridge|navigator\.(usb|bluetooth|serial|hid|geolocation|mediaDevices)|process\.platform)\b/g
  const envSeen = new Map() // dep -> first occurrence
  for (const [file, src] of sourceCache) {
    let m
    while ((m = envDepRe.exec(src)) !== null) {
      const depName = m[0]
      if (envSeen.has(depName)) continue
      envSeen.set(depName, { file, line: lineOf(src, m.index) })
    }
  }
  for (const [dep, loc] of envSeen) {
    limits.push({
      kind: 'runtime_environment_dependency',
      signal: `accesses ${dep}`,
      target: dep,
      file: loc.file, line: loc.line,
      implication: `依赖运行环境 ${dep}：跨平台/浏览器版本/硬件可用性会影响功能`,
    })
  }

  // 信号 4：WebSocket / emitter.on 订阅但无补偿/重连/重订阅
  const wsSubRe = /\b(?:emitter|eventBus|bus|subscribe|on)\s*\.?\s*(?:on|subscribe)\s*\(\s*['"`]([^'"]+)['"`]/g
  for (const [file, src] of sourceCache) {
    let m
    while ((m = wsSubRe.exec(src)) !== null) {
      const evtKey = m[1]
      // 排除 DOM 事件
      if (/^(click|input|change|submit|scroll|keydown|keyup|focus|blur)$/i.test(evtKey)) continue
      // 检查同文件是否有 reconnect / resubscribe / offline-handler
      const hasCompensation = /reconnect|resubscribe|onReconnect|onOffline|retry|backoff/i.test(src)
      if (hasCompensation) continue
      limits.push({
        kind: 'push_may_be_lost',
        signal: 'event subscription without reconnect/resubscribe',
        target: evtKey,
        file, line: lineOf(src, m.index),
        implication: `事件 ${evtKey} 订阅无重连补偿：网络断开/服务重启期间推送可能丢失`,
      })
    }
  }

  // 按 kind+target+file 去重
  const seen = new Set()
  return limits.filter(l => {
    const k = `${l.kind}:${l.target || ''}:${l.file}:${l.line}`
    if (seen.has(k)) return false
    seen.add(k); return true
  }).slice(0, 80)
}

// ============================================================
// Main
// ============================================================
async function main() {
  if (validateMode) {
    validateEvidenceReferences()
    return
  }

  console.log(`[deep-analyzer] Analyzing module: ${absTarget}`)
  console.log(`  Functions: ${allFunctions.length}, Components: ${allComponents.length}, Source files: ${sourceFiles.length}`)
  console.log(`  Node scores loaded: ${Object.keys(nodeScores).length} nodes`)

  const pipelines = detectPipelines()
  const renderingMatrix = detectRenderingMatrix()
  const calculationChains = detectCalculationChains()
  const eventFlows = detectEventFlows()
  const flowAnalysis = detectFlows()
  const validationSummary = detectValidationSummary()
  const runtimeFlows = detectRuntimeFlows()
  const stateMachines = detectStateMachines()
  const uiFeedback = detectUIFeedback()
  const timeoutRecovery = detectTimeoutRecovery()
  const branchRoutes = detectBranchRoutes()
  const productLimits = detectProductLimits()

  const output = {
    metadata: {
      generated_at: new Date().toISOString(),
      target_dir: targetDir,
      base_commit: baseCommit,
      version: '3.0.0',
      signal_contract: 'candidate-evidence-only',
    },
    known_limitations: [
      'deep-analyzer 输出的是候选行为信号，不是业务结论或接口契约事实',
      '动态链路、IPC/RPC、事件总线、插件加载等关系必须由 Claude Code 继续读源码补证',
      '正则命中的状态、分支、UI 反馈、超时和产品限制只能作为读码入口',
    ],
    pipelines,
    rendering_matrix: renderingMatrix,
    calculation_chains: calculationChains,
    event_flows: eventFlows,
    runtime_flows: runtimeFlows,
    flows: flowAnalysis,
    validation_summary: validationSummary,
    state_machines: stateMachines,
    ui_feedback: uiFeedback,
    timeout_recovery: timeoutRecovery,
    branch_routes: branchRoutes,
    product_limits: productLimits,
  }

  mkdirSync(navDir, { recursive: true })
  const outputPath = join(navDir, 'deep-analysis.json')
  writeFileSync(outputPath, JSON.stringify(output, null, 2))

  console.log(`\n[deep-analyzer] Written to ${outputPath}`)
  console.log(`  Pipelines:           ${pipelines.length}`)
  console.log(`  Rendering entries:   ${renderingMatrix.length}`)
  console.log(`  Calculation chains:  ${calculationChains.length}`)
  console.log(`  Event flows:         ${eventFlows.length}`)
  console.log(`  Runtime flows:       ${runtimeFlows.length}`)
  if (flowAnalysis.main_flow) {
    console.log(`  Main flow:           ${flowAnalysis.main_flow.steps.length} steps, weight=${flowAnalysis.main_flow.total_weight.toFixed(3)}`)
  }
  console.log(`  Branch flows:        ${flowAnalysis.branch_flows.length} (${flowAnalysis.branch_flows.filter(b => b.frequency === 'primary').length} primary, ${flowAnalysis.branch_flows.filter(b => b.frequency === 'secondary').length} secondary, ${flowAnalysis.branch_flows.filter(b => b.frequency === 'edge').length} edge)`)
  console.log(`  Weight thresholds:   mean=${flowAnalysis.weight_thresholds.mean.toFixed(4)}, stddev=${flowAnalysis.weight_thresholds.stddev.toFixed(4)}`)
  console.log(`  Validation files:    ${validationSummary.length}`)
  console.log(`  State machines:      ${stateMachines.length} (entities with ≥2 states)`)
  console.log(`  UI feedback points:  ${uiFeedback.length}`)
  console.log(`  Timeout constants:   ${timeoutRecovery.constants.length}, recovery handlers: ${timeoutRecovery.handlers.length}`)
  console.log(`  Branch route fields: ${branchRoutes.length}`)
  console.log(`  Product limit signals: ${productLimits.length} (${[...new Set(productLimits.map(l => l.kind))].join(', ')})`)
}

main().catch(err => {
  console.error('[deep-analyzer] Failed:', err)
  process.exit(1)
})
