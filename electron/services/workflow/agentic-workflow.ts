// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import type { InterviewResult, LlmProfile } from '../../../shared/types.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { assertInterviewResultContract } from '../../../shared/result-contract.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import type { ScanResult } from '../scanner.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { generateInterview, type GenerateParams } from '../generator.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import type { BudgetLedgerSnapshot, ModelUsage } from './budget-ledger.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { createBudgetLedger } from './budget-ledger.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { createEvidenceGenerationAdapter, type EvidenceGenerationRequestMetadata } from './evidence-generation.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { createEvidenceStore, type WorkflowProjectSnapshot } from './evidence-store.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { INVESTIGATION_PROMPT_VERSION, runInvestigation, type InvestigationResult } from './investigation-controller.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { createModelGateway, type ModelTransport } from './model-gateway.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { WorkflowError } from './project-contract.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { createRunCoordinator, type RunCoordinator, type RunCoordinatorEvent, type RunSessionSnapshot } from './run-coordinator.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import type { RunSpec } from './run-spec.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { createToolGateway } from './tool-gateway.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { snapshotMatchesScan } from './snapshot-adapter.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import type { QuestionEvidenceSidecar } from './question-evidence.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import type { PackedManifest } from './evidence-packer.ts'

export interface AgenticWorkflowRunnerOptions {
  readonly transport?: ModelTransport
  readonly onEvent?: (event: RunCoordinatorEvent) => void
  readonly clock?: () => number
}

export interface AgenticWorkflowInput {
  readonly spec: RunSpec
  readonly scan: ScanResult
  readonly snapshot: WorkflowProjectSnapshot
  readonly profile: LlmProfile
  readonly objective?: string
  readonly signal?: AbortSignal
  readonly onProgress?: GenerateParams['onProgress']
}

export interface InvestigationDiagnostics {
  readonly status: InvestigationResult['status']
  readonly stopReason: InvestigationResult['stopReason']
  readonly statistics: InvestigationResult['statistics']
  readonly selectedEvidenceIds: readonly string[]
  readonly selectedEvidenceCount: number
  readonly topicCount: number
  readonly events: readonly Readonly<{ type: 'decision' | 'tool' | 'topic' | 'selection' | 'stop'; id?: string; hash?: string; reason?: string }>[]
}

export interface GenerationDispatchDiagnostics {
  readonly requestId: string
  readonly stage: EvidenceGenerationRequestMetadata['stage']
  readonly manifest: EvidenceGenerationRequestMetadata['manifest']
  readonly usage: ModelUsage
  readonly completion: 'completed'
}

export interface AgenticWorkflowDiagnostics {
  readonly lifecycle: RunSessionSnapshot
  readonly budget: BudgetLedgerSnapshot
  readonly investigation: InvestigationDiagnostics
  readonly generationDispatches: readonly GenerationDispatchDiagnostics[]
}

export interface AgenticWorkflowResult {
  readonly result: InterviewResult
  readonly evidenceSidecar: QuestionEvidenceSidecar
  readonly diagnostics: AgenticWorkflowDiagnostics
}

export interface AgenticWorkflowRunner {
  run(input: AgenticWorkflowInput): Promise<AgenticWorkflowResult>
  cancel(runId: string): boolean
  cancelProject(projectId: string): boolean
  getActiveProjectRun(projectId: string): string | null
}

function fail(code: ConstructorParameters<typeof WorkflowError>[0]): never { throw new WorkflowError(code) }

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object' || seen.has(value as object)) return value
  seen.add(value as object)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen)
  return Object.freeze(value)
}

function freezeProfile(profile: LlmProfile): LlmProfile {
  if (!profile || typeof profile !== 'object') fail('configuration-changed')
  return Object.freeze({
    id: profile.id, name: profile.name, baseUrl: profile.baseUrl, apiKey: profile.apiKey, model: profile.model,
    ...(profile.protocol !== undefined ? { protocol: profile.protocol } : {}),
    ...(profile.reasoningEffort !== undefined ? { reasoningEffort: profile.reasoningEffort } : {}),
    ...(profile.temperature !== undefined ? { temperature: profile.temperature } : {}),
    ...(profile.contextWindowTokens !== undefined ? { contextWindowTokens: profile.contextWindowTokens } : {}),
    ...(profile.maxOutputTokens !== undefined ? { maxOutputTokens: profile.maxOutputTokens } : {})
  })
}

