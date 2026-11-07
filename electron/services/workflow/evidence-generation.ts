import { createHash } from 'node:crypto'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import type { Granularity, InterviewResult, LlmProfile, QuestionItem, RoleFocus } from '../../../shared/types.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { assertInterviewResultContract } from '../../../shared/result-contract.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { CONTEXT_CHAR_BUDGETS, safeClipText } from '../../../shared/context-budget.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { emptyContentReadSummary } from '../../../shared/content-read.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import type { ScanResult } from '../scanner.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import type { BuiltContext, ContextBatch, ContextFile, ContentSecuritySummary, RenderedSelection } from '../context-builder.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import type { ContextProvider } from './context-provider.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import type { BudgetLedger, ModelStage, ModelUsage } from './budget-ledger.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import type { WorkflowEvidenceStore, WorkflowProjectSnapshot, EvidenceRecord } from './project-contract.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import type { SelectionPlan, TopicCard } from './investigation-contract.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import type { RunSpec } from './run-spec.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { packEvidence, makeDispatchGuard, type PackedContext, type PackedManifest } from './evidence-packer.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { createQuestionEvidenceRegistry, type QuestionEvidenceSidecar } from './question-evidence.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { createModelGateway, type ModelCompletion, type ModelTransport } from './model-gateway.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { CitationValidationError, type GenerationRequestAdapter, type GenerationRequestPreparationInput, type PreparedGenerationRequest, type AcceptedGenerationQuestion } from './generation-request.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { snapshotMatchesScan } from './snapshot-adapter.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { normalizeBaseUrl } from '../llm.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { chatCompletionStream } from '../llm.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { WorkflowError } from './project-contract.ts'

export interface EvidenceGenerationAdapterInput {
  readonly spec: RunSpec
  readonly scan: ScanResult
  readonly snapshot: WorkflowProjectSnapshot
  readonly store: WorkflowEvidenceStore
  readonly selection: SelectionPlan
  readonly topics: readonly TopicCard[]
  readonly ledger: BudgetLedger
  readonly profile: LlmProfile
  readonly signal: AbortSignal
  readonly transport?: ModelTransport
  /** Private evaluation-only writer switch; omitted means the candidate writer. */
  readonly writerVariant?: EvidenceGenerationWriterVariant
}

export interface EvidenceGenerationAdapter {
  readonly writerVersion: typeof EVIDENCE_GENERATION_WRITER_VERSION
  readonly writerVariant: EvidenceGenerationWriterVariant
  readonly requestAdapter: GenerationRequestAdapter
  readonly contextProvider: ContextProvider
  metadata(): readonly EvidenceGenerationRequestMetadata[]
  finalize(result: InterviewResult): Promise<QuestionEvidenceSidecar>
}

export const EVIDENCE_GENERATION_WRITER_VERSION = 'm08-evidence-writer-v1' as const
export const EVIDENCE_GENERATION_WRITER_VARIANTS = Object.freeze({ topicCards: 'topic-cards', staticControl: 'static-control' } as const)
export type EvidenceGenerationWriterVariant = typeof EVIDENCE_GENERATION_WRITER_VARIANTS[keyof typeof EVIDENCE_GENERATION_WRITER_VARIANTS]

export interface EvidenceGenerationRequestMetadata {
  readonly requestId: string
  readonly stage: GenerationRequestPreparationInput['stage']
  readonly manifest: PackedManifest
  readonly usage: ModelUsage | null
  readonly completion: 'completed' | 'failed' | 'pending'
}

interface GenerationGroup {
  readonly ids: readonly string[]
  readonly topics: readonly TopicCard[]
  readonly bundles: readonly Readonly<{ id: string; evidenceIds: readonly string[] }>[]
  readonly files: readonly EvidenceRecord[]
}

