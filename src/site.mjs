// codewiki site — 把 .codewiki/modules/<module> 的 Markdown 知识库渲染成交互式 HTML 站点。
//
// 产物（.codewiki/site/）：
//   index.html        模块总览（评级徽章、文档统计、全局搜索）
//   <module>.html     模块页（侧边栏文档导航 + 折叠章节 + 证据高亮 + mermaid）
//   site-data.json    客户端搜索索引
//
// 语义层源文件保持 Markdown（frontmatter 供检索引擎/校验器消费），HTML 是浏览视图。
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { MODULES_ROOT, moduleDirs, moduleNameFromManifest } from './scan/knowledge-retrieval.mjs'

const GRADE_COLORS = { A: '#16a34a', B: '#65a30d', C: '#d97706', D: '#ea580c', E: '#dc2626', N_A: '#6b7280' }

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

function parseFrontmatter(content) {
  const match = String(content || '').match(/^---\s*\n([\s\S]*?)\n---\s*\n?/)
  if (!match) return { data: {}, body: String(content || '') }
  const data = {}
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (!m) continue
    const [, key, raw] = m
    const value = raw.replace(/^["']|["']$/g, '').trim()
    if (!value) continue
    const inlineList = value.match(/^\[(.*)]$/)
    if (inlineList) {
      const items = inlineList[1].split(',').map(item => item.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
      if (items.length > 0) data[key] = items
    } else data[key] = value
  }
  // 列表项（questions:\n  - xxx）
  let currentList = null
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^\s+-\s+(.+)$/)
    if (item && currentList) { data[currentList].push(item[1].trim()); continue }
    const head = line.match(/^([A-Za-z_][\w-]*):\s*$/)
    if (head) { currentList = head[1]; data[currentList] = [] }
    else if (!line.match(/^\s/)) currentList = null
  }
  return { data, body: content.slice(match[0].length) }
}

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
}

