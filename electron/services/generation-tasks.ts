// 前台生成任务的槽位注册表（issue #20）。
//
// 背景：generate:run 的空闲检查与 AbortController 赋值必须原子完成，否则
// 并发请求可能同时通过检查、并发扫描/生成，后一个还会覆盖前一个的取消句柄。
// 把"占用/取消/释放"抽成同步的纯逻辑类：
// - begin() 同步检查并占用——同一事件循环 tick 内不可能被穿插，天然原子；
// - 每个任务使用渲染进程生成的稳定 runId；finish(runId) 只在 runId 仍是当前任务时才释放，
//   防止迟到/陈旧的 finish 清掉新任务的锁；
// - cancel(runId) 只中止匹配任务的 controller，不影响其它任务（当前也只有一个）。

export interface GenerationTask {
  runId: string
  controller: AbortController
}

export class GenerationTaskRegistry {
  private current: GenerationTask | null = null

  /** 当前任务（只读，供测试与状态展示） */
  get active(): Readonly<GenerationTask> | null {
    return this.current
  }

  /**
   * 原子占用生成槽位。已有任务在进行中时返回 null——
   * 调用方应把重复请求拒之门外（返回明确的"进行中"错误）。
   */
  begin(runId: string): GenerationTask | null {
    if (this.current) return null
    const task: GenerationTask = { runId: runId.toLowerCase(), controller: new AbortController() }
    this.current = task
    return task
  }

  /** 按规范化 UUID 精确匹配任务；旧任务的取消不会误伤当前任务。 */
  cancel(runId: string): boolean {
    if (!this.current || this.current.runId !== runId.toLowerCase()) return false
    this.current.controller.abort()
    return true
  }

  /** 释放槽位。runId 不匹配（陈旧调用）时是空操作 */
  finish(runId: string): void {
    if (this.current?.runId === runId.toLowerCase()) this.current = null
  }

  /** 窗口关闭 / 应用退出时中止当前任务；槽位仍由任务 finally 释放 */
  cancelAll(): void {
    this.current?.controller.abort()
  }
}
