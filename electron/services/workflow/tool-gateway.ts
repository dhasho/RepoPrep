import type { ApprovedProjectRead, EvidenceRecord, WorkflowEvidenceStore, WorkflowFile, WorkflowProjectSnapshot } from './project-contract'
import { WorkflowError } from './project-contract'
// @ts-ignore TS5097 -- direct Node tests require explicit TypeScript extensions.
import { safeClipText } from '../../../shared/context-budget.ts'

export type ToolName = 'get_overview' | 'list_symbols' | 'search_text' | 'read_region' | 'read_declaration_context'
export type ModelStage = 'investigation' | 'generation' | 'review' | 'repair' | 'compensation'
/** Structural until the shared M05 ledger is available in this module's dependency graph. */
export interface ToolBudget {
  chargeTool(id: string, stage?: ModelStage): void
  reserveRead(id: string, bytes: number): void
  settleRead(id: string, actualBytes: number): void
  releaseRead(id: string): void
  assertCanContinue(stage?: ModelStage): void
}
export interface ToolResult {
  readonly actionId: string
  readonly tool: ToolName | 'unknown'
  readonly status: 'ok' | 'rejected' | 'cancelled' | 'budget-exhausted' | 'unavailable'
  readonly reasonCode?: string
  readonly evidenceIds: readonly string[]
  readonly preview: string
  readonly consumption: Readonly<{ readBytes: number; toolCalls: number; cacheHit: boolean }>
  readonly data?: unknown
}
type Action = { actionId: string; tool: ToolName; args: Record<string, unknown> }
type CachedRead = { read: ApprovedProjectRead; bytes: number }
type Context = { read: ApprovedProjectRead; text: string; lines: string[]; evidence: readonly EvidenceRecord[]; cacheHit: boolean; readBytes: number }
const TOOLS = new Set<ToolName>(['get_overview', 'list_symbols', 'search_text', 'read_region', 'read_declaration_context'])
const MAX_PREVIEW = 4000
const MAX_RESULT = 64 * 1024
const MAX_GATEWAY_CACHE_BYTES = 8 * 1024 * 1024
const MAX_GATEWAY_CACHE_FILES = 1000
const SAFE_REASON = new Set(['invalid-argument', 'permission-denied', 'stale-snapshot', 'unreadable', 'cancelled', 'budget-exhausted', 'timeout', 'capacity-exhausted', 'unknown-evidence'])
let globalReadNonce = 0
let globalToolCallNonce = 0

