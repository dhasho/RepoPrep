// 设置保存的流程控制（issue #15）。
//
// 背景：设置页此前调用 saveSettings 后立即显示"已保存"、清除 dirty——
// 完全没有等待主进程写盘结果，写盘失败时用户以为已保存。
//
// 这里把"保存中"状态抽成不依赖 React 的流程控制器：
// - save() 必须等主进程确认写盘成功才返回 'saved'，失败时抛出主进程给的可操作错误；
// - 同一时刻只允许一个进行中的保存，重复触发返回 'busy'（防重复提交）；
// - 组件在发生任何本地修改时调用 markLocalEdit()；保存发起后若有新修改，
//   结果会带上 hasEditsDuringSave —— 这些修改未持久化，调用方不得清除 dirty。
import type { SettingsSaveRequest } from '../../shared/types'

export type SettingsSaveOutcome = 'saved' | 'busy'

export interface SettingsSaveResult {
  outcome: SettingsSaveOutcome
  /** 保存发起后组件又发生了本地修改（这些修改未持久化，调用方不得清除未保存标记） */
  hasEditsDuringSave: boolean
}

/** 保存流程需要的最小 API 面（便于注入假实现做测试） */
export interface SettingsSaveApi {
  saveSettings(settings: SettingsSaveRequest): Promise<void>
}

export class SettingsSaveFlow {
  private inFlight = false
  private editSeq = 0
  private readonly api: SettingsSaveApi

  // 注意：不能用 TypeScript 的参数属性——Node 的 strip-only 类型剥离不支持该语法。
  constructor(api: SettingsSaveApi) {
    this.api = api
  }

  /** 组件在任何产生未保存修改的交互后调用（编辑配置、增删配置、切换默认配置） */
  markLocalEdit(): void {
    this.editSeq++
  }

  /**
   * 保存设置。
   * - 主进程写盘成功 → 返回 outcome 'saved'；
   * - 写盘失败 → 抛出错误（调用方展示，且不得清除未保存状态）；
   * - 已有保存在进行中 → 返回 outcome 'busy'，不排队第二次写盘。
   */
  async save(next: SettingsSaveRequest, afterWrite?: () => Promise<void>): Promise<SettingsSaveResult> {
    if (this.inFlight) return { outcome: 'busy', hasEditsDuringSave: false }
    this.inFlight = true
    const seqAtStart = this.editSeq
    try {
      await this.api.saveSettings(next)
      if (afterWrite) await afterWrite()
      return { outcome: 'saved', hasEditsDuringSave: this.editSeq !== seqAtStart }
    } finally {
      this.inFlight = false
    }
  }
}
