import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { applies, collectPages, evaluateReport, inspectChunk, normalizeRange } = require('../scripts/audit-deps-core.cjs')
const here = path.dirname(fileURLToPath(import.meta.url))
const cliPath = path.resolve(here, '../scripts/audit-deps.cjs')
const preloadPath = path.resolve(here, 'audit-deps-preload.cjs')
const credentialMarker = 'GH_FAKE_SECRET_DO_NOT_LEAK_73'

const advisory = (range = '>= 1.0.0, < 2.0.0', options = {}) => ({
  advisory: {
    ghsaId: options.ghsaId ?? 'GHSA-test',
    summary: options.summary ?? 'test advisory',
    severity: options.severity ?? 'HIGH',
    withdrawnAt: options.withdrawnAt ?? null
  },
  vulnerableVersionRange: range
})
const connection = (nodes = [], hasNextPage = false, endCursor = null) => ({
  nodes,
  pageInfo: { hasNextPage, endCursor }
})
const packagePages = (first = connection(), pages = {}) => ({ first, ...pages })
const packageEntry = (version, extra = {}) => ({ version, ...extra })

function lockfile(packages) {
  return {
    name: 'offline-audit-fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': { name: 'offline-audit-fixture', version: '1.0.0' },
      ...packages
    }
  }
}

function entriesFor(names) {
  return Object.fromEntries(names.map((name) => [`node_modules/${name}`, packageEntry('1.0.0')]))
}

async function makeCliCase(t, { packages = { demo: packagePages() }, lock = null, steps = [], args = [], reportOverride = null } = {}) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'projectlens-audit-73-'))
  const expectedPrefix = path.resolve(os.tmpdir()) + path.sep
  const absoluteTempRoot = path.resolve(tempRoot)
  assert.ok(absoluteTempRoot.startsWith(expectedPrefix), 'temporary fixture must be inside os.tmpdir()')
  t.after(async () => {
    const checkedPath = path.resolve(tempRoot)
    assert.ok(checkedPath.startsWith(expectedPrefix), 'refusing to remove a path outside os.tmpdir()')
    assert.ok(path.basename(checkedPath).startsWith('projectlens-audit-73-'), 'refusing to remove a non-fixture temporary directory')
    await rm(checkedPath, { recursive: true, force: true })
  })

  const lockPath = path.join(tempRoot, 'package-lock.json')
  const reportPath = reportOverride ?? path.join(tempRoot, 'audit-report.json')
  const configPath = path.join(tempRoot, 'fake-gh.json')
  const tracePath = path.join(tempRoot, 'fake-gh-trace.json')
  if (lock !== false) await writeFile(lockPath, JSON.stringify(lock ?? lockfile(entriesFor(Object.keys(packages)))), 'utf8')
  await writeFile(configPath, JSON.stringify({ packages, steps }), 'utf8')

  const childEnv = { ...process.env }
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST']) {
    delete childEnv[key]
  }
  childEnv.PROJECTLENS_FAKE_GH_CONFIG = configPath
  childEnv.PROJECTLENS_FAKE_GH_TRACE = tracePath
  childEnv.PROJECTLENS_AUDIT_REPORT = reportPath
  childEnv.GH_CONFIG_DIR = path.join(tempRoot, 'empty-gh-config')
  const cliArgs = ['--require', preloadPath, cliPath, lockPath, ...args]
  const child = spawnSync(process.execPath, cliArgs, {
    cwd: path.resolve(here, '..'),
    env: childEnv,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024
  })
  const report = existsSync(reportPath) ? JSON.parse(await readFile(reportPath, 'utf8')) : null
  const trace = existsSync(tracePath) ? JSON.parse(await readFile(tracePath, 'utf8')) : []
  return { child, report, trace, lockPath, reportPath, tempRoot }
}

function assertNoCredentialLeak(result) {
  const output = `${result.child.stdout ?? ''}\n${result.child.stderr ?? ''}\n${JSON.stringify(result.report)}`
  assert.equal(output.includes(credentialMarker), false, 'fake upstream credential marker must not appear in output or report')
}

function assertReportStatus(report, status, complete) {
  assert.ok(report, 'CLI should write a structured JSON report')
  assert.equal(report.status, status)
  assert.equal(report.complete, complete)
  for (const key of ['packageCount', 'queriedPackageCount', 'chunkCount', 'activeCount', 'active', 'withdrawn', 'unparsed', 'failures']) {
    assert.ok(Object.hasOwn(report, key), `report should include ${key}`)
  }
}

