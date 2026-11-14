// Shared structural policy for generated reports; inspection grants no request or source authority.
import { randomUUID } from 'node:crypto'
import type { FollowUp, QuestionItem, Section } from '@shared/types'
import { assertInterviewResultContract, ResultContractError, RESULT_LIMITS } from '@shared/result-contract'
import { GENERATION_DRAFT_MESSAGES } from '@shared/generation-checkpoint'
import { InterviewJsonStream, type StreamedInterviewQuestion } from './interview-json-stream'

interface RawQuestion {
  title?: unknown
  question?: unknown
  answer?: unknown
  followUps?: unknown
}
interface RawSection {
  title?: unknown
  summary?: unknown
  questions?: unknown
}
interface RawResult {
  projectSummary?: unknown
  sections?: unknown
  glossary?: unknown
}

function normalizeFollowUps(raw: unknown, depth: number): FollowUp[] {
  if (!Array.isArray(raw) || depth > 2) return []
  return raw
    .map((item): FollowUp | null => {
      if (!item || typeof item !== 'object') return null
      const q = item as RawQuestion
      const question = typeof q.question === 'string' ? q.question.trim() : ''
      const answer = typeof q.answer === 'string' ? q.answer.trim() : ''
      if (!question || !answer) return null
      return { question, answer, followUps: normalizeFollowUps(q.followUps, depth + 1) }
    })
    .filter((f): f is FollowUp => f !== null)
}

export type ParsedGenerationBatch = {
  projectSummary: string
  sections: Section[]
  glossary: Record<string, string>
}

export function normalizeParsed(raw: unknown, allowEmpty = false): ParsedGenerationBatch {
  if (!raw || typeof raw !== 'object') throw new Error('模型输出不是 JSON 对象')
  const obj = raw as RawResult
  const projectSummary = typeof obj.projectSummary === 'string' ? obj.projectSummary.trim() : ''

  const sections: Section[] = []
  if (Array.isArray(obj.sections)) {
    for (const s of obj.sections) {
      if (!s || typeof s !== 'object') continue
      const sec = s as RawSection
      const title = typeof sec.title === 'string' && sec.title.trim() ? sec.title.trim() : '未命名主题'
      const questions: QuestionItem[] = []
      if (Array.isArray(sec.questions)) {
        for (const q of sec.questions) {
          if (!q || typeof q !== 'object') continue
          const qo = q as RawQuestion
          const question = typeof qo.question === 'string' ? qo.question.trim() : ''
          const answer = typeof qo.answer === 'string' ? qo.answer.trim() : ''
          if (!question || !answer) continue
          const title = typeof qo.title === 'string'
            ? qo.title.trim().replace(/[\r\n]+/g, ' ')
            : ''
          questions.push({
            id: randomUUID(),
            ...(title && title.length <= RESULT_LIMITS.questionTitle ? { title } : {}),
            question,
            answer,
            followUps: normalizeFollowUps(qo.followUps, 1)
          })
        }
      }
      if (questions.length) {
        sections.push({
          id: randomUUID(),
          title,
          summary: typeof sec.summary === 'string' ? sec.summary.trim() : undefined,
          questions
        })
      }
    }
  }
  if (!sections.length && !allowEmpty) throw new Error('模型输出中没有有效的问题（sections 为空）')

  const glossary: Record<string, string> = {}
  if (obj.glossary && typeof obj.glossary === 'object') {
    for (const [k, v] of Object.entries(obj.glossary as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim()) Object.defineProperty(glossary, k, { value: v.trim(), enumerable: true, writable: true, configurable: true })
    }
  }
  return { projectSummary, sections, glossary }
}

// Preserve the legacy public error mapping while inspection distinguishes internal failures.
const checkpointFailureCauses = new WeakMap<Error, unknown>()

export function validateCheckpointBatch(batch: unknown): ParsedGenerationBatch {
  if (!batch || typeof batch !== 'object') throw new Error(GENERATION_DRAFT_MESSAGES.changed)
  const keys = Object.keys(batch as object).sort()
  if (keys.join(',') !== 'glossary,projectSummary,sections') throw new Error(GENERATION_DRAFT_MESSAGES.changed)
  const candidate = batch as ParsedGenerationBatch
  try {
    assertInterviewResultContract({
      version: 1, createdAt: '2026-01-01T00:00:00.000Z', projectName: 'checkpoint', projectPath: '/checkpoint',
      granularity: 'coarse', roleFocus: 'general', profileId: 'checkpoint', modelUsed: 'checkpoint',
      projectSummary: candidate.projectSummary, sections: candidate.sections, glossary: candidate.glossary
    }, () => true)
  } catch (cause) {
    const error = new Error(GENERATION_DRAFT_MESSAGES.changed)
    checkpointFailureCauses.set(error, cause)
    throw error
  }
  return JSON.parse(JSON.stringify(candidate)) as ParsedGenerationBatch
}

export const GENERATION_OUTPUT_POLICY_VERSION = 'generation-output-policy-v1' as const

export interface ClosedGenerationObject {
  readonly sectionIndex: number
  readonly questionIndex: number
  readonly section: Readonly<{ title: string; summary?: string }>
  /** Transient inspection data; never persistence metadata or accepted source evidence. */
  readonly rawQuestion: unknown
}

export type GenerationOutputInspection =
  | Readonly<{
      kind: 'complete'
      batch: ParsedGenerationBatch
      closed: readonly ClosedGenerationObject[]
    }>
  | Readonly<{
      kind: 'format-failure'
      reason: 'json-syntax' | 'normalized-structure-invalid' | 'checkpoint-invalid'
      closed: readonly ClosedGenerationObject[]
    }>

function closedObjects(objects: StreamedInterviewQuestion[]): ClosedGenerationObject[] {
  return objects.map(({ sectionIndex, questionIndex, section, question }) => ({
    sectionIndex, questionIndex, section, rawQuestion: question
  }))
}

/** Inspect actual whole output independently of deltas, without granting acceptance or repair authority. */
export function inspectGenerationOutputText(reply: string): GenerationOutputInspection {
  if (typeof reply !== 'string') throw new TypeError('Generation output must be a string')
  const parser = new InterviewJsonStream()
  let closed: readonly ClosedGenerationObject[] = []
  let raw: unknown
  try {
    closed = closedObjects(parser.push(reply))
    raw = parser.finish()
  } catch (error) {
    if (!(error instanceof SyntaxError) || error.constructor !== SyntaxError || error.message !== 'Invalid interview JSON stream') throw error
    closed = [...closed, ...closedObjects(parser.drain())]
    return { kind: 'format-failure', reason: 'json-syntax', closed }
  }

  let batch: ParsedGenerationBatch
  try {
    batch = normalizeParsed(raw, true)
  } catch (error) {
    if (raw && typeof raw === 'object') throw error
    if (!(error instanceof Error) || error.constructor !== Error || ![
      '模型输出不是 JSON 对象',
      '模型输出中没有有效的问题（sections 为空）'
    ].includes(error.message)) throw error
    return { kind: 'format-failure', reason: 'normalized-structure-invalid', closed }
  }
  try {
    batch = validateCheckpointBatch(batch)
  } catch (error) {
    if (!(error instanceof Error) || !checkpointFailureCauses.has(error)) throw error
    const cause = checkpointFailureCauses.get(error)
    if (!(cause instanceof ResultContractError) || cause.constructor !== ResultContractError) throw cause
    return { kind: 'format-failure', reason: 'checkpoint-invalid', closed }
  }
  return { kind: 'complete', batch, closed }
}
