// 生成日志时间戳的本地化渲染（issue #13）。
//
// 历史缺陷：GeneratingPage 在每次渲染时调用 new Date()，导致所有历史日志
// 显示同一个不断变化的时间。正确做法是渲染主进程在事件发生时写入的 ts，
// 本函数只负责把那一刻格式化成本地时区的 24 小时制时间。

const LOG_TIME_OPTIONS = { hour12: false } as const

/** 缺失 / 非法时间戳的占位显示（兼容不带 ts 的旧进度数据） */
export const LOG_TIME_PLACEHOLDER = '--:--:--'

export function formatLogTime(ts: number | undefined): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return LOG_TIME_PLACEHOLDER
  return new Date(ts).toLocaleTimeString('zh-CN', LOG_TIME_OPTIONS)
}
