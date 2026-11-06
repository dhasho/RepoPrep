import { loadChecks } from './checks/index.mjs'
import { runGate } from './gate-runner.mjs'

function parseArgs(args) {
  const parsed = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (['--module', '--mode', '--report-file', '--authorization-file'].includes(arg)) {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`)
      const key = arg === '--report-file' ? 'reportPath' : arg === '--authorization-file' ? 'authorizationPath' : arg.slice(2)
      if (Object.hasOwn(parsed, key)) throw new Error('Duplicate argument')
      parsed[key] = value
      index += 1
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  if (!parsed.module) throw new Error('--module is required (for example M01)')
  return parsed
}

try {
  const { module: moduleId, mode = 'synthetic', reportPath, authorizationPath } = parseArgs(process.argv.slice(2))
  const sourceRoot = process.cwd()
  let authorization = null
  if (moduleId === 'M06' && mode === 'real' && authorizationPath) {
    try {
      const { checkAuthorizationArtifact } = await import('./retrieval-eval.mjs')
      const binding = await checkAuthorizationArtifact({ repoRoot: sourceRoot, authorizationPath })
      authorization = { authorized: true, reference: binding.reference }
    } catch { /* Invalid or absent local approval stays blocked; verification never reads credentials. */ }
  }
  const checks = await loadChecks(moduleId, { mode, sourceRoot, reportPath, authorizationPath })
  const result = await runGate({ module: moduleId, mode, checks, sourceRoot, authorization, printSummary: true })
  process.exitCode = result.status === 'pass' ? 0 : 1
} catch {
  process.stdout.write(`${JSON.stringify({ module: null, status: 'failed', failed: 1, missing: 0, skipped: 0, unknown: 0, report: null, errorCode: 'GATE_START_FAILED' })}\n`)
  process.exitCode = 1
}
