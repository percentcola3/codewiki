import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'

const EXCLUDED_DIRS = new Set([
  '.codewiki', '.git', '.idea', '.next', '.nuxt', '.output', '.turbo',
  'build', 'coverage', 'dist', 'node_modules', 'target', 'vendor',
])
const SOURCE_EXTENSIONS = new Set(['.cjs', '.go', '.java', '.js', '.jsx', '.mjs', '.ts', '.tsx', '.vue'])
const MANIFEST_FILES = new Set(['build.gradle', 'build.gradle.kts', 'go.mod', 'package.json', 'pom.xml'])

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '') || '.'
}

function isInside(filePath, parent) {
  const rel = relative(resolve(parent), resolve(filePath))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function readJson(filePath, fallback = null) {
  try { return JSON.parse(readFileSync(filePath, 'utf8')) } catch { return fallback }
}

function readText(filePath, fallback = '') {
  try { return readFileSync(filePath, 'utf8') } catch { return fallback }
}

function readProjectYaml(projectRoot) {
  const path = join(projectRoot, 'codewiki.yml')
  if (!existsSync(path)) return {}
  try { return parseYaml(readFileSync(path, 'utf8')) || {} } catch { return {} }
}

function declaredVersion(packageJson, name) {
  const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
  for (const section of sections) {
    const value = packageJson?.[section]?.[name]
    if (value) return String(value)
  }
  return null
}

function versionParts(value) {
  const match = String(value || '').match(/(?:^|[^\d])(\d+)\.(\d+)(?:\.(\d+))?/)
  if (!match) return { raw: value || null, major: null, minor: null, patch: null }
  return {
    raw: value,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] == null ? null : Number(match[3]),
  }
}

function resolvedPackageVersion(projectRoot, unitPath, packageName, declared) {
  const rel = normalizePath(relative(projectRoot, unitPath))
  for (const lockPath of [...new Set([join(unitPath, 'package-lock.json'), join(projectRoot, 'package-lock.json')])]) {
    const packageLock = readJson(lockPath)
    if (packageLock?.packages) {
      const candidates = lockPath === join(unitPath, 'package-lock.json')
        ? [`node_modules/${packageName}`]
        : [rel === '.' ? `node_modules/${packageName}` : `${rel}/node_modules/${packageName}`, `node_modules/${packageName}`]
      for (const key of candidates) {
        if (packageLock.packages[key]?.version) {
          return { value: packageLock.packages[key].version, source: normalizePath(relative(projectRoot, lockPath)) }
        }
      }
    }
  }

  const pnpmLockPath = join(projectRoot, 'pnpm-lock.yaml')
  if (existsSync(pnpmLockPath)) {
    try {
      const lock = parseYaml(readFileSync(pnpmLockPath, 'utf8')) || {}
      const rel = normalizePath(relative(projectRoot, unitPath))
      const importer = lock.importers?.[rel] || lock.importers?.['.']
      for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        const item = importer?.[section]?.[packageName]
        const value = typeof item === 'string' ? item : item?.version
        if (value) return { value: String(value), source: 'pnpm-lock.yaml' }
      }
    } catch {
      // package.json still provides a reliable major-version fallback.
    }
  }

  return { value: declared, source: declared ? 'package.json' : null }
}

function vueFeatures(version) {
  const { major, minor } = versionParts(version)
  if (major === 2) {
    const features = ['options-api', 'mixins', 'filters', 'legacy-v-model', 'vue-extend']
    if (minor != null && minor >= 7) features.push('composition-api', 'script-setup')
    return features
  }
  if (major === 3) {
    const features = ['options-api', 'composition-api', 'script-setup', 'model-value']
    if (minor != null && minor >= 4) features.push('define-model')
    if (minor != null && minor >= 5) features.push('reactive-props-destructure')
    return features
  }
  return ['options-api', 'composition-api', 'script-setup']
}

function reactFeatures(version) {
  const { major, minor } = versionParts(version)
  const features = ['class-components', 'function-components']
  if (major == null || major > 16 || (major === 16 && Number(minor || 0) >= 8)) features.push('hooks')
  if (major != null && major >= 17) features.push('automatic-jsx-runtime')
  else features.push('classic-jsx-runtime')
  if (major != null && major >= 18) features.push('create-root', 'suspense')
  if (major != null && major >= 19) features.push('actions', 'use-api', 'server-components')
  return features
}

