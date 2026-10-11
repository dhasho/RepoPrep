// 按颗粒度组装送入大模型的项目上下文（字符预算控制 + 细粒度分批）
import path from 'node:path'
import {
  contentReadFailureReason,
  contentReadWarning,
  CONTENT_READ_MESSAGES,
  emptyContentReadSummary,
  recordContentReadFailure,
  type ContentReadSummary
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
} from '../../shared/content-read.ts'
import type { ContextTruncationMetadata, Granularity, ScanTruncation } from '../../shared/types'
import type { ScannedFile, ScanResult } from './scanner'
// @ts-ignore TS5097 -- extension is required by the direct Node security test runner.
import { MAX_CONTENT_FILE_BYTES } from './scanner.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node security test runner.
import { classifySensitivePath, redactSensitiveContent, type SensitiveCategory } from './sensitive.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node security test runner.
import { batchWeight, MIN_GLOBAL_WEIGHT } from './question-budget.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node security test runner.
import { ProjectContentBoundaryError, ProjectContentReadError, readProjectContent } from './project-content-reader.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node security test runner.
import { isProjectContentReadable, resolveProjectIdentity } from './project-snapshot.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node security test runner.
import { CONTEXT_CHAR_BUDGETS, CONTEXT_TRUNCATION_WARNING, safeClipText, treeCharBudget } from '../../shared/context-budget.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node security test runner.
import { renderBoundedTree } from './scanner.ts'

const CODE_EXTS = new Set([
  'ts','tsx','js','jsx','mjs','cjs','py','java','go','rs','c','h','cpp','cc','cxx','hpp',
  'cs','rb','php','swift','kt','kts','scala','dart','lua','vue','svelte','astro','sql','proto','graphql','prisma'
])

// Five capped samples are escaped for display; reserve enough room for their
// worst-case JSON expansion and the bounded reason/count summary.
const CONTENT_READ_WARNING_RESERVE = 2200

export interface ContextFile {
  relPath: string
  content: string
  truncated: boolean
  redacted: boolean
  redactionMatches: number
}

export interface ContentSecuritySummary {
  redactedFiles: number
  redactionMatches: number
  matchesByCategory: Partial<Record<SensitiveCategory, number>>
}

export interface ContextBatch {
  label: string // 批次名（如"全局概览"、模块名）
  files: ContextFile[]
  totalChars: number
  /** 批次类型：global=全局批（架构/选型），module=单个模块批。配额规划按类型施加不同下限。 */
  kind: 'global' | 'module'
  /**
   * 相对权重，由模块体量（文件数 × 内容量）合成，用于把总题量预算按权重分配到各批次。
   * 全局批按"最重要的单个模块"量级参与分配，避免模块多时全局题量被摊薄。
   */
  weight: number
}

export interface BuiltContext {
  headerText: string // 项目名 + 语言分布 + 文件树（每批都带）
  /** The one bounded tree rendering used by every batch and model request. */
  treeText: string
  contextTruncation: ContextTruncationMetadata
  batches: ContextBatch[]
  contentSecurity: ContentSecuritySummary
  contentReadSummary: ContentReadSummary
  /** 模块批的数量（0 表示没有按模块分批）。进度提示用它区分"全局+模块"与"仅全局"。 */
  moduleCount: number
}

/**
 * 常见关键配置文件名。比较统一用小写（构造时归一化）——此前集合里是
 * Dockerfile / Makefile / Cargo.toml 等混合大小写原值，而比较前 basename
 * 已被转小写，导致这些关键配置拿不到配置分（issue #18）。
 */
const CONFIG_BASENAMES = new Set(
  [
    'package.json', 'tsconfig.json', 'jsconfig.json', 'vite.config.ts', 'vite.config.js', 'webpack.config.js', 'next.config.js',
    'nuxt.config.ts', 'vue.config.js', 'babel.config.js', '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.prettierrc', '.prettierrc.json',
    'electron.vite.config.ts', 'electron.vite.config.js', 'electron-builder.yml', 'electron-builder.yaml', 'electron-builder.json',
    'tailwind.config.js', 'tailwind.config.ts', 'tailwind.config.cjs', 'postcss.config.js', 'postcss.config.cjs', 'postcss.config.mjs', 'postcss.config.ts',
    'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'go.mod', 'Cargo.toml', 'Makefile',
    'CMakeLists.txt', 'requirements.txt', 'pyproject.toml', 'setup.py', 'composer.json', 'Gemfile', 'mix.exs',
    'docker-compose.yml', 'docker-compose.yaml', 'Dockerfile'
  ].map((n) => n.toLowerCase())
)