function validateRunInput(input: AgenticWorkflowInput): void {
  if (!input || typeof input !== 'object' || !input.spec || !input.scan || !input.snapshot || !input.profile) fail('invalid-argument')
  const { spec, snapshot } = input
  if (spec.version !== 1 || spec.strategy !== 'agentic' || spec.strategyVersion !== 'agentic-v1' || spec.promptVersion !== INVESTIGATION_PROMPT_VERSION) fail('configuration-changed')
  if (snapshot.projectId !== spec.projectId || snapshot.snapshotId !== spec.snapshotId) fail('stale-snapshot')
  if (!snapshotMatchesScan(snapshot, input.scan)) fail('stale-snapshot')
  if (typeof snapshot.assertCurrent !== 'function' || typeof snapshot.readFile !== 'function' || typeof snapshot.ownsRead !== 'function') fail('invalid-argument')
  if (input.objective !== undefined && (typeof input.objective !== 'string' || input.objective.length < 1 || input.objective.length > 800 || input.objective.includes('\0'))) fail('invalid-argument')
  if (input.onProgress !== undefined && typeof input.onProgress !== 'function') fail('invalid-argument')
}

function validUsage(value: unknown): value is ModelUsage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const usage = value as Record<string, unknown>
  return Number.isSafeInteger(usage.inputTokens) && Number(usage.inputTokens) >= 0 && Number.isSafeInteger(usage.outputTokens) && Number(usage.outputTokens) >= 0 && Number.isSafeInteger(usage.totalTokens) && Number(usage.totalTokens) === Number(usage.inputTokens) + Number(usage.outputTokens)
}

function safeRelativePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !/^[a-z]:/iu.test(value) && !value.includes('\\') && value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..')
}

function safeInvestigationEvent(value: unknown): InvestigationDiagnostics['events'][number] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const event = value as Record<string, unknown>
  if (!['decision', 'tool', 'topic', 'selection', 'stop'].includes(String(event.type))) return null
  const id = typeof event.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(event.id) ? event.id : undefined
  const hash = typeof event.hash === 'string' && /^[a-f0-9]{64}$/u.test(event.hash) ? event.hash : undefined
  const reason = typeof event.reason === 'string' && /^[a-z-]{1,64}$/u.test(event.reason) ? event.reason : undefined
  return Object.freeze({ type: event.type as InvestigationDiagnostics['events'][number]['type'], ...(id ? { id } : {}), ...(hash ? { hash } : {}), ...(reason ? { reason } : {}) })
}

function freezeDispatchMetadata(rows: readonly EvidenceGenerationRequestMetadata[], spec: RunSpec, ledger: BudgetLedgerSnapshot): readonly GenerationDispatchDiagnostics[] {
  if (!Array.isArray(rows) || rows.length > spec.budget.total.maxModelRequests) fail('budget-exhausted')
  const reservations = new Map(ledger.reservations.map(entry => [entry.id, entry]))
  const dispatches = rows.map(row => {
    if (!row || typeof row.requestId !== 'string' || !['generation', 'repair', 'compensation'].includes(row.stage) || row.completion !== 'completed' || !validUsage(row.usage)) fail('budget-exhausted')
    const reservation = reservations.get(row.requestId)
    if (!reservation || reservation.stage !== row.stage || reservation.state !== 'settled' || !reservation.usage || reservation.usage.inputTokens !== row.usage.inputTokens || reservation.usage.outputTokens !== row.usage.outputTokens || reservation.usage.totalTokens !== row.usage.totalTokens) fail('budget-exhausted')
    const manifest = row.manifest
    if (!manifest || manifest.runId !== spec.runId || manifest.projectId !== spec.projectId || manifest.snapshotId !== spec.snapshotId || !Array.isArray(manifest.selectedIds) || !Array.isArray(manifest.requiredIds) || !Array.isArray(manifest.packedIds) || !Array.isArray(manifest.omitted) || !Array.isArray(manifest.sources)) fail('unknown-evidence')
    const typedManifest = manifest as PackedManifest
    if (typedManifest.sources.some(source => !source || !safeRelativePath(source.relPath))) fail('unknown-evidence')
    const safeManifest = deepFreeze({
      version: manifest.version,
      runId: manifest.runId,
      projectId: manifest.projectId,
      snapshotId: manifest.snapshotId,
      selectedIds: [...typedManifest.selectedIds],
      requiredIds: [...typedManifest.requiredIds],
      packedIds: [...typedManifest.packedIds],
      omitted: typedManifest.omitted.map(item => ({ id: item.id, reason: item.reason })),
      sources: typedManifest.sources.map(source => ({
        ids: [...source.ids], fileId: source.fileId, relPath: source.relPath,
        displayRange: { startLine: source.displayRange.startLine, endLine: source.displayRange.endLine },
        originalRange: source.originalRange ? { startLine: source.originalRange.startLine, endLine: source.originalRange.endLine } : null,
        hash: source.hash, sourceKind: source.sourceKind
      })),
      requestHash: manifest.requestHash,
      manifestHash: manifest.manifestHash,
      estimatedInputTokens: manifest.estimatedInputTokens,
      serializedChars: manifest.serializedChars,
      contextChars: manifest.contextChars,
      serializationOverheadTokens: manifest.serializationOverheadTokens,
      maxInputTokens: manifest.maxInputTokens,
      maxChars: manifest.maxChars
    })
    return Object.freeze({ requestId: row.requestId, stage: row.stage, manifest: safeManifest, usage: Object.freeze({ ...row.usage }), completion: 'completed' as const })
  })
  const generationReservations = ledger.reservations.filter(entry => entry.stage !== 'investigation')
  if (generationReservations.length !== dispatches.length) fail('budget-exhausted')
  return Object.freeze(dispatches)
}

