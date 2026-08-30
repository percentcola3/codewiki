// codewiki init — 初始化共享知识目录、Agent Skills、MCP 检索与本地运行目录。
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIG_FILE, knowledgeRootRelative, loadProjectConfig } from './config.mjs'
import { promoteGoodFeedbackCases } from './feedback.mjs'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LOCAL_STATE_DIRS = [
  'cache',
  'site',
  'workflow',
  'evaluation-runs',
  'knowledge-health',
  'quality-report',
  'eval-log',
  'knowledge-overlay',
  'codewiki-migration',
  'transactions',
]
const LOCAL_STATE_FILES = ['retrieval.jsonl', 'feedback.jsonl', 'gaps.jsonl']
const CODEWIKI_INTERNAL_COMMANDS = ['generate', 'query', 'preview', 'confidence']
const CLAUDE_SETTINGS_LOCAL = '.claude/settings.local.json'
const CODEX_RULES_FILE = '.codex/rules/codewiki.rules'
const LEGACY_INTEGRATIONS = [
  '.claude/commands/fe-scan.md',
  '.claude/commands/wiki-scan.md',
  '.claude/commands/wiki-explore.md',
  '.claude/skills/fe-scan',
  '.claude/skills/codewiki-scan',
  '.claude/skills/codewiki-explore',
  '.agents/skills/fe-scan',
  '.agents/skills/codewiki-scan',
  '.agents/skills/codewiki-explore',
]
const LEGACY_INSTRUCTION_FILES = ['CLAUDE.md', '.claude/CLAUDE.md', 'AGENTS.md']

function copyTree(srcDir, destDir, label, results, outputRoot = destDir) {
  if (!existsSync(srcDir)) return
  mkdirSync(destDir, { recursive: true })
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const src = join(srcDir, entry.name)
    const dest = join(destDir, entry.name)
    if (entry.isDirectory()) copyTree(src, dest, label, results, outputRoot)
    else if (entry.isFile()) {
      copyFileSync(src, dest)
      results.push(`${label}: ${relative(outputRoot, dest).replace(/\\/g, '/')}`)
    }
  }
}

function upsertCodexMcp(content) {
  const block = ['[mcp_servers.codewiki]', 'command = "npx"', 'args = ["-y", "codewiki", "mcp"]']
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex(line => line.trim() === '[mcp_servers.codewiki]')
  if (start < 0) return `${content.trimEnd()}${content.trim() ? '\n\n' : ''}${block.join('\n')}\n`
  let end = start + 1
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++
  return `${[...lines.slice(0, start), ...block, ...lines.slice(end)].join('\n').trimEnd()}\n`
}

function removeCodexMcp(content) {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex(line => line.trim() === '[mcp_servers.codewiki]')
  if (start < 0) return content
  let end = start + 1
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++
  const next = [...lines.slice(0, start), ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
  return next ? `${next}\n` : ''
}

function configureMcp(projectRoot, enabled, results) {
  const mcpPath = join(projectRoot, '.mcp.json')
  if (enabled) {
    let mcp = {}
    if (existsSync(mcpPath)) {
      try { mcp = JSON.parse(readFileSync(mcpPath, 'utf8')) } catch { mcp = {} }
    }
    mcp.mcpServers = mcp.mcpServers || {}
    mcp.mcpServers.codewiki = { command: 'npx', args: ['-y', 'codewiki', 'mcp'] }
    writeFileSync(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`, 'utf8')
    results.push(`mcp: ${mcpPath}`)
  } else if (existsSync(mcpPath)) {
    try {
      const mcp = JSON.parse(readFileSync(mcpPath, 'utf8'))
      if (mcp.mcpServers?.codewiki) {
        delete mcp.mcpServers.codewiki
        if (Object.keys(mcp.mcpServers).length === 0) delete mcp.mcpServers
        writeFileSync(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`, 'utf8')
        results.push('mcp: 已移除 codewiki 配置（默认使用 Skills）')
      }
    } catch {
      results.push('mcp: .mcp.json 无法解析，未修改')
    }
  }

  const codexConfigPath = join(projectRoot, '.codex', 'config.toml')
  if (enabled) {
    mkdirSync(dirname(codexConfigPath), { recursive: true })
    const content = existsSync(codexConfigPath) ? readFileSync(codexConfigPath, 'utf8') : ''
    writeFileSync(codexConfigPath, upsertCodexMcp(content), 'utf8')
    results.push(`codex-mcp: ${codexConfigPath}`)
  } else if (existsSync(codexConfigPath)) {
    const content = readFileSync(codexConfigPath, 'utf8')
    const next = removeCodexMcp(content)
    if (next !== content) {
      writeFileSync(codexConfigPath, next, 'utf8')
      results.push('codex-mcp: 已移除 codewiki 配置（默认使用 Skills）')
    }
  }
}