interface PreparedState {
  readonly requestId: string
  readonly stage: GenerationRequestPreparationInput['stage']
  readonly packet: PackedContext
  readonly signal: AbortSignal
  registered: boolean
  consumed: boolean
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const EVIDENCE_ID = /^ev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MAX_SELECTED_IDS = 400
const MAX_REQUIRED_BUNDLES = 40
const MAX_BUNDLE_EVIDENCE_IDS = 100
const MAX_TOPICS = 40
const MAX_TOPIC_REFS = 100
const MAX_TOPIC_ID_CHARS = 64
const MAX_TOPIC_TITLE_CHARS = 160
const MAX_TOPIC_DETAIL_CHARS = 500
const MAX_TOPIC_LIST_ITEMS = 20
const MAX_TOPIC_LIST_TEXT_CHARS = 240
// M06 bounds each unresolved list to 40 entries, but its terminal controller unions
// the selection and finish lists, so the actual returned selection can contain 80.
const MAX_UNRESOLVED_ITEMS = 80
const MAX_UNRESOLVED_TEXT_CHARS = 240
const MAX_MODEL_GROUPS = 4
const MAX_PRIOR_QUESTIONS = 12
const MAX_PRIOR_QUESTION_CHARS = 180
const MAX_METADATA_BYTES = 4 * 1024 * 1024

function fail(code: ConstructorParameters<typeof WorkflowError>[0] = 'invalid-argument'): never { throw new WorkflowError(code) }
function boundedText(value: unknown, maxChars: number): value is string { return typeof value === 'string' && value.length >= 1 && value.length <= maxChars && !value.includes('\0') }
function boundedTextList(value: unknown, maxCount: number, maxChars: number): value is readonly string[] { return Array.isArray(value) && value.length <= maxCount && value.every(item => boundedText(item, maxChars)) }
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
function json(value: unknown): string { return JSON.stringify(value) }
function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }
function endpointFingerprint(profile: LlmProfile): string {
  try { return createHash('sha256').update(normalizeBaseUrl(profile.baseUrl)).digest('hex') }
  catch { fail('configuration-changed') }
}
function assertHealthyLedger(ledger: BudgetLedger): void {
  const meter = ledger.snapshot()
  if (!meter.usageComplete || meter.blocked || meter.overspend.inputTokens || meter.overspend.outputTokens || meter.overspend.readBytes || meter.reservations.some(item => item.state !== 'settled')) fail('budget-exhausted')
}
function assertProfile(spec: RunSpec, profile: LlmProfile): void {
  if (!profile || profile.id !== spec.model.profileId || profile.model !== spec.model.model || endpointFingerprint(profile) !== spec.model.endpointFingerprint || (profile.protocol ?? 'openai') !== (spec.model.protocol ?? 'openai') || profile.reasoningEffort !== spec.model.reasoningEffort || (profile.temperature ?? 0.4) !== (spec.model.temperature ?? 0.4) || profile.contextWindowTokens !== spec.model.contextWindowTokens || profile.maxOutputTokens !== spec.model.maxOutputTokens || typeof profile.apiKey !== 'string') fail('configuration-changed')
}
function freezeProfile(profile: LlmProfile): LlmProfile {
  return Object.freeze({
    id: profile.id, name: profile.name, baseUrl: profile.baseUrl, apiKey: profile.apiKey, model: profile.model,
    ...(profile.protocol !== undefined ? { protocol: profile.protocol } : {}),
    ...(profile.reasoningEffort !== undefined ? { reasoningEffort: profile.reasoningEffort } : {}),
    ...(profile.temperature !== undefined ? { temperature: profile.temperature } : {}),
    ...(profile.contextWindowTokens !== undefined ? { contextWindowTokens: profile.contextWindowTokens } : {}),
    ...(profile.maxOutputTokens !== undefined ? { maxOutputTokens: profile.maxOutputTokens } : {})
  })
}