test('comma advisory ranges are normalized and invalid ranges are reported as unparsed', () => {
  assert.equal(normalizeRange('>= 1.0.0, < 2.0.0'), '>= 1.0.0 < 2.0.0')
  assert.deepEqual(applies('1.0.0', '>= 1.0.0, < 2.0.0'), { ok: true })
  assert.deepEqual(applies('1.0.0', 'not a semver range'), { ok: false, unparsed: true })
  const installed = new Map([['demo', new Set(['1.0.0'])]])
  const result = inspectChunk(['demo'], { data: { p0: connection([advisory('broken range')]) } }, installed)
  assert.equal(result.unparsed.length, 1)
  assert.equal(result.failures.length, 0)
})

test('GraphQL failures and missing response aliases make an audit incomplete', () => {
  const installed = new Map([['demo', new Set(['1.0.0'])]])
  assert.equal(inspectChunk(['demo'], null, installed).failures[0].reason, 'graphql-response-incomplete')
  assert.equal(inspectChunk(['demo'], { errors: [{ message: 'query error' }], data: {} }, installed).failures.length, 1)
  assert.equal(inspectChunk(['demo'], { data: {} }, installed).failures[0].reason, 'missing-query-data')
})

test('pagination and malformed advisory data are reported as incomplete', () => {
  const installed = new Map([['demo', new Set(['1.0.0'])]])
  const paginated = inspectChunk(['demo'], { data: { p0: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'a' } } } }, installed)
  assert.equal(paginated.failures[0].reason, 'advisory-pagination-required')
  const malformed = inspectChunk(['demo'], { data: { p0: connection([{ vulnerableVersionRange: '>=1' }]) } }, installed)
  assert.equal(malformed.failures[0].reason, 'malformed-advisory')
})

test('advisory pages accumulate until complete and reject missing, repeated, failed, or excessive cursors', async () => {
  const first = { nodes: [1], pageInfo: { hasNextPage: true, endCursor: 'a' } }
  const complete = await collectPages(first, async (cursor) => {
    assert.equal(cursor, 'a')
    return { nodes: [2], pageInfo: { hasNextPage: false, endCursor: 'b' } }
  })
  assert.deepEqual(complete.connection.nodes, [1, 2])
  assert.deepEqual(complete.failures, [])

  const missing = await collectPages({ nodes: [], pageInfo: { hasNextPage: true } }, async () => null)
  assert.equal(missing.failures[0].reason, 'missing-advisory-cursor')
  const repeated = await collectPages(first, async () => ({ nodes: [2], pageInfo: { hasNextPage: true, endCursor: 'a' } }))
  assert.equal(repeated.failures[0].reason, 'repeated-advisory-cursor')
  const failed = await collectPages(first, async () => { throw new Error('network') })
  assert.equal(failed.failures[0].reason, 'advisory-page-query-failed')
  const limited = await collectPages(first, async () => ({ nodes: [], pageInfo: { hasNextPage: true, endCursor: 'b' } }), 1)
  assert.equal(limited.failures[0].reason, 'advisory-pagination-limit')
})

test('only a complete zero-finding report with exit code zero passes', () => {
  const clean = { complete: true, activeCount: 0, active: [], unparsed: [], failures: [] }
  assert.equal(evaluateReport(clean, 0), true)
  assert.equal(evaluateReport({ ...clean, activeCount: 1 }, 0), false)
  assert.equal(evaluateReport({ ...clean, active: [{ ghsa: 'GHSA-test' }] }, 0), false)
  assert.equal(evaluateReport({ ...clean, complete: false }, 0), false)
  assert.equal(evaluateReport({ ...clean, failures: [{ reason: 'chunk-failed' }] }, 0), false)
  assert.equal(evaluateReport({ ...clean, unparsed: [{ range: 'bad' }] }, 0), false)
  assert.equal(evaluateReport(clean, 1), false)
  assert.equal(evaluateReport(null, 0), false)
})

