// 配置与生成结果的本地持久化（存于 Electron userData 目录）
import { app } from 'electron'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { InterviewResult, RecentProject, Settings } from '@shared/types'
import { assertInterviewResultContract, RESULT_CONTRACT_MESSAGES } from '@shared/result-contract'
import { isFilesystemRoot, projectDisplayName } from './project-display-name'

function userDataFile(name: string): string {
  return path.join(app.getPath('userData'), name)
}

function projectsDir(): string {
  return path.join(app.getPath('userData'), 'projects')
}

function readJson<T>(file: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(file, 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8')
}

const DEFAULT_SETTINGS: Settings = { profiles: [], defaultProfileId: null }

export function getSettings(): Settings {
  return { ...DEFAULT_SETTINGS, ...readJson(userDataFile('settings.json'), DEFAULT_SETTINGS) }
}

export function saveSettings(settings: Settings): void {
  writeJson(userDataFile('settings.json'), settings)
}

function resultFile(projectPath: string): string {
  const hash = createHash('sha1').update(projectPath).digest('hex')
  return path.join(projectsDir(), `${hash}.json`)
}

export function saveResult(projectPath: string, result: InterviewResult): void {
  try {
    assertInterviewResultContract(result, path.isAbsolute)
  } catch {
    throw new Error(RESULT_CONTRACT_MESSAGES.generated)
  }
  writeJson(resultFile(projectPath), result)
}

export function loadResult(projectPath: string): InterviewResult | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(resultFile(projectPath), 'utf-8'))
  } catch {
    return null
  }
  if (parsed === null) return null
  try {
    let candidate = parsed
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      'projectName' in parsed &&
      parsed.projectName === '' &&
      'projectPath' in parsed &&
      typeof parsed.projectPath === 'string' &&
      path.isAbsolute(parsed.projectPath) &&
      isFilesystemRoot(parsed.projectPath)
    ) {
      candidate = { ...parsed, projectName: projectDisplayName(parsed.projectPath) }
    }
    assertInterviewResultContract(candidate, path.isAbsolute)
    return candidate
  } catch {
    throw new Error(RESULT_CONTRACT_MESSAGES.history)
  }
}

export function deleteResult(projectPath: string): void {
  try {
    fs.rmSync(resultFile(projectPath), { force: true })
  } catch {
    /* 忽略删除失败 */
  }
}

export function getRecentProjects(): RecentProject[] {
  const list = readJson<RecentProject[]>(userDataFile('recent.json'), [])
  return Array.isArray(list) ? list : []
}

export function addRecentProject(entry: { path: string; name: string; granularity?: string }): RecentProject[] {
  const list = getRecentProjects().filter((p) => p.path !== entry.path)
  list.unshift({
    path: entry.path,
    name: entry.name,
    lastUsedAt: new Date().toISOString(),
    ...(entry.granularity ? { granularity: entry.granularity as RecentProject['granularity'] } : {})
  })
  const capped = list.slice(0, 20)
  writeJson(userDataFile('recent.json'), capped)
  return capped
}

export function removeRecentProject(projectPath: string): void {
  const list = getRecentProjects().filter((p) => p.path !== projectPath)
  writeJson(userDataFile('recent.json'), list)
}
