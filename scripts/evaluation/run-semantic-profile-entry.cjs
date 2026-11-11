'use strict'

const path = require('node:path')
const { isMainThread } = require('node:worker_threads')
const io = require('./m09-semantic-io.cjs')
const native = require('./m09-semantic-native.cjs')

function args(argv) {
  io.check(argv.length === 2 && argv[0] === '--runtime-root', 'semantic-native-arguments-invalid')
  return io.absolute(argv[1])
}
function report(message) { process.stdout.write(io.bytes(message)) }
async function continueNative(token) {
  const { app } = require('electron')
  try {
    const ready = await native.prepareNativeSemanticContext(token)
    // Install the input receiver before publishing ready. It requires EOF.
    const pendingGrant = io.oneMessage(process.stdin, { timeoutMs: 60000 })
    report(ready)
    const grant = await pendingGrant
    await native.acceptNativeSemanticGrant(token, grant)
    const { executeNativeSemanticEvaluation } = await import('../agentic/semantic-eval.mjs')
    const outcome = await executeNativeSemanticEvaluation({ context: token })
    report(outcome)
    app.exit(0)
  } catch (error) {
    report({ type: 'semantic-error', code: io.safeCode(error, 'semantic-native-execution-failed') })
    app.exit(1)
  }
}
// No await, store import, readiness callback or asynchronous setup precedes this
// one capture/stage/path-switch bootstrap. E3a remains the only staging helper.
const electronMainEntry = process.platform === 'win32' && process.type === 'browser' &&
  typeof process.versions.electron === 'string' && isMainThread &&
  !Object.hasOwn(process.env, 'ELECTRON_RUN_AS_NODE') && Array.isArray(process.argv) &&
  typeof process.argv[1] === 'string' && path.isAbsolute(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(__filename)
if (require.main === module || electronMainEntry) {
  try {
    const token = native.bootstrapNativeSemanticContext(args(process.argv.slice(2)), __filename)
    void continueNative(token)
  } catch (error) {
    report({ type: 'semantic-error', code: io.safeCode(error, 'semantic-native-bootstrap-failed') })
    try { require('electron').app.exit(1) } catch { process.exitCode = 1 }
  }
}
module.exports = { args }