test('real CLI exits zero and reports complete clean, withdrawn, nonmatching, and LOW-only advisories', async (t) => {
  const result = await makeCliCase(t, {
    packages: {
      demo: packagePages(connection([
        advisory('>= 1.0.0, < 2.0.0', { ghsaId: 'GHSA-withdrawn', withdrawnAt: '2026-01-01T00:00:00Z' }),
        advisory('>= 2.0.0', { ghsaId: 'GHSA-not-applicable' }),
        advisory('>= 1.0.0', { ghsaId: 'GHSA-low', severity: 'LOW' })
      ]))
    }
  })
  assert.equal(result.child.status, 0, result.child.stderr)
  assertReportStatus(result.report, 'clean', true)
  assert.equal(result.report.packageCount, 1)
  assert.equal(result.report.activeCount, 0)
  assert.equal(result.report.withdrawn.length, 1)
  assertNoCredentialLeak(result)

  const empty = await makeCliCase(t, { lock: lockfile({}), packages: {} })
  assert.equal(empty.child.status, 0, empty.child.stderr)
  assertReportStatus(empty.report, 'clean', true)
  assert.equal(empty.report.packageCount, 0)
  assert.deepEqual(empty.trace, [])
  assertNoCredentialLeak(empty)
})

test('real CLI exits one for applicable HIGH and CRITICAL findings and retains all installed versions', async (t) => {
  const lock = lockfile({
    'node_modules/demo': packageEntry('1.5.0'),
    'node_modules/outer/node_modules/demo': packageEntry('2.5.0'),
    'node_modules/other': packageEntry('1.0.0')
  })
  const result = await makeCliCase(t, {
    lock,
    packages: {
      demo: packagePages(connection([
        advisory('>= 1.0.0, < 2.0.0', { ghsaId: 'GHSA-high' }),
        advisory('>= 2.0.0, < 3.0.0', { ghsaId: 'GHSA-critical', severity: 'CRITICAL' })
      ])),
      other: packagePages()
    }
  })
  assert.equal(result.child.status, 1, result.child.stderr)
  assertReportStatus(result.report, 'findings', true)
  assert.equal(result.report.packageCount, 2)
  assert.equal(result.report.activeCount, 2)
  assert.deepEqual(result.report.active.map((finding) => finding.version).sort(), ['1.5.0', '2.5.0'])
  assert.deepEqual(result.report.active.map((finding) => finding.ghsa).sort(), ['GHSA-critical', 'GHSA-high'])
  assertNoCredentialLeak(result)
})

test('real CLI parses prerelease applicability and marks invalid ranges and installed versions incomplete', async (t) => {
  const lock = lockfile({
    'node_modules/pre': packageEntry('1.5.0-beta.1'),
    'node_modules/bad-range': packageEntry('1.0.0'),
    'node_modules/bad-range-low': packageEntry('1.0.0'),
    'node_modules/bad-version': packageEntry('version?')
  })
  const result = await makeCliCase(t, {
    lock,
    packages: {
      pre: packagePages(connection([advisory('>= 1.5.0-beta.0, < 2.0.0', { ghsaId: 'GHSA-prerelease' })])),
      'bad-range': packagePages(connection([advisory('not a semver range', { ghsaId: 'GHSA-unparsed' })])),
      'bad-range-low': packagePages(connection([advisory('still not a semver range', { ghsaId: 'GHSA-low-unparsed', severity: 'LOW' })])),
      'bad-version': packagePages(connection([advisory('>= 1.0.0', { ghsaId: 'GHSA-bad-version' })]))
    }
  })
  assert.equal(result.child.status, 2, result.child.stderr)
  assertReportStatus(result.report, 'incomplete', false)
  assert.ok(result.report.active.some((finding) => finding.ghsa === 'GHSA-prerelease'), 'confirmed findings remain in an incomplete report')
  assert.ok(result.report.unparsed.some((item) => JSON.stringify(item).includes('not a semver range')))
  assert.ok(result.report.unparsed.some((item) => JSON.stringify(item).includes('still not a semver range')))
  assert.ok(result.report.failures.length > 0)
  assertNoCredentialLeak(result)
})

test('real CLI exits two for any failed chunk while preserving package counts and confirmed findings', async (t) => {
  const names = Array.from({ length: 21 }, (_, i) => `pkg-${String(i).padStart(2, '0')}`)
  const packages = Object.fromEntries(names.map((name) => [name, packagePages(name === names[0]
    ? connection([advisory('>= 1.0.0', { ghsaId: 'GHSA-confirmed' })])
    : connection())]))
  const result = await makeCliCase(t, {
    packages,
    steps: [{}, { kind: 'throw', message: `gh failed: ${credentialMarker}`, stderr: credentialMarker }]
  })
  assert.equal(result.child.status, 2, result.child.stderr)
  assertReportStatus(result.report, 'incomplete', false)
  assert.equal(result.report.packageCount, 21)
  assert.equal(result.report.chunkCount, 2)
  assert.ok(Number.isInteger(result.report.queriedPackageCount) && result.report.queriedPackageCount > 0)
  assert.equal(result.report.activeCount, 1)
  assert.equal(result.report.active[0].ghsa, 'GHSA-confirmed')
  assert.ok(JSON.stringify(result.report.failures).includes(names[20]))
  assertNoCredentialLeak(result)
})

