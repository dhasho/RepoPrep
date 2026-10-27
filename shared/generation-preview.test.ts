import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore TS5097 -- direct Node tests use explicit TypeScript extensions.
import { isGenerationPreview } from './generation-preview.ts'

const preview = () => ({
  projectSummary: '报告正文', sections: [], completedQuestions: 0, targetQuestions: 20,
  activeQuestion: { key: '0:0', sectionTitle: '架构', question: '', answer: '正在形成的答案\n\n- 第一项', followUps: [] }
})

test('bounded incomplete report text is allowed without treating it as a saved question', () => {
  assert.equal(isGenerationPreview(preview()), true)
  assert.equal(isGenerationPreview({ projectSummary: '', sections: [], completedQuestions: 0, targetQuestions: 20 }), true)
  assert.equal(isGenerationPreview({ ...preview(), security: { excludedFiles: 1, redactedFiles: 0, redactionMatches: 0, categories: {} } }), true)
})

test('preview rejects raw, reasoning, credential and unknown fields without executing getters', () => {
  for (const field of ['rawJson', 'reasoning', 'apiKey']) assert.equal(isGenerationPreview({ ...preview(), [field]: 'private' }), false)
  assert.equal(isGenerationPreview({ ...preview(), activeQuestion: { ...preview().activeQuestion, thinking: 'private' } }), false)
  let getterRead = false
  const value = preview()
  Object.defineProperty(value, 'projectSummary', { enumerable: true, get() { getterRead = true; return 'private' } })
  assert.equal(isGenerationPreview(value), false)
  assert.equal(getterRead, false)
})

test('preview shares result text limits and rejects invalid types and metadata', () => {
  assert.equal(isGenerationPreview({ ...preview(), completedQuestions: -1 }), false)
  assert.equal(isGenerationPreview({ ...preview(), targetQuestions: '20' }), false)
  assert.equal(isGenerationPreview({ ...preview(), projectSummary: 'x'.repeat(50_001) }), false)
  assert.equal(isGenerationPreview({ ...preview(), activeQuestion: { ...preview().activeQuestion, answer: 'x'.repeat(50_001) } }), false)
  assert.equal(isGenerationPreview({ ...preview(), activeQuestion: { ...preview().activeQuestion, question: { html: 'unsafe' } } }), false)
  assert.equal(isGenerationPreview({ ...preview(), sections: [{ id: 's1', title: 'Section', questions: [{ id: 'q1', question: 'Q?', answer: 'A', followUps: [], apiKey: 'private' }] }] }), false)
})
