const { contextBridge } = require('electron')

const pathA = 'C:\\Fixture\\ProjectA'
const pathB = 'C:\\Fixture\\ProjectB'
const makeResult = (projectPath, identity) => ({
  version: 1,
  createdAt: '2026-10-11T00:00:00.000Z',
  projectName: projectPath.split('\\').at(-1),
  projectPath,
  granularity: 'medium',
  roleFocus: 'general',
  profileId: identity === 'A' ? 'profile-A' : 'profile-B',
  modelUsed: `model-${identity}`,
  projectSummary: `SUMMARY_${identity}`,
  sections: [{ id: `s-${identity}`, title: `${identity} section`, questions: [{
    id: `q-${identity}`, question: `QUESTION_${identity} [[TERM_${identity}]]`,
    answer: `ANSWER_${identity} TERM_${identity} context. ${'报告段落随分栏宽度自动换行，并保留原有文字和缩进。'.repeat(16)}`, followUps: []
  }] }],
  glossary: { [`TERM_${identity}`]: `GLOSSARY_${identity}` }
})

const resultA = makeResult(pathA, 'A')
const resultB = makeResult(pathB, 'B')
const generationRequests = []
const explainRequests = []
const generationCancels = []
const explainCancels = []
const progressListeners = new Set()
const explainListeners = new Set()
const staleExplainCallbacks = new Map()
let resolveB
let explainCallback
let lateEventEvidence = []

contextBridge.exposeInMainWorld('api', {
  selectFolder: async () => pathB,
  scanProject: async (projectPath) => ({
    root: projectPath, storagePath: projectPath, name: projectPath.split('\\').at(-1),
    totalFiles: 1, totalBytes: 4, languages: [],
    tree: { name: 'root', path: '.', type: 'dir', children: [] }, keyFiles: [],
    security: { excludedFiles: 0, redactedFiles: 0, redactionMatches: 0, categories: {} }
  }),
  getRecentProjects: async () => [{ path: pathA, name: 'ProjectA', lastUsedAt: '2026-10-11T00:00:00.000Z' }],
  loadResult: async (projectPath) => projectPath === pathA ? resultA : null,
  listAnalyses: async (projectPath) => ({ items: projectPath === pathA ? [{
    id: 'analysis-A', createdAt: resultA.createdAt, granularity: resultA.granularity, roleFocus: resultA.roleFocus
  }] : [], nextCursor: null }),
  loadAnalysis: async (projectPath, analysisId) => projectPath === pathA && analysisId === 'analysis-A' ? resultA : null,
  removeRecent: async () => {},
  deleteResult: async () => {},
  getSettings: async () => ({ profiles: [
    { id: 'profile-A', name: 'Profile A', baseUrl: 'https://a.invalid/v1', apiKey: '', model: 'model-A' },
    { id: 'profile-B', name: 'Profile B', baseUrl: 'https://b.invalid/v1', apiKey: '', model: 'model-B' }
  ], defaultProfileId: 'profile-B' }),
  getStorageDiagnostics: async () => [],
  recoverStorage: async () => {},
  saveSettings: async () => {},
  testLlm: async () => ({ ok: true, message: 'mock' }),
  listModels: async () => ({ ok: true, models: [], message: 'mock' }),
  exportMarkdown: async () => ({ ok: true, message: 'mock' }),
  generate(request) {
    generationRequests.push(request)
    return new Promise((resolve) => { resolveB = () => resolve({ runId: request.runId, result: resultB }) })
  },
  cancelGenerate(runId) { generationCancels.push(runId) },
  onGenerateProgress(callback) { progressListeners.add(callback); return () => progressListeners.delete(callback) },
  explain(request) {
    explainRequests.push(request)
    if (explainCallback) staleExplainCallbacks.set(request.requestId, explainCallback)
    return new Promise(() => {})
  },
  cancelExplain(requestId) { explainCancels.push(requestId) },
  onExplainEvent(callback) {
    explainListeners.add(callback)
    explainCallback = callback
    return () => { explainListeners.delete(callback); if (explainCallback === callback) explainCallback = undefined }
  }
})

contextBridge.exposeInMainWorld('nativeControl', {
  state() {
    return {
      generationRequests: [...generationRequests], explainRequests: [...explainRequests],
      generationCancels: [...generationCancels], explainCancels: [...explainCancels],
      pendingB: Boolean(resolveB), lateEventEvidence: [...lateEventEvidence]
    }
  },
  completeB() { if (!resolveB) throw new Error('B generation has not started'); resolveB(); resolveB = undefined },
  currentDelta(text) {
    const request = explainRequests.at(-1)
    if (!request) throw new Error('No explanation request')
    for (const callback of explainListeners) callback({ type: 'delta', requestId: request.requestId, data: text })
  },
  lateAEvents(requestId) {
    const events = [
      { type: 'delta', requestId, data: 'LATE_A_DELTA' },
      { type: 'done', requestId, data: '' },
      { type: 'error', requestId, data: 'LATE_A_ERROR' }
    ]
    const stale = staleExplainCallbacks.get(requestId)
    lateEventEvidence = []
    for (const event of events) {
      stale?.(event)
      const activeCount = explainListeners.size
      for (const callback of explainListeners) callback(event)
      lateEventEvidence.push({ type: event.type, requestId, activeListenerCount: activeCount, broadcast: true, data: event.data })
    }
  }
})
