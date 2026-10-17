import type { LlmProfileDraft, TestConnectionResult } from '@shared/types'

export interface ConnectionTestState {
  readonly profileId: string | null
  readonly testing: boolean
  readonly result: TestConnectionResult | null
}

interface ConnectionTestControllerOptions {
  testLlm: (profile: LlmProfileDraft) => Promise<TestConnectionResult>
}

const IPC_FAILURE: TestConnectionResult = {
  ok: false,
  message: '连接测试失败，请稍后重试。'
}

export class ConnectionTestController {
  private readonly testLlm: ConnectionTestControllerOptions['testLlm']
  private active = true
  private revision = 0
  private sequence = 0
  private snapshot: ConnectionTestState = { profileId: null, testing: false, result: null }
  private readonly listeners = new Set<() => void>()

  constructor({ testLlm }: ConnectionTestControllerOptions) {
    this.testLlm = testLlm
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): ConnectionTestState => this.snapshot

  activate(): void {
    this.active = true
  }

  dispose(): void {
    this.active = false
    this.invalidate()
  }

  invalidate(): void {
    this.revision += 1
    this.sequence += 1
    this.publish({ profileId: null, testing: false, result: null })
  }

  async run(profile: LlmProfileDraft): Promise<void> {
    if (!this.active) return

    const requestProfile = { ...profile }
    const requestRevision = ++this.revision
    const requestSequence = ++this.sequence
    const isCurrent = () =>
      this.active &&
      this.revision === requestRevision &&
      this.sequence === requestSequence &&
      this.snapshot.profileId === requestProfile.id

    this.publish({ profileId: requestProfile.id, testing: true, result: null })

    try {
      const result = await this.testLlm(requestProfile)
      if (isCurrent()) this.publish({ profileId: requestProfile.id, testing: true, result })
    } catch {
      if (isCurrent()) this.publish({ profileId: requestProfile.id, testing: true, result: IPC_FAILURE })
    } finally {
      if (isCurrent()) this.publish({ ...this.snapshot, testing: false })
    }
  }

  private publish(next: ConnectionTestState): void {
    if (
      this.snapshot.profileId === next.profileId &&
      this.snapshot.testing === next.testing &&
      this.snapshot.result === next.result
    ) {
      return
    }

    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}
