import type { GenerateOptions, GenerateProgress, GenerateRequest, GenerateResponse, GenerationPreview, InterviewResult, ProjectOverview } from '@shared/types'

export interface GenerationApi {
  generate(request: GenerateRequest): Promise<GenerateResponse>
  cancelGenerate(runId: string): Promise<void> | void
}

export type GenerationStatus = 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled'
export type GenerationMode = 'foreground' | 'background'

export interface GenerationTask {
  runId: string
  options: Readonly<GenerateOptions>
  overview: Readonly<ProjectOverview>
  existingResult: Readonly<InterviewResult> | null
  status: GenerationStatus
  mode: GenerationMode
  progress: GenerateProgress | null
  preview?: GenerationPreview | null
  logs: readonly GenerateProgress[]
  result: InterviewResult | null
  resultStoragePath?: string
  analysisId?: string
  error: string | null
  startedAt: number
}

export interface GenerationSnapshot {
  activeRunId: string | null
  tasks: readonly GenerationTask[]
}

const EMPTY_SNAPSHOT: GenerationSnapshot = { activeRunId: null, tasks: [] }

function immutableClone<T>(value: T): T {
  const clone = JSON.parse(JSON.stringify(value)) as T
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== 'object' || Object.isFrozen(item)) return
    Object.freeze(item)
    for (const child of Object.values(item)) freeze(child)
  }
  freeze(clone)
  return clone
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Owns one unsettled generation at a time and retains detached task results for recovery. */
export class GenerationSession {
  private snapshot: GenerationSnapshot = EMPTY_SNAPSHOT
  private readonly listeners = new Set<() => void>()
  private readonly api: GenerationApi
  private readonly makeRunId: () => string
  private disposed = false

  constructor(api: GenerationApi, makeRunId: () => string = () => crypto.randomUUID()) {
    this.api = api
    this.makeRunId = makeRunId
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): GenerationSnapshot => this.snapshot

  activate(): void {
    this.disposed = false
  }

  get activeTask(): GenerationTask | null {
    return this.snapshot.tasks.find((task) => task.runId === this.snapshot.activeRunId) ?? null
  }

  getTask(runId: string): GenerationTask | null {
    return this.snapshot.tasks.find((task) => task.runId === runId) ?? null
  }

  start(options: GenerateOptions, overview: ProjectOverview, existingResult: InterviewResult | null = null, resumeDraftId?: string): string | null {
    if (this.disposed || this.snapshot.activeRunId) return null
    const runId = this.makeRunId()
    const frozenOptions = immutableClone(options)
    const frozenOverview = immutableClone(overview)
    const task: GenerationTask = {
      runId,
      options: frozenOptions,
      overview: frozenOverview,
      existingResult: existingResult ? immutableClone(existingResult) : null,
      status: 'running',
      mode: 'foreground',
      progress: { runId, step: '准备中…', percent: 1, ts: Date.now() },
      preview: null,
      logs: [],
      result: null,
      error: null,
      startedAt: Date.now()
    }
    // Claim the slot before invoking IPC, then invoke synchronously so an immediate
    // unmount can only cancel a request that has already been sent.
    this.snapshot = { activeRunId: runId, tasks: [task, ...this.snapshot.tasks].slice(0, 10) }
    const request = { ...frozenOptions, runId, ...(resumeDraftId ? { resumeDraftId } : {}) } as GenerateRequest
    let pending: Promise<GenerateResponse>
    try {
      pending = this.api.generate(request)
    } catch (error) {
      this.notify()
      this.finishFailure(runId, error)
      return runId
    }
    this.notify()
    void Promise.resolve(pending)
      .then((response) => this.finishSuccess(runId, response))
      .catch((error: unknown) => this.finishFailure(runId, error))
    return runId
  }

  receiveProgress(progress: GenerateProgress): void {
    if (this.disposed || !progress.runId || progress.runId !== this.snapshot.activeRunId) return
    const task = this.getTask(progress.runId)
    if (!task || task.status !== 'running') return
    const { preview, ...progressFields } = progress
    const stamped = { ...progressFields }
    this.replaceTask(task.runId, {
      ...task,
      progress: stamped,
      preview: preview ? immutableClone(preview) : task.preview,
      logs: [...task.logs.slice(-79), stamped]
    })
  }

  detach(runId: string): void {
    const task = this.getTask(runId)
    if (!task || task.mode === 'background') return
    this.replaceTask(runId, { ...task, mode: 'background' })
  }

  resume(runId: string): boolean {
    const task = this.getTask(runId)
    if (!task) return false
    if ((task.status === 'running' || task.status === 'cancelling') && this.snapshot.activeRunId !== runId) return false
    this.replaceTask(runId, { ...task, mode: 'foreground' })
    return true
  }

  cancel(runId: string): boolean {
    const task = this.getTask(runId)
    if (!task || runId !== this.snapshot.activeRunId || task.status !== 'running') return false
    this.replaceTask(runId, { ...task, status: 'cancelling' })
    this.requestCancellation(runId)
    return true
  }

  private finishSuccess(runId: string, response: GenerateResponse): void {
    if (this.disposed || runId !== this.snapshot.activeRunId) return
    const task = this.getTask(runId)
    if (!task || (task.status !== 'running' && task.status !== 'cancelling')) return
    if (!response || response.runId !== runId || !response.result) {
      this.finishFailure(runId, new Error('生成响应与当前任务不匹配'))
      return
    }
    this.replaceTask(runId, {
      ...task,
      resultStoragePath: response.storagePath ?? task.options.projectPath,
      analysisId: response.analysisId,
      status: 'succeeded',
      result: response.result,
      error: null
    })
    this.update({ ...this.snapshot, activeRunId: null })
  }

  private finishFailure(runId: string, error: unknown): void {
    if (this.disposed || runId !== this.snapshot.activeRunId) return
    const task = this.getTask(runId)
    if (!task || (task.status !== 'running' && task.status !== 'cancelling')) return
    const message = errorMessage(error)
    const cancelled = task.status === 'cancelling' || message.includes('取消')
    this.replaceTask(runId, {
      ...task,
      status: cancelled ? 'cancelled' : 'failed',
      error: cancelled ? null : message
    })
    this.update({ ...this.snapshot, activeRunId: null })
  }

  dispose(): void {
    this.disposed = true
    const active = this.activeTask
    if (active?.status === 'running') {
      this.requestCancellation(active.runId)
    }
    if (active) {
      this.snapshot = {
        activeRunId: null,
        tasks: this.snapshot.tasks.map((task) => task.runId === active.runId
          ? { ...task, status: 'cancelled', mode: 'background', error: null }
          : task)
      }
    }
    this.listeners.clear()
  }

  private replaceTask(runId: string, replacement: GenerationTask): void {
    this.update({
      ...this.snapshot,
      tasks: this.snapshot.tasks.map((task) => task.runId === runId ? replacement : task)
    })
  }

  private update(next: GenerationSnapshot): void {
    this.snapshot = next
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  private requestCancellation(runId: string): void {
    try {
      void Promise.resolve(this.api.cancelGenerate(runId)).catch(() => undefined)
    } catch {
      // Cancellation is best effort during unmount; the generation promise remains guarded by runId.
    }
  }
}
