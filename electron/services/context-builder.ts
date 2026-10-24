// 按颗粒度组装送入大模型的项目上下文（字符预算控制 + 细粒度分批）
import {
  contentReadFailureReason,
  contentReadWarning,
  CONTENT_READ_MESSAGES,
  emptyContentReadSummary,
  recordContentReadFailure,
  type ContentReadSummary
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
} from '../../shared/content-read.ts'
import type { ContextTruncationMetadata, Granularity, RoleFocus, ScanTruncation } from '../../shared/types'
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
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { CODE_EXTS, collectFileSignals, isCoarseCandidate, orderFilesForContext, selectProbeFiles, type FileSelectionSignals } from './file-selection.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { selectSourceRegions, sourceRegionCandidates, type SourceRegion } from './snippet-selection.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { analyzeSource } from './source-analysis.ts'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
export { isCoarseCandidate } from './file-selection.ts'

// Five capped samples are escaped for display; reserve enough room for their
// worst-case JSON expansion and the bounded reason/count summary.
const CONTENT_READ_WARNING_RESERVE = 2200

export interface ContextFile {
  relPath: string
  content: string
  truncated: boolean
  redacted: boolean
  redactionMatches: number
  /** Private, already-redacted selection source used only for bounded re-rendering. */
  selectionRegions?: SourceRegion[]
  /** Ranked complete source candidates cached after one redacted analysis pass. */
  selectionCandidates?: SourceRegion[]
  /** Internal bounded importance weight for constrained budget sharing; absent means equal share. */
  weight?: number
}

export interface BuildContextOptions {
  maxChars?: number
  roleFocus?: RoleFocus
  signal?: AbortSignal
}

