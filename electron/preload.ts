// preload：向渲染进程暴露类型安全的 window.api（contextIsolation 开启）
import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type ProjectLensApi } from '@shared/ipc'

const api: ProjectLensApi = {
  selectFolder: () => ipcRenderer.invoke(IPC.selectFolder),
  scanProject: (path) => ipcRenderer.invoke(IPC.scanProject, path),
  getRecentProjects: () => ipcRenderer.invoke(IPC.recentProjects),
  removeRecent: (path) => ipcRenderer.invoke(IPC.removeRecent, path),
  loadResult: (projectPath) => ipcRenderer.invoke(IPC.loadResult, projectPath),
  deleteResult: (projectPath) => ipcRenderer.invoke(IPC.deleteResult, projectPath),
  listAnalyses: (projectPath, cursor) => ipcRenderer.invoke(IPC.listAnalyses, projectPath, ...(cursor === undefined ? [] : [cursor])),
  loadAnalysis: (projectPath, analysisId) => ipcRenderer.invoke(IPC.loadAnalysis, projectPath, analysisId),
  generate: (request) => ipcRenderer.invoke(IPC.generateRun, request),
  cancelGenerate: (runId) => ipcRenderer.invoke(IPC.generateCancel, runId),
  onGenerateProgress: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, p: Parameters<typeof cb>[0]): void => cb(p)
    ipcRenderer.on(IPC.generateProgress, listener)
    return () => ipcRenderer.removeListener(IPC.generateProgress, listener)
  },
  explain: (req) => ipcRenderer.invoke(IPC.explainStart, req),
  cancelExplain: (requestId) => ipcRenderer.invoke(IPC.explainCancel, requestId),
  onExplainEvent: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: Parameters<typeof cb>[0]): void => cb(ev)
    ipcRenderer.on(IPC.explainEvent, listener)
    return () => ipcRenderer.removeListener(IPC.explainEvent, listener)
  },
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  saveSettings: (settings) => ipcRenderer.invoke(IPC.settingsSave, settings),
  testLlm: (profile) => ipcRenderer.invoke(IPC.llmTest, profile),
  listModels: (profile) => ipcRenderer.invoke(IPC.llmListModels, profile),
  exportMarkdown: (result) => ipcRenderer.invoke(IPC.exportMarkdown, result),
  getStorageDiagnostics: () => ipcRenderer.invoke(IPC.storageDiagnostics),
  recoverStorage: (id) => ipcRenderer.invoke(IPC.storageRecover, id)
}

contextBridge.exposeInMainWorld('api', api)
