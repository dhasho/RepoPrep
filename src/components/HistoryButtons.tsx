import { AppIcon } from './AppIcon'

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
        <AppIcon name="arrow-left" size={16} />
      </button>
      <button
        type="button"
        className="flex h-8 w-8 items-center justify-center rounded-md text-slate-600 transition hover:bg-slate-100 disabled:cursor-default disabled:text-slate-300 disabled:hover:bg-transparent"
        aria-label="下一步"
        title="下一步"
        disabled={!canGoForward}
        onClick={onForward}
      >
        <AppIcon name="arrow-right" size={16} />
      </button>
    </div>
  )
}
