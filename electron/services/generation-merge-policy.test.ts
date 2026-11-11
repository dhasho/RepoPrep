import test from 'node:test'
import assert from 'node:assert/strict'
import type { QuestionItem, Section } from '@shared/types'
// @ts-ignore TS5097 -- direct Node tests require the explicit TypeScript extension.
import { absorbGenerationBatch, capSectionsToMax, collectReferencedTerms, createGenerationMergeState, nextGenerationCompensation, pruneGlossary } from './generation-merge-policy.ts'
// @ts-ignore TS5097 -- direct Node tests require the explicit TypeScript extension.
import { mergeWithCompensation, type MergeInput } from './generator.ts'
import type { ParsedGenerationBatch } from './generation-output-policy'
// @ts-ignore TS5097 -- direct Node tests require the explicit TypeScript extension.
import { LlmRequestError } from './llm.ts'
// @ts-ignore TS5097 -- direct Node tests require the explicit TypeScript extension.
import { WorkflowError } from './workflow/project-contract.ts'

function question(id: string, wording = id, answer = 'Answer'): QuestionItem {
  return { id, question: wording, answer, followUps: [] }
}

function section(id: string, questions: QuestionItem[]): Section {
  return { id, title: id, questions }
}

function batch(id: string, questions: QuestionItem[], projectSummary = '', glossary: Record<string, string> = {}): ParsedGenerationBatch {
  return { projectSummary, sections: questions.length ? [section(id, questions)] : [], glossary }
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

function ordinaryInput(overrides: Partial<MergeInput> = {}): MergeInput {
  return {
    budget: { min: 2, target: 2, max: 4 },
    batches: [{ label: 'Alpha' }],
    quotas: [2],
    total: 2,
    requestBatch: async () => batch('initial', [question('one')]),
    ...overrides
  }
}

test('B0.2 empty states and unretained batches grant no summary, glossary, or seen keys', () => {
  const empty = createGenerationMergeState(0)
  assert.deepEqual(empty, {
    projectSummary: '', sections: [], glossary: {}, delivered: [], retainedByBatch: [], seenKeys: [],
    collected: 0, droppedByQuota: 0, duplicates: 0, compensated: 0, compensationRounds: 0
  })
  assert.equal(nextGenerationCompensation({ state: empty, minimum: 5, maxRounds: 2 }), null)
  const initial = freeze(createGenerationMergeState(2))
  const noQuestions = absorbGenerationBatch({ state: initial, slotIndex: 0, quota: 12, batch: freeze(batch('empty', [], 'Discarded summary', { Unused: 'No retained reference' })), role: 'initial' })
  assert.equal(noQuestions.kept, 0)
  assert.deepEqual(noQuestions.retained, [])
  const dropped = absorbGenerationBatch({ state: noQuestions.state, slotIndex: 0, quota: 0, batch: freeze(batch('zero', [question('one', '[[Term]]'), question('two')], 'Also discarded', { Term: 'Dropped' })), role: 'initial' }).state
  assert.deepEqual({ summary: dropped.projectSummary, glossary: dropped.glossary, seen: dropped.seenKeys, delivered: dropped.delivered, collected: dropped.collected, dropped: dropped.droppedByQuota }, {
    summary: '', glossary: {}, seen: [], delivered: [0, 0], collected: 0, dropped: 2
  })
  const retainedEmptySummary = absorbGenerationBatch({ state: dropped, slotIndex: 1, quota: 1, batch: batch('blank', [question('three')]), role: 'initial' }).state
  const firstSummary = absorbGenerationBatch({ state: retainedEmptySummary, slotIndex: 1, quota: 1, batch: batch('summary', [question('four')], 'First retained nonempty summary'), role: 'initial' }).state
  assert.equal(firstSummary.projectSummary, 'First retained nonempty summary')
  assert.deepEqual(firstSummary.delivered, [0, 2])
  assert.equal(firstSummary.compensated, 0)
})

test('B0.2 absorbs normalized cross-batch duplicates separately from quota drops and preserves first references', () => {
  const first = question('first', '  ＡPI [[Ｓｅｒｖｅｒ]]\t STATUS  ', 'First [[Shared]] answer')
  first.title = 'First question title'
  const other = question('other', 'Other retained [[Later]]')
  const deferred = question('deferred', 'Quota [[Deferred]]')
  const initialBatch = freeze(batch('first-section', [first, other, deferred, question('duplicate-after-quota', 'api server status')], 'First summary', {
    Deferred: 'Discarded definition', Shared: 'First shared definition', 'Ｓｅｒｖｅｒ': 'First full-width definition', Later: 'First later definition', Unused: 'Unused'
  }))
  const initialState = freeze(createGenerationMergeState(2))
  const firstAbsorb = absorbGenerationBatch({ state: initialState, slotIndex: 0, quota: 2, batch: initialBatch, role: 'initial' })
  assert.deepEqual({ kept: firstAbsorb.kept, collected: firstAbsorb.state.collected, dropped: firstAbsorb.state.droppedByQuota, duplicates: firstAbsorb.state.duplicates, seen: firstAbsorb.state.seenKeys }, {
    kept: 2, collected: 2, dropped: 1, duplicates: 1, seen: ['api server status', 'other retained later']
  })
  assert.equal(firstAbsorb.retained[0].questions[0], first)
  assert.equal(firstAbsorb.state.sections[0], firstAbsorb.retained[0])
  assert.equal(firstAbsorb.state.retainedByBatch[0][0], firstAbsorb.retained[0])
  assert.deepEqual(Object.keys(firstAbsorb.state.glossary), ['Shared', 'Ｓｅｒｖｅｒ', 'Later'])
  const duplicateOnly = absorbGenerationBatch({ state: freeze(firstAbsorb.state), slotIndex: 1, quota: 2, batch: freeze(batch('duplicate-only', [question('copy', 'API server\nSTATUS')], 'Discarded summary', { Shared: 'Discarded override' })), role: 'initial' })
  assert.equal(duplicateOnly.kept, 0)
  const later = question('new', 'A new [[Shared]] topic')
  const final = absorbGenerationBatch({ state: freeze(duplicateOnly.state), slotIndex: 1, quota: 2, batch: freeze(batch('later-section', [question('copy2', 'api   SERVER status'), deferred, later], 'Later summary', { Shared: 'Later override', Deferred: 'Retained deferred definition' })), role: 'initial' }).state
  assert.deepEqual({ summary: final.projectSummary, delivered: final.delivered, collected: final.collected, dropped: final.droppedByQuota, duplicates: final.duplicates, compensated: final.compensated }, {
    summary: 'First summary', delivered: [2, 2], collected: 4, dropped: 1, duplicates: 3, compensated: 0
  })
  assert.deepEqual(final.sections.map(s => s.id), ['first-section', 'later-section'])
  assert.deepEqual(final.sections.flatMap(s => s.questions.map(q => q.id)), ['first', 'other', 'deferred', 'new'])
  assert.equal(final.sections[0].questions[0], first)
  assert.equal(final.sections[0].questions[0].title, 'First question title')
  assert.equal(final.sections[1].questions[0], deferred)
  assert.deepEqual(Object.entries(final.glossary), [['Shared', 'First shared definition'], ['Ｓｅｒｖｅｒ', 'First full-width definition'], ['Later', 'First later definition'], ['Deferred', 'Retained deferred definition']])
  assert.deepEqual(firstAbsorb.state.delivered, [2, 0])
  assert.deepEqual(initialState.seenKeys, [])
})

test('B0.2 frozen merge snapshots can branch without mutating caller data', () => {
  const initial = freeze(createGenerationMergeState(2))
  const source = freeze(batch('frozen', [question('original', 'Original [[Term]]')], 'Summary', { Term: 'Definition' }))
  const absorbed = absorbGenerationBatch({ state: initial, slotIndex: 0, quota: 1, batch: source, role: 'initial' })
  const snapshot = freeze(absorbed.state)
  const left = absorbGenerationBatch({ state: snapshot, slotIndex: 1, quota: 1, batch: freeze(batch('left', [question('left')])), role: 'initial' }).state
  const right = absorbGenerationBatch({ state: snapshot, slotIndex: 1, quota: 1, batch: freeze(batch('right', [question('right')])), role: 'compensation' }).state
  assert.deepEqual(snapshot.seenKeys, ['original term'])
  assert.deepEqual(snapshot.delivered, [1, 0])
  assert.deepEqual(snapshot.retainedByBatch.map(s => s.map(item => item.id)), [['frozen'], []])
  assert.deepEqual(left.seenKeys, ['original term', 'left'])
  assert.deepEqual(right.seenKeys, ['original term', 'right'])
  assert.equal(left.compensated, 0)
  assert.equal(right.compensated, 1)
  assert.equal(right.sections[0].questions[0], source.sections[0].questions[0])
  assert.deepEqual(source.glossary, { Term: 'Definition' })
})

test('B0.2 compensation chooses the first least-delivered slot and lists that slot before all others', () => {
  let state = createGenerationMergeState(3)
  state = absorbGenerationBatch({ state, slotIndex: 0, quota: 2, batch: batch('A', [question('A-one'), question('A-two')]), role: 'initial' }).state
  state = absorbGenerationBatch({ state, slotIndex: 1, quota: 1, batch: batch('B', [question('B-only')]), role: 'initial' }).state
  state = absorbGenerationBatch({ state, slotIndex: 2, quota: 1, batch: batch('C', [question('C-only')]), role: 'initial' }).state
  freeze(state)
  const next = nextGenerationCompensation({ state, minimum: 15, maxRounds: 2 })
  assert.ok(next)
  assert.deepEqual({ slotIndex: next.slotIndex, gap: next.gap, ask: next.ask, round: next.round }, { slotIndex: 1, gap: 11, ask: 8, round: 1 })
  assert.equal(next.instruction, '这是补充请求：此前该部分已保留 1 题，总量还差 11 题。请再补充 8 个此前没有覆盖到的考察点，不要重复已有问题。\n以下是已保留的问题，请避开这些问题：\n- B-only\n- A-one\n- A-two\n- C-only\n')
  assert.equal(state.compensationRounds, 0)
  assert.equal(next.startedState.compensationRounds, 1)
  const retained = absorbGenerationBatch({ state: freeze(next.startedState), slotIndex: next.slotIndex, quota: next.ask, batch: batch('B-extra', [question('B-extra')]), role: 'compensation' }).state
  const second = nextGenerationCompensation({ state: retained, minimum: 15, maxRounds: 2 })
  assert.ok(second)
  assert.deepEqual({ slotIndex: second.slotIndex, gap: second.gap, ask: second.ask, round: second.round, compensated: retained.compensated }, { slotIndex: 2, gap: 10, ask: 8, round: 2, compensated: 1 })
})

test('B0.2 initial quotas above eight remain intact and one compensation round can close the gap', () => {
  const initialQuestions = Array.from({ length: 12 }, (_, index) => question('initial-' + index))
  const initial = absorbGenerationBatch({ state: createGenerationMergeState(1), slotIndex: 0, quota: 12, batch: batch('large-initial', initialQuestions), role: 'initial' }).state
  assert.deepEqual({ delivered: initial.delivered, collected: initial.collected, dropped: initial.droppedByQuota }, { delivered: [12], collected: 12, dropped: 0 })
  assert.equal(initial.sections[0].questions[11], initialQuestions[11])
  const next = nextGenerationCompensation({ state: initial, minimum: 14, maxRounds: 2 })
  assert.ok(next)
  assert.equal(next.ask, 2)
  const closed = absorbGenerationBatch({ state: next.startedState, slotIndex: 0, quota: next.ask, batch: batch('extra', [question('extra-one'), question('extra-two'), question('extra-over-quota')]), role: 'compensation' }).state
  assert.deepEqual({ delivered: closed.delivered, collected: closed.collected, compensated: closed.compensated, dropped: closed.droppedByQuota, rounds: closed.compensationRounds }, { delivered: [14], collected: 14, compensated: 2, dropped: 1, rounds: 1 })
  assert.equal(nextGenerationCompensation({ state: closed, minimum: 14, maxRounds: 2 }), null)
  assert.equal(nextGenerationCompensation({ state: initial, minimum: 14, maxRounds: 0 }), null)
})

test('B0.2 two rounds exhaust the ceiling even when later compensation repeats earlier compensation', () => {
  const initial = absorbGenerationBatch({ state: createGenerationMergeState(1), slotIndex: 0, quota: 1, batch: batch('initial', [question('A')]), role: 'initial' }).state
  const first = nextGenerationCompensation({ state: initial, minimum: 5, maxRounds: 2 })
  assert.ok(first)
  const afterFirst = absorbGenerationBatch({ state: first.startedState, slotIndex: 0, quota: first.ask, batch: batch('first-compensation', [question('A-copy', ' A '), question('B')]), role: 'compensation' }).state
  const second = nextGenerationCompensation({ state: afterFirst, minimum: 5, maxRounds: 2 })
  assert.ok(second)
  assert.deepEqual({ gap: second.gap, ask: second.ask, round: second.round }, { gap: 3, ask: 3, round: 2 })
  const exhausted = absorbGenerationBatch({ state: second.startedState, slotIndex: 0, quota: second.ask, batch: batch('second-compensation', [question('B-copy', '[[Ｂ]]'), question('C')]), role: 'compensation' }).state
  assert.deepEqual({ collected: exhausted.collected, delivered: exhausted.delivered, duplicates: exhausted.duplicates, compensated: exhausted.compensated, rounds: exhausted.compensationRounds }, { collected: 3, delivered: [3], duplicates: 2, compensated: 2, rounds: 2 })
  assert.deepEqual(exhausted.sections.flatMap(s => s.questions.map(q => q.id)), ['A', 'B', 'C'])
  assert.equal(nextGenerationCompensation({ state: exhausted, minimum: 5, maxRounds: 2 }), null)
})

test('B0.2 compensation instructions stay within 8000 characters without splitting Unicode', () => {
  const longQuestion = question('long', '🙂'.repeat(5000) + 'TAIL')
  const state = absorbGenerationBatch({ state: createGenerationMergeState(1), slotIndex: 0, quota: 2, batch: batch('long', [longQuestion, question('unlisted')]), role: 'initial' }).state
  const next = nextGenerationCompensation({ state, minimum: 3, maxRounds: 2 })
  assert.ok(next)
  const instruction = next.instruction
  assert.ok(instruction.length <= 8000)
  assert.match(instruction, /\n- 🙂/u)
  assert.ok(instruction.endsWith('…（其余问题省略）'))
  assert.ok(!instruction.includes('TAIL'))
  assert.doesNotMatch(instruction, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u)
})

test('B0.2 whole-section capping removes later ties first and does not create delivered credit', () => {
  const sections = [section('A', [question('a1'), question('a2'), question('a3')]), section('B', [question('b1')]), section('C', [question('c1'), question('c2')]), section('D', [question('d1')]), section('E', [question('e1'), question('e2')])]
  const source = freeze({ projectSummary: '', sections, glossary: {} })
  const state = absorbGenerationBatch({ state: createGenerationMergeState(1), slotIndex: 0, quota: 9, batch: source, role: 'initial' }).state
  const unchanged = capSectionsToMax(sections, 9)
  assert.equal(unchanged.sections, sections)
  assert.equal(unchanged.dropped, 0)
  const capped = capSectionsToMax(sections, 6)
  assert.deepEqual(capped.sections.map(s => s.id), ['A', 'C'])
  assert.equal(capped.sections[0], sections[0])
  assert.equal(capped.sections[1], sections[2])
  assert.equal(capped.dropped, 4)
  assert.deepEqual(capSectionsToMax(sections, 0), { sections: [], dropped: 9 })
  assert.equal(state.collected, 9)
  assert.deepEqual(state.delivered, [9])
  assert.equal(nextGenerationCompensation({ state, minimum: 8, maxRounds: 2 }), null)
})

test('B0.2 glossary pruning follows recursive question and answer marks in original glossary order', () => {
  const kept = question('kept', '[[Question]] [[Missing]] [[Inherited]]', '[[Answer]]')
  kept.title = '[[QuestionTitleIgnored]]'
  kept.followUps = [{ question: '[[Follow]]', answer: '[[FollowAnswer]]', followUps: [{ question: '[[Deep]]', answer: '[[DeepAnswer]]' }] }]
  const keptSection = section('kept', [kept])
  keptSection.title = '[[SectionTitleIgnored]]'
  keptSection.summary = '[[SectionSummaryIgnored]]'
  const droppedSection = section('dropped', [question('discarded', '[[Orphan]]')])
  const sections = freeze([keptSection, droppedSection])
  assert.deepEqual([...collectReferencedTerms(sections)], ['Question', 'Missing', 'Inherited', 'Answer', 'Follow', 'FollowAnswer', 'Deep', 'DeepAnswer', 'Orphan'])
  const glossary: Record<string, string> = Object.assign(Object.create({ Inherited: 'Inherited entries are ignored' }), {
    Orphan: 'Discarded section', DeepAnswer: '[[DefinitionTextIgnored]]', Question: 'Question definition', Unused: 'Unused definition', Deep: 'Deep definition', Answer: 'Answer definition', FollowAnswer: 'Nested answer', Follow: 'Nested question', SectionTitleIgnored: 'Not a question mark'
  })
  freeze(glossary)
  const pruned = pruneGlossary(glossary, capSectionsToMax(sections, 1).sections)
  assert.deepEqual(Object.entries(pruned), [['DeepAnswer', '[[DefinitionTextIgnored]]'], ['Question', 'Question definition'], ['Deep', 'Deep definition'], ['Answer', 'Answer definition'], ['FollowAnswer', 'Nested answer'], ['Follow', 'Nested question']])
  assert.equal(Object.hasOwn(pruned, 'Missing'), false)
  assert.equal(Object.hasOwn(pruned, 'Inherited'), false)
  assert.deepEqual(pruneGlossary(glossary, []), {})
})

test('B0.2 ordinary merge retains sequential requests and exact before-after progress messages', async () => {
  const events: string[] = []
  let inFlight = false
  let requests = 0
  const replies = [batch('A', [question('A-one')], 'Summary'), batch('B', [question('B-one')]), batch('A-extra', [question('A-two')])]
  const result = await mergeWithCompensation(ordinaryInput({
    budget: { min: 3, target: 3, max: 5 }, batches: [{ label: 'Alpha' }, { label: 'Beta' }], quotas: [2, 1], total: 3,
    onBatch: (index, detail, fraction) => events.push('batch ' + index + ' ' + fraction + ' ' + detail),
    onCompensate: detail => events.push('compensate ' + detail),
    requestBatch: async (index, quota, instruction) => {
      assert.equal(inFlight, false)
      inFlight = true
      events.push('request ' + index + ' ' + quota + ' ' + (instruction === undefined ? 'initial' : 'compensation'))
      if (instruction !== undefined) assert.ok(instruction.endsWith('- A-one\n- B-one\n'))
      await Promise.resolve()
      inFlight = false
      return replies[requests++]
    }
  }))
  assert.deepEqual(events, [
    'batch 0 0 本批目标 2 题，累计 0/3 题（预算 3–5）', 'request 0 2 initial', 'batch 0 0.5 本批 1/2 题（少 1 题），累计 1 题',
    'batch 1 0.5 本批目标 1 题，累计 1/3 题（预算 3–5）', 'request 1 1 initial', 'batch 1 1 本批 1/1 题，累计 2 题',
    'compensate 第 1 轮：累计 2 题，比下限少 1 题，向「Alpha」补充请求 1 题', 'request 0 1 compensation'
  ])
  assert.deepEqual(Object.keys(result), ['projectSummary', 'sections', 'glossary', 'droppedByQuota', 'compensated', 'compensationRounds', 'collected', 'duplicates'])
  assert.deepEqual({ summary: result.projectSummary, collected: result.collected, rounds: result.compensationRounds, compensated: result.compensated, dropped: result.droppedByQuota, duplicates: result.duplicates }, { summary: 'Summary', collected: 3, rounds: 1, compensated: 1, dropped: 0, duplicates: 0 })
})

test('B0.2 ordinary compensation formats retained references after onCompensate edits them', async () => {
  const retained = question('retained', 'Original wording')
  const events: string[] = []
  const result = await mergeWithCompensation(ordinaryInput({
    onCompensate: () => { events.push('callback'); retained.question = 'Changed [[Term]] wording' },
    requestBatch: async (_index, _quota, instruction) => {
      if (instruction === undefined) return batch('initial', [retained])
      events.push('request')
      assert.match(instruction, /- Changed \[\[Term\]\] wording/)
      assert.ok(!instruction.includes('Original wording'))
      return batch('empty', [])
    }
  }), 1)
  assert.deepEqual(events, ['callback', 'request'])
  assert.equal(result.sections[0].questions[0], retained)
  assert.equal(result.compensationRounds, 1)
})

test('B0.2 onCompensate exceptions propagate before formatting or launching compensation', async () => {
  const callbackError = new Error('callback failed')
  const formattingError = new Error('formatting must not run')
  let armed = false
  let formattingReads = 0
  let requests = 0
  const retained = question('retained')
  Object.defineProperty(retained, 'question', { get() { if (armed) { formattingReads++; throw formattingError } return 'Retained wording' } })
  await assert.rejects(mergeWithCompensation(ordinaryInput({
    onBatch: (_index, _detail, fraction) => { if (fraction === 1) armed = true },
    onCompensate: () => { throw callbackError },
    requestBatch: async () => { requests++; return batch('initial', [retained]) }
  })), error => error === callbackError)
  assert.equal(formattingReads, 0)
  assert.equal(requests, 1)
})

test('B0.2 compensation formatting failures retain the already-started round diagnostic', async () => {
  const retained = question('retained')
  let requests = 0
  let notified = 0
  const result = await mergeWithCompensation(ordinaryInput({
    onCompensate: () => {
      notified++
      Object.defineProperty(retained, 'question', { get() { throw new Error('formatting failure') } })
    },
    requestBatch: async () => { requests++; return batch('initial', [retained]) }
  }))
  assert.equal(notified, 1)
  assert.equal(requests, 1)
  assert.deepEqual({ rounds: result.compensationRounds, collected: result.collected, compensated: result.compensated }, { rounds: 1, collected: 1, compensated: 0 })
})

test('B0.2 failed ordinary compensation counts one started round and stops best-effort retry', async () => {
  const failure = new Error('ordinary request failure')
  let requests = 0
  const result = await mergeWithCompensation(ordinaryInput({ requestBatch: async (_index, _quota, instruction) => {
    requests++
    if (instruction !== undefined) throw failure
    return batch('initial', [question('one')])
  } }))
  assert.equal(requests, 2)
  assert.deepEqual({ collected: result.collected, compensated: result.compensated, rounds: result.compensationRounds }, { collected: 1, compensated: 0, rounds: 1 })
})

test('B0.2 checkpoint recovery rethrows the exact compensation request failure', async () => {
  const failure = new Error('retain resumable checkpoint')
  let requests = 0
  await assert.rejects(mergeWithCompensation(ordinaryInput({ checkpointResume: true, requestBatch: async (_index, _quota, instruction) => {
    requests++
    if (instruction !== undefined) throw failure
    return batch('initial', [question('one')])
  } })), error => error === failure)
  assert.equal(requests, 2)
})

test('B0.2 both LLM and workflow compensation timeouts retain their exact error identity', async () => {
  for (const failure of [new LlmRequestError('timeout'), new WorkflowError('timeout')]) {
    let requests = 0
    await assert.rejects(mergeWithCompensation(ordinaryInput({ requestBatch: async (_index, _quota, instruction) => {
      requests++
      if (instruction !== undefined) throw failure
      return batch('initial', [question('one')])
    } })), error => error === failure)
    assert.equal(requests, 2)
  }
})

test('B0.2 abort checks fence every initial batch and the full-gap compensation iteration', async () => {
  const beforeSecond = new AbortController()
  let requests = 0
  await assert.rejects(mergeWithCompensation(ordinaryInput({
    signal: beforeSecond.signal, batches: [{ label: 'A' }, { label: 'B' }], quotas: [1, 1],
    onBatch: (_index, _detail, fraction) => { if (fraction === 0.5) beforeSecond.abort() },
    requestBatch: async () => { requests++; return batch('one', [question('one')]) }
  })), error => error instanceof LlmRequestError && error.kind === 'cancelled')
  assert.equal(requests, 1)
  const afterInitial = new AbortController()
  await assert.rejects(mergeWithCompensation(ordinaryInput({
    signal: afterInitial.signal, budget: { min: 1, target: 1, max: 2 }, quotas: [1], total: 1,
    onBatch: (_index, _detail, fraction) => { if (fraction === 1) afterInitial.abort() }
  })), error => error instanceof LlmRequestError && error.kind === 'cancelled')
})

test('B0.2 compensation cancellation preserves the rejection and fences the next full-gap iteration only when one remains', async () => {
  const abortFailure = new Error('aborted request failure')
  const rejectingController = new AbortController()
  await assert.rejects(mergeWithCompensation(ordinaryInput({ signal: rejectingController.signal, requestBatch: async (_index, _quota, instruction) => {
    if (instruction !== undefined) { rejectingController.abort(); throw abortFailure }
    return batch('initial', [question('one')])
  } })), error => error === abortFailure)
  const completedInput = (controller: AbortController): MergeInput => ordinaryInput({ signal: controller.signal, requestBatch: async (_index, _quota, instruction) => {
    if (instruction !== undefined) { controller.abort(); return batch('compensation', [question('two')]) }
    return batch('initial', [question('one')])
  } })
  await assert.rejects(mergeWithCompensation(completedInput(new AbortController()), 2), error => error instanceof LlmRequestError && error.kind === 'cancelled')
  const exhausted = await mergeWithCompensation(completedInput(new AbortController()), 1)
  assert.deepEqual({ collected: exhausted.collected, rounds: exhausted.compensationRounds }, { collected: 2, rounds: 1 })
})

test('B0.2 ordinary caller round overrides preserve zero, default two, and an explicit third round', async () => {
  const run = (rounds?: number) => {
    let number = 0
    return mergeWithCompensation(ordinaryInput({ budget: { min: 3, target: 3, max: 4 }, quotas: [3], total: 3, requestBatch: async (_index, _quota, instruction) => {
      if (instruction === undefined) return batch('empty', [])
      number++
      return batch('round-' + number, [question('extra-' + number)])
    } }), rounds)
  }
  const disabled = await run(0)
  const defaults = await run()
  const third = await run(3)
  assert.deepEqual([disabled.collected, disabled.compensationRounds, disabled.compensated], [0, 0, 0])
  assert.deepEqual([defaults.collected, defaults.compensationRounds, defaults.compensated], [2, 2, 2])
  assert.deepEqual([third.collected, third.compensationRounds, third.compensated], [3, 3, 3])
  const controller = new AbortController()
  const noExtraFence = await mergeWithCompensation(ordinaryInput({ signal: controller.signal, onBatch: (_index, _detail, fraction) => { if (fraction === 1) controller.abort() } }), 0)
  assert.equal(noExtraFence.collected, 1)
})