test('real CLI treats GraphQL errors, absent aliases, malformed connections, and malformed advisories as incomplete', async (t) => {
  const cases = [
    { steps: [{ kind: 'graphql-errors', errors: [{ message: credentialMarker }] }] },
    { steps: [{ kind: 'raw', response: { errors: null, data: { p0: connection() } } }] },
    { steps: [{ kind: 'raw', response: { errors: { message: credentialMarker }, data: { p0: connection() } } }] },
    { steps: [{ kind: 'raw', response: { data: {} } }] },
    { steps: [{ kind: 'raw', response: { data: { p0: { nodes: [], pageInfo: { hasNextPage: false } } } } }] },
    { packages: { demo: packagePages(connection([{ vulnerableVersionRange: '>= 1.0.0' }])) } }
  ]
  for (const fixture of cases) {
    const result = await makeCliCase(t, fixture)
    assert.equal(result.child.status, 2, result.child.stderr)
    assertReportStatus(result.report, 'incomplete', false)
    assertNoCredentialLeak(result)
  }
})

test('real CLI does not treat empty or invalid withdrawn timestamps as a clean withdrawn finding', async (t) => {
  for (const withdrawnAt of ['', 'not-a-date']) {
    const result = await makeCliCase(t, {
      packages: {
        demo: packagePages(connection([advisory('>= 1.0.0', { ghsaId: 'GHSA-invalid-withdrawn-date', withdrawnAt })]))
      }
    })
    assert.equal(result.child.status, 2, result.child.stderr)
    assertReportStatus(result.report, 'incomplete', false)
    assert.equal(result.report.withdrawn.length, 0)
    assertNoCredentialLeak(result)
  }
})

test('real CLI rejects malformed ranges before filtering LOW severity advisories', async (t) => {
  const malformedRanges = [
    '>= 1.0.0,, < 2.0.0',
    ', >= 1.0.0',
    '>= 1.0.0,',
    '   '
  ]
  for (const range of malformedRanges) {
    const result = await makeCliCase(t, {
      packages: {
        demo: packagePages(connection([advisory(range, { ghsaId: 'GHSA-malformed-low-range', severity: 'LOW' })]))
      }
    })
    assert.equal(result.child.status, 2, result.child.stderr)
    assertReportStatus(result.report, 'incomplete', false)
    assert.ok(result.report.unparsed.length > 0, `report should mark malformed range ${JSON.stringify(range)} unparsed`)
    assert.ok(result.report.unparsed.some((item) => item.name === 'demo'), 'report should identify the affected package')
    assertNoCredentialLeak(result)
  }
})

test('real CLI does not let non-ISO or invalid-calendar withdrawal timestamps hide HIGH findings', async (t) => {
  for (const withdrawnAt of ['1', '2026-02-30T00:00:00Z']) {
    const result = await makeCliCase(t, {
      packages: {
        demo: packagePages(connection([advisory('>= 1.0.0', { ghsaId: 'GHSA-invalid-withdrawn-date', withdrawnAt })]))
      }
    })
    assert.equal(result.child.status, 2, result.child.stderr)
    assertReportStatus(result.report, 'incomplete', false)
    assert.equal(result.report.withdrawn.length, 0)
    assertNoCredentialLeak(result)
  }
})

test('real CLI tracks malformed lockfile package keys instead of silently dropping their tails', async (t) => {
  const badKeys = [
    'node_modules/demo/subdir',
    'node_modules/@scope/pkg/more',
    'foo_node_modules/nonboundary'
  ]
  const packages = Object.fromEntries(badKeys.map((key) => [key, packageEntry('1.0.0')]))
  const result = await makeCliCase(t, { lock: lockfile(packages), packages: {} })
  assert.equal(result.child.status, 2, result.child.stderr)
  assertReportStatus(result.report, 'incomplete', false)
  const failures = JSON.stringify(result.report.failures)
  for (const key of badKeys) assert.ok(failures.includes(key), `report should identify malformed lock key ${key}`)
  assertNoCredentialLeak(result)
})

