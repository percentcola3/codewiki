import { createHash } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { loadProjectConfig, statePath } from '../config.mjs'

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/')
}

function isInside(filePath, parent) {
  const rel = relative(resolve(parent), resolve(filePath))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function filesUnder(root, output = [], excludedRoots = []) {
  if (!existsSync(root)) return output
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const filePath = join(root, entry.name)
    if (excludedRoots.some(excluded => isInside(filePath, excluded))) continue
    if (entry.isDirectory()) filesUnder(filePath, output, excludedRoots)
    else if (entry.isFile()) output.push(filePath)
  }
  return output
}

export function directoryFingerprint(root, options = {}) {
  if (!existsSync(root)) return null
  const hash = createHash('sha256')
  for (const filePath of filesUnder(root, [], options.exclude || []).sort()) {
    hash.update(normalizePath(relative(root, filePath)))
    hash.update('\0')
    hash.update(readFileSync(filePath))
    hash.update('\0')
  }
  return `sha256:${hash.digest('hex')}`
}

export function semanticAssetFingerprint(moduleDir) {
  if (!existsSync(moduleDir)) return null
  const roots = ['product', 'developer', 'quality', 'frontend'].map(name => join(moduleDir, name)).filter(existsSync)
  const files = roots.flatMap(root => filesUnder(root)).filter(file => file.endsWith('.md'))
  const cases = join(moduleDir, 'retrieval-cases.json')
  if (existsSync(cases)) files.push(cases)
  if (files.length === 0) return null
  const hash = createHash('sha256')
  for (const filePath of files.sort()) {
    hash.update(normalizePath(relative(moduleDir, filePath)))
    hash.update('\0')
    hash.update(readFileSync(filePath))
    hash.update('\0')
  }
  return `sha256:${hash.digest('hex')}`
}

function transactionRoot(projectRoot, moduleName) {
  const safe = encodeURIComponent(String(moduleName || 'unknown'))
  return statePath(projectRoot, 'transactions', safe)
}

function metadataPath(projectRoot, moduleName) {
  return join(transactionRoot(projectRoot, moduleName), 'transaction.json')
}

export function readGenerationTransaction(projectRoot, moduleName) {
  try { return JSON.parse(readFileSync(metadataPath(projectRoot, moduleName), 'utf8')) } catch { return null }
}

function writeTransaction(projectRoot, moduleName, value) {
  const dir = transactionRoot(projectRoot, moduleName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(metadataPath(projectRoot, moduleName), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return value
}

export function beginGenerationTransaction({ projectRoot, moduleName, moduleDir, targetDir }) {
  const existing = readGenerationTransaction(projectRoot, moduleName)
  if (existing?.status === 'active') return existing
  const root = transactionRoot(projectRoot, moduleName)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  const baselineDir = join(root, 'baseline')
  const moduleExisted = existsSync(moduleDir)
  const config = loadProjectConfig(projectRoot)
  const sourceExcludes = [...new Set([config.stateRootPath, config.knowledgeRootPath])]
  if (moduleExisted) cpSync(moduleDir, baselineDir, { recursive: true })
  return writeTransaction(projectRoot, moduleName, {
    version: 1,
    status: 'active',
    module: moduleName,
    module_dir: resolve(moduleDir),
    target_dir: resolve(targetDir),
    module_existed: moduleExisted,
    baseline_dir: baselineDir,
    baseline_fingerprint: directoryFingerprint(moduleDir),
    baseline_semantic_fingerprint: semanticAssetFingerprint(moduleDir),
    source_fingerprint: directoryFingerprint(targetDir, { exclude: sourceExcludes }),
    source_excludes: sourceExcludes,
    started_at: new Date().toISOString(),
    impact: null,
  })
}

export function updateGenerationTransaction(projectRoot, moduleName, patch) {
  const current = readGenerationTransaction(projectRoot, moduleName)
  if (!current) return null
  return writeTransaction(projectRoot, moduleName, { ...current, ...patch, updated_at: new Date().toISOString() })
}

function archiveFailedModule(root, moduleDir) {
  const failedDir = join(root, 'failed')
  rmSync(failedDir, { recursive: true, force: true })
  if (existsSync(moduleDir)) cpSync(moduleDir, failedDir, { recursive: true })
  return failedDir
}

function restoreBaseline(transaction, root) {
  const moduleDir = transaction.module_dir
  rmSync(moduleDir, { recursive: true, force: true })
  if (transaction.module_existed) cpSync(join(root, 'baseline'), moduleDir, { recursive: true })
}

export function rollbackGenerationTransaction(projectRoot, moduleName, reason) {
  const transaction = readGenerationTransaction(projectRoot, moduleName)
  if (!transaction) return null
  const root = transactionRoot(projectRoot, moduleName)
  const failedDir = archiveFailedModule(root, transaction.module_dir)
  restoreBaseline(transaction, root)
  const next = writeTransaction(projectRoot, moduleName, {
    ...transaction,
    status: 'rolled_back',
    rolled_back_at: new Date().toISOString(),
    reason: String(reason || 'finalize failed'),
    failed_dir: failedDir,
  })
  return next
}

export function assertGenerationUnchanged(projectRoot, moduleName) {
  const transaction = readGenerationTransaction(projectRoot, moduleName)
  if (!transaction) return null
  const currentSource = directoryFingerprint(transaction.target_dir, { exclude: transaction.source_excludes || [] })
  if (currentSource !== transaction.source_fingerprint) {
    throw new Error('生成期间源码发生变化；已停止 finalize，请重新运行 generate --update')
  }
  return transaction
}

export function assertKnowledgeImpactReviewed(projectRoot, moduleName) {
  const transaction = readGenerationTransaction(projectRoot, moduleName)
  if (!transaction || transaction.impact?.classification !== 'KNOWLEDGE_IMPACT') return transaction
  const current = semanticAssetFingerprint(transaction.module_dir)
  if (!transaction.module_existed && !current) {
    throw new Error('首次生成尚未产生 product/developer/quality Markdown，不能 finalize')
  }
  if (transaction.module_existed && transaction.impact?.knowledge_ids?.length > 0 && current === transaction.baseline_semantic_fingerprint) {
    throw new Error(`以下受影响知识尚未更新：${transaction.impact.knowledge_ids.join(', ')}`)
  }
  return transaction
}

export function completeGenerationTransaction(projectRoot, moduleName, result = {}) {
  const transaction = readGenerationTransaction(projectRoot, moduleName)
  if (!transaction) return null
  const root = transactionRoot(projectRoot, moduleName)
  const historyDir = statePath(projectRoot, 'transactions')
  mkdirSync(historyDir, { recursive: true })
  appendFileSync(join(historyDir, 'history.jsonl'), `${JSON.stringify({
    ...transaction,
    ...result,
    status: 'complete',
    completed_at: new Date().toISOString(),
    final_fingerprint: directoryFingerprint(transaction.module_dir),
  })}\n`, 'utf8')
  rmSync(root, { recursive: true, force: true })
  return transaction
}

export function transactionSummary(transaction) {
  if (!transaction) return ''
  return `${basename(transaction.module_dir)}: ${transaction.impact?.classification || 'PENDING'}`
}