/** 配置分基准：根目录配置满分；子目录同名配置递减，避免深层普通同名文件冒充根配置 */
const CONFIG_SCORE = 900
const CONFIG_DEPTH_PENALTY = 50

export function scoreFile(relPath: string, size: number): number {
  const base = path.basename(relPath).toLowerCase()
  const depth = relPath.split('/').length
  let score = 0
  if (/^readme\.(md|txt|rst)$/.test(base)) score = 1000
  else if (CONFIG_BASENAMES.has(base)) score = CONFIG_SCORE - (depth - 1) * CONFIG_DEPTH_PENALTY
  else if (/^(main|index|app|server|cli)\.(ts|tsx|js|jsx|py|go|rs|java)$/.test(base) && depth <= 3) score = 800
  else if (CODE_EXTS.has(path.extname(relPath).slice(1).toLowerCase())) score = 500 - depth * 20
  else if (/\.(md|json|ya?ml|toml)$/i.test(relPath)) score = 300 - depth * 10
  else score = 100 - depth * 10
  // 太小的文件信息量低，太大的可能是生成物/数据文件
  if (size < 200) score -= 30
  if (size > 100_000) score -= 100
  return score
}

/** 粗粒度只保留文档/配置类文件（导出便于测试大小写与目录策略） */
export function isCoarseCandidate(relPath: string): boolean {
  const base = path.basename(relPath).toLowerCase()
  return /^readme\./.test(base) || CONFIG_BASENAMES.has(base) || /\.(md|json|ya?ml|toml|txt)$/i.test(relPath)
}

interface PickedFiles {
  files: ContextFile[]
  contentSecurity: ContentSecuritySummary
  contentTruncated: boolean
}

export function renderScanWarnings(t: ScanTruncation): string {
  const reasons: string[] = []
  if (t.byFileCount) reasons.push(`文件数达到上限（${t.limits.maxFiles}）`)
  if (t.byTreeNodes) reasons.push(`树节点数达到上限（${t.limits.maxTreeNodes}）`)
  if (t.oversizedFiles > 0) reasons.push(`${t.oversizedFiles} 个文件超过单文件大小上限（${Math.round(t.limits.maxContentFileBytes / 1024)}KB）而未纳入阅读`)
  if (!reasons.length) return ''
  const skipped = t.estimatedSkipped > 0 ? `，估计至少还有 ${t.estimatedSkipped} 项未扫描` : ''
  return `⚠️ 警告：本次扫描不完整（${reasons.join('；')}${skipped}）。以下分析仅基于扫描到的部分，结论可能遗漏未扫描的内容。`
}

function emptyContentSecurity(): ContentSecuritySummary {
  return { redactedFiles: 0, redactionMatches: 0, matchesByCategory: {} }
}

function addContentSecurity(target: ContentSecuritySummary, source: ContentSecuritySummary): void {
  target.redactedFiles += source.redactedFiles
  target.redactionMatches += source.redactionMatches
  for (const [category, count] of Object.entries(source.matchesByCategory) as Array<[SensitiveCategory, number]>) {
    target.matchesByCategory[category] = (target.matchesByCategory[category] ?? 0) + count
  }
}