test('real CLI reports missing arguments with exit two through a preloaded child process', async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'projectlens-audit-73-'))
  const expectedPrefix = path.resolve(os.tmpdir()) + path.sep
  const absoluteTempRoot = path.resolve(tempRoot)
  assert.ok(absoluteTempRoot.startsWith(expectedPrefix), 'temporary fixture must be inside os.tmpdir()')
  t.after(async () => {
    const checkedPath = path.resolve(tempRoot)
    assert.ok(checkedPath.startsWith(expectedPrefix), 'refusing to remove a path outside os.tmpdir()')
    assert.ok(path.basename(checkedPath).startsWith('projectlens-audit-73-'), 'refusing to remove a non-fixture temporary directory')
    await rm(checkedPath, { recursive: true, force: true })
  })

  const configPath = path.join(tempRoot, 'fake-gh.json')
  const tracePath = path.join(tempRoot, 'fake-gh-trace.json')
  const reportPath = path.join(tempRoot, 'audit-report.json')
  await writeFile(configPath, JSON.stringify({ packages: {}, steps: [] }), 'utf8')
  const childEnv = { ...process.env }
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST']) {
    delete childEnv[key]
  }
  childEnv.PROJECTLENS_FAKE_GH_CONFIG = configPath
  childEnv.PROJECTLENS_FAKE_GH_TRACE = tracePath
  childEnv.PROJECTLENS_AUDIT_REPORT = reportPath
  childEnv.GH_CONFIG_DIR = path.join(tempRoot, 'empty-gh-config')
  const child = spawnSync(process.execPath, ['--require', preloadPath, cliPath], {
    cwd: path.resolve(here, '..'),
    env: childEnv,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024
  })
  const report = existsSync(reportPath) ? JSON.parse(await readFile(reportPath, 'utf8')) : null
  const result = { child, report }
  assert.equal(child.status, 2, child.stderr)
  assertReportStatus(report, 'incomplete', false)
  assertNoCredentialLeak(result)
})

test('real CLI follows all pages and reports missing, repeated, failed, and over-limit cursors', async (t) => {
  const paged = (second) => packagePages(
    connection([advisory('>= 1.0.0', { ghsaId: 'GHSA-page-one' })], true, 'cursor-1'),
    { 'cursor-1': second }
  )
  const complete = await makeCliCase(t, {
    packages: { demo: paged(connection([advisory('>= 1.0.0', { ghsaId: 'GHSA-page-two', severity: 'CRITICAL' })])) }
  })
  assert.equal(complete.child.status, 1, complete.child.stderr)
  assertReportStatus(complete.report, 'findings', true)
  assert.equal(complete.report.activeCount, 2)
  assert.deepEqual(complete.trace.map((call) => call.cursors), [null, 'cursor-1'])
  assertNoCredentialLeak(complete)

  const incompletePages = [
    { first: connection([], true, null) },
    { first: connection([], true, 'cursor-1'), 'cursor-1': connection([], true, 'cursor-1') },
    { first: connection([], true, 'cursor-1'), steps: [{}, { kind: 'throw', message: credentialMarker }] },
    { first: connection([], true, 'cursor-1'), steps: [{}, { kind: 'raw', response: { errors: null, data: { p0: connection() } } }] },
    { first: connection([], true, 'cursor-1'), steps: [{}, { kind: 'raw', response: { errors: 'invalid', data: { p0: connection() } } }] },
    { first: connection([], true, 'cursor-1'), 'cursor-1': connection([], true, 'cursor-2'), 'cursor-2': connection([], true, 'cursor-3') }
  ]
  for (const pages of incompletePages) {
    const { steps = [], ...pageMap } = pages
    const result = await makeCliCase(t, {
      packages: { demo: packagePages(pageMap.first, Object.fromEntries(Object.entries(pageMap).filter(([key]) => key !== 'first'))) },
      steps
    })
    assert.equal(result.child.status, 2, result.child.stderr)
    assertReportStatus(result.report, 'incomplete', false)
    assertNoCredentialLeak(result)
  }
})

