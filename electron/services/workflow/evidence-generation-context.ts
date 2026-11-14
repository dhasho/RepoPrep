// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import type { ScanResult } from '../scanner.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import type { BuiltContext, ContextBatch, ContextFile, ContentSecuritySummary } from '../context-builder.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { emptyContentReadSummary } from '../../../shared/content-read.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import type { EvidenceRecord } from './project-contract.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import type { TopicCard } from './investigation-contract.ts'
// @ts-ignore TS5097 -- Node tests execute TypeScript modules with explicit extensions.
import { WorkflowError } from './project-contract.ts'
import { createHash } from 'node:crypto'

const MAX_MODEL_GROUPS = 4

export interface GenerationGroup {
  readonly ids: readonly string[]
  readonly topics: readonly TopicCard[]
  readonly bundles: readonly Readonly<{ id: string; evidenceIds: readonly string[] }>[]
  readonly files: readonly EvidenceRecord[]
}

function fail(code: ConstructorParameters<typeof WorkflowError>[0] = 'invalid-argument'): never { throw new WorkflowError(code) }
function json(value: unknown): string { return JSON.stringify(value) }
function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }

export function makeEvidenceGenerationGroups(ids: readonly string[], records: readonly EvidenceRecord[], bundles: readonly { id: string; evidenceIds: readonly string[] }[], topics: readonly TopicCard[], maximum: number, componentAwareFine: boolean): GenerationGroup[] {
  const parent = new Map(ids.map(id => [id, id]))
  const root = (id: string): string => {
    let current = parent.get(id)
    if (!current) fail('unknown-evidence')
    while (parent.get(current!) !== current) current = parent.get(current!)
    return current!
  }
  const join = (values: readonly string[]): void => {
    if (values.length < 2) return
    const first = root(values[0])
    for (const id of values.slice(1)) parent.set(root(id), first)
  }
  for (const bundle of bundles) join(bundle.evidenceIds)
  for (const topic of topics) join(topic.evidenceIds)
  const byId = new Map(records.map(record => [record.id, record]))
  const components = new Map<string, string[]>()
  for (const id of ids) components.set(root(id), [...(components.get(root(id)) ?? []), id])
  const ordered = [...components.values()].map(component => ({ ids: component, weight: component.reduce((sum, id) => sum + (byId.get(id)?.text.length ?? 0) + 1, 0) })).sort((a, b) => b.weight - a.weight || a.ids[0].localeCompare(b.ids[0]))
  const groupCount = componentAwareFine
    ? Math.min(Math.max(1, maximum), MAX_MODEL_GROUPS, Math.max(2, ordered.length))
    : Math.min(Math.max(1, maximum), MAX_MODEL_GROUPS)
  const groups = Array.from({ length: groupCount }, () => ({ ids: [] as string[], weight: 0 }))
  for (const component of ordered) {
    const target = groups.reduce((best, candidate, index) => candidate.weight < groups[best].weight ? index : best, 0)
    groups[target].ids.push(...component.ids)
    groups[target].weight += component.weight
  }
  let replicationIndex = 0
  for (const group of groups) {
    if (group.ids.length) continue
    const component = ordered[replicationIndex++ % ordered.length]
    group.ids.push(...component.ids)
    group.weight += component.weight
  }
  return groups.map(group => {
    const memberIds = new Set(group.ids)
    const topicCards = topics.filter(topic => topic.evidenceIds.every(id => memberIds.has(id)))
    const required = bundles.filter(bundle => bundle.evidenceIds.every(id => memberIds.has(id))).map(bundle => Object.freeze({ id: bundle.id, evidenceIds: Object.freeze([...bundle.evidenceIds]) }))
    for (const topic of topicCards) required.push(Object.freeze({ id: `topic-${sha256(topic.id).slice(0, 24)}`, evidenceIds: Object.freeze([...topic.evidenceIds]) }))
    return Object.freeze({ ids: Object.freeze([...group.ids]), topics: Object.freeze(topicCards), bundles: Object.freeze(required), files: Object.freeze(group.ids.map(id => byId.get(id)!).filter(Boolean)) })
  })
}