async function pickFiles(
  scan: ScanResult,
  granularity: Granularity,
  budgetChars: number,
  contentReadSummary: ContentReadSummary,
  headerText: string,
  treeText: string,
  warningReserve: number,
  sourceScan = scan
): Promise<PickedFiles> {
  const candidates = scan.files
    .filter((f) => f.isContentCandidate)
    .filter((f) => {
      if (granularity === 'coarse') {
        // 粗粒度只要文档/配置/入口，不看业务源码
        return isCoarseCandidate(f.relPath)
      }
      return true
    })
    .map((f) => ({ f, score: scoreFile(f.relPath, f.size) }))
    .sort((a, b) => b.score - a.score)

  const out: ContextFile[] = []
  const contentSecurity = emptyContentSecurity()
  const emptyBatch: ContextBatch = { label: '', files: [], totalChars: 0, kind: 'global', weight: 1 }
  let renderedChars = renderBatch(headerText, treeText, emptyBatch).length
  let contentTruncated = false
  for (let index = 0; index < candidates.length; index++) {
    const { f } = candidates[index]
    const separatorChars = 1
    const plainTitle = `### 文件：${f.relPath}`
    const plainOverhead = plainTitle.length + 9 + separatorChars
    const remaining = budgetChars - warningReserve - renderedChars - plainOverhead
    if (remaining < 0) {
      contentTruncated = true
      continue
    }
    const truncatedTitle = `### 文件：${f.relPath}（内容过长已截断）`
    const truncatedOverhead = truncatedTitle.length + 9 + separatorChars
    const availableWithNotice = budgetChars - warningReserve - renderedChars - truncatedOverhead
    const contentMarker = '…（内容已截断）'
    contentReadSummary.attemptedReads++
    let rawContent: string
    try {
      rawContent = await readProjectContent(sourceScan, f)
    } catch (error) {
      if (error instanceof ProjectContentBoundaryError) throw error
      if (!(error instanceof ProjectContentReadError)) throw error
      recordContentReadFailure(contentReadSummary, f.relPath, contentReadFailureReason(error))
      continue
    }
    contentReadSummary.successfulReads++

    // Redact before applying the budget: placeholders must be the only form
    // of matched secrets that can enter ContextFile, batches, or renderBatch.
    const redaction = redactSensitiveContent(rawContent)
    const content = redaction.content
    const truncated = content.length > remaining
    if (truncated && availableWithNotice < contentMarker.length) {
      contentTruncated = true
      continue
    }
    const selectedContent = truncated
      ? safeClipText(content, availableWithNotice, contentMarker)
      : content
    out.push({
      relPath: f.relPath,
      content: selectedContent,
      truncated,
      redacted: redaction.totalMatches > 0,
      redactionMatches: redaction.totalMatches
    })
    renderedChars += (truncated ? truncatedOverhead : plainOverhead) + selectedContent.length
    contentTruncated ||= truncated
    if (redaction.totalMatches > 0) {
      contentSecurity.redactedFiles++
      contentSecurity.redactionMatches += redaction.totalMatches
      for (const match of redaction.matches) {
        contentSecurity.matchesByCategory[match.category] =
          (contentSecurity.matchesByCategory[match.category] ?? 0) + match.count
      }
    }
    if (truncated) {
      if (index < candidates.length - 1) contentTruncated = true
      break
    }
  }
  return { files: out, contentSecurity, contentTruncated }
}

/** 模块体量估计：文件数与内容量（按单文件上限截断，避免个别大文件垄断权重） */
function moduleMass(files: readonly ScannedFile[]): { fileCount: number; contentBytes: number } {
  let contentBytes = 0
  for (const f of files) {
    contentBytes += Math.min(f.textBytes ?? f.size, MAX_CONTENT_FILE_BYTES)
  }
  return { fileCount: files.length, contentBytes }
}

