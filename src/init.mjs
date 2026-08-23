// codewiki init — 在目标项目中初始化 codewiki：Claude Code 指令、MCP 配置、工作流文档、gitignore。
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BIN_PATH = join(PACKAGE_ROOT, 'bin', 'codewiki.js')

function copyTree(srcDir, destDir, label, results) {
  if (!existsSync(srcDir)) return
  mkdirSync(destDir, { recursive: true })
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const src = join(srcDir, entry.name)
    const dest = join(destDir, entry.name)
    if (entry.isDirectory()) copyTree(src, dest, label, results)
    else if (entry.isFile()) {
      copyFileSync(src, dest)
      results.push(`${label}: ${entry.name}`)
    }
  }
}

export function runInit(options = {}) {
  const projectRoot = resolve(options.projectRoot || process.cwd())
  const results = []

  // 1. Claude Code 指令（/wiki-scan、/wiki-explore）
  const commandsDir = join(projectRoot, '.claude', 'commands')
  copyTree(join(PACKAGE_ROOT, 'commands'), commandsDir, 'command', results)

  // 2. Agent 工作流文档（指令按此执行，随 init 版本化在项目本地）
  copyTree(join(PACKAGE_ROOT, 'docs'), join(projectRoot, '.codewiki', 'workflow'), 'workflow', results)

  // 3. MCP 配置合并到项目 .mcp.json
  const mcpPath = join(projectRoot, '.mcp.json')
  let mcp = {}
  if (existsSync(mcpPath)) {
    try { mcp = JSON.parse(readFileSync(mcpPath, 'utf8')) } catch { mcp = {} }
  }
  mcp.mcpServers = mcp.mcpServers || {}
  mcp.mcpServers.codewiki = { command: process.execPath, args: [BIN_PATH, 'mcp'] }
  writeFileSync(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`, 'utf8')
  results.push(`mcp: ${mcpPath}（server: codewiki）`)

  // 4. .gitignore 追加 .codewiki/
  const gitignorePath = join(projectRoot, '.gitignore')
  const current = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : ''
  if (!current.split(/\r?\n/).some(line => line.trim() === '.codewiki/' || line.trim() === '.codewiki')) {
    writeFileSync(gitignorePath, `${current.replace(/\n*$/, '\n')}.codewiki/\n`, 'utf8')
    results.push('gitignore: .codewiki/')
  }

  process.stdout.write(`[codewiki] 初始化完成（${projectRoot}）\n`)
  for (const item of results) process.stdout.write(`  - ${item}\n`)
  process.stdout.write('\n[codewiki] 下一步：\n')
  process.stdout.write('  1. 重启 Claude Code 使指令与 MCP 生效\n')
  process.stdout.write('  2. /wiki-scan <目标路径>   建立模块知识库\n')
  process.stdout.write('  3. /wiki-explore           用真实问题验证检索并评级\n')
  process.stdout.write('  4. codewiki preview       浏览器查看知识库站点\n')
  return 0
}
