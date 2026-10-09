import type { ScanLimits } from '@shared/types'
import { SCAN_LIMIT_BOUNDS } from '@shared/types'

export type ScanLimitDraft = Record<keyof ScanLimits, string>
export type ScanLimitErrors = Partial<Record<keyof ScanLimits, string>>

export function scanLimitDraftOf(limits?: Partial<ScanLimits>): ScanLimitDraft {
  return {
    maxFiles: limits?.maxFiles === undefined ? '' : String(limits.maxFiles),
    maxTreeNodes: limits?.maxTreeNodes === undefined ? '' : String(limits.maxTreeNodes),
    maxContentFileBytes: limits?.maxContentFileBytes === undefined ? '' : String(limits.maxContentFileBytes)
  }
}

export function parseScanLimitDraft(draft: ScanLimitDraft): { value?: Partial<ScanLimits>; errors: ScanLimitErrors } {
  const value: Partial<ScanLimits> = {}
  const errors: ScanLimitErrors = {}
  for (const key of Object.keys(SCAN_LIMIT_BOUNDS) as Array<keyof ScanLimits>) {
    const raw = draft[key]
    if (!raw.trim()) continue
    const bounds = SCAN_LIMIT_BOUNDS[key]
    if (!/^\d+$/.test(raw.trim())) {
      errors[key] = `请输入 ${bounds.min}–${bounds.max} 范围内的整数`
      continue
    }
    const number = Number(raw.trim())
    if (!Number.isInteger(number) || number < bounds.min || number > bounds.max) {
      errors[key] = `请输入 ${bounds.min}–${bounds.max} 范围内的整数`
      continue
    }
    value[key] = number
  }
  return { value: Object.keys(errors).length ? undefined : value, errors }
}
