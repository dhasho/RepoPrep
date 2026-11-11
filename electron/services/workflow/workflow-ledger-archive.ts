import type { PreparedCriticalSpec } from './ledger-critical-envelope.ts'
import type { WorkflowComponentReadContext, WorkflowVerifiedJournal } from './workflow-store.ts'
// @ts-ignore TS5097 -- direct Node tests execute TypeScript sources.
import { inspectWorkflowComponentReadContext } from './workflow-store.ts'
// @ts-ignore TS5097 -- direct Node tests execute TypeScript sources.
import { LEDGER_CRITICAL_SCHEMA_ID, prepareLedgerCriticalSpec, validateLedgerCriticalEnvelope } from './ledger-critical-envelope.ts'
// @ts-ignore TS5097 -- direct Node tests execute TypeScript sources.
import { foldLedgerCriticalPrefix } from './ledger-critical-transitions.ts'
// @ts-ignore TS5097 -- direct Node tests execute TypeScript sources.
import { validateLedgerState } from './ledger-state.ts'

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}
interface ArchiveFold {
  readonly prepared: PreparedCriticalSpec
  readonly references: ReadonlySet<string>
}
// The key is the private W-verified view identity, never an ambient run/spec ID.
// Values retain only one prepared spec and reference keys, not copied ledger states.
const folds = new WeakMap<readonly WorkflowVerifiedJournal[], ArchiveFold>()

/** Fixed schema decoder for historical V1 ledger reads; no terminal authority. */
export function validateArchivedWorkflowLedger(payload: unknown, context: WorkflowComponentReadContext): boolean {
  try {
    const view = inspectWorkflowComponentReadContext(context)
    if (view.component.kind !== 'ledger' || view.component.schemaId !== 'workflow-ledger-state-v1' || view.journal.length < 1 || !view.manifest.journalPosition) return false
    let fold = folds.get(view.journal)
    if (!fold) {
      const first = view.journal[0].payload as { readonly originalSpecJson?: unknown }
      if (typeof first?.originalSpecJson !== 'string') return false
      const prepared = prepareLedgerCriticalSpec({ json: first.originalSpecJson })
      if (canonical(prepared.binding) !== canonical(view.binding)) return false
      const records = view.journal.map((item, index) => {
        const envelope = validateLedgerCriticalEnvelope(item.payload, prepared)
        if (item.schemaId !== LEDGER_CRITICAL_SCHEMA_ID || item.sequence !== index + 1 || envelope.provenance.sequence !== item.sequence || canonical(envelope.provenance.binding) !== canonical(view.binding) || canonical(envelope.provenance.producingEpoch) !== canonical(item.reference.producingEpoch) || canonical(envelope.provenance.previous) !== canonical(view.journal[index - 1]?.reference ?? null)) throw new Error('invalid-archive')
        // Keep W-owned payload references; do not retain a second decoded state per record.
        return { payload: item.payload, reference: item.reference }
      })
      // Fold the complete actual causal view, including any tail after this manifest.
      const cursor = foldLedgerCriticalPrefix(records)
      if (!cursor.reference || canonical(cursor.reference) !== canonical(view.journal.at(-1)!.reference)) return false
      fold = Object.freeze({ prepared, references: new Set(view.journal.map(item => canonical(item.reference))) })
      folds.set(view.journal, fold)
    }
    if (canonical(fold.prepared.binding) !== canonical(view.binding) || !fold.references.has(canonical(view.manifest.journalPosition))) return false
    validateLedgerState(fold.prepared.spec, payload)
    // Anchored projection equality, outcome/stage, latest-tail and sole-component
    // checks stay in the genuine host, preserving manifest-mismatch diagnostics.
    inspectWorkflowComponentReadContext(context)
    return true
  } catch { return false }
}