export async function buildContext(scan: ScanResult, granularity: Granularity): Promise<BuiltContext> {
  if (!isProjectContentReadable(scan)) throw new ProjectContentBoundaryError()
  let policyRoot: string
  try {
    policyRoot = (await resolveProjectIdentity(scan.root)).realPath
  } catch {
    throw new Error('无法安全解析所选项目路径，已停止分析')
  }
  const protectedRoot = Boolean(scan.tree.modelExcluded || classifySensitivePath('__project_root__', policyRoot))
  const tree = renderBoundedTree(scan.tree, 4000, treeCharBudget(granularity), policyRoot)
  const safeFiles = protectedRoot ? [] : scan.files.filter((file) => !classifySensitivePath(file.relPath, policyRoot))
  const safeScan = safeFiles.length === scan.files.length ? scan : { ...scan, files: safeFiles }
  const contextTruncation: ContextTruncationMetadata = {
    treeTruncated: tree.truncated,
    contentTruncated: false,
    requestTruncated: false
  }
  const langText = scan.languages.length
    ? scan.languages.map((l) => `${l.lang} ${l.percent}%`).join('、')
    : '未识别出常见编程语言'
  const headerLines = [
    `项目根目录：${protectedRoot ? '（受保护项目）' : scan.name}`,
    `主要语言：${langText}`,
    `文件总数（不含忽略项）：${scan.totalFiles}`
  ]
  if (scan.truncation) {
    const warning = renderScanWarnings(scan.truncation)
    if (warning) headerLines.push(warning)
  }
  headerLines.push(
    '',
    '## 项目文件树',
    '```',
    '（见下方文件树）',
    '```'
  )
  let headerText = headerLines.join('\n')
  const contextWarning = `⚠️ ${CONTEXT_TRUNCATION_WARNING}请基于实际提供的内容作答，不要假设已看到省略内容。`
  if (contextTruncation.treeTruncated) {
    headerText = headerText.replace('\n\n## 项目文件树', `\n\n${contextWarning}\n\n## 项目文件树`)
  }
  const warningReserve = CONTENT_READ_WARNING_RESERVE + (contextTruncation.treeTruncated ? 0 : contextWarning.length + 4)
  const render = (batch: ContextBatch): string => renderBatch(headerText, tree.text, batch)
  const setTotalChars = (batch: ContextBatch): void => { batch.totalChars = render(batch).length }
  const addContextWarning = (): void => {
    if (!contextTruncation.treeTruncated && !contextTruncation.contentTruncated) return
    if (headerText.includes(contextWarning)) return
    headerText = headerText.replace(
      '\n\n## 项目文件树',
      `\n\n${contextWarning}\n\n## 项目文件树`
    )
  }
  const batches: ContextBatch[] = []
  const contentSecurity = emptyContentSecurity()
  const contentReadSummary = emptyContentReadSummary()

  if (granularity !== 'fine') {
    const picked = await pickFiles(
      safeScan,
      granularity,
      CONTEXT_CHAR_BUDGETS[granularity],
      contentReadSummary,
      headerText,
      tree.text,
      warningReserve,
      scan
    )
    addContentSecurity(contentSecurity, picked.contentSecurity)
    const files = picked.files
    contextTruncation.contentTruncated = picked.contentTruncated
    addContextWarning()
    const batch: ContextBatch = {
      label: granularity === 'coarse' ? '项目整体分析' : '项目整体与核心模块分析',
      files,
      totalChars: 0,
      kind: 'global',
      // 单批即全部：权重恒为 1，配额必然等于该颗粒度的总题量目标
      weight: 1
    }
    batches.push(batch)
    if (contentReadSummary.attemptedReads > 0 && contentReadSummary.successfulReads === 0 && contentReadSummary.failedReads > 0) {
      throw new Error(CONTENT_READ_MESSAGES.allFailed)
    }
    const readWarning = contentReadWarning(contentReadSummary)
    if (readWarning) headerText = `${headerText}\n\n${readWarning}`
    setTotalChars(batch)
    return {
      headerText,
      treeText: tree.text,
      contextTruncation,
      batches,
      contentSecurity,
      contentReadSummary,
      moduleCount: 0
    }
  }

  // 细粒度：全局批（文档+配置）+ 各模块批（按顶层目录分组）
  // 全局批与模块批分别代表实际请求；同一文件若出现在多个批次，按请求次数分别计数。
  const globalPicked = await pickFiles(
    safeScan,
    'coarse',
    CONTEXT_CHAR_BUDGETS.fine,
    contentReadSummary,
    headerText,
    tree.text,
    warningReserve,
    scan
  )
  addContentSecurity(contentSecurity, globalPicked.contentSecurity)
  const globalFiles = globalPicked.files
  const globalBatch: ContextBatch = {
    label: '全局概览（架构与选型）',
    files: globalFiles,
    totalChars: 0,
    kind: 'global',
    weight: 1 // 占位，下面按模块体量定稿
  }
  batches.push(globalBatch)
  contextTruncation.contentTruncated = globalPicked.contentTruncated

  const groups = new Map<string, ScannedFile[]>()
  for (const f of safeScan.files) {
    if (!f.isContentCandidate) continue
    if (!CODE_EXTS.has(f.ext)) continue
    const segs = f.relPath.split('/')
    const group = segs.length > 1 ? segs[0] : '（根目录文件）'
    const list = groups.get(group) ?? []
    list.push(f)
    groups.set(group, list)
  }

  const sortedGroups = Array.from(groups.entries())
    .map(([group, groupFiles]) => ({ group, groupFiles, mass: moduleMass(groupFiles) }))
    .sort((a, b) => {
      const scoreOf = (m: { fileCount: number; contentBytes: number }) => m.fileCount + m.contentBytes / 1000
      return scoreOf(b.mass) - scoreOf(a.mass)
    })

  const MAX_MODULE_BATCHES = 10
  let moduleBatches = 0
  for (const { group, groupFiles, mass } of sortedGroups) {
    if (moduleBatches >= MAX_MODULE_BATCHES) {
      // The batch cap omits remaining modules just like per-file clipping omits content.
      contextTruncation.contentTruncated = true
      break
    }
    // 复用 pickFiles 的打分与预算逻辑：构造仅含该模块的临时 ScanResult 子集
    const subScan: ScanResult = { ...safeScan, files: groupFiles }
    const picked = await pickFiles(
      subScan,
      'fine',
      CONTEXT_CHAR_BUDGETS.fine,
      contentReadSummary,
      headerText,
      tree.text,
      warningReserve,
      scan
    )
    addContentSecurity(contentSecurity, picked.contentSecurity)
    const files = picked.files
    if (!files.length) continue
    moduleBatches++
    batches.push({
      label: `模块「${group}」`,
      files,
      totalChars: 0,
      kind: 'module',
      weight: batchWeight(mass.fileCount, mass.contentBytes)
    })
    contextTruncation.contentTruncated ||= picked.contentTruncated
  }

  // 全局批权重 = 模块批数量，这样全局批的按比例份额与"所有模块加起来"相当，
  // 保证它在任何模块数下都稳定拿到 MIN_QUESTIONS_GLOBAL(6) 以上；
  // 若只给 1 份权重，模块多于 5 个时全局批会被摊薄到 3 题左右、再被下限硬抬到 6，
  // 反而挤占模块题量。
  // 注意：这里不存在"权重下限"判断——moduleBatches ≥ 1 时它必然 ≥ MIN_GLOBAL_WEIGHT(0.5)，
  // 所以 MIN_GLOBAL_WEIGHT 只在 0 个模块的退化分支里作为语义常量使用。
  globalBatch.weight = moduleBatches === 0 ? MIN_GLOBAL_WEIGHT : moduleBatches

  addContextWarning()
  if (contentReadSummary.attemptedReads > 0 && contentReadSummary.successfulReads === 0 && contentReadSummary.failedReads > 0) {
    throw new Error(CONTENT_READ_MESSAGES.allFailed)
  }
  const readWarning = contentReadWarning(contentReadSummary)
  if (readWarning) headerText = `${headerText}\n\n${readWarning}`
  for (const batch of batches) setTotalChars(batch)

  return {
    headerText,
    treeText: tree.text,
    contextTruncation,
    batches,
    contentSecurity,
    contentReadSummary,
    moduleCount: moduleBatches
  }
}

