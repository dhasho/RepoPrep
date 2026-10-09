// 名词解释流式请求的生命周期控制。
//
// 背景（issue #12）：TermPopover 原先只在 useEffect 清理里退订事件，
// **从不调用 cancelExplain**，因此关闭弹窗或切换词条后，主进程里的流式请求会继续跑、
// 继续消耗模型额度；同时"用户点停止"只调了 API 却没改状态，界面会一直停在"生成中…"。
//
// 这里把生命周期抽成不依赖 React/DOM 的控制器，便于直接对卸载与竞态写测试：
// - start() 会先取消自己上一个仍在进行的请求；
// - dispose() 用于组件卸载/页面离开，取消进行中的请求并阻止后续事件影响界面；
// - status 明确区分 完成 / 用户停止 / 失败，停止不会显示成普通错误；
// - 事件按 requestId 过滤，旧请求的事件不会影响新词条的内容。
import type { ExplainEvent, ExplainRequest } from '../../shared/types'

export type ExplainStatus = 'idle' | 'streaming' | 'done' | 'stopped' | 'error'

export interface ExplainSnapshot {
  status: ExplainStatus
  text: string
  error: string
  /** 当前进行中的 requestId；无请求时为空串 */
  requestId: string
}

/** 控制器需要的最小 API 面（便于注入假实现做测试） */
export interface ExplainApi {
  explain(req: ExplainRequest): Promise<void>
  cancelExplain(requestId: string): Promise<void> | void
  onExplainEvent(cb: (e: ExplainEvent) => void): () => void
}

const IDLE: ExplainSnapshot = { status: 'idle', text: '', error: '', requestId: '' }

export class ExplainStreamController {
  private snapshot: ExplainSnapshot = IDLE
  private readonly listeners = new Set<() => void>()
  private unsubscribe: (() => void) | null = null
  private disposed = false
  /** 被主动取消的请求：其后续事件应视为"已停止"，而不是"失败" */
  private readonly aborted = new Set<string>()
  private readonly api: ExplainApi
  private readonly makeRequestId: () => string

  // 注意：不能用 TypeScript 的参数属性（constructor(private readonly api: …)）——
  // Node 的 strip-only 类型剥离不支持该语法，会让测试无法直接运行。
  //
  // 默认 requestId 必须是 UUIDv4：electron/services/ipc-validation.ts 的 REQUEST_ID
  // 正则会拒绝其他格式，导致请求根本到不了主进程。
  constructor(api: ExplainApi, makeRequestId?: () => string) {
    this.api = api
    this.makeRequestId = makeRequestId ?? (() => crypto.randomUUID())
  }

  /** 供 useSyncExternalStore 订阅 */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 供 useSyncExternalStore 读取（引用稳定，未变化时返回同一对象） */
  getSnapshot = (): ExplainSnapshot => this.snapshot

  private emit(next: Partial<ExplainSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next }
    for (const listener of this.listeners) listener()
  }

  /** 取消进行中的请求（用户点停止 / 弹窗卸载 / 页面离开时调用） */
  private abortCurrent(): void {
    const requestId = this.snapshot.requestId
    if (!requestId) return
    this.aborted.add(requestId)
    // 主进程正常会把取消包装成"已取消"error 事件下发，invoke 一般不会 reject；
    // 但失败时也不能在渲染进程抛 unhandledrejection
    void Promise.resolve(this.api.cancelExplain(requestId)).catch(() => {})
    // 乐观置为已停止：即便主进程稍后才回 '已取消' 事件，界面也已立即反映
    this.emit({ status: 'stopped', requestId: '' })
  }

  /**
   * 发起解释请求。若已有进行中的请求会**先取消它**，
   * 避免快速切换词条时出现串流或旧内容覆盖新内容。
   *
   * 若控制器已 dispose（React StrictMode 会在 dev 下先模拟一次卸载清理、
   * 再重挂载同一个组件实例），这里会重新武装：start 只可能来自仍存活的组件。
   */
  start(req: Omit<ExplainRequest, 'requestId'>): void {
    this.disposed = false
    if (this.snapshot.requestId) this.abortCurrent()

    const requestId = this.makeRequestId()
    this.unsubscribe?.()
    this.unsubscribe = this.api.onExplainEvent((event) => this.handleEvent(event))

    this.emit({ status: 'streaming', text: '', error: '', requestId })

    void this.api.explain({ ...req, requestId }).catch((e: unknown) => {
      // 旧请求迟到的拒绝不允许改写界面状态（否则会把新请求的 streaming 打翻）
      const stillCurrent = !this.disposed && this.snapshot.requestId === requestId
      const wasAborted = this.aborted.has(requestId)
      this.aborted.delete(requestId)
      if (!stillCurrent) return
      if (wasAborted) {
        // 主动取消导致的失败不算错误
        this.emit({ status: 'stopped', requestId: '' })
        return
      }
      this.emit({
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
        requestId: ''
      })
    })
  }

  /** 用户主动停止：不算失败，界面应显示"已停止"并可重试 */
  stop(): void {
    this.abortCurrent()
  }

  /** 组件卸载 / 页面离开：取消进行中的请求，并让后续事件不再影响界面 */
  dispose(): void {
    if (this.disposed) return
    this.abortCurrent()
    this.disposed = true
    this.unsubscribe?.()
    this.unsubscribe = null
    for (const listener of this.listeners) listener()
  }

  private handleEvent(event: ExplainEvent): void {
    if (this.disposed) return
    // 旧请求的事件一律忽略，避免影响当前词条
    if (event.requestId !== this.snapshot.requestId) {
      this.aborted.delete(event.requestId)
      return
    }

    if (event.type === 'delta') {
      this.emit({ text: this.snapshot.text + event.data })
      return
    }
    if (event.type === 'done') {
      this.aborted.delete(event.requestId)
      this.emit({ status: 'done', requestId: '' })
      return
    }
    // 主进程把取消也走 error 事件下发（'已取消'），这里按"是否主动取消"区分
    if (this.aborted.has(event.requestId)) {
      this.aborted.delete(event.requestId)
      this.emit({ status: 'stopped', requestId: '' })
      return
    }
    this.emit({ status: 'error', error: event.data, requestId: '' })
  }
}
