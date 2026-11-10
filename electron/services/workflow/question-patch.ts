import type { FollowUp, InterviewResult, QuestionItem } from '../../../shared/types.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { GRANULARITY_QUESTION_BUDGET } from '../../../shared/types.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { assertInterviewResultContract, RESULT_LIMITS } from '../../../shared/result-contract.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { normalizeParsed } from '../generator.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { normalizeQuestionKey } from '../question-dedupe.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { fingerprintQuestion } from './question-evidence.ts'
// @ts-ignore TS5097 -- direct Node tests execute explicit TypeScript module paths.
import { WorkflowError } from './project-contract.ts'

export interface NormalizedQuestionPatch {
  readonly question: QuestionItem
  readonly evidenceIds: readonly string[]
  readonly glossary: Readonly<Record<string, string>>
}
export interface QuestionReplacementInput {
  readonly result: InterviewResult
  readonly questionId: string
  readonly expectedFingerprint: string
  readonly proposal: unknown
  readonly allowedEvidenceIds: readonly string[]
}
export interface QuestionReplacement {
  readonly result: InterviewResult
  readonly question: QuestionItem
  readonly evidenceIds: readonly string[]
  readonly beforeFingerprint: string
  readonly afterFingerprint: string
}
export interface SingleQuestionReplacementInput {
  readonly question: QuestionItem
  readonly glossary: Readonly<Record<string, string>>
  readonly expectedFingerprint: string
  readonly proposal: unknown
  readonly allowedEvidenceIds: readonly string[]
}
export interface SingleQuestionReplacement {
  readonly question: QuestionItem
  readonly glossary: Readonly<Record<string, string>>
  readonly evidenceIds: readonly string[]
  readonly beforeFingerprint: string
  readonly afterFingerprint: string
}
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const HASH = /^[a-f0-9]{64}$/
const EVIDENCE_ID = /^ev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MAX_GLOSSARY_ADDITIONS = 64
const MAX_PATCH_CHARS = 256_000
function fail(): never { throw new WorkflowError('invalid-argument') }
function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
function keys(value: unknown, allowed: readonly string[], required: readonly string[]): asserts value is Record<string, unknown> {
  if (!record(value)) fail()
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) fail()
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor)) fail()
  }
  if (required.some(key => !Object.hasOwn(value, key))) fail()
}
function array(value: unknown, min: number, max: number): asserts value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < min || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) fail()
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail()
  }
}
function text(value: unknown, max: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) fail()
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child)
    Object.freeze(value)
  }
  return value
}
function validateQuestionContent(value: unknown, depth: number, counter: { count: number; chars: number }): void {
  keys(value, depth === 0 ? ['title', 'question', 'answer', 'followUps'] : ['question', 'answer', 'followUps'], depth === 0 ? ['question', 'answer', 'followUps'] : ['question', 'answer'])
  text(value.question, RESULT_LIMITS.question)
  text(value.answer, RESULT_LIMITS.answer)
  counter.chars += value.question.length + value.answer.length
  if (depth === 0 && Object.hasOwn(value, 'title')) {
    text(value.title, MAX_PATCH_CHARS)
    if (value.title.trim().replace(/[\r\n]+/g, ' ').length > RESULT_LIMITS.questionTitle) fail()
    counter.chars += value.title.length
  }
  if (counter.chars > MAX_PATCH_CHARS || depth > 2 || depth > 0 && ++counter.count > 64) fail()
  if (Object.hasOwn(value, 'followUps')) {
    array(value.followUps, 0, 32)
    if (depth === 2 && value.followUps.length) fail()
    for (const child of value.followUps) validateQuestionContent(child, depth + 1, counter)
  }
}
function normalizeContent(value: unknown, id: string): QuestionItem {
  if (!ID.test(id)) fail()
  validateQuestionContent(value, 0, { count: 0, chars: 0 })
  // Strict validation above ensures the existing generator normalizer cannot silently drop any supplied content.
  const batch = normalizeParsed({ sections: [{ title: 'Question', questions: [value] }], glossary: {} })
  if (batch.sections.length !== 1 || batch.sections[0].questions.length !== 1) fail()
  return { ...batch.sections[0].questions[0], id }
}
function glossary(value: unknown, maxEntries: number): Record<string, string> {
  if (!record(value) || Reflect.ownKeys(value).length > maxEntries) fail()
  const result: Record<string, string> = {}
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !key || key.length > RESULT_LIMITS.glossaryKey || /[\s\[\]\0]/u.test(key)) fail()
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor)) fail()
    text(descriptor.value, RESULT_LIMITS.glossaryValue)
    if (/\[\[|\]\]/u.test(descriptor.value)) fail()
    Object.defineProperty(result, key, { value: descriptor.value.trim(), enumerable: true, writable: true, configurable: true })
  }
  return result
}
function mergeGlossary(existing: Readonly<Record<string, string>>, additions: Readonly<Record<string, string>>): Record<string, string> {
  if (!record(existing) || Reflect.ownKeys(existing).length > RESULT_LIMITS.glossaryEntries) fail()
  const merged: Record<string, string> = {}
  for (const key of Reflect.ownKeys(existing)) {
    if (typeof key !== 'string' || !key || key.length > RESULT_LIMITS.glossaryKey) fail()
    const descriptor = Object.getOwnPropertyDescriptor(existing, key)
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string' || descriptor.value.length > RESULT_LIMITS.glossaryValue) fail()
    Object.defineProperty(merged, key, { value: descriptor.value, enumerable: true, writable: true, configurable: true })
  }
  for (const [key, value] of Object.entries(additions)) {
    if (Object.hasOwn(merged, key) && merged[key] !== value) fail()
    Object.defineProperty(merged, key, { value, enumerable: true, writable: true, configurable: true })
  }
  if (Object.keys(merged).length > RESULT_LIMITS.glossaryEntries) fail()
  return merged
}
function markerCoverage(question: QuestionItem, terms: Readonly<Record<string, string>>): void {
  const check = (value: string): void => {
    const stripped = value.replace(/\[\[([^\[\]]*)\]\]/gu, (_marker, term: string) => {
      if (!term || /\s/u.test(term) || !Object.hasOwn(terms, term) || !terms[term].trim()) fail()
      return ''
    })
    if (/\[\[|\]\]/u.test(stripped)) fail()
  }
  if (question.title) check(question.title)
  check(question.question); check(question.answer)
  const visit = (children: readonly FollowUp[]): void => {
    for (const child of children) { check(child.question); check(child.answer); visit(child.followUps ?? []) }
  }
  visit(question.followUps)
}
function assertFingerprint(question: QuestionItem, expected: string): string {
  if (!HASH.test(expected) || fingerprintQuestion(question) !== expected) fail()
  return expected
}