/** 把批次渲染为完整的用户消息文本 */
export function renderBatch(headerText: string, treeText: string, batch: ContextBatch): string {
  const header = headerText.replace('（见下方文件树）', treeText)
  const parts = batch.files.map((f) =>
    [`### 文件：${f.relPath}${f.truncated ? '（内容过长已截断）' : ''}`, '```', f.content, '```'].join('\n')
  )
  return [header, '', '## 文件内容', ...parts].join('\n')
}

/** Fit prompt overhead by clipping/removing whole file entries while keeping Markdown fences balanced. */
export function renderBatchWithinBudget(
  headerText: string,
  treeText: string,
  batch: ContextBatch,
  maxChars: number,
  requestTruncationMarker = ''
): { text: string; truncated: boolean } {
  const text = renderBatch(headerText, treeText, batch)
  if (text.length <= maxChars) return { text, truncated: false }
  const outputBudget = maxChars - requestTruncationMarker.length
  const base = renderBatch(headerText, treeText, { ...batch, files: [] })
  if (outputBudget < 0 || base.length > outputBudget) throw new Error('模型请求固定上下文超出支持范围。')

  const files: ContextFile[] = []
  let renderedChars = base.length
  let truncated = false
  for (let index = 0; index < batch.files.length; index++) {
    const file = batch.files[index]
    const separator = 1
    const plainTitle = `### 文件：${file.relPath}${file.truncated ? '（内容过长已截断）' : ''}`
    const plainCost = separator + plainTitle.length + 9 + file.content.length
    if (renderedChars + plainCost <= outputBudget) {
      files.push(file)
      renderedChars += plainCost
      continue
    }

    const clippedTitle = `### 文件：${file.relPath}（内容过长已截断）`
    const clipMarker = '…（内容已截断）'
    const contentAllowance = outputBudget - renderedChars - separator - clippedTitle.length - 9
    if (contentAllowance >= clipMarker.length) {
      const content = safeClipText(file.content, contentAllowance, clipMarker)
      files.push({ ...file, content, truncated: true })
      renderedChars += separator + clippedTitle.length + 9 + content.length
    }
    truncated = true
    break
  }
  if (files.length < batch.files.length) truncated = true
  const rendered = renderBatch(headerText, treeText, { ...batch, files })
  return { text: `${rendered}${requestTruncationMarker}`, truncated: truncated || files.length < batch.files.length }
}
