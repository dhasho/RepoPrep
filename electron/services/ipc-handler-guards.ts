// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { INVOKE_CHANNELS, validateIpcArgs } from './ipc-validation.ts'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { assertTrustedIpcSender, isTrustedIpcSender, AuthorizedProjectRegistry } from './ipc-authority.ts'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import type { IpcEventLike, IpcWebContentsLike } from './ipc-authority.ts'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { IPC } from '../../shared/ipc.ts'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { RESULT_CONTRACT_MESSAGES } from '../../shared/result-contract.ts'

export type IpcHandler<E extends IpcEventLike = IpcEventLike> = (event: E, ...args: any[]) => unknown
export interface IpcGuardDependencies {
  getExpectedWebContents: () => IpcWebContentsLike | null
  /**
   * 信任的渲染入口 URL。返回 null 表示还没有可信入口（窗口尚未创建或入口未确定），
   * 此时拒绝一切 IPC，而不是退化成“只看 webContents 是不是主窗口”。
   */
  getTrustedRendererUrl: () => string | null
  projects: AuthorizedProjectRegistry
}

const projectArgumentChannels = new Set<string>([IPC.scanProject, IPC.loadResult, IPC.deleteResult, IPC.removeRecent])
const invokeChannels = new Set<string>(INVOKE_CHANNELS)
/**
 * 可以原样回显给渲染进程的业务提示。判据：消息必须由主进程静态构造、不含任何
 * 外部输入（上游响应体、文件系统异常、用户参数），否则一律替换成通用文案。
 * 往这里新增条目时请保持该判据，不要为了“让报错更好懂”而放松它。
 */
const SAFE_BUSINESS_ERRORS = new Set([
  '已取消生成',
  '已有生成任务在进行中',
  '已有相同名词解释请求在进行中',
  '生成面试题时模型请求超时，请检查网络或稍后重试。',
  '项目文件在读取期间发生变化，请重新扫描后重试。',
  '未找到指定的大模型配置，请先到设置页完成配置',
  RESULT_CONTRACT_MESSAGES.generated,
  RESULT_CONTRACT_MESSAGES.history,
  // 设置持久化失败（issue #15）：主进程按 errno 静态映射，不含路径等敏感细节
  '磁盘空间不足，无法保存设置。请清理磁盘空间后重试。',
  '没有写入权限，无法保存设置。请检查应用数据目录权限后重试。',
  '保存设置失败，请重试；若持续失败请检查磁盘状态。'
])
class DisplayableIpcError extends Error {}

/** Keeps cancellation bound to one active explanation request, even under duplicate starts. */
export class ExplainAbortRegistry {
  private readonly active = new Map<string, AbortController>()

  begin(requestId: string): AbortController | null {
    const key = requestId.toLowerCase()
    if (this.active.has(key)) return null
    const controller = new AbortController()
    this.active.set(key, controller)
    return controller
  }

  finish(requestId: string, controller: AbortController): void {
    const key = requestId.toLowerCase()
    if (this.active.get(key) === controller) this.active.delete(key)
  }

  cancel(requestId: string): void {
    this.active.get(requestId.toLowerCase())?.abort()
  }
}

/** Wraps every renderer invoke with sender, schema and project authority checks. */
export function createGuardedIpcHandler<E extends IpcEventLike>(
  channel: string,
  deps: IpcGuardDependencies,
  handler: IpcHandler<E>
): (event: E, ...args: any[]) => Promise<unknown> {
  return async (event, ...rawArgs) => {
    try {
      if (!invokeChannels.has(channel)) throw new Error('unknown')
      const expected = deps.getExpectedWebContents()
      if (!expected) throw new Error('sender')
      // 发送方判定与 #51 的 handleTrustedIpc 语义一致：必须是当前主窗口、且是它的主框架。
      // 先做这层纯身份判断，再拿信任入口 URL 做完整比对，这样“窗口还没建好 / 入口未确定”
      // 会被明确拒绝，而不是被误判成 URL 不匹配。
      if (!isTrustedIpcSender(event, expected)) throw new Error('sender-frame')
      const trustedUrl = deps.getTrustedRendererUrl()
      if (!trustedUrl) throw new Error('trusted-url')
      assertTrustedIpcSender(event, expected, trustedUrl)
      validateIpcArgs(channel, rawArgs)

      let args = rawArgs
      if (projectArgumentChannels.has(channel)) {
        const projectPath = deps.projects.requireAuthorized(rawArgs[0] as string)
        // removeRecent acts on an exact persisted recent.json key. Authorization
        // still checks the supplied path, while the store must receive that key
        // unchanged instead of a selected-path alias from the registry.
        args = [channel === IPC.removeRecent ? rawArgs[0] : projectPath, ...rawArgs.slice(1)]
      } else if (channel === IPC.generateRun) {
        const options = rawArgs[0] as Record<string, unknown>
        args = [{ ...options, projectPath: deps.projects.requireAuthorized(options.projectPath as string) }]
      } else if (channel === IPC.exportMarkdown) {
        const result = rawArgs[0] as Record<string, unknown>
        args = [{ ...result, projectPath: deps.projects.requireAuthorized(result.projectPath as string) }]
      }

      try {
        return await handler(event, ...args)
      } catch (error) {
        if (error instanceof Error && SAFE_BUSINESS_ERRORS.has(error.message)) throw new DisplayableIpcError(error.message)
        throw new DisplayableIpcError('请求处理失败，请稍后重试')
      }
    } catch (error) {
      if (error instanceof DisplayableIpcError) throw error
      if (error instanceof Error && SAFE_BUSINESS_ERRORS.has(error.message)) throw error
      throw new Error('请求无效或未获授权')
    }
  }
}

export function registerGuardedIpcHandler<E extends IpcEventLike>(
  registrar: { handle: (channel: string, listener: IpcHandler<E>) => void },
  channel: string,
  deps: IpcGuardDependencies,
  handler: IpcHandler<E>
): void {
  registrar.handle(channel, createGuardedIpcHandler(channel, deps, handler))
}