function validateSelection(selection: SelectionPlan, topics: readonly TopicCard[]): { ids: string[]; bundles: Array<{ id: string; evidenceIds: string[] }>; topics: TopicCard[]; unresolved: string[] } {
  if (!selection || !Array.isArray(selection.selectedIds) || selection.selectedIds.length < 1 || selection.selectedIds.length > MAX_SELECTED_IDS || !Array.isArray(selection.requiredBundles) || selection.requiredBundles.length > MAX_REQUIRED_BUNDLES || !boundedTextList(selection.unresolved, MAX_UNRESOLVED_ITEMS, MAX_UNRESOLVED_TEXT_CHARS) || !Array.isArray(topics) || topics.length > MAX_TOPICS) fail()
  const ids = [...selection.selectedIds]
  const selected = new Set(ids)
  if (ids.some(id => typeof id !== 'string' || !EVIDENCE_ID.test(id)) || selected.size !== ids.length) fail('unknown-evidence')
  const bundles: Array<{ id: string; evidenceIds: string[] }> = []
  for (const bundle of selection.requiredBundles) {
    if (!bundle || !boundedText(bundle.id, MAX_TOPIC_ID_CHARS) || !Array.isArray(bundle.evidenceIds) || bundle.evidenceIds.length < 1 || bundle.evidenceIds.length > MAX_BUNDLE_EVIDENCE_IDS || bundle.evidenceIds.some((id: unknown) => typeof id !== 'string' || !selected.has(id))) fail('unknown-evidence')
    bundles.push({ id: bundle.id, evidenceIds: [...new Set(bundle.evidenceIds as readonly string[])] })
  }
  const safeTopics: TopicCard[] = []
  for (const topic of topics) {
    if (!topic || typeof topic !== 'object' || !boundedText(topic.id, MAX_TOPIC_ID_CHARS) || !boundedText(topic.title, MAX_TOPIC_TITLE_CHARS) || !boundedText(topic.mechanism, MAX_TOPIC_DETAIL_CHARS) || !boundedText(topic.valueRationale, MAX_TOPIC_DETAIL_CHARS) || !['basic', 'intermediate', 'advanced'].includes(topic.difficulty) || !Array.isArray(topic.evidenceIds) || topic.evidenceIds.length < 1 || topic.evidenceIds.length > MAX_TOPIC_REFS || topic.evidenceIds.some((id: unknown) => typeof id !== 'string' || !selected.has(id)) || !boundedTextList(topic.evidenceNeeds, MAX_TOPIC_LIST_ITEMS, MAX_TOPIC_LIST_TEXT_CHARS) || !boundedTextList(topic.unconfirmed, MAX_TOPIC_LIST_ITEMS, MAX_TOPIC_LIST_TEXT_CHARS)) fail('unknown-evidence')
    safeTopics.push(deepFreeze({ ...topic, evidenceIds: [...new Set(topic.evidenceIds as readonly string[])], evidenceNeeds: [...topic.evidenceNeeds as readonly string[]], unconfirmed: [...topic.unconfirmed as readonly string[]] }))
  }
  return { ids, bundles, topics: safeTopics, unresolved: [...selection.unresolved] }
}

function makeGroups(ids: readonly string[], records: readonly EvidenceRecord[], bundles: readonly { id: string; evidenceIds: readonly string[] }[], topics: readonly TopicCard[], maximum: number): GenerationGroup[] {
  const parent = new Map(ids.map(id => [id, id]))
  const root = (id: string): string => {
    let current = parent.get(id)
    if (!current) fail('unknown-evidence')
    while (parent.get(current!) !== current) current = parent.get(current!)
    return current!
  }
  const join = (values: readonly string[]): void => {
    if (values.length < 2) return
    const first = root(values[0])
    for (const id of values.slice(1)) parent.set(root(id), first)
  }
  for (const bundle of bundles) join(bundle.evidenceIds)
  for (const topic of topics) join(topic.evidenceIds)
  const byId = new Map(records.map(record => [record.id, record]))
  const components = new Map<string, string[]>()
  for (const id of ids) components.set(root(id), [...(components.get(root(id)) ?? []), id])
  const ordered = [...components.values()].map(component => ({ ids: component, weight: component.reduce((sum, id) => sum + (byId.get(id)?.text.length ?? 0) + 1, 0) })).sort((a, b) => b.weight - a.weight || a.ids[0].localeCompare(b.ids[0]))
  const groupCount = Math.min(Math.max(1, maximum), MAX_MODEL_GROUPS)
  const groups = Array.from({ length: groupCount }, () => ({ ids: [] as string[], weight: 0 }))
  for (const component of ordered) {
    const target = groups.reduce((best, candidate, index) => candidate.weight < groups[best].weight ? index : best, 0)
    groups[target].ids.push(...component.ids)
    groups[target].weight += component.weight
  }
  let replicationIndex = 0
  for (const group of groups) {
    if (group.ids.length) continue
    const component = ordered[replicationIndex++ % ordered.length]
    group.ids.push(...component.ids)
    group.weight += component.weight
  }
  return groups.map(group => {
    const memberIds = new Set(group.ids)
    const topicCards = topics.filter(topic => topic.evidenceIds.every(id => memberIds.has(id)))
    const required = bundles.filter(bundle => bundle.evidenceIds.every(id => memberIds.has(id))).map(bundle => Object.freeze({ id: bundle.id, evidenceIds: Object.freeze([...bundle.evidenceIds]) }))
    for (const topic of topicCards) required.push(Object.freeze({ id: `topic-${sha256(topic.id).slice(0, 24)}`, evidenceIds: Object.freeze([...topic.evidenceIds]) }))
    return Object.freeze({ ids: Object.freeze([...group.ids]), topics: Object.freeze(topicCards), bundles: Object.freeze(required), files: Object.freeze(group.ids.map(id => byId.get(id)!).filter(Boolean)) })
  })
}

