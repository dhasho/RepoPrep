const { contextBridge } = require('electron')

const listeners = new Set()
const calls = { explains: [], cancels: [] }
const lifecycle = { subscriptions: 0, unsubscriptions: 0, transitions: [] }
let pending = new Map()
let lastRequestId = ''

contextBridge.exposeInMainWorld('api', {
  explain(request) {
    calls.explains.push(request.requestId)
    lastRequestId = request.requestId
    return new Promise((resolve) => pending.set(request.requestId, resolve))
  },
  cancelExplain(requestId) {
    calls.cancels.push(requestId)
    pending.get(requestId)?.()
    pending.delete(requestId)
  },
  onExplainEvent(callback) {
    lifecycle.subscriptions++
    listeners.add(callback)
    return () => { lifecycle.unsubscriptions++; listeners.delete(callback) }
  }
})

contextBridge.exposeInMainWorld('nativeTest', {
  state() {
    return { explains: [...calls.explains], cancels: [...calls.cancels], pending: [...pending.keys()], lastRequestId,
      subscriptions: lifecycle.subscriptions, unsubscriptions: lifecycle.unsubscriptions, transitions: [...lifecycle.transitions] }
  },
  async pushDelta(text) {
    for (const callback of listeners) callback({ type: 'delta', requestId: lastRequestId, data: text })
  },
  async resetScenario(kind) {
    if (kind === 'stream') {
      window.dispatchEvent(new CustomEvent('native-test-scenario', { detail: 'close', bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 80))
      const beforeReset = { explains: [...calls.explains], cancels: [...calls.cancels], pending: [...pending.keys()],
        subscriptions: lifecycle.subscriptions, unsubscriptions: lifecycle.unsubscriptions }
      if (beforeReset.explains.length !== 1 || beforeReset.cancels.length !== 1 ||
          beforeReset.cancels[0] !== beforeReset.explains[0] || beforeReset.pending.length !== 0 ||
          beforeReset.unsubscriptions !== 1) throw new Error(`old component cleanup did not cancel/unsubscribe exactly once: ${JSON.stringify(beforeReset)}`)
      lifecycle.transitions.push({ beforeReset })
      calls.explains = []
      calls.cancels = []
      pending = new Map()
      lastRequestId = ''
      lifecycle.subscriptions = 0
      lifecycle.unsubscriptions = 0
    }
    window.dispatchEvent(new CustomEvent('native-test-scenario', { detail: kind, bubbles: true }))
  }
})
