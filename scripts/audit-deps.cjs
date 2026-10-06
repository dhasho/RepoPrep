// 审计依赖的 HIGH/CRITICAL 公告。
// 关键修正：GitHub Advisory 返回的区间是 ">= 1.0.0, < 1.2.2" 这种**逗号**形式，
// npm 的 semver 无法解析（validRange 返回 null），satisfies 会**静默返回 false**，
// 从而系统性漏报。必须先规范化为空格 AND 形式。
// 用法: node audit-fixed.cjs <lockfilePath> [--label NAME]
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')

const lockPath = process.argv[2]
const labelIdx = process.argv.indexOf('--label')
const label = labelIdx > 0 ? process.argv[labelIdx + 1] : lockPath

const semver = require('semver')

/** 规范化 GitHub 的逗号区间为 npm 语义的空格 AND 形式。 */
function normalizeRange(range) {
  return String(range)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ')
}

function applies(version, range) {
  const normalized = normalizeRange(range)
  if (semver.validRange(normalized) === null) return { ok: false, unparsed: true }
  try {
    return { ok: semver.satisfies(version, normalized, { includePrerelease: true }) }
  } catch {
    return { ok: false, unparsed: true }
  }
}

// 从 lockfile 取出「已安装」的 name@version 集合（顶层与嵌套都算）
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
const installed = new Map()
for (const [key, info] of Object.entries(lock.packages || {})) {
  if (!key.startsWith('node_modules/')) continue
  if (!info || !info.version) continue
  const name = key.replace(/^.*node_modules\//, '')
  const prev = installed.get(name)
  // 同名多版本时保留全部（用列表）
  if (!prev) installed.set(name, new Set([info.version]))
  else prev.add(info.version)
}

const names = [...installed.keys()]
console.error(`[${label}] packages: ${names.length}`)

function gql(query) {
  const out = execFileSync('gh', ['api', 'graphql', '-f', `query=${query}`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  return JSON.parse(out)
}

const CHUNK = 20
const hits = []
for (let i = 0; i < names.length; i += CHUNK) {
  const chunk = names.slice(i, i + CHUNK)
  const parts = chunk.map(
    (name, idx) =>
      `p${idx}: securityVulnerabilities(ecosystem: NPM, first: 50, package: ${JSON.stringify(name)}) {
         nodes { advisory { ghsaId summary severity withdrawnAt } vulnerableVersionRange }
       }`
  )
  let res
  try {
    res = gql(`query { ${parts.join('\n')} }`)
  } catch (e) {
    console.error(`  chunk ${i} failed: ${String(e.message).split('\n')[0]}`)
    continue
  }
  chunk.forEach((name, idx) => {
    const nodes = (res.data && res.data[`p${idx}`] && res.data[`p${idx}`].nodes) || []
    for (const node of nodes) {
      const sev = node.advisory.severity
      if (sev !== 'HIGH' && sev !== 'CRITICAL') continue
      for (const version of installed.get(name)) {
        const { ok, unparsed } = applies(version, node.vulnerableVersionRange)
        if (!ok) continue
        hits.push({
          name,
          version,
          severity: sev,
          ghsa: node.advisory.ghsaId,
          withdrawn: !!node.advisory.withdrawnAt,
          withdrawnAt: node.advisory.withdrawnAt || null,
          range: node.vulnerableVersionRange,
          summary: node.advisory.summary,
          unparsed: !!unparsed
        })
      }
    }
  })
}

const active = hits.filter((h) => !h.withdrawn)
const withdrawn = hits.filter((h) => h.withdrawn)

console.log(`\n===== ${label} =====`)
console.log(`适用 HIGH/CRITICAL（不含已撤回）: ${active.length}`)
console.log(`适用 HIGH/CRITICAL（含已撤回）  : ${hits.length}`)
console.log(`  CRITICAL: ${active.filter((h) => h.severity === 'CRITICAL').length}`)

const group = (list) => {
  const m = new Map()
  for (const h of list) {
    const k = `${h.name}@${h.version}`
    if (!m.has(k)) m.set(k, [])
    m.get(k).push(h.ghsa)
  }
  return [...m.entries()].sort()
}

console.log('\n--- 不含已撤回 ---')
for (const [k, ids] of group(active)) console.log(`  ${k}  ${ids.join(', ')}`)
console.log('--- 已撤回（不计入）---')
for (const [k, ids] of group(withdrawn)) console.log(`  ${k}  ${ids.join(', ')}`)

fs.writeFileSync(
  `${process.env.TEMP}/audit-${label}.json`,
  JSON.stringify({ label, activeCount: active.length, active, withdrawn }, null, 2)
)
console.log(`\n详细结果: ${process.env.TEMP}/audit-${label}.json`)