function manifestSelection(packet: PackedContext, records: readonly EvidenceRecord[]): RenderedSelection {
  const byId = new Map(records.map(record => [record.id, record]))
  const packed = packet.manifest.packedIds.map(id => byId.get(id)).filter((item): item is EvidenceRecord => Boolean(item))
  if (packed.length !== packet.manifest.packedIds.length) fail('unknown-evidence')
  const sources = packet.manifest.sources
  const paths = [...new Set(sources.map(source => source.relPath))]
  return Object.freeze({
    filePaths: Object.freeze(paths),
    selectedRegions: sources.length,
    providedChars: packed.reduce((sum, record) => sum + record.text.length, 0),
    sourceSelections: Object.freeze(sources.map(source => Object.freeze({
      relPath: source.relPath,
      wholeFile: false,
      regions: Object.freeze([Object.freeze({
        start: source.originalRange?.startLine ?? source.displayRange.startLine,
        end: source.originalRange?.endLine ?? source.displayRange.endLine,
        complete: source.originalRange !== null
      })])
    })))
  }) as unknown as RenderedSelection
}

function metadataSecurity(records: readonly EvidenceRecord[]): ContentSecuritySummary {
  const files = new Map<string, NonNullable<EvidenceRecord['redactionSummary']>>()
  for (const record of records) {
    const summary = record.redactionSummary
    if (!summary || !Number.isSafeInteger(summary.totalMatches) || summary.totalMatches < 0 || !summary.matchesByCategory || typeof summary.matchesByCategory !== 'object') fail('invalid-argument')
    const prior = files.get(record.fileId)
    if (prior && json(prior) !== json(summary)) fail('invalid-argument')
    files.set(record.fileId, summary)
  }
  const matchesByCategory: ContentSecuritySummary['matchesByCategory'] = {}
  let redactionMatches = 0
  let redactedFiles = 0
  for (const summary of files.values()) {
    redactionMatches += summary.totalMatches
    if (summary.totalMatches > 0) redactedFiles++
    let fileCategoryTotal = 0
    for (const [category, count] of Object.entries(summary.matchesByCategory)) {
      if (!Number.isSafeInteger(count) || count < 0) fail('invalid-argument')
      fileCategoryTotal += count
      matchesByCategory[category as keyof typeof matchesByCategory] = (matchesByCategory[category as keyof typeof matchesByCategory] ?? 0) + count
    }
    if (fileCategoryTotal !== summary.totalMatches) fail('invalid-argument')
  }
  return { redactedFiles, redactionMatches, matchesByCategory }
}

