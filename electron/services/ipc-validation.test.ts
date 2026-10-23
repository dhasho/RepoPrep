import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore TypeScript's current project config forbids .ts import suffixes; tests run directly in Node.
import { IPC } from '../../shared/ipc.ts'
// @ts-ignore TypeScript's current project config forbids .ts import suffixes; tests run directly in Node.
import { SCAN_LIMIT_BOUNDS } from '../../shared/types.ts'
// @ts-ignore TypeScript's current project config forbids .ts import suffixes; tests run directly in Node.
import { INVOKE_CHANNELS, IpcValidationError, validateIpcArgs } from './ipc-validation.ts'
// @ts-ignore TypeScript's current project config forbids .ts import suffixes; tests run directly in Node.
import { EXPLAIN_CONTEXT_LIMITS, LLM_PROFILE_LIMITS, MAX_LLM_PROFILES } from '../../shared/result-contract.ts'

const profile = { id: 'p1', name: '本地', baseUrl: 'https://api.example.com/v1', apiKey: '', model: 'model-x' }
const requestId = '4f22d0a1-3e0f-4f4e-8c1d-1c9f9036bc17'
const result = {
  version: 1, createdAt: '2026-01-01T00:00:00Z', projectName: 'demo', projectPath: 'C:\\demo',
  granularity: 'medium', roleFocus: 'general', profileId: 'p1', modelUsed: 'model-x', projectSummary: '',
  sections: [{ id: 's1', title: '模块', questions: [{ id: 'q1', question: '如何工作？', answer: '说明', followUps: [] }] }],
  glossary: { IPC: '进程间通信' }
}
function rejects(channel: string, ...args: unknown[]): void {
  assert.throws(() => validateIpcArgs(channel, args), IpcValidationError)
}

test('每个 invoke 通道全部登记且各自接受合法参数形状', () => {
  const valid = new Map<string, unknown[]>([
    [IPC.selectFolder, []], [IPC.scanProject, ['C:\\demo']], [IPC.recentProjects, []],
    [IPC.removeRecent, ['C:\\demo']], [IPC.loadResult, ['C:\\demo']], [IPC.deleteResult, ['C:\\demo']],
    [IPC.listAnalyses, ['C:\\demo']], [IPC.loadAnalysis, ['C:\\demo', 'a'.repeat(64)]],
    [IPC.generateRun, [{ projectPath: 'C:\\demo', granularity: 'fine', roleFocus: 'backend', profileId: 'p1', runId: requestId }]],
    [IPC.generateCancel, [requestId]], [IPC.explainStart, [{ requestId, term: 'IPC', profileId: 'p1', projectSummary: '', question: '问题', snippet: '' }]],
    [IPC.explainCancel, [requestId]], [IPC.settingsGet, []], [IPC.settingsSave, [{ profiles: [profile], defaultProfileId: 'p1' }]],
    [IPC.storageDiagnostics, []], [IPC.storageRecover, [`result:${'a'.repeat(40)}`]],
    [IPC.llmTest, [profile]], [IPC.llmListModels, [profile]], [IPC.exportMarkdown, [result]]
  ])
  for (const channel of INVOKE_CHANNELS) {
    assert.ok(valid.has(channel), `缺少 ${channel} schema`)
    assert.doesNotThrow(() => validateIpcArgs(channel, valid.get(channel)!))
  }
})

test('生成请求与取消接受大小写不同但格式合法的 UUIDv4', () => {
  const runId = requestId.toUpperCase()
  assert.doesNotThrow(() => validateIpcArgs(IPC.generateRun, [
    { projectPath: 'C:\\demo', granularity: 'fine', roleFocus: 'backend', profileId: 'p1', runId }
  ]))
  assert.doesNotThrow(() => validateIpcArgs(IPC.generateCancel, [runId]))
})

test('拒绝未知通道、参数缺失/多余及事件通道', () => {
  rejects('not:a:channel')
  rejects(IPC.scanProject)
  rejects(IPC.scanProject, 'C:\\demo', 'extra')
  rejects(IPC.generateProgress)
})