function workflow(code: ConstructorParameters<typeof WorkflowError>[0]): never { throw new WorkflowError(code) }
function abort(signal?: AbortSignal): void {
  if (signal !== undefined && (typeof AbortSignal === 'undefined' || !(signal instanceof AbortSignal))) workflow('invalid-argument')
  if (signal?.aborted) workflow('cancelled')
}
function combineSignals(first?: AbortSignal, second?: AbortSignal): AbortSignal | undefined {
  abort(first); abort(second)
  if (first && second && first !== second) return AbortSignal.any([first, second])
  return first ?? second
}
function obj(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function plain(value: unknown): value is Record<string, unknown> {
  if (!obj(value)) return false
  return Object.getPrototypeOf(value) === Object.prototype
}
function dataObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!plain(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key)) || Object.keys(value).length !== Reflect.ownKeys(value).length) return false
  return Object.keys(value).every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return !!descriptor && 'value' in descriptor && descriptor.enumerable
  })
}
function stringArray(value: unknown, max: number): value is string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) return false
  const keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9]\d*)$/.test(key))) || keys.length !== value.length + 1) return false
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable || !safeString(descriptor.value, 1, 128)) return false
  }
  return true
}
function validId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value) }
function safeString(value: unknown, min: number, max: number): value is string { return typeof value === 'string' && value.length >= min && value.length <= max }
function int(value: unknown, min: number, max: number): value is number { return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max }
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (obj(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
function lineAt(text: string, offset: number): number { return text.slice(0, Math.max(0, offset)).split('\n').length }
function lineCount(text: string): number { return text.length === 0 ? 1 : text.split('\n').length }
function sliceLines(lines: string[], startLine: number, endLine: number): string { return lines.slice(startLine - 1, endLine).join('\n') }
function capText(value: string): string { return safeClipText(value, MAX_PREVIEW, '\n[preview truncated]') }
function validateArgs(tool: ToolName, args: unknown): boolean {
  switch (tool) {
    case 'get_overview': return dataObject(args, ['offset', 'limit', 'pathQuery']) && (args.offset === undefined || int(args.offset, 0, 250000)) && (args.limit === undefined || int(args.limit, 1, 100)) && (args.pathQuery === undefined || safeString(args.pathQuery, 0, 200))
    case 'list_symbols': return dataObject(args, ['fileId', 'offset', 'limit']) && safeString(args.fileId, 1, 128) && (args.offset === undefined || int(args.offset, 0, 250000)) && (args.limit === undefined || int(args.limit, 1, 100))
    case 'search_text': return dataObject(args, ['query', 'fileIds', 'limit', 'caseSensitive']) && safeString(args.query, 1, 256) && (args.fileIds === undefined || stringArray(args.fileIds, 100)) && (args.limit === undefined || int(args.limit, 1, 50)) && (args.caseSensitive === undefined || typeof args.caseSensitive === 'boolean')
    case 'read_region': return dataObject(args, ['fileId', 'startLine', 'endLine']) && safeString(args.fileId, 1, 128) && int(args.startLine, 1, Number.MAX_SAFE_INTEGER) && int(args.endLine, 1, Number.MAX_SAFE_INTEGER) && (args.endLine as number) >= (args.startLine as number) && (args.endLine as number) - (args.startLine as number) < 500
    case 'read_declaration_context': return dataObject(args, ['fileId', 'line', 'maxLines']) && safeString(args.fileId, 1, 128) && int(args.line, 1, Number.MAX_SAFE_INTEGER) && (args.maxLines === undefined || int(args.maxLines, 1, 500))
  }
}

export function createToolGateway(snapshot: WorkflowProjectSnapshot, store: WorkflowEvidenceStore, ledger: ToolBudget, options: { signal?: AbortSignal } = {}) {
  if (!snapshot || !store || !ledger || !dataObject(options, ['signal'])) workflow('invalid-argument')
  if (options.signal !== undefined) abort(options.signal)
  const reads = new Map<string, CachedRead>()
  let gatewayCacheBytes = 0
  const actions = new Map<string, { fingerprint: string; result: ToolResult }>()
  const result = (actionId: string, tool: ToolName | 'unknown', status: ToolResult['status'], reasonCode?: string, evidenceIds: readonly string[] = [], preview = '', data?: unknown, readBytes = 0, toolCalls = 0, cacheHit = false): ToolResult => {
    const reportedBytes = Number.isFinite(readBytes) && readBytes >= 0 ? readBytes : 0
    const output: ToolResult = { actionId, tool, status, ...(reasonCode ? { reasonCode } : {}), evidenceIds: Object.freeze([...new Set(evidenceIds)].slice(0, 512)), preview: capText(preview), consumption: Object.freeze({ readBytes: reportedBytes, toolCalls, cacheHit }), ...(data === undefined ? {} : { data }) }
    const bounded = JSON.stringify(output)
    if (Buffer.byteLength(bounded, 'utf8') > MAX_RESULT) return deepFreeze({ ...output, data: undefined, preview: safeClipText(output.preview, 1000), evidenceIds: output.evidenceIds.slice(0, 100), reasonCode: 'result-truncated' })
    return deepFreeze(output)
  }
  const makeContext = async (file: WorkflowFile, actionId: string, signal?: AbortSignal): Promise<Context> => {
    abort(signal)
    await snapshot.assertCurrent(signal)
    abort(signal)
    ledger.assertCanContinue('investigation')
    const cached = reads.get(file.fileId)
    let read: ApprovedProjectRead
    let readBytes = 0
    let cacheHit = false
    if (cached) {
      if (!snapshot.ownsRead(cached.read)) workflow('stale-snapshot')
      ledger.assertCanContinue('investigation')
      read = cached.read
      cacheHit = true
    } else {
      const reservation = `tool-read:${snapshot.snapshotId}:${++globalReadNonce}`
      ledger.assertCanContinue('investigation')
      ledger.reserveRead(reservation, file.byteLength)
      let ioStarted = false
      try {
        abort(signal)
        ledger.assertCanContinue('investigation')
        ioStarted = true
        const response = await snapshot.readFile(file.fileId, signal)
        ledger.settleRead(reservation, response.consumedBytes)
        abort(signal)
        await snapshot.assertCurrent(signal)
        abort(signal)
        ledger.assertCanContinue('investigation')
        if (!snapshot.ownsRead(response.read) || response.read.fileId !== file.fileId || response.read.snapshotId !== snapshot.snapshotId) workflow('permission-denied')
        read = response.read
        readBytes = response.consumedBytes
        if (snapshot.ownsRead(read)) {
          const cacheBytes = Buffer.byteLength(read.text, 'utf8')
          if (cacheBytes <= MAX_GATEWAY_CACHE_BYTES) {
            while (reads.size >= MAX_GATEWAY_CACHE_FILES || gatewayCacheBytes + cacheBytes > MAX_GATEWAY_CACHE_BYTES) {
              const oldest = reads.keys().next().value as string | undefined
              if (!oldest) break
              const evicted = reads.get(oldest)
              if (evicted) gatewayCacheBytes -= Buffer.byteLength(evicted.read.text, 'utf8')
              reads.delete(oldest)
            }
            reads.set(file.fileId, { read, bytes: cacheBytes })
            gatewayCacheBytes += cacheBytes
          }
        }
      } catch (error) {
        if (!ioStarted) { try { ledger.releaseRead(reservation) } catch { /* conservative if ledger rejects */ } }
        throw error
      }
    }
    abort(signal)
    const lines = read.text.split(/\r\n|\n|\r/)
    return { read, text: read.text, lines, evidence: [], cacheHit, readBytes }
  }
  const issue = async (ctx: Context, startLine: number, endLine: number, signal?: AbortSignal): Promise<Context> => {
    abort(signal)
    ledger.assertCanContinue('investigation')
    const evidence = await store.issue(ctx.read, { startLine, endLine }, signal)
    abort(signal)
    ledger.assertCanContinue('investigation')
    return { ...ctx, evidence }
  }
  const run = async (action: Action, signal?: AbortSignal): Promise<ToolResult> => {
    const merged = combineSignals(options.signal, signal)
    try {
      abort(merged)
      const duplicate = actions.get(action.actionId)
      const fingerprint = canonical(action)
      if (duplicate) {
        if (duplicate.fingerprint !== fingerprint) return result(action.actionId, action.tool, 'rejected', 'duplicate-id-conflict')
        await snapshot.assertCurrent(merged)
        abort(merged)
        ledger.assertCanContinue('investigation')
        if (!duplicate.result.evidenceIds.every(id => store.metadata().ids.includes(id))) return result(action.actionId, action.tool, 'unavailable', 'stale-evidence')
        return result(action.actionId, action.tool, duplicate.result.status, duplicate.result.reasonCode, duplicate.result.evidenceIds, duplicate.result.preview, duplicate.result.data, 0, 0, true)
      }
      abort(merged)
      ledger.assertCanContinue('investigation')
      ledger.chargeTool(`tool-call:${snapshot.snapshotId}:${++globalToolCallNonce}`, 'investigation')
      let out: ToolResult
      const args = action.args
      if (action.tool === 'get_overview') {
        await snapshot.assertCurrent(merged); abort(merged); ledger.assertCanContinue('investigation')
        const offset = (args.offset as number | undefined) ?? 0
        const limit = (args.limit as number | undefined) ?? 100
        const pathQuery = ((args.pathQuery as string | undefined) ?? '').toLowerCase()
        const files = snapshot.files.filter(file => file.relPath.toLowerCase().includes(pathQuery)).slice(offset, offset + limit).map(file => ({ fileId: file.fileId, relPath: file.relPath, byteLength: file.byteLength, sourceKind: file.sourceKind }))
        out = result(action.actionId, action.tool, 'ok', undefined, [], `${snapshot.summary.name}: ${snapshot.files.length} approved content files`, { projectName: snapshot.summary.name.slice(0, 120), totalFiles: snapshot.summary.totalFiles, approvedContentFiles: snapshot.files.length, truncated: snapshot.summary.truncated, offset, limit, files })
      } else if (action.tool === 'list_symbols') {
        const file = snapshot.files.find(item => item.fileId === args.fileId); if (!file) workflow('permission-denied')
        let ctx = await makeContext(file, action.actionId, merged)
        if (ctx.read.indexStatus !== 'available' || !ctx.read.analysis) out = result(action.actionId, action.tool, 'unavailable', 'index-unavailable', [], 'Parsed symbol index unavailable; use bounded plaintext line reads.', { indexStatus: 'unavailable' }, ctx.readBytes, 1, ctx.cacheHit)
        else {
          const offset = (args.offset as number | undefined) ?? 0; const limit = (args.limit as number | undefined) ?? 100
          const all = ctx.read.analysis.symbols.map(symbol => ({ name: symbol.name.slice(0, 200), kind: symbol.kind, startLine: lineAt(ctx.text, symbol.start), endLine: lineAt(ctx.text, symbol.end), exported: symbol.exported, ...(symbol.parentName ? { parentName: symbol.parentName.slice(0, 200) } : {}) }))
          const chosen = all.slice(offset, offset + limit)
          if (chosen.length) { const lo = Math.min(...chosen.map(item => item.startLine)); const hi = Math.min(lineCount(ctx.text), Math.max(...chosen.map(item => item.endLine))); ctx = await issue(ctx, lo, hi, merged) }
          out = result(action.actionId, action.tool, 'ok', undefined, ctx.evidence.map(item => item.id), `Symbols ${offset + 1}-${Math.min(offset + limit, all.length)} of ${all.length}`, { indexStatus: 'available', total: all.length, offset, symbols: chosen }, ctx.readBytes, 1, ctx.cacheHit)
        }
      } else if (action.tool === 'search_text') {
        const files = args.fileIds === undefined ? snapshot.files : (args.fileIds as string[]).map(id => snapshot.files.find(file => file.fileId === id) ?? workflow('permission-denied'))
        const query = args.query as string; const needle = args.caseSensitive ? query : query.toLowerCase(); const limit = (args.limit as number | undefined) ?? 50
        const matches: Array<{ fileId: string; relPath: string; line: number; text: string }> = []; const evidenceIds: string[] = []; let bytes = 0; let cacheHit = true; let reason: string | undefined
        for (const file of files) {
          abort(merged)
          if (matches.length >= limit) { reason = 'match-limit'; break }
          try {
            const ctx = await makeContext(file, action.actionId, merged); bytes += ctx.readBytes; cacheHit = cacheHit && ctx.cacheHit
            const foundLines: number[] = []
            for (let i = 0; i < ctx.lines.length && matches.length < limit; i++) {
              const haystack = args.caseSensitive ? ctx.lines[i] : ctx.lines[i].toLowerCase()
              if (haystack.indexOf(needle) >= 0) {
                matches.push({ fileId: file.fileId, relPath: file.relPath, line: i + 1, text: capText(ctx.lines[i]) })
                foundLines.push(i + 1)
                if (matches.length >= limit) { reason = 'match-limit'; break }
              }
            }
            for (const line of foundLines) { const cited = await issue(ctx, line, line, merged); evidenceIds.push(...cited.evidence.map(item => item.id)) }
          } catch (error) {
            if ((error as { code?: string })?.code === 'budget-exhausted') { reason = 'budget-exhausted'; break }
            throw error
          }
        }
        out = result(action.actionId, action.tool, 'ok', reason, evidenceIds, `${matches.length} literal matches${reason ? `; stopped: ${reason}` : ''}`, { matches, searchComplete: reason === undefined, ...(reason ? { stopReason: reason } : {}) }, bytes, 1, cacheHit)
      } else if (action.tool === 'read_region') {
        const file = snapshot.files.find(item => item.fileId === args.fileId); if (!file) workflow('permission-denied')
        const ctx = await makeContext(file, action.actionId, merged); const start = args.startLine as number; const requestedEnd = args.endLine as number
        if (start > ctx.lines.length) workflow('invalid-argument')
        const end = Math.min(requestedEnd, ctx.lines.length)
        const cited = await issue(ctx, start, end, merged); const excerpt = sliceLines(ctx.lines, start, end)
        out = result(action.actionId, action.tool, 'ok', undefined, cited.evidence.map(item => item.id), excerpt, { fileId: file.fileId, relPath: file.relPath, startLine: start, endLine: end, requestedEndLine: requestedEnd, totalLines: ctx.lines.length, reachedEndOfFile: requestedEnd > end, text: capText(excerpt), omitted: excerpt.length > MAX_PREVIEW }, ctx.readBytes, 1, ctx.cacheHit)
      } else {
        const file = snapshot.files.find(item => item.fileId === args.fileId); if (!file) workflow('permission-denied')
        const ctx = await makeContext(file, action.actionId, merged); const target = args.line as number
        if (target > ctx.lines.length) workflow('invalid-argument')
        const maxLines = (args.maxLines as number | undefined) ?? 80
        const symbols = ctx.read.analysis?.symbols ?? []
        const declaration = ctx.read.indexStatus === 'available' ? symbols.filter(symbol => lineAt(ctx.text, symbol.start) <= target && lineAt(ctx.text, symbol.end) >= target).sort((a, b) => b.start - a.start)[0] : undefined
        let start = declaration ? lineAt(ctx.text, declaration.start) : Math.max(1, target - Math.floor((maxLines - 1) / 2))
        let end = declaration ? lineAt(ctx.text, declaration.end) : Math.min(ctx.lines.length, start + maxLines - 1)
        let omitted = false
        if (end - start + 1 > maxLines) {
          omitted = true
          start = Math.max(1, Math.min(target - Math.floor((maxLines - 1) / 2), ctx.lines.length - maxLines + 1))
          end = Math.min(ctx.lines.length, start + maxLines - 1)
        }
        const cited = await issue(ctx, start, end, merged); const excerpt = sliceLines(ctx.lines, start, end)
        out = result(action.actionId, action.tool, 'ok', undefined, cited.evidence.map(item => item.id), excerpt, { fileId: file.fileId, relPath: file.relPath, startLine: start, endLine: end, text: capText(excerpt), indexStatus: ctx.read.indexStatus, declarationIncluded: Boolean(declaration) && !omitted, declarationOmitted: Boolean(declaration) && omitted, contextMode: declaration && !omitted ? 'declaration' : 'plaintext-fallback' }, ctx.readBytes, 1, ctx.cacheHit)
      }
      abort(merged)
      await snapshot.assertCurrent(merged)
      abort(merged)
      ledger.assertCanContinue('investigation')
      actions.set(action.actionId, { fingerprint, result: out })
      return out
    } catch (error) {
      const code = error instanceof WorkflowError ? error.code : (error as { code?: string })?.code === 'budget-exhausted' || (error instanceof Error && error.message === 'Workflow budget exhausted.') ? 'budget-exhausted' : 'unreadable'
      if (code === 'stale-snapshot') { reads.clear(); gatewayCacheBytes = 0 }
      const status: ToolResult['status'] = code === 'cancelled' || merged?.aborted ? 'cancelled' : code === 'budget-exhausted' ? 'budget-exhausted' : 'rejected'
      return result(action.actionId, action.tool, status, SAFE_REASON.has(code) ? code : 'operation-failed')
    }
  }
  return Object.freeze({ async execute(actionValue: unknown, signal?: AbortSignal): Promise<ToolResult> {
    let signalMerged: AbortSignal | undefined
    let actionId = 'invalid'; let tool: ToolName | 'unknown' = 'unknown'
    try {
      signalMerged = combineSignals(options.signal, signal)
      abort(signalMerged)
      if (!dataObject(actionValue, ['actionId', 'tool', 'args']) || !validId(actionValue.actionId) || typeof actionValue.tool !== 'string' || !TOOLS.has(actionValue.tool as ToolName) || !validateArgs(actionValue.tool as ToolName, actionValue.args)) workflow('invalid-argument')
      actionId = actionValue.actionId as string; tool = actionValue.tool as ToolName
      return await run({ actionId, tool, args: actionValue.args as Record<string, unknown> }, signalMerged)
    } catch (error) {
      const code = error instanceof WorkflowError ? error.code : 'invalid-argument'
      return Promise.resolve(result(actionId, tool, code === 'cancelled' ? 'cancelled' : code === 'budget-exhausted' ? 'budget-exhausted' : 'rejected', SAFE_REASON.has(code) ? code : 'invalid-argument'))
    }
  } })
}
