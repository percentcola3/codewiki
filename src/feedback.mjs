// codewiki feedback / case — wiki-explore 的评级记录与差评反哺。
//
//   codewiki feedback record --rating good|bad --query "..." [--module M]
//         [--retrieval-id ret_xxx] [--comment "..."]
//       追加 .codewiki/feedback.jsonl；retrieval_id 关联 MCP 检索命中记录。
//
//   codewiki case add --module orders --title "退款条件" --question "什么情况下允许退款？"
//         --answer "..." --evidence src/views/order/refund.vue:42 [--evidence ...] [--unverified]
//       追加 .codewiki/knowledge-overlay/<module>.jsonl（source=user，默认 verified），
//       `codewiki index` 后即可被检索命中，并计入 confidence 场景覆盖。
import { createHash } from 'node:crypto'
import { appendFileSync as appendFile, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

function stateDir(projectRoot) {
  return join(projectRoot, '.codewiki')
}

function appendJsonl(filePath, record) {
  mkdirSync(dirname(filePath), { recursive: true })
  appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8')
}

function slug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
}

export function runFeedback({ sub, rating, query, retrievalId, module, comment, projectRoot }) {
  if (sub !== 'record') {
    process.stderr.write('[codewiki] 用法: codewiki feedback record --rating good|bad --query "..." [--module M] [--retrieval-id ID] [--comment "..."]\n')
    return 1
  }
  if (!['good', 'bad'].includes(rating)) {
    process.stderr.write('[codewiki] --rating 必须是 good 或 bad\n')
    return 1
  }
  if (!query || !query.trim()) {
    process.stderr.write('[codewiki] --query 不能为空\n')
    return 1
  }
  const record = {
    at: new Date().toISOString(),
    query: query.trim(),
    module: module || null,
    rating,
    ...(retrievalId ? { retrieval_id: retrievalId } : {}),
    ...(comment ? { comment } : {}),
  }
  appendJsonl(join(stateDir(projectRoot), 'feedback.jsonl'), record)
  process.stdout.write(`[codewiki] 已记录评级 ${rating}：${query.trim().slice(0, 60)}${retrievalId ? `（retrieval_id=${retrievalId}）` : ''}\n`)
  return 0
}

export function runCaseAdd(options) {
  const { module, title, question, answer, evidence, verified, projectRoot } = options
  const missing = ['module', 'title', 'question', 'answer'].filter(key => !options[key] || !String(options[key]).trim())
  if (missing.length > 0) {
    process.stderr.write(`[codewiki] case add 缺少必填参数: ${missing.map(key => `--${key}`).join(' ')}\n`)
    return 1
  }
  if (!Array.isArray(evidence) || evidence.length === 0) {
    process.stderr.write('[codewiki] case add 至少需要一条 --evidence <file:line>（反捏造约束：知识必须可追证）\n')
    return 1
  }
  const moduleName = module.trim()
  const id = `kb-case:${slug(moduleName) || 'case'}:${createHash('sha1').update(`${moduleName}\n${title}\n${question}`).digest('hex').slice(0, 8)}`
  const questions = question.split(/\n|\n?,\s*/).map(item => item.trim()).filter(Boolean)
  const record = {
    id,
    module: moduleName,
    status: 'active',
    kind: 'feedback',
    source: 'user',
    verified: verified !== false,
    title: title.trim(),
    questions,
    answer: answer.trim(),
    evidence_refs: evidence,
    at: new Date().toISOString(),
  }
  const overlayPath = join(stateDir(projectRoot), 'knowledge-overlay', `${encodeURIComponent(moduleName)}.jsonl`)
  // 幂等：同 id 已存在时跳过
  if (existsSync(overlayPath)) {
    const duplicate = readFileSync(overlayPath, 'utf8').split(/\r?\n/).some(line => {
      try { return JSON.parse(line).id === id } catch { return false }
    })
    if (duplicate) {
      process.stdout.write(`[codewiki] case 已存在：${id}\n`)
      return 0
    }
  }
  appendJsonl(overlayPath, record)
  process.stdout.write(`[codewiki] 已增补知识 case：${id}\n`)
  process.stdout.write(`[codewiki] 运行 codewiki index 后即可被检索命中；confidence 场景覆盖将计入本条（verified=${record.verified}）\n`)
  return 0
}
