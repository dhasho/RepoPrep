import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleX,
  ClipboardList,
  ExternalLink,
  File,
  Folder,
  FolderOpen,
  List,
  LoaderCircle,
  Paperclip,
  Plus,
  Search,
  Settings,
  Sparkles,
  TriangleAlert,
  X
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

const icons = {
  folder: Folder,
  'folder-open': FolderOpen,
  list: List,
  settings: Settings,
  search: Search,
  'arrow-left': ArrowLeft,
  'arrow-right': ArrowRight,
  plus: Plus,
  close: X,
  'chevron-right': ChevronRight,
  'chevron-down': ChevronDown,
  'chevron-up': ChevronUp,
  check: Check,
  error: CircleX,
  warning: TriangleAlert,
  bot: Bot,
  clipboard: ClipboardList,
  attachment: Paperclip,
  file: File,
  'external-link': ExternalLink,
  loader: LoaderCircle,
  sparkles: Sparkles
} satisfies Record<string, LucideIcon>

export type AppIconName = keyof typeof icons

interface Props {
  name: AppIconName
  size?: number
  className?: string
}

export function AppIcon({ name, size = 20, className = '' }: Props) {
  const Icon = icons[name]
  return <Icon size={size} strokeWidth={2} color="currentColor" aria-hidden="true" focusable="false" className={`inline-block shrink-0 align-middle ${className}`} />
}
