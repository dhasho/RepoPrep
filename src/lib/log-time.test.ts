// 生成日志时间戳格式化的测试（issue #13）
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import test from 'node:test'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import assert from 'node:assert/strict'
import { formatLogTime, LOG_TIME_PLACEHOLDER }
  // @ts-expect-error Node strip-types requires the explicit extension; project bundler resolution does not.
  from './log-time.ts'

test('同一时间戳多次渲染结果完全一致（旧日志时间不随重渲染漂移）', () => {
  const ts = 1_759_820_400_123
  const first = formatLogTime(ts)
  assert.equal(formatLogTime(ts), first)
  assert.equal(formatLogTime(ts), first)
})

test('输出为本地时区 24 小时制 HH:mm:ss', () => {
  const ts = 1_759_820_400_123
  assert.match(formatLogTime(ts), /^\d{2}:\d{2}:\d{2}$/)
})

test('不同时间戳渲染出不同的时间（相邻两秒即可区分）', () => {
  const a = formatLogTime(1_759_820_400_000)
  const b = formatLogTime(1_759_820_401_000)
  assert.notEqual(a, b)
})

test('缺失或非法时间戳显示占位符（兼容旧数据，不显示成当前时间）', () => {
  assert.equal(formatLogTime(undefined), LOG_TIME_PLACEHOLDER)
  assert.equal(formatLogTime(Number.NaN), LOG_TIME_PLACEHOLDER)
  assert.equal(formatLogTime(Number.POSITIVE_INFINITY), LOG_TIME_PLACEHOLDER)
})
