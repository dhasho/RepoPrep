// Bounded, hidden native child. No providers, credentials, source text or app data.
import { openWorkflowStore } from '../../../electron/services/workflow/workflow-store.ts'
const [directory, mode = 'hold', crashStep = ''] = process.argv.slice(2)
const binding = { version: 1, logicalRunId: 'run-01', projectId: 'project-01', snapshotId: 'snapshot-01', runSpecHash: 'a'.repeat(64), configHash: 'b'.repeat(64), schemaVersion: 'workflow-v1', policyVersion: 'policy-v1' }
const validators = {
  ledger: { schemaId: 'ledger-test-v1', validate: value => value !== null && typeof value === 'object' && Number.isSafeInteger(value.held) },
  result: { schemaId: 'result-test-v1', validate: value => value !== null && typeof value === 'object' && typeof value.text === 'string' },
  'critical-journal': { schemaId: 'journal-test-v1', validate: value => value !== null && typeof value === 'object' && typeof value.event === 'string' }
}
const watchdog = setTimeout(() => process.exit(124), 45000)
let armed = mode === 'crash-open'
const send = value => process.connected && process.send(value)
try {
  const store = await openWorkflowStore({ storageDirectory: directory, validators, onDurableStep(step) { if (armed && step === crashStep) process.exit(86) } })
  if (mode === 'crash' || mode === 'crash-journal') {
    const initial = await store.beginAttempt(binding)
    await store.appendJournal(initial, { event: 'intent' })
    await store.publish(initial, { stage: 'generating', components: [{ kind: 'ledger', payload: { held: 100 } }, { kind: 'result', payload: { text: 'prefix' } }] })
    armed = true
    if (mode === 'crash-journal') await store.appendJournal(initial, { event: 'receipt' })
    else await store.publish(initial, { stage: 'persisting', components: [{ kind: 'ledger', payload: { held: 101 } }, { kind: 'result', payload: { text: 'next' } }] })
    throw new Error('crash step not reached')
  }
  if (mode === 'crash-attempt') {
    armed = true
    await store.beginAttempt(binding)
    throw new Error('crash step not reached')
  }
  send({ state: 'owner' })
  process.on('message', async message => {
    if (message === 'close') { await store.close(); clearTimeout(watchdog); send({ state: 'closed' }); process.disconnect() }
    if (message === 'exit') process.exit(0)
  })
} catch (error) {
  send({ state: 'rejected', code: error.code ?? 'unexpected' })
  clearTimeout(watchdog)
  process.disconnect?.()
}