function claudePermissionRules(config) {
  const knowledgePath = `./${config.knowledgeRoot.replace(/\\/g, '/')}/**`
  return [
    'Read(./**)',
    `Edit(${knowledgePath})`,
    'mcp__codewiki__codewiki_explore',
    ...CODEWIKI_INTERNAL_COMMANDS.flatMap(command => [
      `Bash(npx codewiki ${command})`,
      `Bash(npx codewiki ${command} *)`,
    ]),
  ]
}

function configureClaudePermissions(projectRoot, config, enabled, results) {
  const settingsPath = join(projectRoot, CLAUDE_SETTINGS_LOCAL)
  if (!enabled && !existsSync(settingsPath)) return
  let settings = {}
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    } catch {
      results.push(`permissions: ${CLAUDE_SETTINGS_LOCAL} 无法解析，未修改`)
      return
    }
  }
  const managedRules = new Set(claudePermissionRules(config))
  const currentRules = Array.isArray(settings.permissions?.allow) ? settings.permissions.allow : []
  const currentServers = Array.isArray(settings.enabledMcpjsonServers) ? settings.enabledMcpjsonServers : []
  const allow = enabled
    ? [...new Set([...currentRules, ...managedRules])]
    : currentRules.filter(rule => !managedRules.has(rule))
  const enabledServers = enabled
    ? [...new Set([...currentServers, 'codewiki'])]
    : currentServers.filter(server => server !== 'codewiki')

  if (!settings.$schema) settings.$schema = 'https://json.schemastore.org/claude-code-settings.json'
  settings.permissions = settings.permissions && typeof settings.permissions === 'object' ? settings.permissions : {}
  if (allow.length > 0) settings.permissions.allow = allow
  else delete settings.permissions.allow
  if (Object.keys(settings.permissions).length === 0) delete settings.permissions
  if (enabledServers.length > 0) settings.enabledMcpjsonServers = enabledServers
  else delete settings.enabledMcpjsonServers
  const remainingKeys = Object.keys(settings).filter(key => key !== '$schema')
  if (!enabled && remainingKeys.length === 0) {
    rmSync(settingsPath, { force: true })
    results.push(`removed: ${CLAUDE_SETTINGS_LOCAL}`)
    return
  }
  mkdirSync(dirname(settingsPath), { recursive: true })
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  results.push(`claude-permissions: ${enabled ? '已放行项目读取、知识写入、MCP 与 CodeWiki 内部命令' : '已移除 CodeWiki 本地权限'}`)
}

function codexRulesContent() {
  const commands = CODEWIKI_INTERNAL_COMMANDS.map(command => `"${command}"`).join(', ')
  return `# Managed by codewiki. Allows only CodeWiki's internal workflow commands.\nprefix_rule(\n    pattern = ["npx", "codewiki", [${commands}]],\n    decision = "allow",\n    justification = "CodeWiki reads the current repository and writes its project-local knowledge base",\n    match = [\n        "npx codewiki generate src --module orders",\n        "npx codewiki query --feedback good --retrieval-id ret:example",\n        "npx codewiki preview --export",\n        "npx codewiki confidence --module orders --json",\n    ],\n    not_match = [\n        "npx codewiki init",\n        "npx codewiki upgrade",\n        "npx codewiki uninstall",\n    ],\n)\n`
}

function configureCodexPermissions(projectRoot, enabled, results) {
  const rulesPath = join(projectRoot, CODEX_RULES_FILE)
  if (!enabled) {
    if (existsSync(rulesPath)) {
      rmSync(rulesPath, { force: true })
      results.push(`removed: ${CODEX_RULES_FILE}`)
    }
    return
  }
  mkdirSync(dirname(rulesPath), { recursive: true })
  writeFileSync(rulesPath, codexRulesContent(), 'utf8')
  results.push(`codex-permissions: ${CODEX_RULES_FILE}`)
}

function removeManagedPaths(projectRoot, paths, results) {
  for (const managedPath of paths) {
    const target = join(projectRoot, managedPath)
    if (!existsSync(target)) continue
    rmSync(target, { recursive: true, force: true })
    results.push(`removed: ${managedPath}`)
  }
}

