import type { ScanLimits } from '@shared/types'
import { DEFAULT_SCAN_LIMITS, SCAN_LIMIT_BOUNDS } from '@shared/types'
// @ts-ignore TS5097 -- direct Node tests require the runtime TypeScript suffix.
import type { ScanLimitDraft } from './scan-limit-input.ts'

export type ScanLimitKey = keyof ScanLimits

const COMMON_STOPS: Record<ScanLimitKey, number[]> = {
  maxFiles: [1_000, 10_000, 20_000, 50_000, 100_000],
  maxTreeNodes: [10_000, 50_000, 100_000, 250_000],
  maxContentFileBytes: [64 * 1024, 256 * 1024, 512 * 1024, 1024 * 1024, 2 * 1024 * 1024, 4 * 1024 * 1024]
}

export function scanLimitStops(key: ScanLimitKey, draftValue: string, retainedCustom?: number): number[] {
  const { min, max } = SCAN_LIMIT_BOUNDS[key]
  const values = new Set([min, max, DEFAULT_SCAN_LIMITS[key], ...COMMON_STOPS[key]])
  if (retainedCustom !== undefined && Number.isSafeInteger(retainedCustom) && retainedCustom >= min && retainedCustom <= max) {
    values.add(retainedCustom)
  }
  const custom = draftValue.trim()
  if (/^\d+$/.test(custom)) {
    const value = Number(custom)
    if (Number.isSafeInteger(value) && value >= min && value <= max) values.add(value)
  }
  return [...values].sort((a, b) => a - b)
}

export function scanLimitValue(key: ScanLimitKey, draftValue: string): number {
  const { min, max } = SCAN_LIMIT_BOUNDS[key]
  const trimmed = draftValue.trim()
  if (!trimmed) return DEFAULT_SCAN_LIMITS[key]
  if (!/^\d+$/.test(trimmed)) return DEFAULT_SCAN_LIMITS[key]
  const value = Number(trimmed)
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : DEFAULT_SCAN_LIMITS[key]
}

export function scanLimitLabel(key: ScanLimitKey, value: number): string {
  if (key === 'maxContentFileBytes') {
    const kib = value / 1024
    return Number.isInteger(kib) && kib >= 1024
      ? `${kib / 1024}MB`
      : `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(kib)}KB`
  }
  if (value < 10_000) return value >= 1_000 ? `${value / 1_000}千` : String(value)
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value / 10_000)}万`
}

export function scanLimitStopIndex(key: ScanLimitKey, draftValue: string): number {
  const stops = scanLimitStops(key, draftValue)
  return Math.max(0, stops.indexOf(scanLimitValue(key, draftValue)))
}

export function scanLimitDraftWithValue(draft: ScanLimitDraft, key: ScanLimitKey, value: number): ScanLimitDraft {
  return { ...draft, [key]: String(value) }
}

export function scanLimitDraftWithDefault(draft: ScanLimitDraft, key: ScanLimitKey): ScanLimitDraft {
  return { ...draft, [key]: '' }
}