function packageProfiles(projectRoot, dir, overrides = {}) {
  const pkg = readJson(join(dir, 'package.json'), {})
  const vueDeclared = declaredVersion(pkg, 'vue')
  const reactDeclared = declaredVersion(pkg, 'react')
  const profiles = []
  const overrideVersion = overrides.version ?? overrides.framework_version

  if (overrides.framework === 'vue' || (!overrides.framework && vueDeclared)) {
    const resolved = overrideVersion && overrideVersion !== 'auto'
      ? { value: String(overrideVersion), source: 'codewiki.yml' }
      : resolvedPackageVersion(projectRoot, dir, 'vue', vueDeclared)
    profiles.push({
      language: overrides.language || 'typescript',
      framework: 'vue',
      version: resolved.value,
      version_source: resolved.source,
      features: vueFeatures(resolved.value),
    })
  }

  if (overrides.framework === 'react' || (!overrides.framework && reactDeclared)) {
    const resolved = overrideVersion && overrideVersion !== 'auto'
      ? { value: String(overrideVersion), source: 'codewiki.yml' }
      : resolvedPackageVersion(projectRoot, dir, 'react', reactDeclared)
    profiles.push({
      language: overrides.language || 'typescript',
      framework: 'react',
      version: resolved.value,
      version_source: resolved.source,
      features: reactFeatures(resolved.value),
    })
  }

  if (profiles.length === 0 && existsSync(join(dir, 'package.json'))) {
    profiles.push({
      language: overrides.language || 'typescript',
      framework: overrides.framework || 'generic-js',
      version: overrideVersion && overrideVersion !== 'auto' ? String(overrideVersion) : null,
      version_source: overrideVersion && overrideVersion !== 'auto' ? 'codewiki.yml' : null,
      features: [],
    })
  }
  return profiles
}

function javaProfile(dir, overrides = {}) {
  const build = `${readText(join(dir, 'pom.xml'))}\n${readText(join(dir, 'build.gradle'))}\n${readText(join(dir, 'build.gradle.kts'))}`
  const spring = /org\.springframework|spring-boot/i.test(build)
  const overrideVersion = overrides.version ?? overrides.framework_version
  return {
    language: 'java',
    framework: overrides.framework || (spring ? 'spring' : 'generic-java'),
    version: overrideVersion && overrideVersion !== 'auto' ? String(overrideVersion) : null,
    version_source: overrideVersion && overrideVersion !== 'auto' ? 'codewiki.yml' : null,
    features: spring ? ['spring-web', 'dependency-injection'] : [],
  }
}

function goProfile(dir, overrides = {}) {
  const mod = readText(join(dir, 'go.mod'))
  let framework = 'generic-go'
  const features = []
  if (/github\.com\/gin-gonic\/gin/.test(mod)) { framework = 'gin'; features.push('http-routing') }
  if (/google\.golang\.org\/grpc/.test(mod)) features.push('grpc')
  const overrideVersion = overrides.version ?? overrides.framework_version
  return {
    language: 'go',
    framework: overrides.framework || framework,
    version: overrideVersion && overrideVersion !== 'auto' ? String(overrideVersion) : null,
    version_source: overrideVersion && overrideVersion !== 'auto' ? 'codewiki.yml' : null,
    features,
  }
}

function profilesForDirectory(projectRoot, dir, overrides = {}) {
  if (overrides.language === 'java') return [javaProfile(dir, overrides)]
  if (overrides.language === 'go') return [goProfile(dir, overrides)]
  if (overrides.language === 'typescript' || overrides.language === 'javascript') return packageProfiles(projectRoot, dir, overrides)

  const profiles = []
  profiles.push(...packageProfiles(projectRoot, dir, overrides))
  if (existsSync(join(dir, 'pom.xml')) || existsSync(join(dir, 'build.gradle')) || existsSync(join(dir, 'build.gradle.kts'))) {
    profiles.push(javaProfile(dir, overrides))
  }
  if (existsSync(join(dir, 'go.mod'))) profiles.push(goProfile(dir, overrides))
  return profiles
}