test('real CLI reports invalid, missing, unresolved workspace link, and unparseable lockfiles as incomplete', async (t) => {
  const invalid = await makeCliCase(t, { lock: { lockfileVersion: 3, packages: { 'node_modules/demo': {} } } })
  assert.equal(invalid.child.status, 2, invalid.child.stderr)
  assertReportStatus(invalid.report, 'incomplete', false)

  const malformed = await makeCliCase(t, { lock: { lockfileVersion: 3, packages: [] } })
  assert.equal(malformed.child.status, 2, malformed.child.stderr)
  assertReportStatus(malformed.report, 'incomplete', false)

  const missing = await makeCliCase(t, { lock: false })
  assert.equal(missing.child.status, 2, missing.child.stderr)
  assertReportStatus(missing.report, 'incomplete', false)

  const unresolvedLink = await makeCliCase(t, {
    lock: lockfile({ 'node_modules/local-link': { resolved: 'workspace:../local-link', link: true } })
  })
  assert.equal(unresolvedLink.child.status, 2, unresolvedLink.child.stderr)
  assertReportStatus(unresolvedLink.report, 'incomplete', false)
  for (const result of [invalid, malformed, missing, unresolvedLink]) assertNoCredentialLeak(result)

  const resolvableLink = await makeCliCase(t, {
    lock: {
      lockfileVersion: 3,
      packages: {
        'node_modules/local-link': { resolved: 'packages/local-link', link: true },
        'packages/local-link': { version: '1.0.0' }
      }
    },
    packages: { 'local-link': packagePages() }
  })
  assert.equal(resolvableLink.child.status, 0, resolvableLink.child.stderr)
  assertReportStatus(resolvableLink.report, 'clean', true)
  assert.equal(resolvableLink.report.packageCount, 1)
  assertNoCredentialLeak(resolvableLink)
})

test('real CLI queries canonical names for aliases and retains every aliased installed version', async (t) => {
  const result = await makeCliCase(t, {
    lock: lockfile({
      'node_modules/legacy-braces': packageEntry('3.0.3', { name: 'braces' }),
      'node_modules/braces': packageEntry('3.1.0'),
      'node_modules/outer/node_modules/old-braces': packageEntry('2.0.0', { name: 'braces' }),
      'node_modules/@scope/real-package': packageEntry('1.0.0'),
      'node_modules/@scope/renamed-package': packageEntry('2.0.0', { name: '@scope/real-package' }),
      'node_modules/legacy-url-alias': packageEntry('1.0.0', { name: 'legacyURLsafe' }),
      'node_modules/@scope/underscored-alias': packageEntry('1.0.0', { name: '@scope/_legacy' }),
      'node_modules/@_scope/legacy-alias': packageEntry('1.0.0', { name: '@_scope/legacy' }),
      'node_modules/moderate-alias': packageEntry('2.2.4', { name: 'moderate-canonical' }),
      'node_modules/local-link': { resolved: 'packages/workspace-package', link: true },
      'packages/workspace-package': packageEntry('1.5.0', { name: 'workspace-canonical' }),
      'node_modules/fallback-name': packageEntry('1.0.0')
    }),
    packages: {
      braces: packagePages(connection([
        advisory('<= 3.0.3', { ghsaId: 'GHSA-braces-high' }),
        advisory('<= 2.0.0', { ghsaId: 'GHSA-braces-critical', severity: 'CRITICAL' })
      ])),
      '@scope/real-package': packagePages(connection([advisory('< 2.0.0', { ghsaId: 'GHSA-scoped-alias' })])),
      legacyURLsafe: packagePages(),
      '@scope/_legacy': packagePages(),
      '@_scope/legacy': packagePages(),
      'moderate-canonical': packagePages(connection([advisory('>= 1.0.0', { ghsaId: 'GHSA-moderate-alias', severity: 'MODERATE' })])),
      'workspace-canonical': packagePages(connection([advisory('>= 1.0.0', { ghsaId: 'GHSA-workspace-link' })])),
      'fallback-name': packagePages()
    }
  })

  assert.equal(result.child.status, 1, result.child.stderr)
  assertReportStatus(result.report, 'findings', true)
  assert.equal(result.report.packageCount, 8)
  assert.equal(result.report.queriedPackageCount, 8)
  assert.equal(result.trace.length, 1)
  assert.deepEqual(result.trace[0].packages, [
    '@_scope/legacy', '@scope/_legacy', '@scope/real-package', 'braces', 'fallback-name', 'legacyURLsafe', 'moderate-canonical', 'workspace-canonical'
  ])
  assert.equal(result.report.active.filter((finding) => finding.name === 'braces').length, 3)
  assert.deepEqual(result.report.active.filter((finding) => finding.name === 'braces').map((finding) => finding.version).sort(), ['2.0.0', '2.0.0', '3.0.3'])
  assert.ok(result.report.active.some((finding) => finding.name === '@scope/real-package' && finding.version === '1.0.0'))
  assert.ok(result.report.active.some((finding) => finding.name === 'workspace-canonical' && finding.version === '1.5.0'))
  assert.equal(result.report.active.some((finding) => finding.name === 'moderate-canonical'), false)
  assertNoCredentialLeak(result)

  const moderateOnly = await makeCliCase(t, {
    lock: lockfile({ 'node_modules/jquery-alias': packageEntry('2.2.4', { name: 'jquery' }) }),
    packages: {
      jquery: packagePages(connection([advisory('>= 1.0.0', { ghsaId: 'GHSA-jquery-moderate', severity: 'MODERATE' })]))
    }
  })
  assert.equal(moderateOnly.child.status, 0, moderateOnly.child.stderr)
  assertReportStatus(moderateOnly.report, 'clean', true)
  assert.equal(moderateOnly.report.packageCount, 1)
  assert.equal(moderateOnly.report.queriedPackageCount, 1)
  assert.deepEqual(moderateOnly.trace.map((call) => call.packages).flat(), ['jquery'])
  assert.equal(moderateOnly.report.activeCount, 0)
  assertNoCredentialLeak(moderateOnly)

  const longLegacyName = 'x'.repeat(220)
  const legacyNames = ['legacy(name)!', longLegacyName]
  const legacy = await makeCliCase(t, {
    lock: lockfile(Object.fromEntries(legacyNames.map((name, index) => [
      `node_modules/legacy-alias-${index}`,
      packageEntry('1.0.0', { name })
    ]))),
    packages: Object.fromEntries(legacyNames.map((name) => [name, packagePages()]))
  })
  assert.equal(legacy.child.status, 0, legacy.child.stderr)
  assertReportStatus(legacy.report, 'clean', true)
  assert.equal(legacy.report.packageCount, legacyNames.length)
  assert.equal(legacy.report.queriedPackageCount, legacyNames.length)
  assert.deepEqual(legacy.trace.map((call) => call.packages).flat().sort(), [...legacyNames].sort())
  assertNoCredentialLeak(legacy)
})