export function normalizeQuestionPatch(proposal: unknown, original: QuestionItem, allowedEvidenceIds: readonly string[]): NormalizedQuestionPatch {
  keys(proposal, ['question', 'evidenceIds', 'glossary'], ['question', 'evidenceIds', 'glossary'])
  array(allowedEvidenceIds, 1, 4096)
  if (!original || !ID.test(original.id) || allowedEvidenceIds.some(id => typeof id !== 'string' || !EVIDENCE_ID.test(id)) || new Set(allowedEvidenceIds).size !== allowedEvidenceIds.length) fail()
  const ids = proposal.evidenceIds
  array(ids, 1, 16)
  if (ids.some(id => typeof id !== 'string' || !allowedEvidenceIds.includes(id)) || new Set(ids).size !== ids.length) fail()
  const question = normalizeContent(proposal.question, original.id)
  const additions = glossary(proposal.glossary, MAX_GLOSSARY_ADDITIONS)
  if (JSON.stringify({ question, glossary: additions }).length > MAX_PATCH_CHARS) fail()
  return freeze({ question, evidenceIds: [...ids] as string[], glossary: additions })
}

/** Standalone evaluation unit validation; no fabricated InterviewResult or question-count bypass. */
export function validateSingleQuestionEvaluationInput(question: QuestionItem, terms: Readonly<Record<string, string>>): Readonly<{ question: QuestionItem; glossary: Readonly<Record<string, string>> }> {
  keys(question, ['id', 'title', 'question', 'answer', 'followUps'], ['id', 'question', 'answer', 'followUps'])
  if (typeof question.id !== 'string' || !ID.test(question.id)) fail()
  const { id, ...content } = question
  const normalized = normalizeContent(content, id)
  const checkedTerms = glossary(terms, RESULT_LIMITS.glossaryEntries)
  if (JSON.stringify({ question: normalized, glossary: checkedTerms }).length > MAX_PATCH_CHARS) fail()
  markerCoverage(normalized, checkedTerms)
  fingerprintQuestion(normalized)
  return freeze({ question: normalized, glossary: checkedTerms })
}

