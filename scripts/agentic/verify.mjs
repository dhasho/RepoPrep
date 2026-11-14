import { loadChecks } from './checks/index.mjs'
import { runGate } from './gate-runner.mjs'
import path from 'node:path'

function parseArgs(args) {
  const parsed = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (['--module', '--mode', '--report-file', '--authorization-file', '--source-root'].includes(arg)) {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`)
      const key = arg === '--report-file' ? 'reportPath' : arg === '--authorization-file' ? 'authorizationPath' : arg === '--source-root' ? 'sourceRoot' : arg.slice(2)
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
  const { module: moduleId, mode = 'synthetic', reportPath, authorizationPath, sourceRoot: sourceRootArg } = parseArgs(process.argv.slice(2))
  if (sourceRootArg && moduleId !== 'M08') throw new Error('Source root is only available for M08 verification')
  const sourceRoot = sourceRootArg ? path.resolve(sourceRootArg) : process.cwd()
  let authorization = null
  if (moduleId === 'M06' && mode === 'real' && authorizationPath) {
    try {
      const { checkAuthorizationArtifact } = await import('./retrieval-eval.mjs')
      const binding = await checkAuthorizationArtifact({ repoRoot: sourceRoot, authorizationPath })
      authorization = { authorized: true, reference: binding.reference }
    } catch { /* Invalid or absent local approval stays blocked; verification never reads credentials. */ }
  }
  if (moduleId === 'M08' && mode === 'real' && authorizationPath) {
    try {
      const { checkGenerationAuthorizationArtifact } = await import('./generation-eval.mjs')
      const binding = await checkGenerationAuthorizationArtifact({ repoRoot: sourceRoot, authorizationPath: path.resolve(authorizationPath) })
      authorization = { authorized: true, reference: binding.reference }
    } catch { /* Invalid local approval remains blocked; verification never reads credentials. */ }
  }
  // M09 is intentionally detached/incomplete here. Formal execution is only
  // available through createM09QualityHost in one long-lived root-supervised Node.
  const checks = await loadChecks(moduleId, { mode, sourceRoot, reportPath, authorizationPath })
  const gateRoot = process.cwd()
  const m08Source = moduleId === 'M08' ? sourceRoot : gateRoot
  const result = await runGate({
    module: moduleId, mode, checks, sourceRoot: m08Source, authorization, printSummary: true,
    ...(moduleId === 'M08' ? {
      manifestPath: path.join(sourceRoot, 'scripts/agentic/manifest.v2.json'),
      manifestLockPath: path.join(sourceRoot, 'scripts/agentic/manifest.v2.lock.json'),
      outRoot: path.join(gateRoot, '.validation/agentic')
    } : {})
  })
  process.exitCode = result.status === 'pass' ? 0 : 1
} catch {
  process.stdout.write(`${JSON.stringify({ module: null, status: 'failed', failed: 1, missing: 0, skipped: 0, unknown: 0, report: null, errorCode: 'GATE_START_FAILED' })}\n`)
  process.exitCode = 1
}