function normalizeFailure(error: unknown, terminalStatus: string | null, elapsedMs: number, spec: RunSpec): WorkflowError {
  const lifecycleCode = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  if (terminalStatus === 'cancelled') return new WorkflowError('cancelled')
  if (lifecycleCode === 'run-deadline-exceeded' || terminalStatus === 'failed' && elapsedMs >= spec.budget.total.wallClockMs) return new WorkflowError('budget-exhausted')
  if (lifecycleCode === 'run-clock-invalid') return new WorkflowError('invalid-argument')
  if (error instanceof WorkflowError && !(terminalStatus === 'failed' && error.code === 'cancelled')) return error
  if (terminalStatus === 'failed' && error instanceof WorkflowError && error.code === 'cancelled') return new WorkflowError('model-failed')
  return new WorkflowError('model-failed')
}

export function createAgenticWorkflowRunner(options: AgenticWorkflowRunnerOptions = {}): AgenticWorkflowRunner {
  const coordinator: RunCoordinator = createRunCoordinator({ onEvent: options.onEvent, clock: options.clock })

  return Object.freeze({
    async run(input: AgenticWorkflowInput): Promise<AgenticWorkflowResult> {
      if (!input || typeof input !== 'object' || !input.spec) fail('invalid-argument')
      let session
      try { session = coordinator.begin(input.spec, { signal: input.signal }) }
      catch { fail('invalid-argument') }
      if (!session) fail('configuration-changed')
      const { spec, scan, snapshot } = input
      try {
        validateRunInput(input)
        const privateProfile = freezeProfile(input.profile)
        const ledger = createBudgetLedger(spec, options.clock ? { clock: options.clock } : undefined)
        const store = createEvidenceStore(snapshot)
        const investigationModel = createModelGateway(spec, privateProfile, ledger, options.transport ? { transport: options.transport } : {})
        const tools = createToolGateway(snapshot, store, ledger)
        const investigationEvents: InvestigationDiagnostics['events'][number][] = []

        await session.execute('scanning', async ({ signal }) => {
          if (!snapshotMatchesScan(snapshot, scan) || snapshot.projectId !== spec.projectId || snapshot.snapshotId !== spec.snapshotId) fail('stale-snapshot')
          await snapshot.assertCurrent(signal)
          if (!snapshotMatchesScan(snapshot, scan)) fail('stale-snapshot')
        })

        const investigation = await session.execute('investigating', ({ signal }) => runInvestigation({
          spec, snapshot, store, tools, ledger, model: investigationModel,
          ...(input.objective !== undefined ? { objective: input.objective } : {}),
          signal,
          onEvent: event => {
            if (investigationEvents.length >= 32) return
            const safeEvent = safeInvestigationEvent(event)
            if (safeEvent) investigationEvents.push(safeEvent)
          }
        }))
        if (investigation.status !== 'completed' || investigation.selection.selectedIds.length < 1 || investigation.topics.length < 1) fail('unknown-evidence')
        const knownEvidence = new Set(store.metadata().ids)
        if (investigation.selection.selectedIds.some(id => !knownEvidence.has(id))) fail('unknown-evidence')

        const facade = await session.execute('packing', ({ signal }) => createEvidenceGenerationAdapter({
          spec, scan, snapshot, store, selection: investigation.selection, topics: investigation.topics,
          ledger, profile: privateProfile, signal,
          ...(options.transport ? { transport: options.transport } : {})
        }))

        const generationResult = await session.execute('generating', async ({ signal }) => generateInterview({
          scan, granularity: spec.granularity, roleFocus: spec.roleFocus, profile: privateProfile, signal,
          contextProvider: facade.contextProvider,
          requestAdapter: facade.requestAdapter,
          onProgress: (step, detail, percent, preview) => {
            if (session.signal.aborted || session.terminalStatus) return
            try { input.onProgress?.(step, detail, percent, preview) } catch { /* progress is observational */ }
          }
        }))

        const validated = await session.execute('validating', async ({ signal }) => {
          if (!snapshotMatchesScan(snapshot, scan)) fail('stale-snapshot')
          await snapshot.assertCurrent(signal)
          assertInterviewResultContract(generationResult)
          if (generationResult.projectName !== scan.name || generationResult.projectPath !== scan.root || generationResult.granularity !== spec.granularity || generationResult.roleFocus !== spec.roleFocus || generationResult.profileId !== spec.model.profileId) fail('configuration-changed')
          const questionCount = generationResult.sections.reduce((sum, section) => sum + section.questions.length, 0)
          if (questionCount < spec.questionBudget.min || questionCount > spec.questionBudget.max) fail('budget-exhausted')
          if (!generationResult.generationDiagnostics || generationResult.generationDiagnostics.status !== 'succeeded' || generationResult.generationDiagnostics.usageComplete !== true) fail('budget-exhausted')

          const evidenceSidecar = await facade.finalize(generationResult)
          const questions = generationResult.sections.flatMap(section => section.questions)
          if (evidenceSidecar.runId !== spec.runId || evidenceSidecar.projectId !== spec.projectId || evidenceSidecar.snapshotId !== spec.snapshotId || evidenceSidecar.questions.length !== questions.length || evidenceSidecar.questions.some((entry, index) => entry.questionId !== questions[index]?.id)) fail('unknown-evidence')
          const budget = ledger.snapshot()
          if (!budget.usageComplete || budget.blocked || budget.overspend.inputTokens || budget.overspend.outputTokens || budget.overspend.readBytes || budget.reservations.some(entry => entry.state !== 'settled')) fail('budget-exhausted')
          const generationDispatches = freezeDispatchMetadata(facade.metadata(), spec, budget)
          return {
            result: deepFreeze(generationResult),
            evidenceSidecar: deepFreeze(evidenceSidecar),
            budget,
            investigation: deepFreeze({
              status: investigation.status,
              stopReason: investigation.stopReason,
              statistics: { ...investigation.statistics },
              selectedEvidenceIds: [...investigation.selection.selectedIds],
              selectedEvidenceCount: investigation.selection.selectedIds.length,
              topicCount: investigation.topics.length,
              events: [...investigationEvents]
            }),
            generationDispatches
          }
        })

        session.succeed(validated)
        const diagnostics: AgenticWorkflowDiagnostics = deepFreeze({
          lifecycle: session.snapshot(),
          budget: validated.budget,
          investigation: validated.investigation,
          generationDispatches: validated.generationDispatches
        })
        return deepFreeze({ result: validated.result, evidenceSidecar: validated.evidenceSidecar, diagnostics })
      } catch (error) {
        if (!session.terminalStatus) session.fail()
        const terminalElapsed = session.snapshot().elapsedMs
        throw normalizeFailure(error, session.terminalStatus, terminalElapsed, input.spec)
      }
    },
    cancel(runId: string) { return coordinator.cancel(runId) },
    cancelProject(projectId: string) { return coordinator.cancelProject(projectId) },
    getActiveProjectRun(projectId: string) { return coordinator.getActiveProjectRun(projectId) }
  })
}
