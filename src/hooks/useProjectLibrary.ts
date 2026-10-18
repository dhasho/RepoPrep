import { useCallback, useEffect, useRef, useState } from 'react'
import type { AnalysisSummary, RecentProject } from '@shared/types'
import { api } from '../lib/ipc'

export interface ProjectLibraryEntry extends RecentProject {
  analyses: AnalysisSummary[]
  nextCursor: string | null
  expanded: boolean
  loading: boolean
  error: string | null
}

export function useProjectLibrary(onStorageRead?: () => void) {
  const [projects, setProjects] = useState<ProjectLibraryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(false)
  const requestIds = useRef(new Map<string, number>())
  const recentRequestId = useRef(0)
  const projectsRef = useRef(projects)
  projectsRef.current = projects

  const refresh = useCallback(async () => {
    const requestId = ++recentRequestId.current
    setLoading(true)
    setError(null)
    try {
      const recent = await api.getRecentProjects()
      if (!mounted.current || requestId !== recentRequestId.current) return
      setProjects((current) => recent.map((project) => {
        const previous = current.find((item) => item.path === project.path)
        return {
          ...project,
          analyses: previous?.analyses ?? [],
          nextCursor: previous?.nextCursor ?? null,
          expanded: previous?.expanded ?? false,
          loading: previous?.loading ?? false,
          error: previous?.error ?? null
        }
      }))
    } catch {
      if (mounted.current && requestId === recentRequestId.current) setError('最近项目暂时无法读取。')
    } finally {
      if (mounted.current && requestId === recentRequestId.current) {
        setLoading(false)
        onStorageRead?.()
      }
    }
  }, [onStorageRead])

  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => {
      mounted.current = false
      requestIds.current.clear()
    }
  }, [refresh])

  const loadPage = useCallback(async (path: string, cursor?: string | null) => {
    const requestId = (requestIds.current.get(path) ?? 0) + 1
    requestIds.current.set(path, requestId)
    setProjects((current) => current.map((project) => project.path === path
      ? { ...project, expanded: true, loading: true, error: null }
      : project))
    try {
      const page = await api.listAnalyses(path, cursor ?? undefined)
      if (!mounted.current || requestIds.current.get(path) !== requestId) return
      setProjects((current) => current.map((project) => project.path === path
        ? {
            ...project,
            analyses: cursor ? [...project.analyses, ...page.items] : page.items,
            nextCursor: page.nextCursor,
            loading: false,
            error: null
          }
        : project))
    } catch {
      if (!mounted.current || requestIds.current.get(path) !== requestId) return
      setProjects((current) => current.map((project) => project.path === path
        ? { ...project, loading: false, error: '分析记录暂时无法读取。' }
        : project))
    } finally {
      if (mounted.current && requestIds.current.get(path) === requestId) onStorageRead?.()
    }
  }, [onStorageRead])

  const toggleExpanded = useCallback((path: string) => {
    const project = projectsRef.current.find((item) => item.path === path)
    if (!project) return
    if (project.expanded) {
      requestIds.current.set(path, (requestIds.current.get(path) ?? 0) + 1)
      setProjects((current) => current.map((item) => item.path === path ? { ...item, expanded: false, loading: false } : item))
      return
    }
    if (project.analyses.length > 0) {
      setProjects((current) => current.map((item) => item.path === path ? { ...item, expanded: true } : item))
      return
    }
    void loadPage(path)
  }, [loadPage])

  const expand = useCallback((path: string) => {
    const project = projectsRef.current.find((item) => item.path === path)
    if (!project || project.expanded) return
    if (project.analyses.length > 0) {
      setProjects((current) => current.map((item) => item.path === path ? { ...item, expanded: true } : item))
      return
    }
    void loadPage(path)
  }, [loadPage])

  const refreshAnalyses = useCallback((path: string) => {
    const expanded = projectsRef.current.some((item) => item.path === path && item.expanded)
    requestIds.current.set(path, (requestIds.current.get(path) ?? 0) + 1)
    setProjects((current) => current.map((project) => project.path === path
      ? { ...project, analyses: [], nextCursor: null, loading: false, error: null }
      : project))
    if (expanded) void loadPage(path)
  }, [loadPage])

  const remove = useCallback(async (path: string) => {
    recentRequestId.current++
    try {
      await api.removeRecent(path)
      requestIds.current.set(path, (requestIds.current.get(path) ?? 0) + 1)
      setProjects((current) => current.filter((project) => project.path !== path))
    } finally {
      recentRequestId.current++
      setLoading(false)
    }
  }, [])

  return { projects, loading, error, refresh, refreshAnalyses, loadMore: (path: string, cursor: string) => loadPage(path, cursor), toggleExpanded, expand, remove }
}