function legacyContext(scan: ScanResult, authorizedFilePaths: readonly string[], records: readonly EvidenceRecord[], groups: readonly GenerationGroup[]): BuiltContext {
  const allSelected = [...new Map(records.map(record => [record.id, record])).values()]
  const byId = new Map(allSelected.map(record => [record.id, record]))
  const batches: ContextBatch[] = groups.map((group, index) => {
    const files: ContextFile[] = group.files.map(record => ({ relPath: record.relPath, content: record.text, truncated: false, redacted: (record.redactionSummary?.totalMatches ?? 0) > 0, redactionMatches: record.redactionSummary?.totalMatches ?? 0 }))
    return { label: `证据组 ${index + 1}`, files, totalChars: files.reduce((sum, file) => sum + file.content.length, 0), kind: 'global', weight: Math.max(1, group.ids.reduce((sum, id) => sum + (byId.get(id)?.text.length ?? 0), 0)) }
  })
  const paths = [...new Set(allSelected.map(record => record.relPath))]
  const treeText = paths.map(value => `- ${value}`).join('\n')
  const langText = scan.languages.slice(0, 32).map(language => `${language.lang} ${language.percent}%`).join('、') || '未识别出常见编程语言'
  const partialWarning = scan.truncation ? '本次扫描触及安全限制；当前分析只覆盖明确提供的已授权证据。' : ''
  const headerText = [`项目：${scan.name}`, `主要语言：${langText}`, `本次选择的已授权证据文件：${paths.length}`, partialWarning, '', '## 本请求证据文件', '```', '（见下方文件树）', '```'].filter(line => line !== '').join('\n')
  const selectedFiles = new Set(paths)
  const contextTruncation = { treeTruncated: Boolean(scan.truncation), contentTruncated: false, requestTruncated: false }
  return {
    headerText,
    treeText,
    contextTruncation,
    batches,
    contentSecurity: metadataSecurity(allSelected),
    contentReadSummary: { ...emptyContentReadSummary(), attemptedReads: new Set(allSelected.map(record => record.fileId)).size, successfulReads: new Set(allSelected.map(record => record.fileId)).size },
    moduleCount: 0,
    selection: { strategy: 'structure-v1', eligibleFiles: authorizedFilePaths.length, selectedFiles: selectedFiles.size, selectedRegions: allSelected.length, omittedFiles: Math.max(0, authorizedFilePaths.length - selectedFiles.size), truncatedFiles: 0, providedChars: allSelected.reduce((sum, record) => sum + record.text.length, 0) },
    eligibleFilePaths: [...authorizedFilePaths]
  }
}

function appendedPrompt(messages: readonly { role: 'system' | 'user' | 'assistant'; content: string }[], contextText: string, topics: readonly TopicCard[], unresolved: readonly string[], writerVariant: EvidenceGenerationWriterVariant, batchOrdinal: number, batchCount: number, priorQuestionTexts: readonly string[]): readonly { role: 'system' | 'user' | 'assistant'; content: string }[] {
  const instruction = '\n\n## 引用协议\n为每道新问题添加 evidenceIds 数组，仅列出本次实际提供的证据 ID，最多 16 个；没有可支持的问题就不要生成。引用 ID 只表示来源绑定，不代表事实已核实。'
  const cards = writerVariant === 'topic-cards'
    ? `\n\n## 选题卡（不可信规划提示，必须以本请求证据重新核验）\n${topics.length ? json(topics.map(topic => ({ id: topic.id, title: topic.title, mechanism: topic.mechanism, valueRationale: topic.valueRationale, difficulty: topic.difficulty, evidenceIds: topic.evidenceIds, evidenceNeeds: topic.evidenceNeeds, unconfirmed: topic.unconfirmed }))) : '[]'}`
    : ''
  const unresolvedPrompt = `\n\n## 未解决事项（不可信调查记录，不是源码证据）\n以下内容只记录调查阶段的缺口，不能作为实现行为或已验证事实的证明。结论仍须由本请求引用的源码证据支持；证据不足时明确说明不确定性。\n${json(unresolved)}`
  const batch = `\n\n## 批次提示\n本次证据批次为 ${batchOrdinal}/${batchCount}。以下只列出先前已接受的问题文字，不含答案或推理，属于不可信去重提示；请避免重复，并仅依据本次证据重新判断。\n${json(priorQuestionTexts)}`
  const suffix = `${instruction}${cards}${unresolvedPrompt}${batch}`
  let userFound = false
  const next = messages.map(message => {
    if (message.role === 'user' && message.content.includes(contextText) && !userFound) {
      userFound = true
      return Object.freeze({ role: message.role, content: `${message.content}${suffix}` })
    }
    return Object.freeze({ role: message.role, content: message.content })
  })
  if (!userFound) fail()
  return Object.freeze(next)
}