function metadataSecurity(records: readonly EvidenceRecord[]): ContentSecuritySummary {
  const files = new Map<string, NonNullable<EvidenceRecord['redactionSummary']>>()
  for (const record of records) {
    const summary = record.redactionSummary
    if (!summary || !Number.isSafeInteger(summary.totalMatches) || summary.totalMatches < 0 || !summary.matchesByCategory || typeof summary.matchesByCategory !== 'object') fail('invalid-argument')
    const prior = files.get(record.fileId)
    if (prior && json(prior) !== json(summary)) fail('invalid-argument')
    files.set(record.fileId, summary)
  }
  const matchesByCategory: ContentSecuritySummary['matchesByCategory'] = {}
  let redactionMatches = 0
  let redactedFiles = 0
  for (const summary of files.values()) {
    redactionMatches += summary.totalMatches
    if (summary.totalMatches > 0) redactedFiles++
    let fileCategoryTotal = 0
    for (const [category, count] of Object.entries(summary.matchesByCategory)) {
      if (!Number.isSafeInteger(count) || count < 0) fail('invalid-argument')
      fileCategoryTotal += count
      matchesByCategory[category as keyof typeof matchesByCategory] = (matchesByCategory[category as keyof typeof matchesByCategory] ?? 0) + count
    }
    if (fileCategoryTotal !== summary.totalMatches) fail('invalid-argument')
  }
  return { redactedFiles, redactionMatches, matchesByCategory }
}

export function buildLegacyEvidenceContext(scan: ScanResult, authorizedFilePaths: readonly string[], records: readonly EvidenceRecord[], groups: readonly GenerationGroup[]): BuiltContext {
  const allSelected = [...new Map(records.map(record => [record.id, record])).values()]
  const byId = new Map(allSelected.map(record => [record.id, record]))
  const batches: ContextBatch[] = groups.map((group, index) => {
    const files: ContextFile[] = group.files.map(record => ({ relPath: record.relPath, content: record.text, truncated: false, redacted: (record.redactionSummary?.totalMatches ?? 0) > 0, redactionMatches: record.redactionSummary?.totalMatches ?? 0 }))
    return { label: `证据组 ${index + 1}`, files, totalChars: files.reduce((sum, file) => sum + file.content.length, 0), kind: 'global', weight: Math.max(1, group.ids.reduce((sum, id) => sum + (byId.get(id)?.text.length ?? 0), 0)) }
  })
  const paths = [...new Set(allSelected.map(record => record.relPath))]
  const treeText = paths.map(value => `- ${value}`).join('\n')
  const langText = scan.languages.slice(0, 32).map(language => `${language.lang} ${language.percent}%`).join('、') || '未识别出常见编程语言'
  const partialWarning = scan.truncation ? '本次扫描触及安全限制；当前分析只覆盖明确提供的已授权证据。' : ''
  const headerText = [`项目：${scan.name}`, `主要语言：${langText}`, `本次选择的已授权证据文件：${paths.length}`, partialWarning, '', '## 本请求证据文件', '```', '（见下方文件树）', '```'].filter(line => line !== '').join('\n')
  const selectedFiles = new Set(paths)
  const contextTruncation = { treeTruncated: Boolean(scan.truncation), contentTruncated: false, requestTruncated: false }
  return {
    headerText,
    treeText,
    contextTruncation,
    batches,
    contentSecurity: metadataSecurity(allSelected),
    contentReadSummary: { ...emptyContentReadSummary(), attemptedReads: new Set(allSelected.map(record => record.fileId)).size, successfulReads: new Set(allSelected.map(record => record.fileId)).size },
    moduleCount: 0,
    selection: { strategy: 'structure-v1', eligibleFiles: authorizedFilePaths.length, selectedFiles: selectedFiles.size, selectedRegions: allSelected.length, omittedFiles: Math.max(0, authorizedFilePaths.length - selectedFiles.size), truncatedFiles: 0, providedChars: allSelected.reduce((sum, record) => sum + record.text.length, 0) },
    eligibleFilePaths: [...authorizedFilePaths]
  }
}
