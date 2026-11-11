import type { FollowUp, Section } from '@shared/types'
import type { ParsedGenerationBatch } from './generation-output-policy'
import { MAX_QUESTIONS_PER_BATCH } from './question-budget'
import { buildCompensationInstruction, selectUniqueQuestions } from './question-dedupe'

/** Transient merge data only; a snapshot grants no request or persistence authority. */
export interface GenerationMergeState {
  readonly projectSummary: string
  readonly sections: readonly Section[]
  readonly glossary: Readonly<Record<string, string>>
  readonly delivered: readonly number[]
  readonly retainedByBatch: readonly (readonly Section[])[]
  readonly seenKeys: readonly string[]
  readonly collected: number
  readonly droppedByQuota: number
  readonly duplicates: number
  readonly compensated: number
  readonly compensationRounds: number
}

export function createGenerationMergeState(slotCount: number): GenerationMergeState {
  return {
    projectSummary: '',
    sections: [],
    glossary: {},
    delivered: Array.from({ length: slotCount }, () => 0),
    retainedByBatch: Array.from({ length: slotCount }, () => []),
    seenKeys: [],
    collected: 0,
    droppedByQuota: 0,
    duplicates: 0,
    compensated: 0,
    compensationRounds: 0
  }
}

export function absorbGenerationBatch(input: Readonly<{
  state: GenerationMergeState
  slotIndex: number
  quota: number
  batch: ParsedGenerationBatch
  role: 'initial' | 'compensation'
}>): Readonly<{ state: GenerationMergeState; kept: number; retained: readonly Section[] }> {
  const { state, slotIndex, quota, batch, role } = input
  const seen = new Set(state.seenKeys)
  const unique = selectUniqueQuestions(batch.sections, quota, seen)
  const delivered = [...state.delivered]
  delivered[slotIndex] += unique.kept
  const retainedByBatch = [...state.retainedByBatch]
  const glossary = { ...state.glossary }
  if (unique.kept > 0) {
    retainedByBatch[slotIndex] = [...retainedByBatch[slotIndex], ...unique.sections]
    const retainedGlossary = pruneGlossary(batch.glossary, unique.sections)
    for (const [term, definition] of Object.entries(retainedGlossary)) {
      if (!Object.hasOwn(glossary, term)) glossary[term] = definition
    }
  }

  return {
    state: {
      ...state,
      projectSummary: state.projectSummary || (unique.kept > 0 ? batch.projectSummary : ''),
      sections: unique.kept > 0 ? [...state.sections, ...unique.sections] : state.sections,
      glossary,
      delivered,
      retainedByBatch,
      seenKeys: [...seen],
      collected: state.collected + unique.kept,
      droppedByQuota: state.droppedByQuota + unique.dropped,
      duplicates: state.duplicates + unique.duplicates,
      compensated: state.compensated + (role === 'compensation' ? unique.kept : 0)
    },
    kept: unique.kept,
    retained: unique.sections
  }
}

export function nextGenerationCompensation(input: Readonly<{
  state: GenerationMergeState
  minimum: number
  maxRounds: number
}>): null | Readonly<{
  slotIndex: number
  gap: number
  ask: number
  round: number
  instruction: string
  startedState: GenerationMergeState
}> {
  const { state, minimum, maxRounds } = input
  const gap = minimum - state.collected
  if (gap <= 0 || !(state.compensationRounds < maxRounds) || !state.delivered.length) return null

  let slotIndex = 0
  for (let index = 1; index < state.delivered.length; index++) {
    if (state.delivered[index] < state.delivered[slotIndex]) slotIndex = index
  }
  const ask = Math.min(gap, MAX_QUESTIONS_PER_BATCH)
  const round = state.compensationRounds + 1
  return {
    slotIndex,
    gap,
    ask,
    round,
    // Ordinary generation formats this only after onCompensate and the round
    // increment, inside its request try. Keep retained question references live
    // until that boundary, including callback edits and formatting failures.
    get instruction() {
      return buildCompensationInstruction({
        delivered: state.delivered[slotIndex],
        gap,
        ask,
        sections: [...state.retainedByBatch[slotIndex], ...state.retainedByBatch.flatMap((sections, index) =>
          index === slotIndex ? [] : sections
        )]
      })
    },
    startedState: { ...state, compensationRounds: round }
  }
}

/**
 * 只保留被最终结果真正引用的名词解释。
 *
 * 裁剪题量后，被丢弃的题里标记过的名词会变成"有解释但没人引用"的孤儿词条；
 * 提示词要求 glossary 覆盖所有 [[ ]] 标记，因此模型每批都会带上自己的词条，
 * 多批合并后会明显膨胀（旧行为下 115 题可产出上千词条，而 IPC 校验对对象键数
 * 有 256 的上限，会导致导出被拒）。这里按最终 sections 里实际出现的标记收敛。
 *
 * 只做删减、不做补全：渲染层对缺失词条有 AI 现取作为兜底。
 */
export function collectReferencedTerms(sections: Section[]): Set<string> {
  const terms = new Set<string>()
  const fromText = (text: string): void => {
    for (const match of text.matchAll(/\[\[([^\[\]]+)\]\]/g)) terms.add(match[1])
  }
  const walkFollowUps = (list: FollowUp[]): void => {
    for (const f of list) {
      fromText(f.question)
      fromText(f.answer)
      if (f.followUps?.length) walkFollowUps(f.followUps)
    }
  }
  for (const section of sections) {
    for (const q of section.questions) {
      fromText(q.question)
      fromText(q.answer)
      walkFollowUps(q.followUps)
    }
  }
  return terms
}

export function pruneGlossary(glossary: Record<string, string>, sections: Section[]): Record<string, string> {
  const referenced = collectReferencedTerms(sections)
  const pruned: Record<string, string> = {}
  for (const [term, definition] of Object.entries(glossary)) {
    if (referenced.has(term)) pruned[term] = definition
  }
  return pruned
}

/**
 * 把总题量压到上限以内：从题量最少的 section 开始整段移除。
 * 整段移除而不是删单题，是为了不留下"半截"主题；同题量时按原顺序靠后者先移除，保证确定性。
 */
export function capSectionsToMax(sections: Section[], max: number): { sections: Section[]; dropped: number } {
  let total = sections.reduce((a, s) => a + s.questions.length, 0)
  if (total <= max) return { sections, dropped: 0 }

  const indexed = sections.map((section, index) => ({ section, index }))
  indexed.sort((a, b) => {
    const bySize = a.section.questions.length - b.section.questions.length
    return bySize !== 0 ? bySize : b.index - a.index
  })

  const removed = new Set<number>()
  let dropped = 0
  for (const { section, index } of indexed) {
    if (total <= max) break
    removed.add(index)
    total -= section.questions.length
    dropped += section.questions.length
  }

  return { sections: sections.filter((_s, i) => !removed.has(i)), dropped }
}