function manifestDirectories(root, maxDepth = 6) {
  const directories = new Set()
  function visit(dir, depth) {
    if (depth > maxDepth) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    if (entries.some(entry => entry.isFile() && MANIFEST_FILES.has(entry.name))) directories.add(dir)
    for (const entry of entries) {
      if (!entry.isDirectory() || EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      visit(join(dir, entry.name), depth + 1)
    }
  }
  visit(root, 0)
  return [...directories]
}

function hasSourceFiles(dir, maxDepth = 3) {
  function visit(current, depth) {
    if (depth > maxDepth) return false
    let entries
    try { entries = readdirSync(current, { withFileTypes: true }) } catch { return false }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        if (visit(join(current, entry.name), depth + 1)) return true
      } else if (SOURCE_EXTENSIONS.has(extname(entry.name))) return true
    }
    return false
  }
  return visit(dir, 0)
}

function explicitModuleUnits(projectRoot, moduleName) {
  const config = readProjectYaml(projectRoot)
  const modules = Array.isArray(config.modules) ? config.modules : []
  const module = modules.find(item => String(item?.name || '') === String(moduleName || ''))
  if (!module || !Array.isArray(module.source_units)) return []
  return module.source_units.map((item, index) => ({ ...item, _index: index }))
}

function makeUnit(projectRoot, dir, profile, input = {}, index = 0) {
  const path = normalizePath(relative(projectRoot, dir))
  const suffix = profile.language === 'typescript' ? profile.framework : profile.language
  return {
    id: String(input.name || `${basename(dir)}-${suffix || index + 1}`),
    name: String(input.name || basename(dir)),
    path,
    abs_path: dir,
    language: profile.language,
    framework: profile.framework,
    framework_version: profile.version || null,
    version_source: profile.version_source || null,
    features: [...new Set(profile.features || [])],
    confidence: profile.version || profile.language === 'java' || profile.language === 'go' ? 'verified' : 'candidate',
  }
}

export function discoverSourceUnits({ projectRoot = process.cwd(), moduleName = '', target = null } = {}) {
  const root = resolve(projectRoot)
  const explicit = explicitModuleUnits(root, moduleName)
  const units = []

  if (explicit.length > 0) {
    for (const item of explicit) {
      const dir = resolve(root, String(item.path || ''))
      if (!isInside(dir, root)) throw new Error(`source_unit 不能指向仓库外: ${item.path}`)
      if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`source_unit 目录不存在: ${item.path}`)
      const profiles = profilesForDirectory(root, dir, item)
      if (profiles.length === 0) throw new Error(`无法识别 source_unit 的语言: ${item.path}`)
      profiles.forEach((profile, index) => units.push(makeUnit(root, dir, profile, item, index)))
    }
    return dedupeUnits(units)
  }

  if (!target) return []
  const absTarget = resolve(root, target)
  if (!isInside(absTarget, root)) throw new Error(`目标目录不能指向仓库外: ${target}`)
  if (!existsSync(absTarget) || !statSync(absTarget).isDirectory()) throw new Error(`目标目录不存在: ${target}`)

  let directories = manifestDirectories(absTarget)
  const nested = directories.filter(dir => dir !== absTarget)
  if (nested.length > 0 && readJson(join(absTarget, 'package.json'))?.workspaces) {
    directories = directories.filter(dir => dir !== absTarget || hasSourceFiles(join(absTarget, 'src'), 2))
  }
  if (directories.length === 0) directories = [absTarget]
  for (const dir of directories) {
    let profiles = profilesForDirectory(root, dir)
    // A common invocation targets `src/`, while package.json lives at the
    // workspace root. Reuse the root package profile without widening files.
    if (profiles.length === 0 && dir !== root) profiles = profilesForDirectory(root, root)
    for (const [index, profile] of profiles.entries()) units.push(makeUnit(root, dir, profile, {}, index))
  }
  return dedupeUnits(units)
}

function dedupeUnits(units) {
  const seen = new Map()
  for (const unit of units) {
    const key = `${unit.path}\n${unit.language}\n${unit.framework}`
    if (!seen.has(key)) seen.set(key, unit)
  }
  const ids = new Map()
  return [...seen.values()].sort((a, b) => `${a.path}:${a.language}`.localeCompare(`${b.path}:${b.language}`)).map(unit => {
    const count = (ids.get(unit.id) || 0) + 1
    ids.set(unit.id, count)
    return count === 1 ? unit : { ...unit, id: `${unit.id}-${count}` }
  })
}

export function isFrontendSourceUnit(unit) {
  return ['typescript', 'javascript'].includes(unit?.language)
}

export function sourceUnitSummary(unit) {
  const version = unit.framework_version ? `@${unit.framework_version}` : ''
  return `${unit.id}=${unit.path} (${unit.framework}${version})`
}
