import { loadChecks } from './checks/index.mjs'
import { runGate } from './gate-runner.mjs'

function parseArgs(args) {
  const parsed = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--module' || arg === '--mode') {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`)
      parsed[arg.slice(2)] = value
      index += 1
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  if (!parsed.module) throw new Error('--module is required (for example M01)')
  return parsed
}

try {
  const { module: moduleId, mode = 'synthetic' } = parseArgs(process.argv.slice(2))
  const checks = await loadChecks(moduleId)
  const result = await runGate({ module: moduleId, mode, checks, sourceRoot: process.cwd(), printSummary: true })
  process.exitCode = result.status === 'pass' ? 0 : 1
} catch {
  process.stdout.write(`${JSON.stringify({ module: null, status: 'failed', failed: 1, missing: 0, skipped: 0, unknown: 0, report: null, errorCode: 'GATE_START_FAILED' })}\n`)
  process.exitCode = 1
}