test('路径、枚举和字符串边界严格校验', () => {
  rejects(IPC.scanProject, 'relative/path')
  rejects(IPC.removeRecent, 'C:\\bad\0path')
  rejects(IPC.generateRun, { projectPath: 'C:\\demo', granularity: 'unknown', roleFocus: 'general', profileId: 'p1' })
  rejects(IPC.generateRun, { projectPath: 'C:\\demo', granularity: 'fine', roleFocus: 'unknown', profileId: 'p1' })
  rejects(IPC.explainStart, { requestId: 'r1', term: 't', profileId: 'p1', projectSummary: '', question: 'q', snippet: 'x'.repeat(24_001) })
})

test('analysis IPC 校验 optional cursor 和 lowercase SHA-256 id', () => {
  assert.doesNotThrow(() => validateIpcArgs(IPC.listAnalyses, ['C:\\demo', 'f'.repeat(64)]))
  for (const id of ['A'.repeat(64), 'f'.repeat(63), `${'f'.repeat(63)}g`, '../'.padEnd(64, 'a')]) {
    rejects(IPC.listAnalyses, 'C:\\demo', id)
    rejects(IPC.loadAnalysis, 'C:\\demo', id)
  }
  rejects(IPC.listAnalyses, 'C:\\demo', undefined)
  rejects(IPC.listAnalyses, 'relative', 'f'.repeat(64))
  rejects(IPC.loadAnalysis, 'C:\\demo')
  rejects(IPC.loadAnalysis, 'C:\\demo', 'f'.repeat(64), 'extra')
})

test('配置拒绝错误协议、嵌入凭据、畸形 URL 和过量 profiles', () => {
  for (const baseUrl of ['file:///tmp/x', 'ftp://example.com', 'https://user:pass@example.com', 'https://[broken']) {
    rejects(IPC.llmTest, { ...profile, baseUrl })
    rejects(IPC.settingsSave, { profiles: [{ ...profile, baseUrl }], defaultProfileId: profile.id })
  }
  for (const field of ['name', 'model', 'apiKey'] as const) {
    rejects(IPC.settingsSave, { profiles: [{ ...profile, [field]: `${profile[field]}\0` }], defaultProfileId: profile.id })
  }
  rejects(IPC.settingsSave, { profiles: Array.from({ length: MAX_LLM_PROFILES + 1 }, (_, i) => ({ ...profile, id: `p${i}` })), defaultProfileId: null })
})

test('profile protocol accepts both providers, preserves the legacy optional shape, and rejects unknown values', () => {
  assert.doesNotThrow(() => validateIpcArgs(IPC.settingsSave, [{ profiles: [profile], defaultProfileId: profile.id }]))
  for (const protocol of ['openai', 'anthropic']) {
    assert.doesNotThrow(() => validateIpcArgs(IPC.settingsSave, [{ profiles: [{ ...profile, protocol }], defaultProfileId: profile.id }]))
    assert.doesNotThrow(() => validateIpcArgs(IPC.llmTest, [{ ...profile, protocol }]))
  }
  for (const protocol of ['claude', '', null, 3]) {
    rejects(IPC.settingsSave, { profiles: [{ ...profile, protocol }], defaultProfileId: profile.id })
    rejects(IPC.llmListModels, { ...profile, protocol })
  }
})

test('token capacity settings accept bounded values and reject invalid pairs', () => {
  assert.doesNotThrow(() => validateIpcArgs(IPC.settingsSave, [{ profiles: [{ ...profile, contextWindowTokens: 8192, maxOutputTokens: 2048 }], defaultProfileId: profile.id }]))
  for (const fields of [{ contextWindowTokens: 4095 }, { contextWindowTokens: 2097153 }, { maxOutputTokens: 255 }, { maxOutputTokens: 393217 }, { contextWindowTokens: 4096, maxOutputTokens: 4096 }, { contextWindowTokens: 4096.5 }]) {
    rejects(IPC.settingsSave, { profiles: [{ ...profile, ...fields }], defaultProfileId: profile.id })
  }
})

