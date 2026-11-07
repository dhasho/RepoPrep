import { createHash } from 'node:crypto'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import type { InterviewResult, QuestionItem } from '../../../shared/types.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import type { RunSpec } from './run-spec.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import type { PackedContext, PackedManifest } from './evidence-packer.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { WorkflowError } from './project-contract.ts'

export interface QuestionEvidenceEntry {
  readonly questionId: string
  readonly questionFingerprint: string
  readonly requestId: string
  readonly manifestHash: string
  readonly evidenceIds: readonly string[]
  readonly verification: 'source-bound-unverified'
}

export interface QuestionEvidenceSidecar {
  readonly version: 1
  readonly runId: string
  readonly projectId: string
  readonly snapshotId: string
  readonly questions: readonly QuestionEvidenceEntry[]
}

export interface QuestionEvidenceRegistry {
  registerRequest(requestId: string, packedContextOrManifest: PackedContext | PackedManifest): void
  capture(input: { readonly requestId: string; readonly rawQuestion: unknown; readonly question: QuestionItem }): void
  finalize(result: InterviewResult): QuestionEvidenceSidecar
}

interface RegisteredRequest { readonly manifestHash: string; readonly packedIds: ReadonlySet<string> }
interface CapturedBinding { readonly requestId: string; readonly manifestHash: string; readonly evidenceIds: readonly string[] }

const HASH = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const EVIDENCE_ID = /^ev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MAX_EVIDENCE_IDS = 16
const MAX_ID_LENGTH = 128

function reject(code: 'invalid-argument' | 'unknown-evidence' = 'invalid-argument'): never {
  throw new WorkflowError(code)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function manifestFrom(value: PackedContext | PackedManifest): unknown {
  if (!isRecord(value)) return undefined
  return 'manifest' in value ? value.manifest : value
}

function validateManifest(value: unknown, spec: RunSpec): PackedManifest {
  if (!isRecord(value) || value.version !== 1 || value.runId !== spec.runId || value.projectId !== spec.projectId || value.snapshotId !== spec.snapshotId) reject('unknown-evidence')
  if (!Array.isArray(value.selectedIds) || !Array.isArray(value.requiredIds) || !Array.isArray(value.packedIds) || !Array.isArray(value.omitted) || !Array.isArray(value.sources)) reject()
  if (value.selectedIds.length > 4096 || value.requiredIds.length > 4096 || value.packedIds.length < 1 || value.packedIds.length > 4096 || value.omitted.length > 4096 || value.sources.length > 4096) reject()
  if (typeof value.requestHash !== 'string' || !HASH.test(value.requestHash) || typeof value.manifestHash !== 'string' || !HASH.test(value.manifestHash)) reject()
  for (const key of ['estimatedInputTokens', 'serializedChars', 'contextChars', 'serializationOverheadTokens', 'maxInputTokens', 'maxChars']) {
    if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0) reject()
  }
  const ids = [...value.packedIds]
  const selectedIds = [...value.selectedIds]
  const requiredIds = [...value.requiredIds]
  if (ids.some(id => typeof id !== 'string' || !EVIDENCE_ID.test(id)) || new Set(ids).size !== ids.length) reject('unknown-evidence')
  if (selectedIds.some((id: unknown) => typeof id !== 'string' || !EVIDENCE_ID.test(id)) || new Set(selectedIds).size !== selectedIds.length) reject('unknown-evidence')
  if (requiredIds.some((id: unknown) => typeof id !== 'string' || !ids.includes(id)) || new Set(requiredIds).size !== requiredIds.length) reject('unknown-evidence')
  if (ids.some(id => !selectedIds.includes(id))) reject('unknown-evidence')

  // Match the M07 manifest's declared payload fields and recompute its commitment.
  const payload = {
    version: value.version,
    runId: value.runId,
    projectId: value.projectId,
    snapshotId: value.snapshotId,
    selectedIds: value.selectedIds,
    requiredIds: value.requiredIds,
    packedIds: value.packedIds,
    omitted: value.omitted,
    sources: value.sources,
    requestHash: value.requestHash,
    estimatedInputTokens: value.estimatedInputTokens,
    serializedChars: value.serializedChars,
    contextChars: value.contextChars,
    serializationOverheadTokens: value.serializationOverheadTokens,
    maxInputTokens: value.maxInputTokens,
    maxChars: value.maxChars
  }
  if (sha256(JSON.stringify(payload)) !== value.manifestHash) reject('unknown-evidence')
  return value as unknown as PackedManifest
}

function followupFingerprint(value: unknown, depth: number, counter: { count: number; chars: number }): unknown {
  if (depth > 8 || counter.count >= 64 || !isRecord(value) || typeof value.question !== 'string' || typeof value.answer !== 'string') reject()
  counter.count++
  counter.chars += value.question.length + value.answer.length
  if (counter.chars > 256_000) reject()
  let children: unknown[] = []
  if (value.followUps !== undefined) {
    if (!Array.isArray(value.followUps) || value.followUps.length > 32) reject()
    children = value.followUps.map(child => followupFingerprint(child, depth + 1, counter))
  }
  return { question: value.question, answer: value.answer, followUps: children }
}

