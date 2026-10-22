// 可折叠的项目文件树
import { useState } from 'react'
import type { FileNode } from '@shared/types'
import { AppIcon } from './AppIcon'

function formatSize(size?: number): string {
  if (size == null) return ''
  if (size < 1024) return `${size}B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)}KB`
  return `${(size / 1024 / 1024).toFixed(1)}MB`
}

function Node({ node, depth }: { node: FileNode; depth: number }) {
  const [open, setOpen] = useState(depth < 2)

  if (node.type === 'dir') {
    return (
      <div>
        <button
          className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-slate-100"
          style={{ paddingLeft: depth * 14 + 4 }}
          onClick={() => setOpen((o) => !o)}
        >
          <AppIcon name={open ? 'chevron-down' : 'chevron-right'} size={14} className="text-slate-400" />
          <span className="truncate text-[13px] font-medium text-slate-700">{node.name}/</span>
        </button>
        {open && (node.children ?? []).map((c) => <Node key={c.path} node={c} depth={depth + 1} />)}
      </div>
    )
  }

  return (
    <div
      className="flex items-center justify-between rounded px-1 py-0.5"
      style={{ paddingLeft: depth * 14 + 18 }}
      title={node.path}
    >
      <span className="truncate text-[13px] text-slate-500">{node.name}</span>
      <span className="ml-2 shrink-0 text-[11px] text-slate-400">{formatSize(node.size)}</span>
    </div>
  )
}

export default function FileTreeView({ root }: { root: FileNode }) {
  return (
    <div className="max-h-[380px] overflow-y-auto rounded-lg border border-slate-200 bg-slate-50/60 p-2">
      <Node node={root} depth={0} />
    </div>
  )
}
