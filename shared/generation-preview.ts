import type { GenerationPreview } from './types'
// @ts-ignore TS5097 -- direct Node tests use explicit TypeScript extensions.
import { assertInterviewResultContract, RESULT_LIMITS } from './result-contract.ts'

function record(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Reflect.ownKeys(value).every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return typeof key === 'string' && keys.includes(key) && Boolean(descriptor?.enumerable && 'value' in descriptor)
  })
}

/** Preview is observational: invalid or oversized snapshots are dropped, never published. */
export function isGenerationPreview(value: unknown): value is GenerationPreview {
  try {
    if (!record(value, ['projectSummary', 'sections', 'completedQuestions', 'targetQuestions', 'activeQuestion', 'security', 'contextTruncation'])) return false
    if (!Number.isSafeInteger(value.completedQuestions) || Number(value.completedQuestions) < 0 || Number(value.completedQuestions) > RESULT_LIMITS.questions) return false
    if (!Number.isSafeInteger(value.targetQuestions) || Number(value.targetQuestions) < 1 || Number(value.targetQuestions) > RESULT_LIMITS.questions) return false
    const base = {
      version: 1, createdAt: '2026-01-01T00:00:00.000Z', projectName: 'Preview', projectPath: '/preview',
      granularity: 'medium', roleFocus: 'general', profileId: 'preview', modelUsed: 'preview', glossary: {}
    }
    assertInterviewResultContract({
      ...base, projectSummary: value.projectSummary, sections: value.sections,
      ...(value.security !== undefined ? { security: value.security } : {}),
      ...(value.contextTruncation !== undefined ? { contextTruncation: value.contextTruncation } : {})
    }, () => true)
    if (value.activeQuestion !== undefined) {
      const active = value.activeQuestion
      if (!record(active, ['key', 'sectionTitle', 'sectionSummary', 'title', 'question', 'answer', 'followUps'])) return false
      if (typeof active.question !== 'string' || active.question.length > RESULT_LIMITS.question) return false
      assertInterviewResultContract({
        ...base, projectSummary: '', sections: [{
          id: 'active', title: active.sectionTitle,
          ...(active.sectionSummary !== undefined ? { summary: active.sectionSummary } : {}),
          questions: [{
            id: active.key, question: active.question || 'Preview', answer: active.answer, followUps: active.followUps,
            ...(active.title !== undefined ? { title: active.title } : {})
          }]
        }]
      }, () => true)
    }
    return true
  } catch { return false }
}
