import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { Granularity, InterviewResult, RoleFocus } from '@shared/types'
import { assertInterviewResultContract } from '@shared/result-contract'
import { GENERATION_DRAFT_MESSAGES as messages, type GenerationCheckpoint, type GenerationDraftRecord } from '@shared/generation-checkpoint'
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
    if (!record(state) || state.version !== 1 || typeof state.fingerprint !== 'string' || !HASH.test(state.fingerprint) || !Array.isArray(state.entries) || state.entries.length > 256) throw new Error(messages.corrupt)
    keys(state, ['version', 'fingerprint', 'totalBatches', 'entries'])
    integer(state.totalBatches, 256)
    if (state.totalBatches !== summary.totalBatches) throw new Error(messages.corrupt)
    const seen = new Set<string>()
    for (const entry of state.entries) {
      if (!record(entry) || typeof entry.key !== 'string' || !HASH.test(entry.key) || seen.has(entry.key) || !record(entry.batch)) throw new Error(messages.corrupt)
      keys(entry, ['key', 'batch']); keys(entry.batch, ['projectSummary', 'sections', 'glossary'])
      seen.add(entry.key)
      validateResult({ version: 1, createdAt: summary.createdAt, projectName: summary.projectName, projectPath, granularity: summary.granularity, roleFocus: summary.roleFocus, profileId: summary.profileId, modelUsed: summary.modelLabel, ...entry.batch })
    }
    if (summary.completedBatches !== Math.min(state.entries.length, state.totalBatches)) throw new Error(messages.corrupt)
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
    if (value.checkpoint && (value.checkpoint.fingerprint !== checkpoint.fingerprint || checkpoint.entries.length < value.checkpoint.entries.length || value.checkpoint.entries.some((entry, index) => JSON.stringify(entry) !== JSON.stringify(checkpoint.entries[index])))) throw new Error(messages.changed)
    const completedQuestions = new Set(checkpoint.entries.flatMap((entry) => entry.batch.sections.flatMap((section) => section.questions.map((question) => question.question.replace(/\[\[|\]\]/g, '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim())))).size
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

  remove(projectPath: string, id: string): void {
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