test('settingsSave 接受共享数量上限且继续拒绝超过上限的直接调用', () => {
  const profiles = Array.from({ length: MAX_LLM_PROFILES }, (_, index) => ({ ...profile, id: `limit-${index}` }))
  assert.doesNotThrow(() => validateIpcArgs(IPC.settingsSave, [{ profiles, defaultProfileId: profiles[0].id }]))
  rejects(IPC.settingsSave, { profiles: [...profiles, { ...profile, id: 'limit-overflow' }], defaultProfileId: profiles[0].id })
})

test('profile 与 explain IPC 使用共享上限，并接受每个字段的合法边界', () => {
  const maximumProfile = {
    ...profile,
    id: 'i'.repeat(LLM_PROFILE_LIMITS.id),
    name: 'n'.repeat(LLM_PROFILE_LIMITS.name),
    model: 'm'.repeat(LLM_PROFILE_LIMITS.model),
    apiKey: 'k'.repeat(LLM_PROFILE_LIMITS.apiKey),
    baseUrl: `https://example.com/${'x'.repeat(LLM_PROFILE_LIMITS.baseUrl - 'https://example.com/'.length)}`
  }
  assert.doesNotThrow(() => validateIpcArgs(IPC.llmTest, [maximumProfile]))
  rejects(IPC.llmTest, { ...maximumProfile, id: `${maximumProfile.id}x` })
  rejects(IPC.llmTest, { ...maximumProfile, name: `${maximumProfile.name}x` })
  rejects(IPC.llmTest, { ...maximumProfile, model: `${maximumProfile.model}x` })
  rejects(IPC.llmTest, { ...maximumProfile, apiKey: `${maximumProfile.apiKey}x` })
  rejects(IPC.llmTest, { ...maximumProfile, baseUrl: `${maximumProfile.baseUrl}x` })

  const maximumSettingsProfile = { ...maximumProfile, baseUrl: `https://example.com/${'x'.repeat(LLM_PROFILE_LIMITS.baseUrl - 'https://example.com/'.length)}` }
  assert.doesNotThrow(() => validateIpcArgs(IPC.settingsSave, [{ profiles: [maximumSettingsProfile], defaultProfileId: maximumSettingsProfile.id }]))
  const maximumHttpProfile = {
    ...maximumSettingsProfile,
    baseUrl: `http://example.com/${'x'.repeat(LLM_PROFILE_LIMITS.baseUrl - 'http://example.com/'.length)}`
  }
  assert.doesNotThrow(() => validateIpcArgs(IPC.settingsSave, [{ profiles: [maximumHttpProfile], defaultProfileId: maximumHttpProfile.id }]))
  for (const field of ['name', 'model', 'apiKey'] as const) {
    rejects(IPC.settingsSave, { profiles: [{ ...maximumSettingsProfile, [field]: `${maximumSettingsProfile[field]}x` }], defaultProfileId: maximumSettingsProfile.id })
  }
  const tooLongSettingsUrl = `https://example.com/${'x'.repeat(LLM_PROFILE_LIMITS.baseUrl - 'https://example.com/'.length + 1)}`
  rejects(IPC.settingsSave, { profiles: [{ ...maximumSettingsProfile, baseUrl: tooLongSettingsUrl }], defaultProfileId: maximumSettingsProfile.id })

  const request = {
    requestId,
    term: 't'.repeat(EXPLAIN_CONTEXT_LIMITS.term),
    profileId: 'p'.repeat(EXPLAIN_CONTEXT_LIMITS.profileId),
    projectSummary: 's'.repeat(EXPLAIN_CONTEXT_LIMITS.projectSummary),
    question: 'q'.repeat(EXPLAIN_CONTEXT_LIMITS.question),
    snippet: 'n'.repeat(EXPLAIN_CONTEXT_LIMITS.snippet),
    glossaryHint: 'g'.repeat(EXPLAIN_CONTEXT_LIMITS.glossaryHint)
  }
  assert.doesNotThrow(() => validateIpcArgs(IPC.explainStart, [request]))
  for (const [field, max] of Object.entries(EXPLAIN_CONTEXT_LIMITS)) {
    if (field === 'profileId') continue
    rejects(IPC.explainStart, { ...request, [field]: `${'x'.repeat(max)}x` })
  }
  rejects(IPC.explainStart, { ...request, profileId: `${request.profileId}x` })
})

