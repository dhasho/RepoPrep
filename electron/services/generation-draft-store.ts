import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { Granularity, InterviewResult, RoleFocus } from '@shared/types'
import { assertInterviewResultContract } from '@shared/result-contract'
import { GENERATION_CHECKPOINT_VERSION, GENERATION_DRAFT_MESSAGES as messages, type CheckpointBatch, type GenerationCheckpoint, type GenerationDraftRecord } from '@shared/generation-checkpoint'
import { atomicReplaceBytes, readBounded, writeBackup } from './atomic-json'

const MAX_BYTES = 16 * 1024 * 1024
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const HASH = /^[a-f0-9]{64}$/

export interface GenerationDraftMetadata {
  projectName: string
  granularity: Granularity
  roleFocus: RoleFocus
  profileId: string
  modelLabel: string
}

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}
function keys(value: Record<string, unknown>, expected: string[]): void {
  if (Object.keys(value).some((key) => !expected.includes(key))) throw new Error(messages.corrupt)
}
function text(value: unknown, max: number, min = 1): asserts value is string {
  if (typeof value !== 'string' || value.length < min || value.length > max || value.includes('\0')) throw new Error(messages.corrupt)
}
function integer(value: unknown, max: number): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) throw new Error(messages.corrupt)
}

function normalizeQuestion(question: string): string {
  return question.replace(/\[\[|\]\]/g, '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

function questionCount(checkpoint: GenerationCheckpoint): number {
  const seen = new Set<string>()
  const batches = [...checkpoint.entries.map((entry) => entry.batch), ...(checkpoint.pending ? [checkpoint.pending.batch] : [])]
  for (const batch of batches) for (const section of batch.sections) for (const question of section.questions) {
    seen.add(normalizeQuestion(question.question))
  }
  return seen.size
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

type LocatedQuestion = { sectionId: string; sectionTitle: string; sectionSummary?: string; question: Record<string, unknown> }

function flattenQuestions(batch: CheckpointBatch): LocatedQuestion[] {
  return batch.sections.flatMap((section) => section.questions.map((question) => ({
    sectionId: section.id,
    sectionTitle: section.title,
    sectionSummary: section.summary,
    question: question as unknown as Record<string, unknown>
  })))
}

function sameOrSupplemented(oldValue: unknown, nextValue: unknown): boolean {
  return oldValue === undefined || oldValue === '' || sameJson(oldValue, nextValue)
}

/** Existing accepted questions remain an ordered, section-owned prefix; optional metadata may be added. */
function preservesQuestionPrefix(previous: CheckpointBatch, next: CheckpointBatch): boolean {
  if (!sameOrSupplemented(previous.projectSummary, next.projectSummary)) return false
  const oldQuestions = flattenQuestions(previous)
  const newQuestions = flattenQuestions(next)
  if (newQuestions.length < oldQuestions.length) return false
  const nextSections = new Map(next.sections.map((section) => [section.id, section]))
  for (let index = 0; index < oldQuestions.length; index += 1) {
    const oldItem = oldQuestions[index]
    const newItem = newQuestions[index]
    if (oldItem.sectionId !== newItem.sectionId) return false
    if (!sameOrSupplemented(oldItem.sectionTitle, newItem.sectionTitle) || !sameOrSupplemented(oldItem.sectionSummary, newItem.sectionSummary)) return false
    const section = nextSections.get(oldItem.sectionId)
    if (!section || !sameOrSupplemented(oldItem.sectionTitle, section.title) || !sameOrSupplemented(oldItem.sectionSummary, section.summary)) return false
    if (!sameJson(oldItem.question, newItem.question)) return false
  }
  const oldGlossary = previous.glossary
  for (const [term, definition] of Object.entries(oldGlossary)) {
    if (!Object.hasOwn(next.glossary, term) || next.glossary[term] !== definition) return false
  }
  return true
}

function validatesPromotion(previous: GenerationCheckpoint, next: GenerationCheckpoint): boolean {
  if (!previous.pending) return true
  if (next.pending?.key === previous.pending.key) return preservesQuestionPrefix(previous.pending.batch, next.pending.batch)
  const promoted = next.entries.slice(previous.entries.length).find((entry) => entry.key === previous.pending!.key)
  return Boolean(promoted && preservesQuestionPrefix(previous.pending.batch, promoted.batch))
}

function validate(value: unknown, projectPath: string): asserts value is GenerationDraftRecord {
  if (!record(value) || value.version !== 1 || !record(value.summary)) throw new Error(messages.corrupt)
  keys(value, ['version', 'summary', 'checkpoint', 'result'])
  const summary = value.summary
  keys(summary, ['id', 'projectPath', 'projectName', 'granularity', 'roleFocus', 'profileId', 'modelLabel', 'createdAt', 'updatedAt', 'completedBatches', 'completedQuestions', 'totalBatches', 'ready'])
  if (typeof summary.id !== 'string' || !UUID.test(summary.id) || summary.projectPath !== projectPath) throw new Error(messages.corrupt)
  text(summary.projectName, 256); text(summary.profileId, 128); text(summary.modelLabel, 515)
  for (const field of ['createdAt', 'updatedAt']) {
    text(summary[field], 128)
    if (!Number.isFinite(Date.parse(summary[field] as string))) throw new Error(messages.corrupt)
  }
  if (!['coarse', 'medium', 'fine'].includes(String(summary.granularity)) || !['general', 'frontend', 'backend', 'algorithm'].includes(String(summary.roleFocus))) throw new Error(messages.corrupt)
  integer(summary.completedBatches, 256); integer(summary.totalBatches, 256); integer(summary.completedQuestions, 100_000)
  if (typeof summary.ready !== 'boolean' || summary.completedBatches > summary.totalBatches) throw new Error(messages.corrupt)
  const validateResult = (result: unknown): void => {
    assertInterviewResultContract(result, path.isAbsolute)
    const item = result as InterviewResult
    if (item.projectPath !== projectPath || item.projectName !== summary.projectName || item.granularity !== summary.granularity || item.roleFocus !== summary.roleFocus || item.profileId !== summary.profileId) throw new Error(messages.corrupt)
  }
  if (value.checkpoint !== null) {
    const state = value.checkpoint
    if (!record(state) || (state.version !== 1 && state.version !== GENERATION_CHECKPOINT_VERSION) || typeof state.fingerprint !== 'string' || !HASH.test(state.fingerprint) || !Array.isArray(state.entries) || state.entries.length > 256) throw new Error(messages.corrupt)
    keys(state, ['version', 'fingerprint', 'totalBatches', 'entries', 'pending'])
    if (state.pending !== undefined && state.version !== GENERATION_CHECKPOINT_VERSION) throw new Error(messages.corrupt)
    integer(state.totalBatches, 256)
    if (state.totalBatches !== summary.totalBatches) throw new Error(messages.corrupt)
    const seen = new Set<string>()
    for (const entry of state.entries) {
      if (!record(entry) || typeof entry.key !== 'string' || !HASH.test(entry.key) || seen.has(entry.key) || !record(entry.batch)) throw new Error(messages.corrupt)
      keys(entry, ['key', 'batch']); keys(entry.batch, ['projectSummary', 'sections', 'glossary'])
      seen.add(entry.key)
      validateResult({ version: 1, createdAt: summary.createdAt, projectName: summary.projectName, projectPath, granularity: summary.granularity, roleFocus: summary.roleFocus, profileId: summary.profileId, modelUsed: summary.modelLabel, ...entry.batch })
    }
    if (state.pending !== undefined) {
      const pending = state.pending
      if (!record(pending) || typeof pending.key !== 'string' || !HASH.test(pending.key) || seen.has(pending.key) || !record(pending.batch)) throw new Error(messages.corrupt)
      keys(pending, ['key', 'batch']); keys(pending.batch, ['projectSummary', 'sections', 'glossary'])
      validateResult({ version: 1, createdAt: summary.createdAt, projectName: summary.projectName, projectPath, granularity: summary.granularity, roleFocus: summary.roleFocus, profileId: summary.profileId, modelUsed: summary.modelLabel, ...pending.batch })
    }
    if (summary.completedBatches !== Math.min(state.entries.length, state.totalBatches)) throw new Error(messages.corrupt)
    const checkpoint = state as unknown as GenerationCheckpoint
    const expectedQuestions = questionCount(checkpoint)
    // Version 1 records predate pending batches and retain their original summary semantics.
    if (state.version === GENERATION_CHECKPOINT_VERSION && summary.completedQuestions !== expectedQuestions) throw new Error(messages.corrupt)
    if (state.version === 1 && summary.completedQuestions !== new Set(checkpoint.entries.flatMap((entry) => entry.batch.sections.flatMap((section) => section.questions.map((question) => normalizeQuestion(question.question))))).size) throw new Error(messages.corrupt)
  } else if (summary.totalBatches !== 0 || summary.completedBatches !== 0 || summary.completedQuestions !== 0) throw new Error(messages.corrupt)
  if (value.result !== undefined) validateResult(value.result)
  if (summary.ready !== (value.result !== undefined)) throw new Error(messages.corrupt)
}

/** Private, one-draft-per-project journal, separate from completed analysis history. */
export class GenerationDraftStore {
  private readonly directory: string

  constructor(userData: string) { this.directory = path.join(userData, 'generation-drafts') }

  private target(projectPath: string): string {
    if (!path.isAbsolute(projectPath) || projectPath.length > 4096 || projectPath.includes('\0')) throw new Error(messages.corrupt)
    return path.join(this.directory, `${createHash('sha256').update(projectPath).digest('hex')}.json`)
  }

  private checkDirectory(create: boolean): void {
    if (create) fs.mkdirSync(this.directory, { recursive: true })
    try {
      const info = fs.lstatSync(this.directory)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(messages.unreadable)
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT' && !create) return
      throw new Error(messages.unreadable)
    }
  }

  private readOne(target: string, projectPath: string): { status: 'valid'; value: GenerationDraftRecord; bytes: Buffer } | { status: 'missing' | 'corrupt' | 'unreadable' } {
    try {
      const info = fs.lstatSync(target)
      if (!info.isFile() || info.isSymbolicLink()) return { status: 'unreadable' }
      if (info.size > MAX_BYTES) return { status: 'corrupt' }
    } catch (error) {
      return { status: error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT' ? 'missing' : 'unreadable' }
    }
    const result = readBounded(target, MAX_BYTES)
    if (result.status !== 'ok') return { status: result.status === 'missing' ? 'missing' : 'unreadable' }
    try {
      const value: unknown = JSON.parse(result.bytes.toString('utf8'))
      validate(value, projectPath)
      return { status: 'valid', value, bytes: result.bytes }
    } catch { return { status: 'corrupt' } }
  }

  read(projectPath: string): GenerationDraftRecord | null {
    this.checkDirectory(false)
    const target = this.target(projectPath)
    const current = this.readOne(target, projectPath)
    if (current.status === 'valid') return current.value
    if (current.status === 'unreadable') throw new Error(messages.unreadable)
    const backup = this.readOne(`${target}.bak`, projectPath)
    if (backup.status === 'valid') return backup.value
    if (current.status === 'missing' && backup.status === 'missing') return null
    throw new Error(backup.status === 'unreadable' ? messages.unreadable : messages.corrupt)
  }

  private write(projectPath: string, value: GenerationDraftRecord): void {
    try {
      validate(value, projectPath)
      const bytes = Buffer.from(JSON.stringify(value), 'utf8')
      if (bytes.length > MAX_BYTES) throw new Error('draft too large')
      this.checkDirectory(true)
      const target = this.target(projectPath)
      const previous = this.readOne(target, projectPath)
      if (previous.status === 'unreadable') throw new Error('unreadable target')
      const backupInfo = fs.existsSync(`${target}.bak`) ? fs.lstatSync(`${target}.bak`) : null
      if (backupInfo && (!backupInfo.isFile() || backupInfo.isSymbolicLink())) throw new Error('unsafe backup')
      if (previous.status === 'valid') writeBackup(target, previous.bytes)
      atomicReplaceBytes(target, bytes)
    } catch { throw new Error(messages.save) }
  }

  begin(projectPath: string, meta: GenerationDraftMetadata): GenerationDraftRecord {
    if (this.read(projectPath)) throw new Error(messages.exists)
    const now = new Date().toISOString()
    const value: GenerationDraftRecord = { version: 1, summary: { ...meta, id: randomUUID(), projectPath, createdAt: now, updatedAt: now, completedBatches: 0, completedQuestions: 0, totalBatches: 0, ready: false }, checkpoint: null }
    this.write(projectPath, value)
    return value
  }

  private owned(projectPath: string, id: string): GenerationDraftRecord {
    const value = this.read(projectPath)
    if (!value || value.summary.id !== id) throw new Error(messages.missing)
    return value
  }

  save(projectPath: string, id: string, checkpoint: GenerationCheckpoint): void {
    const value = this.owned(projectPath, id)
    if (value.result) throw new Error(messages.changed)
    if (checkpoint.version !== GENERATION_CHECKPOINT_VERSION) throw new Error(messages.changed)
    const previous = value.checkpoint
    if (previous) {
      if (previous.fingerprint !== checkpoint.fingerprint || previous.totalBatches !== checkpoint.totalBatches || checkpoint.entries.length < previous.entries.length || previous.version > checkpoint.version || previous.entries.some((entry, index) => !sameJson(entry, checkpoint.entries[index]))) throw new Error(messages.changed)
      if (!validatesPromotion(previous, checkpoint)) throw new Error(messages.changed)
      if (previous.pending) {
        if (checkpoint.pending?.key === previous.pending.key) {
          if (!preservesQuestionPrefix(previous.pending.batch, checkpoint.pending.batch)) throw new Error(messages.changed)
        } else if (!previous.entries.some((entry) => entry.key === previous.pending!.key) && !checkpoint.entries.slice(previous.entries.length).some((entry) => entry.key === previous.pending!.key)) {
          throw new Error(messages.changed)
        }
      }
    }
    const completedQuestions = questionCount(checkpoint)
    value.checkpoint = checkpoint
    value.summary = { ...value.summary, updatedAt: new Date().toISOString(), completedBatches: Math.min(checkpoint.entries.length, checkpoint.totalBatches), completedQuestions, totalBatches: checkpoint.totalBatches }
    this.write(projectPath, value)
  }

  complete(projectPath: string, id: string, result: InterviewResult): void {
    const value = this.owned(projectPath, id)
    value.result = result
    value.summary = { ...value.summary, updatedAt: new Date().toISOString(), ready: true }
    this.write(projectPath, value)
  }

  remove(projectPath: string, id: string | null): void {
    if (id === null) {
      try {
        if (this.read(projectPath)) throw new Error(messages.changed)
        throw new Error(messages.missing)
      } catch (error) {
        if (!(error instanceof Error) || error.message !== messages.corrupt) throw error
      }
      // Explicit corrupt-draft recovery never follows links or erases valid data.
      // Keep original bytes recoverable without parsing an arbitrarily large file.
      try {
        const target = this.target(projectPath)
        const files = [target, `${target}.bak`].filter((name) => fs.existsSync(name))
        for (const name of files) {
          const info = fs.lstatSync(name)
          if (!info.isFile() || info.isSymbolicLink()) throw new Error('unsafe corrupt draft')
        }
        for (const name of files) fs.renameSync(name, `${name}.corrupt-${randomUUID()}`)
        return
      } catch { throw new Error(messages.discard) }
    }
    this.owned(projectPath, id)
    try {
      const target = this.target(projectPath)
      const names = [`${target}.bak`, target]
      for (const name of names) {
        if (!fs.existsSync(name)) continue
        const info = fs.lstatSync(name)
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('unsafe draft file')
      }
      for (const name of names) {
        if (!fs.existsSync(name)) continue
        fs.unlinkSync(name)
      }
    } catch { throw new Error(messages.discard) }
  }
}
