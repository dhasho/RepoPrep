// 模型列表检测的生命周期控制（issue #14）。
//
// 背景：SettingsPage 原先在异步函数闭包里用 selectedId 判断响应是否过期——
// 闭包捕获的是调用时的值，请求期间切换配置后旧响应仍会写进新配置的界面；
// 连续快速检测时先发后至的响应也可能被后发先至的旧响应覆盖。
//
// 这里把检测状态抽成不依赖 React/DOM 的控制器：
// - 每个 profile 一个独立槽位（loading / message / models / showList），
//   响应只写回发起它的那个 profile，界面永远不会看到别的配置的结果；
// - 每个 profile 一个单调递增的请求序号，只有"最后一次"检测的响应会被采纳，
//   被取代的请求无论成功失败都静默丢弃（不显示误导性错误）；
// - 换 Base URL / API Key 时 invalidate：序号立即失效 + 清空该配置的结果；
// - 快照引用稳定，可直接供 useSyncExternalStore 使用。
import type { ListModelsResult, LlmProfile } from '../../shared/types'

export interface ModelState {
  loading: boolean
  message: string
  messageOk: boolean
  models: string[]
  showList: boolean
}

const IDLE: ModelState = { loading: false, message: '', messageOk: false, models: [], showList: false }

export type ModelDetectionSnapshot = ReadonlyMap<string, ModelState>

/** 读取某个配置的检测状态（没有记录时返回统一的空闲态） */
export function modelStateOf(slots: ModelDetectionSnapshot, profileId: string): ModelState {
  return slots.get(profileId) ?? IDLE
}

/** 控制器需要的最小 API 面（便于注入假实现做竞态测试） */
export interface ModelDetectionApi {
  listModels(profile: LlmProfile): Promise<ListModelsResult>
}

export class ModelDetectionController {
  private readonly slots = new Map<string, ModelState>()
  private readonly seqs = new Map<string, number>()
  private readonly listeners = new Set<() => void>()
  private snapshot: ModelDetectionSnapshot = new Map()
  private readonly api: ModelDetectionApi

  // 注意：不能用 TypeScript 的参数属性——Node 的 strip-only 类型剥离不支持该语法。
  constructor(api: ModelDetectionApi) {
    this.api = api
  }

  /** 供 useSyncExternalStore 订阅 */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 供 useSyncExternalStore 读取（引用稳定，未变化时返回同一对象） */
  getSnapshot = (): ModelDetectionSnapshot => this.snapshot

  private emit(profileId: string, next: ModelState): void {
    this.slots.set(profileId, next)
    this.snapshot = new Map(this.slots)
    for (const listener of this.listeners) listener()
  }

  private bumpSeq(profileId: string): number {
    const seq = (this.seqs.get(profileId) ?? 0) + 1
    this.seqs.set(profileId, seq)
    return seq
  }

  /**
   * 使该配置进行中的检测失效并清空其结果。
   * 切换 Base URL / API Key 后旧列表已无意义；被失效请求的迟到响应会被丢弃。
   */
  invalidate(profileId: string): void {
    this.bumpSeq(profileId)
    if (this.slots.has(profileId)) this.emit(profileId, IDLE)
  }

  /** 收起模型列表（选择模型 / 手动关闭时） */
  hideList(profileId: string): void {
    const cur = this.slots.get(profileId)
    if (cur?.showList) this.emit(profileId, { ...cur, showList: false })
  }

  /** 检测该配置可用的模型列表。只接受该配置"最后一次"检测的响应 */
  detect(profile: LlmProfile): void {
    const profileId = profile.id
    if (!profile.baseUrl.trim()) {
      this.emit(profileId, {
        ...modelStateOf(this.slots, profileId),
        loading: false,
        message: '请先填写接口地址（Base URL）',
        messageOk: false,
        showList: false
      })
      return
    }
    const seq = this.bumpSeq(profileId)
    this.emit(profileId, {
      ...modelStateOf(this.slots, profileId),
      loading: true,
      message: '',
      messageOk: false,
      showList: false
    })

    void this.api.listModels(profile).then(
      (r) => {
        if (this.seqs.get(profileId) !== seq) return // 过期响应：已被新检测或失效操作取代
        this.emit(profileId, {
          loading: false,
          message: r.message,
          messageOk: r.ok,
          models: r.models,
          showList: r.ok && r.models.length > 0
        })
      },
      (e: unknown) => {
        if (this.seqs.get(profileId) !== seq) return // 被取代的请求失败不算错误
        this.emit(profileId, {
          ...IDLE,
          message: `获取失败：${e instanceof Error ? e.message : String(e)}`
        })
      }
    )
  }
}
