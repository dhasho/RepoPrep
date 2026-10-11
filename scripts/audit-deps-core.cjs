'use strict'

const semver = require('semver')

const SEVERITIES = new Set(['LOW', 'MODERATE', 'HIGH', 'CRITICAL'])
const INVALID_RANGE = '__invalid_advisory_range__'

function normalizeRange(range) {
  let source
  try {
    source = String(range)
  } catch {
    return INVALID_RANGE
  }
  const parts = source.split(',').map((part) => part.trim())
  if (!source.trim() || parts.some((part) => !part)) return INVALID_RANGE
  return parts.join(' ')
}

function hasValidSemverRange(range) {
  try {
    return semver.validRange(range) !== null
  } catch {
    return false
  }
}

function applies(version, range) {
  const normalized = normalizeRange(range)
  try {
    if (semver.valid(version) === null || !hasValidSemverRange(normalized)) {
      return { ok: false, unparsed: true }
    }
    return { ok: semver.satisfies(version, normalized, { includePrerelease: true }) }
  } catch {
    return { ok: false, unparsed: true }
  }
}

function isValidDateTime(value) {
  if (typeof value !== 'string') return false
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!match) return false
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  if (year === 0 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysPerMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (day < 1 || day > daysPerMonth[month - 1]) return false
  const offset = /[+-](\d{2}):(\d{2})$/.exec(value)
  if (offset && (Number(offset[1]) > 23 || Number(offset[2]) > 59)) return false
  return Number.isFinite(Date.parse(value))
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function packageNameFromKey(key) {
  const marker = 'node_modules/'
  const index = key.lastIndexOf(marker)
  if (index < 0 || (index > 0 && key[index - 1] !== '/')) return null
  const tail = key.slice(index + marker.length)
  const parts = tail.split('/')
  if (parts[0]?.startsWith('@')) {
    if (!parts[0].slice(1) || !parts[1] || parts.length !== 2) return null
    return `${parts[0]}/${parts[1]}`
  }
  return parts.length === 1 && parts[0] ? parts[0] : null
}

function isValidPackageName(name) {
  if (typeof name !== 'string' || !name || name !== name.trim()) return false
  if (name.toLowerCase() === 'node_modules' || name.toLowerCase() === 'favicon.ico') return false

  const isUrlFriendly = (value) => {
    try {
      return encodeURIComponent(value) === value
    } catch {
      return false
    }
  }

  if (name.startsWith('@')) {
    const match = /^@([^/]+)\/([^/]+)$/.exec(name)
    if (!match) return false
    const [, scope, packageName] = match
    return isUrlFriendly(scope) && isUrlFriendly(packageName) && !packageName.startsWith('.')
  }

  return !/^[-._]/.test(name) && isUrlFriendly(name)
}

function parseLockfile(lock) {
  const installed = new Map()
  const failures = []
  if (!isObject(lock) || !isObject(lock.packages)) {
    return { installed, failures: [{ reason: 'invalid-lockfile-structure' }] }
  }

  const packages = lock.packages
  for (const [key, entry] of Object.entries(packages)) {
    if (!key.includes('node_modules/')) continue
    const name = packageNameFromKey(key)
    if (!name) {
      failures.push({ package: key, reason: 'invalid-package-entry' })
      continue
    }
    if (!isObject(entry)) {
      failures.push({ package: name, reason: 'invalid-package-entry' })
      continue
    }

    let metadata = entry
    if (entry.link === true) {
      if (typeof entry.resolved !== 'string' || !entry.resolved) {
        failures.push({ package: name, reason: 'unresolved-workspace-link' })
        continue
      }
      const target = entry.resolved.replaceAll('\\', '/').replace(/^\.\//, '')
      metadata = packages[target]
      if (!isObject(metadata)) {
        failures.push({ package: name, reason: 'unresolved-workspace-link' })
        continue
      }
    }

    let canonicalName = name
    if (Object.hasOwn(metadata, 'name')) {
      if (!isValidPackageName(metadata.name)) {
        failures.push({ package: name, reason: 'invalid-installed-package-name' })
        continue
      }
      canonicalName = metadata.name
    }

    if (typeof metadata.version !== 'string' || semver.valid(metadata.version) === null) {
      failures.push({ package: name, reason: 'invalid-installed-version' })
      continue
    }
    if (!installed.has(canonicalName)) installed.set(canonicalName, new Set())
    installed.get(canonicalName).add(metadata.version)
  }
  return { installed, failures }
}

function inspectChunk(chunk, response, installed) {
  const findings = []
  const unparsed = []
  const failures = []
  if (!Array.isArray(chunk) || !isObject(response) ||
      (Object.hasOwn(response, 'errors') && (!Array.isArray(response.errors) || response.errors.length > 0)) ||
      !isObject(response.data)) {
    return { findings, unparsed, failures: [{ reason: 'graphql-response-incomplete' }] }
  }

  chunk.forEach((name, idx) => {
    const result = response.data[`p${idx}`]
    if (!isObject(result) || !Array.isArray(result.nodes) || !isObject(result.pageInfo) ||
        typeof result.pageInfo.hasNextPage !== 'boolean') {
      failures.push({ package: name, reason: 'missing-query-data' })
      return
    }
    if (result.pageInfo.hasNextPage) {
      if (typeof result.pageInfo.endCursor !== 'string' || !result.pageInfo.endCursor) {
        failures.push({ package: name, reason: 'missing-advisory-cursor' })
      }
      failures.push({ package: name, reason: 'advisory-pagination-required' })
    } else if (!Object.hasOwn(result.pageInfo, 'endCursor') ||
        !(result.pageInfo.endCursor === null || typeof result.pageInfo.endCursor === 'string')) {
      failures.push({ package: name, reason: 'missing-advisory-end-cursor' })
    }
    for (const node of result.nodes) {
      const advisory = node?.advisory
      if (!isObject(node) || !isObject(advisory) ||
          typeof advisory.ghsaId !== 'string' || !advisory.ghsaId ||
          !SEVERITIES.has(advisory.severity) ||
          !(advisory.withdrawnAt === null || isValidDateTime(advisory.withdrawnAt)) ||
          typeof node.vulnerableVersionRange !== 'string' ||
          typeof advisory.summary !== 'string') {
        failures.push({ package: name, reason: 'malformed-advisory' })
        continue
      }

      const normalized = normalizeRange(node.vulnerableVersionRange)
      if (!hasValidSemverRange(normalized)) {
        unparsed.push({ name, range: node.vulnerableVersionRange, reason: 'invalid-advisory-range' })
        continue
      }
      if (advisory.severity !== 'HIGH' && advisory.severity !== 'CRITICAL') continue

      const versions = installed.get(name)
      if (!versions || versions.size === 0) {
        failures.push({ package: name, reason: 'missing-installed-package' })
        continue
      }
      for (const version of versions) {
        const result = applies(version, normalized)
        if (result.unparsed) {
          unparsed.push({ name, version, range: node.vulnerableVersionRange, reason: 'invalid-installed-version-or-range' })
          continue
        }
        if (!result.ok) continue
        findings.push({
          name,
          version,
          severity: advisory.severity,
          ghsa: advisory.ghsaId,
          withdrawn: advisory.withdrawnAt !== null,
          withdrawnAt: advisory.withdrawnAt,
          range: node.vulnerableVersionRange,
          summary: advisory.summary
        })
      }
    }
  })
  return { findings, unparsed, failures }
}

async function collectPages(firstPage, fetchPage, maxPages = 100) {
  const nodes = []
  const failures = []
  const cursors = new Set()
  if (!Number.isInteger(maxPages) || maxPages < 0 || !isObject(firstPage) ||
      !Array.isArray(firstPage.nodes) || !isObject(firstPage.pageInfo) ||
      typeof firstPage.pageInfo.hasNextPage !== 'boolean') {
    return {
      connection: { nodes, pageInfo: { hasNextPage: true, endCursor: null } },
      failures: [{ reason: 'missing-advisory-page-data' }]
    }
  }
  nodes.push(...firstPage.nodes)
  let page = firstPage
  let fetched = 0
  if (!page.pageInfo.hasNextPage &&
      (!Object.hasOwn(page.pageInfo, 'endCursor') ||
        !(page.pageInfo.endCursor === null || typeof page.pageInfo.endCursor === 'string'))) {
    failures.push({ reason: 'missing-advisory-end-cursor' })
  }
  while (page.pageInfo.hasNextPage) {
    if (fetched >= maxPages) {
      failures.push({ reason: 'advisory-pagination-limit' })
      break
    }
    const cursor = page.pageInfo.endCursor
    if (typeof cursor !== 'string' || cursor.length === 0) {
      failures.push({ reason: 'missing-advisory-cursor' })
      break
    }
    if (cursors.has(cursor)) {
      failures.push({ reason: 'repeated-advisory-cursor' })
      break
    }
    cursors.add(cursor)
    try {
      page = await fetchPage(cursor)
    } catch {
      failures.push({ reason: 'advisory-page-query-failed' })
      break
    }
    fetched += 1
    if (!isObject(page) || !Array.isArray(page.nodes) || !isObject(page.pageInfo) ||
        typeof page.pageInfo.hasNextPage !== 'boolean') {
      failures.push({ reason: 'missing-advisory-page-data' })
      break
    }
    nodes.push(...page.nodes)
    if (!page.pageInfo.hasNextPage &&
        (!Object.hasOwn(page.pageInfo, 'endCursor') ||
          !(page.pageInfo.endCursor === null || typeof page.pageInfo.endCursor === 'string'))) {
      failures.push({ reason: 'missing-advisory-end-cursor' })
    }
  }
  const pageInfo = { hasNextPage: page?.pageInfo?.hasNextPage === true }
  if (isObject(page?.pageInfo) && Object.hasOwn(page.pageInfo, 'endCursor')) {
    pageInfo.endCursor = page.pageInfo.endCursor
  }
  return {
    connection: {
      nodes,
      pageInfo
    },
    failures
  }
}

function createReport(label, fields = {}) {
  const active = Array.isArray(fields.active) ? fields.active.filter((item) => !item.withdrawn) : []
  const withdrawn = Array.isArray(fields.withdrawn) ? [...fields.withdrawn] : []
  const unparsed = Array.isArray(fields.unparsed) ? [...fields.unparsed] : []
  const failures = Array.isArray(fields.failures) ? [...fields.failures] : []
  const complete = fields.complete !== false && unparsed.length === 0 && failures.length === 0
  return {
    label,
    complete,
    status: complete ? (active.length ? 'findings' : 'clean') : 'incomplete',
    packageCount: Number.isInteger(fields.packageCount) ? fields.packageCount : 0,
    queriedPackageCount: Number.isInteger(fields.queriedPackageCount) ? fields.queriedPackageCount : 0,
    chunkCount: Number.isInteger(fields.chunkCount) ? fields.chunkCount : 0,
    activeCount: active.length,
    active,
    withdrawn,
    unparsed,
    failures
  }
}

function evaluateReport(report, exitCode) {
  if (exitCode !== 0 || !isObject(report) || report.complete !== true ||
      report.activeCount !== 0 || !Array.isArray(report.active) || report.active.length !== 0 ||
      (report.withdrawn !== undefined && !Array.isArray(report.withdrawn)) ||
      !Array.isArray(report.unparsed) || report.unparsed.length !== 0 ||
      !Array.isArray(report.failures) || report.failures.length !== 0) return false
  return report.status === undefined || report.status === 'clean'
}

module.exports = {
  applies,
  collectPages,
  createReport,
  evaluateReport,
  inspectChunk,
  normalizeRange,
  parseLockfile
}
