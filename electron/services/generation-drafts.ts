import { app } from 'electron'
import type { InterviewResult } from '@shared/types'
import type { GenerationCheckpoint } from '@shared/generation-checkpoint'
import { GenerationDraftStore, type GenerationDraftMetadata } from './generation-draft-store'

const store = (): GenerationDraftStore => new GenerationDraftStore(app.getPath('userData'))
export const readGenerationDraft = (projectPath: string) => store().read(projectPath)
export const beginGenerationDraft = (projectPath: string, meta: GenerationDraftMetadata) => store().begin(projectPath, meta)
export const saveGenerationDraft = (projectPath: string, id: string, state: GenerationCheckpoint): void => store().save(projectPath, id, state)
export const completeGenerationDraft = (projectPath: string, id: string, result: InterviewResult): void => store().complete(projectPath, id, result)
export const removeGenerationDraft = (projectPath: string, id: string): void => store().remove(projectPath, id)