export function validateSingleQuestionReplacement(input: SingleQuestionReplacementInput): SingleQuestionReplacement {
  const original = validateSingleQuestionEvaluationInput(input.question, input.glossary)
  const beforeFingerprint = assertFingerprint(input.question, input.expectedFingerprint)
  const patch = normalizeQuestionPatch(input.proposal, original.question, input.allowedEvidenceIds)
  const afterFingerprint = fingerprintQuestion(patch.question)
  if (beforeFingerprint === afterFingerprint) fail()
  const terms = mergeGlossary(original.glossary, patch.glossary)
  markerCoverage(patch.question, terms)
  return freeze({ question: patch.question, glossary: terms, evidenceIds: patch.evidenceIds, beforeFingerprint, afterFingerprint })
}

/** Pure atomic replacement: all validation happens on a detached prospective result. */
export function validateQuestionReplacement(input: QuestionReplacementInput): QuestionReplacement {
  try { assertInterviewResultContract(input.result) } catch { fail() }
  const matches = input.result.sections.flatMap(section => section.questions).filter(question => question.id === input.questionId)
  if (matches.length !== 1) fail()
  const original = matches[0]
  const beforeFingerprint = assertFingerprint(original, input.expectedFingerprint)
  const patch = normalizeQuestionPatch(input.proposal, original, input.allowedEvidenceIds)
  const afterFingerprint = fingerprintQuestion(patch.question)
  if (beforeFingerprint === afterFingerprint) fail()
  const prospective = structuredClone(input.result)
  prospective.glossary = mergeGlossary(prospective.glossary, patch.glossary)
  for (const section of prospective.sections) section.questions = section.questions.map(question => question.id === original.id ? structuredClone(patch.question) : question)
  const budget = GRANULARITY_QUESTION_BUDGET[prospective.granularity]
  const count = prospective.sections.reduce((sum, section) => sum + section.questions.length, 0)
  if (!budget || count < budget.min || count > budget.max) fail()
  const sectionIds = new Set<string>()
  const questionIds = new Set<string>()
  const questionKeys = new Set<string>()
  for (const section of prospective.sections) {
    if (!ID.test(section.id) || sectionIds.has(section.id)) fail()
    sectionIds.add(section.id)
    for (const question of section.questions) {
      const key = normalizeQuestionKey(question.question)
      if (!ID.test(question.id) || questionIds.has(question.id) || !key || questionKeys.has(key)) fail()
      questionIds.add(question.id); questionKeys.add(key)
      markerCoverage(question, prospective.glossary)
    }
  }
  try { assertInterviewResultContract(prospective) } catch { fail() }
  return freeze({ result: prospective, question: prospective.sections.flatMap(section => section.questions).find(question => question.id === original.id)!, evidenceIds: patch.evidenceIds, beforeFingerprint, afterFingerprint })
}
