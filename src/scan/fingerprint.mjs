/**
 * fingerprint.mjs — 文件级 / 页面级结构指纹计算（T1）
 *
 * 用途：--update 增量模式下判定变更等级（NONE / COSMETIC / STRUCTURAL / FIELD-ONLY）
 *
 * 三种指纹（对应方案 §6.2）：
 *   - hash（兼容 contentHash） SHA-1(源码全文)                              nav-parser Stage 1
 *   - structuralFingerprint    SHA-1(sorted[imports+exports+funcs+bindings]) nav-parser Stage 1
 *   - fieldFingerprint         SHA-1(sorted[fields.id+source_apis+transforms])  field-lineage.mjs 回填
 *
 * 归一化要点（避免误报 STRUCTURAL）：
 *   - 全部 sort 后拼串
 *   - 只用 name/signature/kind/path 等语义键，剔除 line/mtime/at 等易变字段
 *   - 空数组和 undefined 归一为空串，保证顺序无关
 */
import { createHash } from 'node:crypto'

function sha1(str) {
  return createHash('sha1').update(str).digest('hex')
}

function joinSorted(arr, mapper) {
  if (!Array.isArray(arr) || arr.length === 0) return ''
  return arr.map(mapper).filter(Boolean).sort().join('|')
}

const VOLATILE_KEYS = new Set(['line', 'at', 'evidence', 'generated_at'])

function stableSemanticValue(value) {
  if (Array.isArray(value)) return value.map(stableSemanticValue).sort().join(',')
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .filter(key => !VOLATILE_KEYS.has(key))
      .sort()
      .map(key => `${key}:${stableSemanticValue(value[key])}`)
      .join(',')
  }
  return value == null ? '' : String(value)
}

// 输入 nav-parser 已经抽好的 imports/exports/functions/template_bindings（file 级），产 structuralFingerprint
export function computeStructuralFingerprint({
  imports = [],
  exports = [],
  functions = [],
  templateBindings = [],
}) {
  const importsPart = joinSorted(imports, i => {
    const src = i.source || ''
    const specs = joinSorted(i.namedImports || [], n => n.name || '')
    return `imp:${src}#${specs}${i.default ? '#default' : ''}${i.namespace ? '#ns' : ''}`
  })
  const exportsPart = joinSorted(exports, e => `exp:${e.name}:${e.type || 'unknown'}`)
  const funcsPart = joinSorted(functions, f => {
    const params = joinSorted(f.params || [], p => `${p.name || ''}:${p.type || ''}`)
    const ret = f.return_type || ''
    return `fn:${f.name}(${params})->${ret}`
  })
  const bindingsPart = joinSorted(templateBindings, b => `tb:${b.path}:${b.kind}${b.editable ? ':W' : ''}`)
  return sha1([importsPart, exportsPart, funcsPart, bindingsPart].join('||'))
}

// 输入 field-lineage 每个页面的 fields，产 fieldFingerprint（页面级）
export function computeFieldFingerprint(fields = []) {
  const part = joinSorted(fields, f => {
    const apis = joinSorted(f.source_apis || [], stableSemanticValue)
    const transforms = joinSorted(f.transforms || [], stableSemanticValue)
    const conditions = stableSemanticValue(f.display_conditions || [])
    const abnormalStates = stableSemanticValue(f.abnormal_states || [])
    return [
      f.id,
      f.path,
      f.editable ? 'W' : 'R',
      f.display_name || '',
      f.display_position || '',
      apis,
      transforms,
      conditions,
      abnormalStates,
    ].join('|')
  })
  return sha1(part)
}

// 用于 --update 判档：给两组 fingerprint 判定变更等级
// 返回 'NONE' | 'COSMETIC' | 'STRUCTURAL' | 'FIELD_ONLY'
export function classifyChange(prev, curr) {
  if (!prev || !curr) return 'STRUCTURAL' // 缺一方按最保守走

  const prevField = prev.fieldFingerprint ?? prev.fingerprint
  const currField = curr.fieldFingerprint ?? curr.fingerprint
  const hasFieldFingerprint = prevField != null || currField != null
  const prevContent = prev.contentHash ?? prev.hash
  const currContent = curr.contentHash ?? curr.hash
  const hasContentHash = prevContent != null || currContent != null

  // page_fingerprints entries only carry `fingerprint`; compare those directly.
  if (!hasContentHash && hasFieldFingerprint) {
    return prevField === currField ? 'NONE' : 'FIELD_ONLY'
  }

  // Missing one side means an old/new schema boundary; take the safe path.
  if (prevContent == null || currContent == null) return 'STRUCTURAL'
  const prevStructural = prev.structuralFingerprint
  const currStructural = curr.structuralFingerprint
  if ((prevStructural == null) !== (currStructural == null)) return 'STRUCTURAL'
  if (prevStructural !== currStructural) return 'STRUCTURAL'
  if (prevContent === currContent) return 'NONE'
  if (hasFieldFingerprint && prevField !== currField) return 'FIELD_ONLY'
  return 'COSMETIC'
}