test('settingsSave 的扫描上限契约接受旧形状、partial 与边界整数并拒绝非法值', () => {
  const save = (scanLimits?: unknown) => validateIpcArgs(IPC.settingsSave, [
    scanLimits === undefined
      ? { profiles: [profile], defaultProfileId: 'p1' }
      : { profiles: [profile], defaultProfileId: 'p1', scanLimits }
  ])

  assert.doesNotThrow(() => save(), '旧版 Settings 形状保持兼容')
  assert.doesNotThrow(() => save({}))
  assert.doesNotThrow(() => save({ maxFiles: 42 }), '合法 partial 设置应可保存')
  assert.doesNotThrow(() => save({
    maxFiles: SCAN_LIMIT_BOUNDS.maxFiles.min,
    maxTreeNodes: SCAN_LIMIT_BOUNDS.maxTreeNodes.max,
    maxContentFileBytes: SCAN_LIMIT_BOUNDS.maxContentFileBytes.min
  }))
  assert.doesNotThrow(() => save({
    maxFiles: SCAN_LIMIT_BOUNDS.maxFiles.max,
    maxTreeNodes: SCAN_LIMIT_BOUNDS.maxTreeNodes.min,
    maxContentFileBytes: SCAN_LIMIT_BOUNDS.maxContentFileBytes.max
  }))

  for (const invalid of [
    { maxFiles: '10' }, { maxFiles: 1.5 }, { maxFiles: Number.NaN }, { maxFiles: Number.POSITIVE_INFINITY },
    { maxFiles: SCAN_LIMIT_BOUNDS.maxFiles.min - 1 }, { maxFiles: SCAN_LIMIT_BOUNDS.maxFiles.max + 1 },
    { maxTreeNodes: '10' }, { maxTreeNodes: 1.5 }, { maxTreeNodes: Number.NaN }, { maxTreeNodes: Number.NEGATIVE_INFINITY },
    { maxTreeNodes: SCAN_LIMIT_BOUNDS.maxTreeNodes.min - 1 }, { maxTreeNodes: SCAN_LIMIT_BOUNDS.maxTreeNodes.max + 1 },
    { maxContentFileBytes: '1024' }, { maxContentFileBytes: 1.5 }, { maxContentFileBytes: Number.NaN }, { maxContentFileBytes: Number.POSITIVE_INFINITY },
    { maxContentFileBytes: SCAN_LIMIT_BOUNDS.maxContentFileBytes.min - 1 },
    { maxContentFileBytes: SCAN_LIMIT_BOUNDS.maxContentFileBytes.max + 1 },
    null, [], 'invalid', { extra: 1 }
  ]) {
    rejects(IPC.settingsSave, { profiles: [profile], defaultProfileId: 'p1', scanLimits: invalid })
  }
})

test('闭合输入对象拒绝额外或循环字段，requestId 仅接受 UUID', () => {
  const oversized = { ...profile, extra: 'x'.repeat(2_000_000) }
  rejects(IPC.llmTest, oversized)
  const cyclic: Record<string, unknown> = { ...profile }
  cyclic.extra = cyclic
  rejects(IPC.settingsSave, { profiles: [cyclic], defaultProfileId: 'p1' })
  rejects(IPC.generateRun, { projectPath: 'C:\\demo', granularity: 'fine', roleFocus: 'general', profileId: 'p1', injected: true })
  rejects(IPC.generateRun, { projectPath: 'C:\\demo', granularity: 'fine', roleFocus: 'general', profileId: 'p1' })
  rejects(IPC.generateRun, { projectPath: 'C:\\demo', granularity: 'fine', roleFocus: 'general', profileId: 'p1', runId: 'not-a-uuid' })
  rejects(IPC.generateRun, { projectPath: 'C:\\demo', granularity: 'fine', roleFocus: 'general', profileId: 'p1', runId: `${requestId} ` })
  rejects(IPC.generateCancel)
  rejects(IPC.generateCancel, 'not-a-uuid')
  rejects(IPC.generateCancel, requestId, 'extra')
  rejects(IPC.explainStart, { requestId: 'r1\nforged', term: 'IPC', profileId: 'p1', projectSummary: '', question: '问题', snippet: '' })
  rejects(IPC.explainCancel, ['r1\0'])
})