export interface RenderedSelection {
  filePaths: string[]
  selectedRegions: number
  providedChars: number
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
  selection?: { strategy: 'structure-v1'; eligibleFiles: number; selectedFiles: number; selectedRegions: number; omittedFiles: number; truncatedFiles: number; providedChars: number }
  /** Internal relative-path whitelist for aggregating files actually dispatched after final fitting. */
  eligibleFilePaths?: string[]
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

/**
 * Bounded per-file weights for constrained budget sharing: manifest-declared
 * entries and locally referenced source earn more room than plain source,
 * which earns more than documents, tests, and generated files. Derived only
 * from the same generic signals that already order the context, so the result
 * is deterministic and never project-specific.
 */
const CONTEXT_WEIGHT_MIN = 1
const CONTEXT_WEIGHT_MAX = 8
/** Every hungry file keeps at least this slice before weights differentiate. */
const WEIGHTED_MIN_SHARE = 1024

const TEST_PATH_PATTERN = /(^|\/)(__tests__|tests?|spec|fixtures?)(\/|$)|\.(test|spec)\.[^.]+$/i
const GENERATED_PATH_PATTERN = /(^|\/)(generated|dist|build|coverage|vendor)(\/|$)|\.(min|generated)\.[^.]+$/i

function normalizeContextWeight(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= CONTEXT_WEIGHT_MIN
    ? Math.min(CONTEXT_WEIGHT_MAX, Math.floor(value))
    : CONTEXT_WEIGHT_MIN
}

function contextFileWeight(relPath: string, signals: FileSelectionSignals): number {
  const rel = relPath.replace(/\\/g, '/')
  if (isDocumentOrConfigPath(rel) || TEST_PATH_PATTERN.test(rel) || GENERATED_PATH_PATTERN.test(rel)) {
    return CONTEXT_WEIGHT_MIN
  }
  const extension = rel.split('/').pop()?.split('.').pop()?.toLowerCase() ?? ''
  if (!CODE_EXTS.has(extension)) return CONTEXT_WEIGHT_MIN
  if (signals.entryPaths.has(rel)) return CONTEXT_WEIGHT_MAX
  const inbound = signals.importedBy.get(rel) ?? 0
  if (inbound > 0) return Math.min(CONTEXT_WEIGHT_MAX - 1, 2 + Math.min(4, inbound))
  return 2
}

function allocateBodyBudget(demands: readonly number[], budget: number, weights?: readonly number[]): number[] {
  if (!weights || weights.length !== demands.length) return allocateEqualShare(demands, budget)
  const effective = demands.map((_, index) => normalizeContextWeight(weights[index]))
  if (effective.every((weight) => weight === effective[0])) return allocateEqualShare(demands, budget)
  return allocateWeightedShare(demands, budget, effective)
}

/** Equal-share water filling: short files return unused space to longer files. */
function allocateEqualShare(demands: readonly number[], budget: number): number[] {
  const allocations = demands.map(() => 0)
  let remaining = Math.max(0, Math.floor(budget))
  let active = demands.map((_, index) => index).filter((index) => demands[index] > 0)
  while (active.length && remaining > 0) {
    const share = Math.floor(remaining / active.length)
    if (share === 0) {
      for (let index = 0; index < remaining; index++) allocations[active[index]]++
      break
    }
    const saturated = active.filter((index) => demands[index] - allocations[index] <= share)
    if (saturated.length) {
      for (const index of saturated) {
        const amount = demands[index] - allocations[index]
        allocations[index] += amount
        remaining -= amount
      }
      const saturatedSet = new Set(saturated)
      active = active.filter((index) => !saturatedSet.has(index))
      continue
    }
    for (const index of active) allocations[index] += share
    remaining -= share * active.length
    for (let index = 0; index < remaining; index++) allocations[active[index]]++
    break
  }
  return allocations
}

/**
 * Weighted water filling with a floor share: every still-hungry file first
 * keeps a minimum slice while the budget affords one, then the remainder is
 * shared in proportion to bounded weights. Saturated files return their unused
 * space to the rest, and the process stays deterministic throughout.
 */
function allocateWeightedShare(demands: readonly number[], budget: number, weights: readonly number[]): number[] {
  const allocations = demands.map(() => 0)
  let remaining = Math.max(0, Math.floor(budget))
  let active = demands.map((_, index) => index).filter((index) => demands[index] > 0)
  // One floor pass: every still-hungry file keeps a minimum slice while the
  // budget affords one; files filled by it are done and return nothing later.
  if (active.length && remaining > 0) {
    const floorShare = Math.min(WEIGHTED_MIN_SHARE, Math.floor(remaining / active.length))
    if (floorShare > 0) {
      const filled: number[] = []
      for (const index of active) {
        const desired = demands[index] - allocations[index]
        allocations[index] += Math.min(desired, floorShare)
        remaining -= Math.min(desired, floorShare)
        if (desired <= floorShare) filled.push(index)
      }
      const filledSet = new Set(filled)
      active = active.filter((index) => !filledSet.has(index))
    }
  }
  while (active.length && remaining > 0) {
    const weightSum = active.reduce((sum, index) => sum + weights[index], 0)
    const shares = active.map((index) => Math.floor((remaining * weights[index]) / weightSum))
    const saturated = active.filter((index, position) => demands[index] - allocations[index] <= shares[position])
    if (saturated.length) {
      const saturatedSet = new Set(saturated)
      active = active.filter((index) => !saturatedSet.has(index))
      for (const index of saturated) {
        const amount = demands[index] - allocations[index]
        allocations[index] += amount
        remaining -= amount
      }
      continue
    }
    for (const [position, index] of active.entries()) allocations[index] += shares[position]
    remaining -= shares.reduce((sum, share) => sum + share, 0)
    const remainderOrder = [...active].sort((a, b) => weights[b] - weights[a] || a - b)
    for (let index = 0; index < remaining; index++) allocations[remainderOrder[index]]++
    break
  }
  return allocations
}

function fileRenderOverhead(relPath: string, truncated: boolean): number {
  const title = `### 文件：${relPath}${truncated ? '（内容过长已截断）' : ''}`
  return title.length + 10
}

async function pickFiles(
  scan: ScanResult,
  granularity: Granularity,
  budgetChars: number,
  contentReadSummary: ContentReadSummary,
  headerText: string,
  treeText: string,
  warningReserve: number,
  sourceScan = scan,
  options: BuildContextOptions = {}
): Promise<PickedFiles> {
  const assertActive = (): void => { if (options.signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError') }
  const eligibleFiles = scan.files
    .filter((f) => f.isContentCandidate)
    .filter((f) => {
      if (granularity === 'coarse') {
        // 粗粒度只要文档/配置/入口，不看业务源码
        return isCoarseCandidate(f.relPath)
      }
      return true
    })

  // Read a bounded sample to infer entry points and local references. The
  // approved reader remains the only source of bytes; only redacted text is
  // retained, and this cache lives for this pickFiles call alone.
  const cache = new Map<string, { content: string; redaction: ReturnType<typeof redactSensitiveContent> } | { failed: true }>()
  const probeFiles = selectProbeFiles(eligibleFiles, granularity)
  for (const file of probeFiles) {
    assertActive()
    contentReadSummary.attemptedReads++
    try {
      const raw = await readProjectContent(sourceScan, file)
      contentReadSummary.successfulReads++
      const redaction = redactSensitiveContent(raw)
      cache.set(file.relPath, { content: redaction.content, redaction })
    } catch (error) {
      if (error instanceof ProjectContentBoundaryError) throw error
      if (!(error instanceof ProjectContentReadError)) throw error
      recordContentReadFailure(contentReadSummary, file.relPath, contentReadFailureReason(error))
      cache.set(file.relPath, { failed: true })
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
    assertActive()
  }
  const probeContents = new Map<string, string>()
  for (const [relPath, value] of cache) {
    if (!('failed' in value)) probeContents.set(relPath, value.content)
  }
  const signals = collectFileSignals(eligibleFiles, probeContents)
  assertActive()
  const candidates = orderFilesForContext(eligibleFiles, granularity, signals)
  const emptyBatch: ContextBatch = { label: '', files: [], totalChars: 0, kind: 'global', weight: 1 }
  const baseChars = renderBatch(headerText, treeText, emptyBatch).length
  const available = Math.max(0, budgetChars - warningReserve - baseChars)
  const estimatedContent = (file: ScannedFile): number => {
    const cached = cache.get(file.relPath)
    if (cached) return 'failed' in cached ? 0 : cached.content.length
    return Math.min(file.textBytes ?? file.size, MAX_CONTENT_FILE_BYTES)
  }
  let estimatedCost = 0
  let estimatedReadBytes = 0
  for (let index = 0; index < candidates.length; index++) {
    const file = candidates[index]
    estimatedCost += fileRenderOverhead(file.relPath, false) + estimatedContent(file)
    estimatedReadBytes += file.size
  }
  const allEstimatedFit = estimatedCost <= available && estimatedReadBytes <= 16 * 1024 * 1024

  // Constrained projects get a bounded window with room for a useful slice in
  // every slot. If estimates say all files fit, retain all and verify after
  // redaction using their actual UTF-16 lengths.
  let windowSize = candidates.length
  if (!allEstimatedFit) {
    windowSize = 0
    let reserved = 0
    for (const file of candidates) {
      const overhead = fileRenderOverhead(file.relPath, true)
      if (windowSize >= 64 || reserved + overhead + 1024 > available) break
      reserved += overhead + 1024
      windowSize++
    }
  }

  const selected: Array<{ file: ScannedFile; redaction: ReturnType<typeof redactSensitiveContent> }> = []
  let selectedReadBytes = 0
  let candidateIndex = 0
  let readBudgetSkipped = false
  while (candidateIndex < candidates.length && selected.length < windowSize) {
    assertActive()
    const file = candidates[candidateIndex++]
    let cached = cache.get(file.relPath)
    if (!cached) {
      if (selectedReadBytes + file.size > 16 * 1024 * 1024) {
        readBudgetSkipped = true
        continue
      }
      selectedReadBytes += file.size
      contentReadSummary.attemptedReads++
      try {
        const raw = await readProjectContent(sourceScan, file)
        contentReadSummary.successfulReads++
        const redaction = redactSensitiveContent(raw)
        cached = { content: redaction.content, redaction }
        cache.set(file.relPath, cached)
      } catch (error) {
        if (error instanceof ProjectContentBoundaryError) throw error
        if (!(error instanceof ProjectContentReadError)) throw error
        recordContentReadFailure(contentReadSummary, file.relPath, contentReadFailureReason(error))
        cache.set(file.relPath, { failed: true })
        continue
      }
      await new Promise<void>((resolve) => setImmediate(resolve))
      assertActive()
    }
    if ('failed' in cached) continue
    selected.push({ file, redaction: cached.redaction })
  }

  const fullCost = selected.reduce((sum, item) => {
    return sum + fileRenderOverhead(item.file.relPath, false) + item.redaction.content.length
  }, baseChars)
  const keepWholeSelected = fullCost + warningReserve <= budgetChars
  const truncatedOverhead = selected.reduce((sum, item) => {
    return sum + fileRenderOverhead(item.file.relPath, true)
  }, 0)
  const bodyBudget = Math.max(0, budgetChars - warningReserve - baseChars - truncatedOverhead)
  const demands = selected.map(({ redaction }) => redaction.content.length)
  const weights = selected.map(({ file }) => contextFileWeight(file.relPath, signals))
  const allocations = keepWholeSelected ? demands : allocateBodyBudget(demands, bodyBudget, weights)
  const out: ContextFile[] = []
  const contentSecurity = emptyContentSecurity()
  let contentTruncated = candidateIndex < candidates.length || readBudgetSkipped
  for (let index = 0; index < selected.length; index++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    assertActive()
    const { file, redaction } = selected[index]
    const truncated = !keepWholeSelected && redaction.content.length > allocations[index]
    const analysis = analyzeSource(file.relPath, redaction.content)
    const referencedSymbols = new Set(signals.referencedSymbols?.get(file.relPath) ?? [])
    for (const imported of analysis?.imports ?? []) {
      for (const name of imported.importedNames) if (name !== '*' && name !== 'default') referencedSymbols.add(name)
    }
    const regions = truncated
      ? selectSourceRegions(redaction.content, analysis, allocations[index], { roleFocus: options.roleFocus, referencedSymbols, extension: file.ext }).regions
      : [{ start: 0, end: redaction.content.length, text: redaction.content, label: 'whole-file', complete: true, priority: 100 }]
    const selectionCandidates = isDocumentOrConfigPath(file.relPath)
      ? undefined
      : sourceRegionCandidates(redaction.content, analysis, { roleFocus: options.roleFocus, referencedSymbols, extension: file.ext })
    const renderedContent = truncated ? formatRegions(regions) : redaction.content
    out.push({
      relPath: file.relPath,
      content: renderedContent,
      selectionRegions: truncated ? regions : undefined,
      selectionCandidates: selectionCandidates?.length ? selectionCandidates : undefined,
      truncated,
      redacted: redaction.totalMatches > 0,
      redactionMatches: redaction.totalMatches,
      weight: weights[index]
    })
    contentTruncated ||= truncated
    if (redaction.totalMatches > 0) {
      contentSecurity.redactedFiles++
      contentSecurity.redactionMatches += redaction.totalMatches
      for (const match of redaction.matches) {
        contentSecurity.matchesByCategory[match.category] =
          (contentSecurity.matchesByCategory[match.category] ?? 0) + match.count
      }
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

export async function buildContext(scan: ScanResult, granularity: Granularity, options: BuildContextOptions = {}): Promise<BuiltContext> {
  if (options.signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError')
  const requestedBudget = Number.isFinite(options.maxChars) ? Math.floor(options.maxChars as number) : CONTEXT_CHAR_BUDGETS[granularity]
  const budgetChars = Math.min(CONTEXT_CHAR_BUDGETS[granularity], Math.max(0, requestedBudget))
  if (!isProjectContentReadable(scan)) throw new ProjectContentBoundaryError()
  let policyRoot: string
  try {
    policyRoot = (await resolveProjectIdentity(scan.root)).realPath
  } catch {
    throw new Error('无法安全解析所选项目路径，已停止分析')
  }
  const protectedRoot = Boolean(scan.tree.modelExcluded || classifySensitivePath('__project_root__', policyRoot))
  const tree = renderBoundedTree(scan.tree, 4000, Math.min(treeCharBudget(granularity), Math.floor(budgetChars * 0.2)), policyRoot)
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
  const fixedChars = renderBatch(headerText, tree.text, { label: '', files: [], totalChars: 0, kind: 'global', weight: 1 }).length
  if (fixedChars + warningReserve > budgetChars) throw new Error('模型请求固定上下文超出支持范围。')
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
      budgetChars,
      contentReadSummary,
      headerText,
      tree.text,
      warningReserve,
      scan,
      options
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
    if (options.signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError')
    return {
      headerText,
      treeText: tree.text,
      contextTruncation,
      batches,
      contentSecurity,
      contentReadSummary,
      moduleCount: 0,
      selection: makeSelectionSummary(safeScan, files, granularity),
      eligibleFilePaths: eligibleContextFilePaths(safeScan, granularity)
    }
  }

  // 细粒度：全局批（文档+配置）+ 各模块批（按顶层目录分组）
  // 全局批与模块批分别代表实际请求；同一文件若出现在多个批次，按请求次数分别计数。
  const globalPicked = await pickFiles(
    safeScan,
    'coarse',
    budgetChars,
    contentReadSummary,
    headerText,
    tree.text,
    warningReserve,
    scan,
    options
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
      return scoreOf(b.mass) - scoreOf(a.mass) || a.group.localeCompare(b.group)
    })

  const MAX_MODULE_BATCHES = 10
  let moduleBatches = 0
  for (const { group, groupFiles, mass } of sortedGroups) {
    if (options.signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError')
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
      budgetChars,
      contentReadSummary,
      headerText,
      tree.text,
      warningReserve,
      scan,
      options
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
  if (options.signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError')

  return {
    headerText,
    treeText: tree.text,
    contextTruncation,
    batches,
    contentSecurity,
    contentReadSummary,
    moduleCount: moduleBatches,
    selection: makeSelectionSummary(safeScan, batches.flatMap((batch) => batch.files), granularity),
    eligibleFilePaths: eligibleContextFilePaths(safeScan, granularity)
  }
}

function formatRegions(regions: readonly SourceRegion[]): string {
  return regions.map((region, index) => `${index ? '…（其他位置省略）…\n' : ''}${region.text}`).join('\n')
}

function eligibleContextFilePaths(scan: ScanResult, granularity: Granularity): string[] {
  return [...new Set(scan.files.filter((file) => file.isContentCandidate && (
    granularity === 'fine' ? isCoarseCandidate(file.relPath) || CODE_EXTS.has(file.ext)
      : granularity === 'coarse' ? isCoarseCandidate(file.relPath)
        : true
  )).map((file) => file.relPath))].sort((a, b) => a.localeCompare(b))
}

function makeSelectionSummary(scan: ScanResult, files: readonly ContextFile[], granularity: Granularity): NonNullable<BuiltContext['selection']> {
  const eligible = eligibleContextFilePaths(scan, granularity)
  const unique = new Map(files.map((file) => [file.relPath, file]))
  const values = [...unique.values()]
  return {
    strategy: 'structure-v1',
    eligibleFiles: eligible.length,
    selectedFiles: values.length,
    selectedRegions: files.reduce((sum, file) => sum + (file.selectionRegions?.length ?? (file.content.length ? 1 : 0)), 0),
    omittedFiles: Math.max(0, eligible.length - values.length),
    truncatedFiles: values.filter((file) => file.truncated).length,
    providedChars: files.reduce((sum, file) => sum + file.content.length, 0)
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
): { text: string; truncated: boolean; selection?: RenderedSelection } {
  const text = renderBatch(headerText, treeText, batch)
  if (text.length <= maxChars) return { text, truncated: false, selection: summarizeRenderedFiles(batch.files) }
  const outputBudget = maxChars - requestTruncationMarker.length
  const base = renderBatch(headerText, treeText, { ...batch, files: [] })
  if (outputBudget < 0 || base.length > outputBudget) throw new Error('模型请求固定上下文超出支持范围。')
  const baseChars = base.length
  const plans = batch.files.map((file, index) => {
    const clippedTitle = `### 文件：${file.relPath}（内容过长已截断）`
    return {
      file,
      index,
      kind: isDocumentOrConfigPath(file.relPath) ? 'document' as const : file.selectionCandidates?.length || file.selectionRegions?.length ? 'regions' as const : 'whole' as const,
      overhead: 1 + clippedTitle.length + 9,
      demand: file.content.length,
      weight: normalizeContextWeight(file.weight)
    }
  })
  // Reserve entry framing for code first, then documents, before sharing the
  // remaining body allowance. A large README can no longer consume the space
  // needed to represent later small source files.
  const overheadPriority = [...plans].sort((a, b) =>
    (a.kind === 'document' ? 1 : 0) - (b.kind === 'document' ? 1 : 0) || a.index - b.index
  )
  let candidates = overheadPriority
  let included: typeof plans = []
  let allocations: number[] = []
  while (true) {
    let availableOverhead = outputBudget - baseChars
    included = candidates.filter((plan) => {
      if (plan.overhead > availableOverhead) return false
      availableOverhead -= plan.overhead
      return true
    })
    if (!included.length) { allocations = []; break }
    const overhead = included.reduce((sum, plan) => sum + plan.overhead, 0)
    allocations = allocateBodyBudget(
      included.map((plan) => plan.demand),
      Math.max(0, outputBudget - baseChars - overhead),
      included.map((plan) => plan.weight)
    )
    const failed = included.filter((plan, index) => !canRenderPlannedFile(plan, allocations[index]))
    if (!failed.length) break
    const failedSet = new Set(failed)
    candidates = candidates.filter((plan) => !failedSet.has(plan))
  }

  const byIndex = new Map(included.map((plan, index) => [plan.index, { plan, allocation: allocations[index] }]))
  const parts = [base]
  const includedFiles: ContextFile[] = []
  let selectedRegions = 0
  let providedChars = 0
  let truncated = included.length < batch.files.length
  for (let index = 0; index < batch.files.length; index++) {
    const entry = byIndex.get(index)
    if (!entry) { truncated = true; continue }
    const { plan, allocation } = entry
    const { file, kind } = plan
    let content: string
    let regionCount: number
    if (kind === 'document') {
      content = allocation >= file.content.length ? file.content : clipDocumentExcerpt(file.content, allocation)
      regionCount = content.length ? 1 : 0
    } else if (kind === 'regions') {
      const candidates = file.selectionCandidates?.length ? file.selectionCandidates : file.selectionRegions ?? []
      if (!file.truncated && allocation >= file.content.length) {
        content = file.content
        regionCount = content.length ? 1 : 0
      } else {
        const regions = regionsWithinBudget(candidates, allocation)
        content = formatRegions(regions)
        regionCount = regions.length
      }
    } else if (allocation >= file.content.length) {
      content = file.content
      regionCount = content.length ? 1 : 0
    } else {
      truncated = true
      continue
    }
    if (!content.length && file.content.length) { truncated = true; continue }
    const wasClipped = content !== file.content
    truncated ||= wasClipped
    const title = `### 文件：${file.relPath}${file.truncated || wasClipped ? '（内容过长已截断）' : ''}`
    parts.push([title, '```', content, '```'].join('\n'))
    includedFiles.push(file)
    selectedRegions += regionCount
    providedChars += content.length
  }
  const rendered = parts.join('\n')
  if (rendered.length > outputBudget) throw new Error('模型请求固定上下文超出支持范围。')
  return {
    text: `${rendered}${requestTruncationMarker}`,
    truncated,
    selection: { filePaths: includedFiles.map((file) => file.relPath), selectedRegions, providedChars }
  }
}

function regionsWithinBudget(regions: readonly SourceRegion[], maxChars: number): SourceRegion[] {
  const selected: SourceRegion[] = []
  const ranked = [...regions].sort((a, b) => b.priority - a.priority || a.start - b.start)
  for (const region of ranked) {
    if (selected.some((item) => item.start < region.end && item.end > region.start)) continue
    const candidate = [...selected, region]
    if (formatRegions(candidate).length <= maxChars) selected.push(region)
  }
  return selected.sort((a, b) => a.start - b.start)
}

function canRenderPlannedFile(plan: { kind: 'document' | 'regions' | 'whole'; file: ContextFile }, allocation: number): boolean {
  if (plan.kind === 'document') return allocation > 0 || plan.file.content.length === 0
  if (plan.kind === 'regions') {
    if (!plan.file.truncated && allocation >= plan.file.content.length) return true
    const candidates = plan.file.selectionCandidates?.length ? plan.file.selectionCandidates : plan.file.selectionRegions ?? []
    return regionsWithinBudget(candidates, allocation).length > 0 || plan.file.content.length === 0
  }
  return allocation >= plan.file.content.length
}

function summarizeRenderedFiles(files: readonly ContextFile[]): RenderedSelection {
  return {
    filePaths: files.map((file) => file.relPath),
    selectedRegions: files.reduce((sum, file) => sum + (file.selectionRegions?.length ?? (file.content.length ? 1 : 0)), 0),
    providedChars: files.reduce((sum, file) => sum + file.content.length, 0)
  }
}

const DOCUMENT_AND_CONFIG_EXTENSIONS = new Set([
  'md', 'mdx', 'markdown', 'txt', 'rst', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'xml', 'csv'
])

function isDocumentOrConfigPath(relPath: string): boolean {
  const extension = relPath.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase() ?? ''
  return DOCUMENT_AND_CONFIG_EXTENSIONS.has(extension)
}

function tailAtCodePointBoundary(text: string, length: number): string {
  if (length <= 0) return ''
  let clipped = text.slice(-length)
  const first = clipped.charCodeAt(0)
  if (first >= 0xdc00 && first <= 0xdfff) clipped = clipped.slice(1)
  return clipped
}

function clipDocumentExcerpt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars <= 0) return ''
  const preferredMarker = '…（文档片段已截断）…'
  const marker = preferredMarker.length <= maxChars ? preferredMarker : '…'
  const available = maxChars - marker.length
  const headLength = Math.ceil(available / 2)
  const tailLength = Math.floor(available / 2)
  const head = safeClipText(text, headLength, '')
  const tail = tailAtCodePointBoundary(text, tailLength)
  return `${head}${marker}${tail}`
}