// 证据引用（path/file.ext:123）渲染为可复制的高亮 chip
function withEvidenceChips(html) {
  return html.replace(/([^<"'\w])([\w./@-]+\.(?:vue|ts|js|tsx|jsx|mjs|cjs|json|yml|yaml)):(\d+)\b/g,
    '$1<span class="ev">$2:$3</span>')
}

function mdToHtml(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n')
  const out = []
  let inCode = false
  let codeLang = ''
  let codeLines = []
  let listType = null
  let tableBuffer = []

  function flushList() {
    if (listType) { out.push(listType === 'ol' ? '</ol>' : '</ul>'); listType = null }
  }

  function flushTable() {
    if (tableBuffer.length === 0) return
    const rows = tableBuffer.filter(row => !/^\s*\|?[\s:|-]+\|?\s*$/.test(row))
    if (rows.length > 0) {
      const cells = row => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(cell => cell.trim())
      const body = rows.map((row, index) => {
        const tag = index === 0 ? 'th' : 'td'
        return `<tr>${cells(row).map(cell => `<${tag}>${inline(cell)}</${tag}>`).join('')}</tr>`
      }).join('')
      out.push(`<table>${body}</table>`)
    }
    tableBuffer = []
  }

  for (const line of lines) {
    const fence = line.match(/^```\s*(\w*)/)
    if (fence) {
      if (inCode) {
        const code = escapeHtml(codeLines.join('\n'))
        out.push(codeLang === 'mermaid'
          ? `<pre class="mermaid">${code}</pre>`
          : `<pre><code>${code}</code></pre>`)
        inCode = false
        codeLines = []
      } else {
        flushList(); flushTable()
        inCode = true
        codeLang = fence[1]
      }
      continue
    }
    if (inCode) { codeLines.push(line); continue }

    if (/^\s*\|.*\|\s*$/.test(line)) { flushList(); tableBuffer.push(line); continue }
    flushTable()

    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      flushList()
      const level = Math.min(heading[1].length + 1, 6)
      out.push(`<h${level} id="${slugify(heading[2])}">${inline(heading[2])}</h${level}>`)
      continue
    }
    const ul = line.match(/^\s*[-*+]\s+(.*)$/)
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/)
    if (ul || ol) {
      const type = ul ? 'ul' : 'ol'
      if (listType !== type) { flushList(); out.push(type === 'ol' ? '<ol>' : '<ul>'); listType = type }
      out.push(`<li>${inline((ul || ol)[1])}</li>`)
      continue
    }
    flushList()
    const quote = line.match(/^>\s?(.*)$/)
    if (quote) { out.push(`<blockquote>${inline(quote[1])}</blockquote>`); continue }
    if (line.trim() === '') continue
    out.push(`<p>${inline(line)}</p>`)
  }
  if (inCode && codeLines.length) out.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
  flushList(); flushTable()
  return withEvidenceChips(out.join('\n'))
}

function slugify(text) {
  return String(text).toLowerCase().replace(/[^\w\u3400-\u9fff]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'section'
}

function collectDocs(moduleDir) {
  const docs = []
  for (const layer of ['product', 'frontend']) {
    const dir = join(moduleDir, layer)
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const { data, body } = parseFrontmatter(readFileSync(join(dir, entry.name), 'utf8'))
      docs.push({
        layer,
        file: `${layer}/${entry.name}`,
        title: data.title || entry.name.replace(/\.md$/, ''),
        aliases: Array.isArray(data.aliases) ? data.aliases : [],
        questions: Array.isArray(data.questions) ? data.questions : [],
        body,
      })
    }
  }
  return docs
}

function moduleGrade(moduleDir) {
  try {
    const report = JSON.parse(readFileSync(join(moduleDir, 'navigation', 'validation-report.json'), 'utf8'))
    const files = report.per_file_confidence || []
    const graded = files.filter(item => item.confidence_v2?.overall_confidence?.score != null)
    if (graded.length === 0) return { grade: 'N_A', score: null }
    const score = graded.reduce((sum, item) => sum + item.confidence_v2.overall_confidence.score, 0) / graded.length
    const grade = score >= 0.9 ? 'A' : score >= 0.7 ? 'B' : score >= 0.5 ? 'C' : score >= 0.3 ? 'D' : 'E'
    return { grade, score: Math.round(score * 100) / 100, validatedAt: report.generated_at, status: report.status }
  } catch { return { grade: 'N_A', score: null } }
}

function countNavNodes(moduleDir) {
  try {
    const graph = JSON.parse(readFileSync(join(moduleDir, 'navigation', 'file-graph.json'), 'utf8'))
    return graph?.data?.nodes?.length || 0
  } catch { return 0 }
}

const CSS = `
:root { --bg:#0f1117; --panel:#171a23; --border:#262b38; --text:#dbe1ec; --muted:#8b93a7; --accent:#5b9dff; }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:14px/1.65 -apple-system,"PingFang SC","Microsoft YaHei",Segoe UI,sans-serif; }
a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }
.layout { display:flex; min-height:100vh; }
.sidebar { width:280px; flex-shrink:0; background:var(--panel); border-right:1px solid var(--border); padding:20px 16px; position:sticky; top:0; height:100vh; overflow-y:auto; }
.sidebar h1 { font-size:16px; margin:0 0 4px; }
.sidebar .crumb { color:var(--muted); font-size:12px; margin-bottom:16px; }
.sidebar input[type=search] { width:100%; padding:8px 10px; background:var(--bg); color:var(--text); border:1px solid var(--border); border-radius:8px; margin-bottom:14px; font-size:13px; }
.doc-list .group { margin-bottom:14px; }
.doc-list .group-label { font-size:11px; letter-spacing:.08em; color:var(--muted); text-transform:uppercase; margin:10px 0 6px; }
.doc-list a { display:block; padding:6px 8px; border-radius:6px; color:var(--text); font-size:13px; }
.doc-list a:hover, .doc-list a.active { background:#1f2432; text-decoration:none; }
.content { flex:1; padding:32px 40px; max-width:980px; }
.badge { display:inline-block; padding:2px 10px; border-radius:999px; font-weight:600; font-size:13px; color:#fff; }
.meta-row { display:flex; gap:16px; flex-wrap:wrap; color:var(--muted); font-size:13px; margin:12px 0 28px; }
.doc-section { border:1px solid var(--border); border-radius:12px; background:var(--panel); margin-bottom:22px; overflow:hidden; }
.doc-section > summary { cursor:pointer; padding:14px 18px; font-weight:600; font-size:15px; list-style:none; display:flex; justify-content:space-between; align-items:center; }
.doc-section > summary::-webkit-details-marker { display:none; }
.doc-section > summary .file { color:var(--muted); font-weight:400; font-size:12px; font-family:ui-monospace,Menlo,monospace; }
.doc-section[open] > summary { border-bottom:1px solid var(--border); }
.doc-body { padding:6px 18px 18px; }
.doc-body h2, .doc-body h3, .doc-body h4 { margin:18px 0 8px; }
.doc-body table { border-collapse:collapse; width:100%; margin:10px 0; font-size:13px; }
.doc-body th, .doc-body td { border:1px solid var(--border); padding:6px 10px; text-align:left; }
.doc-body th { background:#1d2230; }
.doc-body blockquote { margin:8px 0; padding:6px 12px; border-left:3px solid var(--accent); background:#1a1f2b; border-radius:0 8px 8px 0; color:var(--muted); }
.doc-body code, .ev { background:#1d2230; border:1px solid var(--border); border-radius:5px; padding:1px 6px; font-family:ui-monospace,Menlo,monospace; font-size:12px; color:#7dd3fc; }
.doc-body pre { background:#0b0d13; border:1px solid var(--border); border-radius:10px; padding:14px; overflow-x:auto; }
.doc-body pre code { background:none; border:none; padding:0; color:#c9d4e8; }
.cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:16px; }
.card { background:var(--panel); border:1px solid var(--border); border-radius:12px; padding:18px; }
.card h3 { margin:0 0 6px; font-size:16px; }
.card .stats { color:var(--muted); font-size:13px; margin-top:8px; }
.search-result { padding:8px 12px; border-bottom:1px solid var(--border); }
.search-result .where { color:var(--muted); font-size:12px; }
mark { background:#3b2f0b; color:#ffd970; border-radius:3px; }
.hidden { display:none !important; }
.footer { color:var(--muted); font-size:12px; margin-top:40px; }
`

const JS = `
function filterDocs(input) {
  const q = input.value.trim().toLowerCase()
  document.querySelectorAll('.doc-list a, .doc-section').forEach(el => {
    el.classList.toggle('hidden', q && !el.textContent.toLowerCase().includes(q))
  })
  if (q) document.querySelectorAll('.doc-section').forEach(s => { if (!s.classList.contains('hidden')) s.open = true })
}
function globalSearch(input) {
  const q = input.value.trim().toLowerCase()
  const box = document.getElementById('search-results')
  if (!q) { box.innerHTML = ''; box.classList.add('hidden'); return }
  box.classList.remove('hidden')
  fetch('site-data.json').then(r => r.json()).then(docs => {
    const hits = docs.filter(d => (d.title + ' ' + (d.aliases||[]).join(' ') + ' ' + (d.questions||[]).join(' ') + ' ' + d.text).toLowerCase().includes(q)).slice(0, 12)
    box.innerHTML = hits.map(h => '<div class="search-result"><a href="' + h.url + '#' + h.anchor + '">' + h.title + '</a><div class="where">' + h.module + ' · ' + h.where + '</div></div>').join('') || '<div class="search-result">无匹配文档</div>'
  })
}
`

function pageHtml({ title, body, sidebar, headExtra }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · codewiki</title>
<style>${CSS}</style>
<script>${JS}</script>
${headExtra || ''}
</head>
<body>
<div class="layout">
${sidebar ? `<nav class="sidebar">${sidebar}</nav>` : ''}
<main class="content">
${body}
<div class="footer">由 codewiki 生成 · 数据来自本地知识库 .codewiki/</div>
</main>
</div>
</body>
</html>
`
}

function gradeBadge(grade) {
  return `<span class="badge" style="background:${GRADE_COLORS[grade] || GRADE_COLORS.N_A}">${grade === 'N_A' ? '未评估' : grade}</span>`
}

function moduleSidebar(module, docs) {
  const groups = ['product', 'frontend']
    .map(layer => {
      const items = docs.filter(doc => doc.layer === layer)
      if (items.length === 0) return ''
      return `<div class="group"><div class="group-label">${layer === 'product' ? '业务语义层' : '前端架构层'}</div>` +
        items.map(doc => `<a href="#${slugify(doc.file)}">${escapeHtml(doc.title)}</a>`).join('') + '</div>'
    })
    .join('')
  return `<h1>${escapeHtml(module)}</h1>
<div class="crumb">${MODULES_ROOT}/${escapeHtml(module)}</div>
<input type="search" placeholder="筛选本文档…" oninput="filterDocs(this)">
<div class="doc-list">${groups || '<div class="crumb">暂无语义文档 — 运行 /wiki-scan 生成</div>'}</div>`
}

function renderModulePage({ module, docs, grade, navNodes }) {
  const sections = docs.map(doc => {
    const firstQuestion = doc.questions[0] ? `<div class="crumb" style="color:var(--muted);font-size:12px;margin:4px 18px 0">${escapeHtml(doc.questions[0])}</div>` : ''
    return `<details class="doc-section" id="${slugify(doc.file)}" open>
<summary><span>${escapeHtml(doc.title)}</span><span class="file">${escapeHtml(doc.file)}</span></summary>
${firstQuestion}
<div class="doc-body">${mdToHtml(doc.body)}</div>
</details>`
  }).join('')
  const body = `
<h1>${escapeHtml(module)} ${gradeBadge(grade.grade)}</h1>
<div class="meta-row">
  <span>评级${grade.score != null ? ` ${grade.score}` : ''}</span>
  <span>${docs.length} 篇语义文档</span>
  <span>${navNodes} 个导航节点</span>
  ${grade.status ? `<span>证据校验：${escapeHtml(grade.status)}</span>` : '<span>未运行 --validate</span>'}
  ${grade.validatedAt ? `<span>校验于 ${escapeHtml(grade.validatedAt.slice(0, 10))}</span>` : ''}
</div>
<a href="index.html">← 返回模块总览</a>
${sections || '<p>该模块暂无 product/frontend 语义文档。</p>'}
`
  return pageHtml({
    title: module,
    body,
    sidebar: moduleSidebar(module, docs),
    headExtra: '<script type="module">try{import("https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs").then(m=>m.default.initialize({startOnLoad:true,theme:"dark"}))}catch(e){document.querySelectorAll("pre.mermaid").forEach(p=>p.textContent="mermaid 图需要网络加载渲染库\\n\\n"+p.textContent)}</script>',
  })
}

function renderIndexPage(modules) {
  const cards = modules.map(m => `
<div class="card">
  <h3><a href="${m.name}.html">${escapeHtml(m.name)}</a> ${gradeBadge(m.grade.grade)}</h3>
  <div class="stats">
    ${m.docs.length} 篇语义文档 · ${m.navNodes} 个导航节点
    ${m.grade.status ? ` · 校验 ${escapeHtml(m.grade.status)}` : ' · 未校验'}
  </div>
  ${m.docs.slice(0, 3).map(doc => `<div class="stats">· ${escapeHtml(doc.title)}</div>`).join('')}
</div>`).join('')
  const sidebar = `<h1>codewiki</h1>
<div class="crumb">模块知识库总览</div>
<input type="search" placeholder="全局搜索（标题/别名/问题/正文）…" oninput="globalSearch(this)">
<div id="search-results" class="hidden" style="margin-bottom:14px"></div>
<div class="doc-list">${modules.map(m => `<div class="group"><a href="${m.name}.html">${escapeHtml(m.name)}</a></div>`).join('') || '<div class="crumb">暂无模块 — 运行 codewiki scan 或 /wiki-scan</div>'}</div>`
  const body = `
<h1>知识库模块</h1>
<div class="meta-row"><span>${modules.length} 个模块</span><span>位置 ${MODULES_ROOT}/</span></div>
<div class="cards">${cards || '<p>暂无模块。在 Claude Code 中运行 /wiki-scan，或执行 codewiki scan &lt;target&gt;。</p>'}</div>
`
  return pageHtml({ title: '模块总览', body, sidebar })
}

export function renderSite(projectRoot, options = {}) {
  const dirs = moduleDirs(projectRoot, options.module)
  if (dirs.length === 0) {
    throw new Error(`未找到知识库模块（期望 ${MODULES_ROOT}/<module>）；先运行 codewiki scan 或 /wiki-scan`)
  }
  const outDir = join(projectRoot, '.codewiki', 'site')
  mkdirSync(outDir, { recursive: true })
  const modules = []
  const searchIndex = []
  for (const dir of dirs) {
    const name = moduleNameFromManifest(dir) || basename(dir)
    const docs = collectDocs(dir)
    const grade = moduleGrade(dir)
    const navNodes = countNavNodes(dir)
    modules.push({ name, docs, grade, navNodes })
    writeFileSync(join(outDir, `${encodeURIComponent(name)}.html`), renderModulePage({ module: name, docs, grade, navNodes }), 'utf8')
    for (const doc of docs) {
      searchIndex.push({
        module: name,
        url: `${encodeURIComponent(name)}.html`,
        anchor: slugify(doc.file),
        title: doc.title,
        aliases: doc.aliases,
        questions: doc.questions,
        where: doc.file,
        text: doc.body.replace(/```[\s\S]*?```/g, ' ').replace(/[#*`>|]/g, ' ').replace(/\s+/g, ' ').slice(0, 2000),
      })
    }
  }
  writeFileSync(join(outDir, 'index.html'), renderIndexPage(modules), 'utf8')
  writeFileSync(join(outDir, 'site-data.json'), JSON.stringify(searchIndex), 'utf8')
  return { outDir, modules: modules.map(m => ({ name: m.name, docs: m.docs.length, grade: m.grade.grade, navNodes: m.navNodes })) }
}
