interface Props {
  canGoBack: boolean
  canGoForward: boolean
  onBack: () => void
  onForward: () => void
}

export default function HistoryButtons({ canGoBack, canGoForward, onBack, onForward }: Props) {
  return (
    <div className="app-titlebar-history absolute left-3 flex items-center gap-1">
      <button
        type="button"
        className="flex h-8 w-8 items-center justify-center rounded-md text-slate-600 transition hover:bg-slate-100 disabled:cursor-default disabled:text-slate-300 disabled:hover:bg-transparent"
        aria-label="上一步"
        title="上一步"
        disabled={!canGoBack}
        onClick={onBack}
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 12H4m6-6-6 6 6 6" />
        </svg>
      </button>
      <button
        type="button"
        className="flex h-8 w-8 items-center justify-center rounded-md text-slate-600 transition hover:bg-slate-100 disabled:cursor-default disabled:text-slate-300 disabled:hover:bg-transparent"
        aria-label="下一步"
        title="下一步"
        disabled={!canGoForward}
        onClick={onForward}
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 12h16m-6-6 6 6-6 6" />
        </svg>
      </button>
    </div>
  )
}