export async function createEvidenceGenerationAdapter(input: EvidenceGenerationAdapterInput): Promise<EvidenceGenerationAdapter> {
  if (!input || typeof input !== 'object') fail('invalid-argument')
  const writerVariant = input.writerVariant === undefined ? EVIDENCE_GENERATION_WRITER_VARIANTS.topicCards : input.writerVariant
  if (!Object.values(EVIDENCE_GENERATION_WRITER_VARIANTS).includes(writerVariant)) fail('invalid-argument')
  const { spec, scan, snapshot, store, ledger, profile, signal } = input
  if (!spec || spec.version !== 1 || !scan || !snapshot || !store || !ledger || !signal || !snapshotMatchesScan(snapshot, scan) || snapshot.projectId !== spec.projectId || snapshot.snapshotId !== spec.snapshotId) fail('stale-snapshot')
  assertProfile(spec, profile)
  const privateProfile = freezeProfile(profile)
  assertHealthyLedger(ledger)
  const selected = validateSelection(input.selection, input.topics)
  const resolved = await store.resolve(selected.ids, spec.snapshotId, signal)
  await snapshot.assertCurrent(signal)
  if (resolved.length !== selected.ids.length || resolved.some(record => !selected.ids.includes(record.id) || record.snapshotId !== spec.snapshotId)) fail('unknown-evidence')
  const desired = spec.granularity === 'coarse' ? 1 : spec.granularity === 'medium' ? 2 : 4
  const remainingCalls = ledger.snapshot().remaining.modelRequests
  if (remainingCalls < 1) fail('budget-exhausted')
  const groups = makeGroups(selected.ids, resolved, selected.bundles, selected.topics, Math.min(desired, remainingCalls))
  if (!groups.length) fail('budget-exhausted')
  const registry = createQuestionEvidenceRegistry(spec)
  const preparedStates = new WeakMap<object, PreparedState>()
  const priorQuestionTexts: string[] = []
  const dispatchMetadata = new Map<string, { readonly stage: GenerationRequestPreparationInput['stage']; readonly manifest: PackedManifest; completion: EvidenceGenerationRequestMetadata['completion'] }>()
  let meteringFailed = false
  let finalized = false
  let builtContext: BuiltContext | undefined

  const contextProvider: ContextProvider = Object.freeze({
    id: 'evidence-source-bound-v1',
    async build(requestScan: ScanResult, granularity: Granularity, options: { maxChars?: number; roleFocus?: RoleFocus; signal?: AbortSignal } = {}): Promise<BuiltContext> {
      if (requestScan !== scan || granularity !== spec.granularity || options.roleFocus !== spec.roleFocus || options.signal !== signal) fail('invalid-argument')
      if (signal.aborted) fail('cancelled')
      if (!snapshotMatchesScan(snapshot, requestScan)) fail('stale-snapshot')
      await snapshot.assertCurrent(signal)
      builtContext = legacyContext(scan, snapshot.files.map(file => file.relPath), resolved, groups)
      return builtContext
    }
  })

  const requestAdapter: GenerationRequestAdapter = Object.freeze({
    id: 'evidence-source-bound-v1',

    async prepare(request: GenerationRequestPreparationInput): Promise<PreparedGenerationRequest> {
      if (meteringFailed) fail('budget-exhausted')
      if (finalized) fail()
      if (!request || request.signal !== signal) fail('invalid-argument')
      if (signal.aborted) fail('cancelled')
      if (!snapshotMatchesScan(snapshot, scan)) fail('stale-snapshot')
      if (!builtContext) fail('invalid-argument')
      await snapshot.assertCurrent(signal)
      ledger.assertCanContinue(request.stage)
      assertHealthyLedger(ledger)
      const group = groups[request.batchIndex]
      if (!group || !Number.isSafeInteger(request.quota) || request.quota < 0 || request.quota > spec.questionBudget.max || typeof request.buildMessages !== 'function' || typeof request.requestId !== 'string' || !ID.test(request.requestId)) fail()
      const maxChars = Math.min(request.maxChars, CONTEXT_CHAR_BUDGETS[spec.granularity])
      const maxInputTokens = Math.min(request.maxInputTokens, spec.generationInputTokens)
      if (!Number.isSafeInteger(maxChars) || maxChars < 1 || !Number.isSafeInteger(maxInputTokens) || maxInputTokens < 1) fail('budget-exhausted')
      const packed = await packEvidence({
        spec,
        store,
        // M07's unresolved field is not rendered and has a tighter item-size limit; preserve M06 gaps in the shared bounded prompt below.
        selection: { selectedIds: group.ids, requiredBundles: group.bundles, unresolved: [] },
        buildMessages: contextText => appendedPrompt(request.buildMessages(contextText), contextText, group.topics, selected.unresolved, writerVariant, request.batchIndex + 1, groups.length, priorQuestionTexts),
        maxChars,
        maxInputTokens,
        signal
      })
      if (packed.status !== 'packed') fail('budget-exhausted')
      if (packed.context.manifest.omitted.length && builtContext) builtContext.contextTruncation.contentTruncated = true
      await snapshot.assertCurrent(signal)
      const renderedSelection = manifestSelection(packed.context, resolved)
      const dispatchToken = Object.freeze({})
      const prepared = Object.freeze({
        requestId: request.requestId,
        stage: request.stage,
        messages: packed.context.messages,
        dispatch: dispatchToken,
        selection: renderedSelection
      }) as PreparedGenerationRequest
      preparedStates.set(prepared as object, { requestId: request.requestId, stage: request.stage, packet: packed.context, signal, registered: false, consumed: false })
      return prepared
    },

    async complete(prepared: PreparedGenerationRequest, onDelta: (delta: string) => unknown, options: import('../llm.ts').CallOptions): Promise<string> {
      const state = prepared && typeof prepared === 'object' ? preparedStates.get(prepared as object) : undefined
      if (meteringFailed) fail('budget-exhausted')
      if (!state || state.consumed || finalized || prepared.requestId !== state.requestId || prepared.stage !== state.stage) fail()
      state.consumed = true
      if (!options || typeof options !== 'object' || options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) || options.maxOutputTokens !== undefined && (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens < 1) || options.beforeRequest !== undefined && typeof options.beforeRequest !== 'function' || options.onRequest !== undefined && typeof options.onRequest !== 'function' || options.onUsage !== undefined && typeof options.onUsage !== 'function') fail()
      if (options.signal !== undefined && options.signal !== state.signal) fail('invalid-argument')
      if (state.signal.aborted) fail('cancelled')
      if (!snapshotMatchesScan(snapshot, scan)) fail('stale-snapshot')
      await snapshot.assertCurrent(signal)
      ledger.assertCanContinue(state.stage)
      assertHealthyLedger(ledger)
      const guard = makeDispatchGuard(state.packet)
      const dispatchGuard = (messages: readonly import('../llm.ts').ChatMessage[]): void => {
        if (state.registered) fail()
        if (state.signal.aborted) fail('cancelled')
        if (!snapshotMatchesScan(snapshot, scan)) fail('stale-snapshot')
        guard(messages)
        options.beforeRequest?.()
        if (state.signal.aborted) fail('cancelled')
        if (!snapshotMatchesScan(snapshot, scan)) fail('stale-snapshot')
        registry.registerRequest(state.requestId, state.packet)
        dispatchMetadata.set(state.requestId, { stage: state.stage, manifest: state.packet.manifest, completion: 'pending' })
        state.registered = true
      }
      const actualTransport = input.transport ?? chatCompletionStream
      const transport: ModelTransport = async (activeProfile, messages, emit, gatewayOptions) => {
        const timeoutMs = options.timeoutMs === undefined ? gatewayOptions.timeoutMs : Math.min(options.timeoutMs, gatewayOptions.timeoutMs ?? options.timeoutMs)
        const maxOutputTokens = options.maxOutputTokens === undefined ? gatewayOptions.maxOutputTokens : Math.min(options.maxOutputTokens, gatewayOptions.maxOutputTokens ?? options.maxOutputTokens)
        return actualTransport(activeProfile, messages, emit, {
          signal: state.signal,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
          includeUsage: true,
          beforeRequest: () => {
            gatewayOptions.beforeRequest?.()
            try { options.onRequest?.() } catch { /* request observers cannot affect dispatch */ }
          },
          onUsage: usage => { gatewayOptions.onUsage?.(usage) }
        })
      }
      const gateway = createModelGateway(spec, privateProfile, ledger, { transport })
      const forwardSettledUsage = (): void => {
        try {
          const usage = ledger.snapshot().reservations.find(item => item.id === state.requestId)?.usage
          if (usage) options.onUsage?.(Object.freeze({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens }))
        } catch { /* A diagnostic observer cannot replace the gateway outcome. */ }
      }
      let completion: ModelCompletion
      try {
        completion = await gateway.complete({ id: state.requestId, stage: state.stage as ModelStage, messages: state.packet.messages, signal: state.signal, onDelta, dispatchGuard, ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}) })
      } catch (error) {
        const meta = dispatchMetadata.get(state.requestId)
        if (meta) meta.completion = 'failed'
        forwardSettledUsage()
        try {
          const failedMeter = ledger.snapshot()
          if (!failedMeter.usageComplete || failedMeter.blocked || failedMeter.overspend.inputTokens || failedMeter.overspend.outputTokens || failedMeter.overspend.readBytes) meteringFailed = true
        } catch { meteringFailed = true }
        throw error
      }
      const completedMeta = dispatchMetadata.get(state.requestId)
      if (completedMeta) completedMeta.completion = 'completed'
      forwardSettledUsage()
      await snapshot.assertCurrent(signal)
      const meter = ledger.snapshot()
      if (!completion.usage || !meter.usageComplete || meter.blocked || meter.overspend.inputTokens || meter.overspend.outputTokens || meter.overspend.readBytes || meter.reservations.some(item => item.state !== 'settled')) {
        if (completedMeta) completedMeta.completion = 'failed'
        meteringFailed = true
        fail('budget-exhausted')
      }
      return completion.content
    },

    acceptQuestion(input: AcceptedGenerationQuestion): void {
      if (meteringFailed) fail('budget-exhausted')
      if (finalized || !input || typeof input.requestId !== 'string') fail()
      if (signal.aborted) fail('cancelled')
      if (!snapshotMatchesScan(snapshot, scan)) fail('stale-snapshot')
      try { registry.capture({ requestId: input.requestId, rawQuestion: input.rawQuestion, question: input.question as QuestionItem }) }
      catch (error) {
        if (error instanceof WorkflowError && (error.code === 'unknown-evidence' || error.code === 'invalid-argument')) throw new CitationValidationError()
        throw error
      }
      const text = safeClipText(input.question.question.replace(/\s+/g, ' ').trim(), MAX_PRIOR_QUESTION_CHARS)
      if (text && !priorQuestionTexts.includes(text)) {
        priorQuestionTexts.push(text)
        if (priorQuestionTexts.length > MAX_PRIOR_QUESTIONS) priorQuestionTexts.shift()
      }
    }
  })

  return Object.freeze({
    writerVersion: EVIDENCE_GENERATION_WRITER_VERSION,
    writerVariant,
    requestAdapter,
    contextProvider,
    metadata(): readonly EvidenceGenerationRequestMetadata[] {
      const reservations = new Map(ledger.snapshot().reservations.map(item => [item.id, item]))
      const rows: EvidenceGenerationRequestMetadata[] = []
      let metadataBytes = 0
      for (const [requestId, item] of dispatchMetadata) {
        const reservation = reservations.get(requestId)
        if (!reservation || !['dispatched', 'settled', 'unknown'].includes(reservation.state)) continue
        const manifestJson = json(item.manifest)
        metadataBytes += Buffer.byteLength(manifestJson, 'utf8')
        if (metadataBytes > MAX_METADATA_BYTES || rows.length >= spec.budget.total.maxModelRequests) fail('capacity-exhausted')
        const manifest = deepFreeze(JSON.parse(manifestJson) as PackedManifest)
        const usage = reservation.state === 'settled' && reservation.usage
          ? Object.freeze({ inputTokens: reservation.usage.inputTokens, outputTokens: reservation.usage.outputTokens, totalTokens: reservation.usage.totalTokens })
          : null
        rows.push(Object.freeze({ requestId, stage: item.stage, manifest, usage, completion: item.completion }))
      }
      return Object.freeze(rows)
    },
    async finalize(result: InterviewResult): Promise<QuestionEvidenceSidecar> {
      if (meteringFailed) fail('budget-exhausted')
      if (finalized) fail()
      if (signal.aborted) fail('cancelled')
      if (!snapshotMatchesScan(snapshot, scan)) fail('stale-snapshot')
      await snapshot.assertCurrent(signal)
      assertHealthyLedger(ledger)
      if (!result || result.projectName !== scan.name || result.projectPath !== scan.root || result.granularity !== spec.granularity || result.roleFocus !== spec.roleFocus || result.profileId !== spec.model.profileId || result.modelUsed !== `${privateProfile.name} / ${privateProfile.model}`) fail('invalid-argument')
      try { assertInterviewResultContract(result) } catch { fail('invalid-argument') }
      const questionCount = result.sections.reduce((sum, section) => sum + section.questions.length, 0)
      if (questionCount < spec.questionBudget.min || questionCount > spec.questionBudget.max) fail('invalid-argument')
      finalized = true
      return registry.finalize(result)
    }
  })
}
