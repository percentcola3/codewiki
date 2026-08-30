import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { knowledgeRootRelative, loadProjectConfig } from '../src/config.mjs'
import { runInit } from '../src/init.mjs'

test('knowledge root defaults to repository .codewiki', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'codewiki-config-'))
  try {
    assert.equal(knowledgeRootRelative(projectRoot), '.codewiki/modules')
    mkdirSync(join(projectRoot, '.codewiki', 'modules'), { recursive: true })
    assert.equal(knowledgeRootRelative(projectRoot), '.codewiki/modules')
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('project config rejects roots outside the repo or overlapping state', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'codewiki-config-'))
  try {
    writeFileSync(join(projectRoot, 'codewiki.yml'), 'knowledge_root: ../shared\nstate_root: .codewiki\n')
    assert.throws(() => loadProjectConfig(projectRoot), /不能指向仓库外/)
    writeFileSync(join(projectRoot, 'codewiki.yml'), 'knowledge_root: .state/modules\nstate_root: .state\n')
    assert.throws(() => loadProjectConfig(projectRoot), /不能重叠/)
    writeFileSync(join(projectRoot, 'codewiki.yml'), 'knowledge_root: .codewiki/modules\nstate_root: .codewiki/modules/cache\n')
    assert.throws(() => loadProjectConfig(projectRoot), /不能重叠/)
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('init creates trackable project instructions without overwriting user content', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'codewiki-instructions-'))
  try {
    runInit({ projectRoot })
    const instructionsPath = join(projectRoot, '.codewiki', 'INSTRUCTIONS.md')
    assert.ok(existsSync(instructionsPath))
    assert.match(readFileSync(instructionsPath, 'utf8'), /重点业务模块/)
    writeFileSync(instructionsPath, '# 团队自定义说明', 'utf8')
    runInit({ projectRoot })
    assert.equal(readFileSync(instructionsPath, 'utf8'), '# 团队自定义说明')
    assert.doesNotMatch(readFileSync(join(projectRoot, '.gitignore'), 'utf8'), /INSTRUCTIONS\.md/)
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('init removes fe-scan integrations and managed instruction blocks', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'codewiki-legacy-fe-scan-'))
  try {
    const legacySkill = join(projectRoot, '.claude', 'skills', 'fe-scan')
    mkdirSync(legacySkill, { recursive: true })
    writeFileSync(join(legacySkill, 'SKILL.md'), '# old fe-scan\n', 'utf8')
    const instructionsPath = join(projectRoot, 'CLAUDE.md')
    writeFileSync(instructionsPath, '# Team rules\n\n## fe-scan (module scanner)\nold managed rule\n\n## Keep me\nteam content\n', 'utf8')

    runInit({ projectRoot })

    assert.equal(existsSync(legacySkill), false)
    const instructions = readFileSync(instructionsPath, 'utf8')
    assert.doesNotMatch(instructions, /fe-scan/)
    assert.match(instructions, /## Keep me\nteam content/)
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
  }
})