test('real CLI treats invalid installed canonical names as incomplete without hiding confirmed risks', async (t) => {
  const invalidNames = [
    '',
    42,
    '   ',
    'bad\nname',
    `${credentialMarker}\n`,
    '@scope/',
    '@/package',
    '@scope/package/extra'
  ]
  const packages = Object.fromEntries(invalidNames.map((name, index) => [
    `node_modules/invalid-${index}`,
    packageEntry('1.0.0', { name })
  ]))
  packages['node_modules/confirmed'] = packageEntry('1.0.0')
  const result = await makeCliCase(t, {
    lock: lockfile(packages),
    packages: {
      confirmed: packagePages(connection([advisory('>= 1.0.0', { ghsaId: 'GHSA-confirmed-alongside-invalid-name' })]))
    }
  })

  assert.equal(result.child.status, 2, result.child.stderr)
  assertReportStatus(result.report, 'incomplete', false)
  assert.equal(result.report.packageCount, 1)
  assert.equal(result.report.queriedPackageCount, 1)
  assert.deepEqual(result.trace.map((call) => call.packages).flat(), ['confirmed'])
  const invalidNameFailures = result.report.failures.filter((failure) => failure.reason === 'invalid-installed-package-name')
  assert.equal(invalidNameFailures.length, invalidNames.length)
  assert.deepEqual(invalidNameFailures.map((failure) => failure.package).sort(),
    invalidNames.map((_, index) => `invalid-${index}`).sort())
  assert.ok(result.report.active.some((finding) => finding.ghsa === 'GHSA-confirmed-alongside-invalid-name'))
  assertNoCredentialLeak(result)
})

test('real CLI exits two and reports safely when the report path cannot be written', async (t) => {
  const result = await makeCliCase(t, {
    reportOverride: path.join(os.tmpdir(), `projectlens-audit-missing-parent-${process.pid}-${Date.now()}`, 'report.json')
  })
  assert.equal(result.child.status, 2, result.child.stderr)
  assert.equal(result.report, null)
  assertNoCredentialLeak(result)
})