test('导出时间必须有效，项目名不能成为路径或携带控制字符', () => {
  rejects(IPC.exportMarkdown, [{ ...result, createdAt: 'not-a-date' }])
  rejects(IPC.exportMarkdown, [{ ...result, projectName: '..\\outside' }])
  rejects(IPC.exportMarkdown, [{ ...result, projectName: 'demo\nname' }])
})

test('存储诊断与恢复 IPC 只接受固定诊断 ID，不接受路径或额外参数', () => {
  assert.doesNotThrow(() => validateIpcArgs(IPC.storageDiagnostics, []))
  for (const id of ['settings', 'recent', `result:${'0'.repeat(40)}`]) {
    assert.doesNotThrow(() => validateIpcArgs(IPC.storageRecover, [id]))
  }
  for (const id of [
    '', 'C:\\Users\\me\\settings.json', 'result:ABC', `result:${'a'.repeat(39)}`,
    `result:${'g'.repeat(40)}`, 'result:../settings', 'settings.json', null, { id: 'settings' }
  ]) rejects(IPC.storageRecover, id)
  rejects(IPC.storageDiagnostics, 'extra')
  rejects(IPC.storageRecover)
  rejects(IPC.storageRecover, 'settings', 'extra')
})

test('InterviewResult 所有对象闭合，兼容旧结果与新增 security 摘要', () => {
  assert.doesNotThrow(() => validateIpcArgs(IPC.exportMarkdown, [result]))
  const secured = { ...result, security: { excludedFiles: 2, redactedFiles: 1, redactionMatches: 3, categories: { credentials: 3 } } }
  assert.doesNotThrow(() => validateIpcArgs(IPC.exportMarkdown, [secured]))
  const invalid = [
    { ...result, extra: true },
    { ...result, sections: [{ ...result.sections[0], extra: true }] },
    { ...result, sections: [{ ...result.sections[0], questions: [{ ...result.sections[0].questions[0], extra: true }] }] },
    { ...result, sections: [{ ...result.sections[0], questions: [{ ...result.sections[0].questions[0], followUps: [{ question: 'q', answer: '', extra: true }] }] }] },
    { ...result, glossary: Object.assign({ IPC: '进程间通信' }, { extra: { token: 'x' } }) },
    { ...result, security: { ...secured.security, extra: true } },
    { ...result, security: { ...secured.security, excludedFiles: 1.5 } },
    { ...result, security: { ...secured.security, redactedFiles: -1 } },
    { ...result, security: { ...secured.security, categories: { credentials: Infinity } } }
  ]
  for (const value of invalid) rejects(IPC.exportMarkdown, value)

  const inherited = Object.assign(Object.create({ extra: true }), result)
  rejects(IPC.exportMarkdown, inherited)
  const arrayWithExtra = Object.assign([...result.sections], { extra: true })
  rejects(IPC.exportMarkdown, { ...result, sections: arrayWithExtra })
})

test('拒绝循环、深层与巨大对象且错误不含用户输入', () => {
  const cyclic: Record<string, unknown> = { ...result }
  cyclic.self = cyclic
  let error: unknown
  try { validateIpcArgs(IPC.exportMarkdown, [cyclic]) } catch (e) { error = e }
  assert.ok(error instanceof IpcValidationError)
  assert.equal((error as Error).message.includes('demo'), false)
  const huge = { ...result, projectSummary: 's'.repeat(1_000_001) }
  assert.throws(() => validateIpcArgs(IPC.exportMarkdown, [huge]), IpcValidationError)
  const broad = { ...result, sections: Array.from({ length: 20_001 }, () => null) }
  assert.throws(() => validateIpcArgs(IPC.exportMarkdown, [broad]), IpcValidationError)
})
