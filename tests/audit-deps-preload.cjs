// Offline child-process shim for the audit CLI. It replaces only gh execution;
// every other process operation is left untouched.
const fs = require('node:fs')
const childProcess = require('node:child_process')

const configPath = process.env.PROJECTLENS_FAKE_GH_CONFIG
const tracePath = process.env.PROJECTLENS_FAKE_GH_TRACE
const config = configPath ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : { packages: {}, steps: [] }
const trace = []
let callIndex = 0
const originalExecFileSync = childProcess.execFileSync

function readQuery(args) {
  const argList = Array.isArray(args) ? args : []
  const queryArg = argList.find((arg) => typeof arg === 'string' && arg.startsWith('query='))
  return queryArg ? queryArg.slice('query='.length) : ''
}

function extractPackages(query) {
  const found = []
  const pattern = /(p\d+):\s*securityVulnerabilities[\s\S]*?package:\s*("(?:\\.|[^"\\])*")/g
  let match
  while ((match = pattern.exec(query))) found.push({ alias: match[1], name: JSON.parse(match[2]) })
  return found
}

function extractCursor(query) {
  const match = /\bafter:\s*("(?:\\.|[^"\\])*"|null)/.exec(query)
  return match ? JSON.parse(match[1]) : null
}

function serialize(response) {
  return typeof response === 'string' ? response : JSON.stringify(response)
}

childProcess.execFileSync = function fakeExecFileSync(file, args, options) {
  if (file !== 'gh') return originalExecFileSync.call(this, file, args, options)

  const query = readQuery(args)
  const packages = extractPackages(query)
  const cursor = extractCursor(query)
  const index = callIndex++
  trace.push({ file, packages: packages.map((item) => item.name), cursors: cursor })
  const step = (config.steps ?? [])[index] ?? {}

  if (step.kind === 'throw') {
    const error = new Error(step.message ?? 'offline fake gh failure')
    if (step.stderr) error.stderr = Buffer.from(step.stderr)
    if (step.stdout) error.stdout = Buffer.from(step.stdout)
    throw error
  }

  let response
  if (step.kind === 'raw') {
    response = step.response
  } else {
    const data = {}
    for (const { alias, name } of packages) {
      const pages = (config.packages ?? {})[name] ?? {}
      data[alias] = pages[String(cursor ?? 'first')] ?? pages.first ?? {
        nodes: [], pageInfo: { hasNextPage: false, endCursor: null }
      }
    }
    response = { data }
    if (step.kind === 'graphql-errors') response.errors = step.errors ?? [{ message: 'fake GraphQL failure' }]
  }

  if (tracePath) fs.writeFileSync(tracePath, JSON.stringify(trace), 'utf8')
  return serialize(response)
}