function fingerprintQuestion(question: QuestionItem): string {
  if (!isRecord(question) || typeof question.question !== 'string' || typeof question.answer !== 'string' || !Array.isArray(question.followUps) || question.followUps.length > 32) reject()
  const counter = { count: 0, chars: question.question.length + question.answer.length + (typeof question.title === 'string' ? question.title.length : 0) }
  if (counter.chars > 256_000) reject()
  const content = {
    title: typeof question.title === 'string' ? question.title : null,
    question: question.question,
    answer: question.answer,
    followUps: question.followUps.map(item => followupFingerprint(item, 0, counter))
  }
  return sha256(canonical(content))
}

function survivingQuestions(result: InterviewResult, maxQuestions: number): QuestionItem[] {
  if (!isRecord(result) || !Array.isArray(result.sections) || result.sections.length > 40) reject()
  const questions: QuestionItem[] = []
  for (const section of result.sections) {
    if (!isRecord(section) || !Array.isArray(section.questions)) reject()
    questions.push(...section.questions as QuestionItem[])
    if (questions.length > maxQuestions) reject()
  }
  return questions
}

/** Main-process-only, in-memory registry for source-bound model evidence references. */
export function createQuestionEvidenceRegistry(spec: RunSpec): QuestionEvidenceRegistry {
  if (!spec || spec.version !== 1 || !Number.isSafeInteger(spec.budget.total.maxModelRequests) || spec.budget.total.maxModelRequests < 1) reject()
  const maxRequests = spec.budget.total.maxModelRequests
  const maxCandidates = Math.min(128, maxRequests * 8)
  const requests = new Map<string, RegisteredRequest>()
  const bindings = new Map<string, CapturedBinding>()
  let candidateCount = 0
  let finalized = false

  return Object.freeze({
    registerRequest(requestId: string, packedContextOrManifest: PackedContext | PackedManifest): void {
      if (finalized || typeof requestId !== 'string' || !ID.test(requestId) || requests.has(requestId) || requests.size >= maxRequests) reject()
      const manifest = validateManifest(manifestFrom(packedContextOrManifest), spec)
      requests.set(requestId, Object.freeze({ manifestHash: manifest.manifestHash, packedIds: new Set(manifest.packedIds) }))
    },

    capture(input: { readonly requestId: string; readonly rawQuestion: unknown; readonly question: QuestionItem }): void {
      if (finalized || !isRecord(input) || typeof input.requestId !== 'string' || !ID.test(input.requestId) || !isRecord(input.rawQuestion) || !isRecord(input.question)) reject()
      if (candidateCount >= maxCandidates) reject()
      candidateCount++
      const request = requests.get(input.requestId)
      if (!request) reject('unknown-evidence')
      const descriptor = Object.getOwnPropertyDescriptor(input.rawQuestion, 'evidenceIds')
      const evidenceIds = descriptor && 'value' in descriptor ? descriptor.value : undefined
      if (!Array.isArray(evidenceIds) || evidenceIds.length < 1 || evidenceIds.length > MAX_EVIDENCE_IDS) reject('unknown-evidence')
      if (evidenceIds.some((id: unknown) => typeof id !== 'string' || id.length < 1 || id.length > MAX_ID_LENGTH) || new Set(evidenceIds).size !== evidenceIds.length) reject('unknown-evidence')
      if (evidenceIds.some((id: string) => !request.packedIds.has(id))) reject('unknown-evidence')
      const questionId = input.question.id
      if (typeof questionId !== 'string' || !ID.test(questionId)) reject()
      const prior = bindings.get(questionId)
      if (prior) {
        if (prior.requestId !== input.requestId || prior.manifestHash !== request.manifestHash || prior.evidenceIds.join('\0') !== evidenceIds.join('\0')) reject()
        reject()
      }
      bindings.set(questionId, Object.freeze({ requestId: input.requestId, manifestHash: request.manifestHash, evidenceIds: Object.freeze([...evidenceIds]) }))
    },

    finalize(result: InterviewResult): QuestionEvidenceSidecar {
      if (finalized) reject()
      finalized = true
      const questions = survivingQuestions(result, spec.questionBudget.max)
      const seen = new Set<string>()
      const entries: QuestionEvidenceEntry[] = []
      for (const question of questions) {
        if (!isRecord(question) || typeof question.id !== 'string' || !ID.test(question.id) || seen.has(question.id)) reject()
        seen.add(question.id)
        const binding = bindings.get(question.id)
        if (!binding) reject('unknown-evidence')
        entries.push(Object.freeze({
          questionId: question.id,
          questionFingerprint: fingerprintQuestion(question),
          requestId: binding.requestId,
          manifestHash: binding.manifestHash,
          evidenceIds: Object.freeze([...binding.evidenceIds]),
          verification: 'source-bound-unverified' as const
        }))
      }
      return Object.freeze({
        version: 1 as const,
        runId: spec.runId,
        projectId: spec.projectId,
        snapshotId: spec.snapshotId,
        questions: Object.freeze(entries)
      })
    }
  })
}