function removeLegacyInstructionSections(projectRoot, results) {
  for (const instructionFile of LEGACY_INSTRUCTION_FILES) {
    const target = join(projectRoot, instructionFile)
    if (!existsSync(target)) continue
    const content = readFileSync(target, 'utf8')
    const lines = content.replace(/\r\n/g, '\n').split('\n')
    const kept = []
    let removing = false
    let found = false
    for (const line of lines) {
      if (/^##\s+fe-scan\b/i.test(line.trim())) {
        removing = true
        found = true
        continue
      }
      if (removing && /^##\s+/.test(line.trim())) removing = false
      if (!removing) kept.push(line)
    }
    if (!found) continue
    const next = `${kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
    writeFileSync(target, next, 'utf8')
    results.push(`removed: ${instructionFile} 中的 fe-scan 旧规则`)
  }
}

function gitignoreRules(config) {
  const stateContainsKnowledge = config.knowledgeRoot.startsWith(`${config.stateRoot}/`)
  if (!stateContainsKnowledge) return [`${config.stateRoot}/`, '**/.claude/settings.local.json']
  return [
    ...LOCAL_STATE_DIRS.map(name => `${config.stateRoot}/${name}/`),
    ...LOCAL_STATE_FILES.map(name => `${config.stateRoot}/${name}`),
    `${config.knowledgeRoot}/*/_intermediate/`,
    `${config.knowledgeRoot}/*/.archive/`,
    `${config.knowledgeRoot}/*.v36-stage/`,
    '**/.claude/settings.local.json',
  ]
}

export function runInit(options = {}) {
  const projectRoot = resolve(options.projectRoot || process.cwd())
  const results = []

  // 1. 显式配置共享知识目录与本地状态目录。
  const configPath = join(projectRoot, CONFIG_FILE)
  if (!existsSync(configPath)) {
    const existingKnowledgeRoot = knowledgeRootRelative(projectRoot)
    writeFileSync(configPath, `knowledge_root: ${existingKnowledgeRoot}\nstate_root: .codewiki\n`, 'utf8')
    results.push(`config: ${CONFIG_FILE}`)
  }
  const config = loadProjectConfig(projectRoot)

  const instructionsPath = join(config.stateRootPath, 'INSTRUCTIONS.md')
  if (!existsSync(instructionsPath)) {
    mkdirSync(dirname(instructionsPath), { recursive: true })
    writeFileSync(instructionsPath, `# codewiki 生成说明\n\n## 重点业务模块\n\n- 请填写需要优先沉淀的模块。\n\n## Source Units\n\n- Monorepo 中请说明同一业务模块包含哪些前端、后端 Workspace；不要按语言拆成不同业务模块。\n\n## 业务术语\n\n- 请填写代码名与业务名的对应关系。\n\n## 关键问题\n\n- 请填写产品、测试和研发必须能稳定检索的问题。\n\n## 证据与边界\n\n- 代码事实必须有 file:line；无法证实的业务原因先向用户确认。\n- 请填写排除目录、敏感信息和不可进入知识库的内容。\n`, 'utf8')
    results.push(`instructions: ${instructionsPath}`)
  }

  // 2. 同一份 Agent Skill 安装到 Claude Code 与 Codex 的项目目录。
  copyTree(join(PACKAGE_ROOT, 'skills'), join(projectRoot, '.claude', 'skills'), 'claude-skill', results)
  copyTree(join(PACKAGE_ROOT, 'skills'), join(projectRoot, '.agents', 'skills'), 'codex-skill', results)
  removeManagedPaths(projectRoot, LEGACY_INTEGRATIONS, results)
  removeLegacyInstructionSections(projectRoot, results)

  // 3. 工作流参考文档只作为本地运行资源，不进入共享知识索引。
  const workflowDir = join(config.stateRootPath, 'workflow')
  mkdirSync(workflowDir, { recursive: true })
  copyFileSync(join(PACKAGE_ROOT, 'docs', 'agent-workflow.md'), join(workflowDir, 'agent-workflow.md'))
  results.push('workflow: agent-workflow.md')
  copyTree(join(PACKAGE_ROOT, 'docs', 'references'), join(workflowDir, 'references'), 'workflow-reference', results)

  // 4. Skills 负责按需编排，MCP 提供检索通道；初始化与升级都必须配置。
  configureMcp(projectRoot, true, results)
  configureClaudePermissions(projectRoot, config, true, results)
  configureCodexPermissions(projectRoot, true, results)

  // 5. 只忽略运行状态；.codewiki/modules 保持可提交。
  const gitignorePath = join(projectRoot, '.gitignore')
  const current = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : ''
  const rules = gitignoreRules(config)
  const broadStateRules = new Set([config.stateRoot, `${config.stateRoot}/`])
  const stateContainsKnowledge = config.knowledgeRoot.startsWith(`${config.stateRoot}/`)
  const lines = current.split(/\r?\n/)
  const kept = stateContainsKnowledge ? lines.filter(line => !broadStateRules.has(line.trim())) : lines
  const existingRules = new Set(kept.map(line => line.trim()))
  const missingRules = rules.filter(rule => !existingRules.has(rule))
  if (missingRules.length > 0 || kept.length !== lines.length) {
    const prefix = kept.join('\n').trimEnd()
    writeFileSync(gitignorePath, `${prefix}${prefix ? '\n' : ''}${missingRules.join('\n')}\n`, 'utf8')
    results.push(`gitignore: 已忽略 ${config.stateRoot} 本地运行产物与 Claude 本地权限`)
  }

  const action = options.mode === 'upgrade' ? '升级' : '初始化'
  process.stdout.write(`[codewiki] ${action}完成（${projectRoot}）\n`)
  for (const item of results) process.stdout.write(`  - ${item}\n`)
  process.stdout.write('\n[codewiki] 下一步：\n')
  process.stdout.write('  1. 重启 Claude Code 或 Codex，使项目 Skills 生效\n')
  process.stdout.write('  2. 直接说“为 <模块> 生成知识库”或“更新 <模块> 知识库”\n')
  process.stdout.write('  3. 直接提出业务问题；回答后可反馈“有帮助”或“没帮助”\n')
  process.stdout.write('  4. 说“预览知识库”或“检查知识置信度”查看质量\n')
  process.stdout.write('  提示：Skills 按需加载，知识检索通过 codewiki MCP 完成。\n')
  return 0
}

export function runUpgrade(options = {}) {
  const projectRoot = resolve(options.projectRoot || process.cwd())
  if (!existsSync(join(projectRoot, CONFIG_FILE))) {
    throw new Error('当前项目尚未初始化，请先运行 npx codewiki init')
  }
  const code = runInit({ ...options, projectRoot, mode: 'upgrade' })
  if (code !== 0) return code
  const promoted = promoteGoodFeedbackCases(projectRoot)
  if (promoted > 0) process.stdout.write(`[codewiki] 已从历史好评补齐 ${promoted} 个 feedback Case\n`)
  return 0
}

export function runUninstall(options = {}) {
  const projectRoot = resolve(options.projectRoot || process.cwd())
  const config = loadProjectConfig(projectRoot)
  const results = []
  const skillNames = existsSync(join(PACKAGE_ROOT, 'skills'))
    ? readdirSync(join(PACKAGE_ROOT, 'skills'), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
    : []

  const currentIntegrations = ['.claude/skills', '.agents/skills']
    .flatMap(hostRoot => skillNames.map(skillName => `${hostRoot}/${skillName}`))
  removeManagedPaths(projectRoot, [...currentIntegrations, ...LEGACY_INTEGRATIONS], results)

  const workflowDir = join(config.stateRootPath, 'workflow')
  if (existsSync(workflowDir)) {
    rmSync(workflowDir, { recursive: true, force: true })
    results.push(`removed: ${relative(projectRoot, workflowDir).replace(/\\/g, '/')}`)
  }
  configureMcp(projectRoot, false, results)
  configureClaudePermissions(projectRoot, config, false, results)
  configureCodexPermissions(projectRoot, false, results)

  process.stdout.write(`[codewiki] 卸载完成（${projectRoot}）\n`)
  if (results.length === 0) process.stdout.write('  - 未发现已安装的 codewiki 集成\n')
  else for (const item of results) process.stdout.write(`  - ${item}\n`)
  process.stdout.write('\n[codewiki] 已保留团队知识资产：\n')
  process.stdout.write(`  - ${CONFIG_FILE}\n`)
  process.stdout.write(`  - ${relative(projectRoot, join(config.stateRootPath, 'INSTRUCTIONS.md')).replace(/\\/g, '/')}\n`)
  process.stdout.write(`  - ${config.knowledgeRoot}/\n`)
  process.stdout.write('  如需删除这些内容，请在确认不再需要团队知识后手动处理。\n')
  return 0
}
