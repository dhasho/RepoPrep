import { useState } from 'react'
import type { ScanLimitKey } from '../lib/scan-limit-slider'
import { scanLimitLabel, scanLimitStops, scanLimitValue } from '../lib/scan-limit-slider'

interface Props {
  id: string
  name: ScanLimitKey
  label: string
  draftValue: string
  error?: string
  onChange: (value: number) => void
  onReset: () => void
}

export default function ScanLimitSlider({ id, name, label, draftValue, error, onChange, onReset }: Props) {
  const [retainedCustom] = useState(() => {
    const raw = draftValue.trim()
    if (!/^\d+$/.test(raw)) return undefined
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || scanLimitStops(name, '').includes(value)) return undefined
    return value
  })
  const stops = scanLimitStops(name, draftValue, retainedCustom)
  const value = scanLimitValue(name, draftValue)
  const index = Math.max(0, stops.indexOf(value))
  const errorId = `${id}-error`

  return (
    <div className="rounded-lg border border-slate-200 px-3 py-1.5">
      <div className="mb-0 flex items-center gap-3">
        <label htmlFor={id} className="min-w-0 flex-1 text-sm font-medium text-slate-700">{label}</label>
        <span className="shrink-0 text-sm font-semibold tabular-nums text-indigo-700" title={value.toLocaleString('zh-CN')} aria-live="polite">
          {scanLimitLabel(name, value)}
        </span>
        <button type="button" aria-label={`恢复默认${label}`} className="shrink-0 rounded px-2 py-0 text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-700" onClick={onReset}>
          恢复默认
        </button>
      </div>
      <input
        id={id}
        name={name}
        type="range"
        min="0"
        max={Math.max(0, stops.length - 1)}
        step="1"
        value={index}
        aria-valuetext={scanLimitLabel(name, value)}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => {
          const stop = stops[Number(event.currentTarget.value)]
          if (stop !== undefined) onChange(stop)
        }}
        className="scan-limit-slider block h-4 w-full accent-indigo-600"
      />
      <div className="mt-0.5 flex items-center justify-between gap-1 leading-none">
        {stops.map((stop) => (
          <button
            key={stop}
            type="button"
            aria-label={`设置${label}为${scanLimitLabel(name, stop)}`}
            title={stop.toLocaleString('zh-CN')}
            aria-pressed={stop === value}
            className={`min-w-0 whitespace-nowrap rounded px-1 py-0 text-[11px] leading-none tabular-nums transition hover:bg-indigo-50 hover:text-indigo-700 ${stop === value ? 'font-semibold text-indigo-700' : 'text-slate-400'}`}
            onClick={() => onChange(stop)}
          >
            {scanLimitLabel(name, stop)}
          </button>
        ))}
      </div>
      {error && <p id={errorId} className="mt-1.5 text-xs text-rose-600" role="alert">{error}</p>}
    </div>
  )
}
