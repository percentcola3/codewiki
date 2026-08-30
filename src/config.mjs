import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'

export const CONFIG_FILE = 'codewiki.yml'
export const DEFAULT_MODULES_ROOT = '.codewiki/modules'
export const DEFAULT_STATE_ROOT = '.codewiki'

function repoRelativePath(value, fallback, field) {
  const input = String(value || fallback).trim().replace(/\\/g, '/')
  if (!input || isAbsolute(input)) throw new Error(`${field} 必须是仓库内的相对路径`)
  const normalized = normalize(input).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '')
  if (normalized === '.') throw new Error(`${field} 不能是仓库根目录`)
  if (normalized === '..' || normalized.startsWith('../')) throw new Error(`${field} 不能指向仓库外`)
  return normalized
}

export function loadProjectConfig(projectRoot = process.cwd()) {
  const root = resolve(projectRoot)
  const configPath = join(root, CONFIG_FILE)
  let raw = {}
  let explicit = false
  if (existsSync(configPath)) {
    explicit = true
    try {
      raw = parseYaml(readFileSync(configPath, 'utf8')) || {}
    } catch (error) {
      throw new Error(`${CONFIG_FILE} 解析失败: ${error.message}`)
    }
  }
  const knowledgeRoot = repoRelativePath(raw.knowledge_root, DEFAULT_MODULES_ROOT, 'knowledge_root')
  const stateRoot = repoRelativePath(raw.state_root, DEFAULT_STATE_ROOT, 'state_root')
  const overlaps = knowledgeRoot === stateRoot
    || knowledgeRoot.startsWith(`${stateRoot}/`)
    || stateRoot.startsWith(`${knowledgeRoot}/`)
  const defaultLayout = knowledgeRoot === DEFAULT_MODULES_ROOT && stateRoot === DEFAULT_STATE_ROOT
  if (overlaps && !defaultLayout) {
    throw new Error('knowledge_root 与 state_root 不能重叠；共享知识会被本地状态的 gitignore 规则隐藏')
  }
  return {
    projectRoot: root,
    configPath,
    explicit,
    knowledgeRoot,
    stateRoot,
    knowledgeRootPath: join(root, knowledgeRoot),
    stateRootPath: join(root, stateRoot),
  }
}

export function resolveKnowledgeRoot(projectRoot = process.cwd()) {
  const config = loadProjectConfig(projectRoot)
  return config.knowledgeRootPath
}

export function knowledgeRootRelative(projectRoot = process.cwd()) {
  const config = loadProjectConfig(projectRoot)
  return relative(config.projectRoot, resolveKnowledgeRoot(config.projectRoot)).replace(/\\/g, '/') || config.knowledgeRoot
}

export function resolveStateRoot(projectRoot = process.cwd()) {
  return loadProjectConfig(projectRoot).stateRootPath
}

export function statePath(projectRoot, ...parts) {
  return join(resolveStateRoot(projectRoot), ...parts)
}
