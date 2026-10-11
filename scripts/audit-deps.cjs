'use strict'

// 审计 lockfile 中已安装依赖适用的 HIGH/CRITICAL GitHub 公告。
// Usage: node scripts/audit-deps.cjs <lockfilePath> [--label NAME]

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  collectPages,
  createReport,
  inspectChunk,
  parseLockfile
} = require('./audit-deps-core.cjs')

const CHUNK_SIZE = 20
const PAGE_SIZE = 50
const MAX_ADVISORY_PAGES = 100

function parseArguments(args) {
  if (!args[0] || args[0].startsWith('--')) return null
  let label = args[0]
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] !== '--label' || !args[index + 1]) return null
    label = args[index + 1]
    index += 1
  }
  return { lockPath: args[0], label }
}

function safeLabel(label) {
  return String(label || 'dependency-audit').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || 'dependency-audit'
}

function reportPathFor(label) {
  const configured = process.env.PROJECTLENS_AUDIT_REPORT
  if (configured) return configured
  return path.join(process.env.TEMP || os.tmpdir(), `audit-${safeLabel(label)}.json`)
}

function gql(query) {
  const output = execFileSync('gh', ['api', 'graphql', '-f', `query=${query}`], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  })
  return JSON.parse(output)
}

function vulnerabilityFields(alias, packageName, cursor) {
  const after = cursor === undefined ? '' : `, after: ${JSON.stringify(cursor)}`
  return `${alias}: securityVulnerabilities(ecosystem: NPM, first: ${PAGE_SIZE}, package: ${JSON.stringify(packageName)}${after}) {
    pageInfo { hasNextPage endCursor }
    nodes { advisory { ghsaId summary severity withdrawnAt } vulnerableVersionRange }
  }`
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function addPageFailures(failures, packageName, pageFailures) {
  for (const failure of pageFailures) failures.push({ package: packageName, reason: failure.reason })
}

async function run() {
  const parsedArgs = parseArguments(process.argv.slice(2))
  const label = parsedArgs?.label || 'dependency-audit'
  const reportPath = reportPathFor(label)
  const state = {
    packageCount: 0,
    queriedPackageCount: 0,
    chunkCount: 0,
    active: [],
    withdrawn: [],
    unparsed: [],
    failures: []
  }

  if (!parsedArgs) {
    state.failures.push({ reason: 'invalid-arguments' })
  } else {
    let lock
    try {
      lock = JSON.parse(fs.readFileSync(parsedArgs.lockPath, 'utf8'))
    } catch {
      state.failures.push({ reason: 'lockfile-input-unreadable-or-invalid-json' })
    }

    if (lock !== undefined) {
      const parsedLock = parseLockfile(lock)
      state.failures.push(...parsedLock.failures)
      const installed = parsedLock.installed
      const names = [...installed.keys()].sort()
      state.packageCount = names.length

      for (let offset = 0; offset < names.length; offset += CHUNK_SIZE) {
        const chunk = names.slice(offset, offset + CHUNK_SIZE)
        const query = `query { ${chunk.map((name, index) => vulnerabilityFields(`p${index}`, name)).join('\n')} }`
        state.chunkCount += 1
        state.queriedPackageCount += chunk.length

        let response
        try {
          response = gql(query)
        } catch {
          for (const packageName of chunk) {
            state.failures.push({ package: packageName, reason: 'graphql-request-failed' })
          }
          continue
        }

        const hasErrorsField = isObject(response) && Object.hasOwn(response, 'errors')
        const responseErrors = hasErrorsField ? response.errors : undefined
        const hasResponseErrors = hasErrorsField &&
          (!Array.isArray(responseErrors) || responseErrors.length > 0)
        if (hasResponseErrors) {
          for (const packageName of chunk) {
            state.failures.push({ package: packageName, reason: 'graphql-response-errors' })
          }
        }

        if (!isObject(response) || !isObject(response.data)) {
          if (!hasResponseErrors) {
            for (const packageName of chunk) {
              state.failures.push({ package: packageName, reason: 'graphql-response-incomplete' })
            }
          }
          continue
        }

        const completeData = {}
        for (let index = 0; index < chunk.length; index += 1) {
          const packageName = chunk[index]
          const firstPage = response.data[`p${index}`]
          if (!isObject(firstPage)) {
            state.failures.push({ package: packageName, reason: 'missing-query-data' })
            continue
          }
          const collected = await collectPages(firstPage, async (cursor) => {
            const pageQuery = `query { ${vulnerabilityFields('p0', packageName, cursor)} }`
            const pageResponse = gql(pageQuery)
            const hasPageErrorsField = isObject(pageResponse) && Object.hasOwn(pageResponse, 'errors')
            const pageErrors = hasPageErrorsField ? pageResponse.errors : undefined
            if (!isObject(pageResponse) ||
                (hasPageErrorsField && (!Array.isArray(pageErrors) || pageErrors.length > 0)) ||
                !isObject(pageResponse.data) || !Object.hasOwn(pageResponse.data, 'p0')) {
              throw new Error('invalid advisory page response')
            }
            return pageResponse.data.p0
          }, MAX_ADVISORY_PAGES)
          completeData[`p${index}`] = collected.connection
          addPageFailures(state.failures, packageName, collected.failures)
        }

        const inspected = inspectChunk(chunk, { data: completeData }, installed)
        for (const finding of inspected.findings) {
          if (finding.withdrawn) state.withdrawn.push(finding)
          else state.active.push(finding)
        }
        state.unparsed.push(...inspected.unparsed)
        state.failures.push(...inspected.failures)
      }
    }
  }

  const report = createReport(label, state)
  try {
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { encoding: 'utf8' })
  } catch {
    process.stderr.write('Dependency audit could not write its report\n')
    process.exitCode = 2
    return
  }

  process.stdout.write(`Dependency audit status: ${report.status}; packages: ${report.packageCount}; active findings: ${report.activeCount}; incomplete conditions: ${report.failures.length + report.unparsed.length}\n`)
  process.exitCode = report.status === 'clean' ? 0 : report.status === 'findings' ? 1 : 2
}

run().catch(() => {
  const report = createReport('dependency-audit', {
    failures: [{ reason: 'audit-unexpected-failure' }]
  })
  try {
    const fallbackPath = process.env.PROJECTLENS_AUDIT_REPORT ||
      path.join(process.env.TEMP || os.tmpdir(), `audit-${safeLabel('dependency-audit')}.json`)
    fs.writeFileSync(fallbackPath, JSON.stringify(report, null, 2), { encoding: 'utf8' })
  } catch {
    // The static stderr message below is the only safe signal when no report can be written.
  }
  process.stderr.write('Dependency audit failed unexpectedly\n')
  process.exitCode = 2
})
