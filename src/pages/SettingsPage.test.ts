// 真实挂载 SettingsPage，验证保存窗口内编辑、失败与成功反馈。
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import test from 'node:test'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import assert from 'node:assert/strict'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { createRequire } from 'node:module'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import path from 'node:path'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { fileURLToPath } from 'node:url'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import { JSDOM } from 'jsdom'
// @ts-ignore TS5097 -- extension is required by the direct Node test runner.
import type { Settings } from '../../shared/types.ts'

interface Deferred {
  resolve: () => void
  reject: (error: Error) => void
}

const require = createRequire(import.meta.url)
const bundlePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.render-test/settings-page.cjs')
const initialSettings: Settings = {
  profiles: [{
    id: 'profile-1', name: 'Original', baseUrl: 'https://example.com/v1',
    apiKey: '', model: 'model-1', temperature: 0.4
  }],
  defaultProfileId: 'profile-1'
}

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    Event: dom.window.Event,
    IS_REACT_ACT_ENVIRONMENT: true
  }
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  return () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
}

function deferred() {
  let controls!: Deferred
  const promise = new Promise<void>((resolve, reject) => {
    controls = { resolve, reject }
  })
  return { promise, ...controls }
}

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

test('SettingsPage preserves newer edits when an older save completes, then saves the current draft', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost'
  })
  const restoreGlobals = installDomGlobals(dom)

  const saves: Array<{ settings: Settings; control: Deferred; promise: Promise<void> }> = []
  dom.window.api = {
    saveSettings(settings: Settings) {
      const pending = deferred()
      saves.push({ settings: structuredClone(settings), control: pending, promise: pending.promise })
      return pending.promise
    },
    listModels: async () => ({ ok: true, models: [], message: '' }),
    testLlm: async () => ({ ok: true, message: 'ok' })
  } as unknown as typeof dom.window.api

  let root: import('react-dom/client').Root | undefined
  try {
    // ReactDOM reads the DOM globals during its first load, so load it only after jsdom setup.
    const React = require('react') as typeof import('react')
    const { createRoot } = require('react-dom/client') as typeof import('react-dom/client')
    delete require.cache[require.resolve(bundlePath)]
    const SettingsPage = require(bundlePath).default as typeof import('./SettingsPage').default
    const rootElement = dom.window.document.getElementById('root')!
    root = createRoot(rootElement)
    let parentSettings = initialSettings
    let backCalls = 0
    const render = () => React.createElement(SettingsPage, {
      settings: parentSettings,
      onSaved: (next: Settings) => {
        parentSettings = next
        root!.render(render())
      },
      onBack: () => { backCalls++ }
    })
    const act = React.act
    await act(async () => root!.render(render()))

    const nameInput = () => rootElement.querySelector<HTMLInputElement>('input[placeholder="如：DeepSeek 日常用"]')!
    const saveButton = () => [...rootElement.querySelectorAll('button')].find((button) => button.textContent?.startsWith('保存'))!
    const backButton = () => [...rootElement.querySelectorAll('button')].find((button) => button.textContent?.includes('返回') && !button.textContent?.includes('放弃'))!

    await act(async () => setInput(nameInput(), 'A'))
    await act(async () => saveButton().click())
    assert.equal(saves.length, 1)
    assert.equal(saveButton().disabled, true, '保存进行中按钮应禁用')
    await act(async () => saveButton().click())
    await act(async () => setInput(nameInput(), 'B'))
    assert.equal(saves.length, 1, '保存进行中再次点击不能重复提交')

    await act(async () => {
      saves[0].control.resolve()
      await saves[0].promise
    })
    assert.equal(saves[0].settings.profiles[0].name, 'A')
    assert.equal(parentSettings.profiles[0].name, 'A', '成功写盘的快照应回调给父组件')
    assert.equal(nameInput().value, 'B', '保存窗口中新编辑的草稿应继续显示')
    assert.match(saveButton().textContent ?? '', /\*$/, '新草稿仍应标记未保存')
    assert.equal(rootElement.textContent?.includes('✓ 已保存'), false)
    await act(async () => backButton().click())
    assert.equal(rootElement.textContent?.includes('有未保存的修改'), true, '返回应要求确认未保存修改')

    await act(async () => saveButton().click())
    assert.equal(saves.length, 2)
    assert.equal(saves[1].settings.profiles[0].name, 'B')
    await act(async () => {
      saves[1].control.resolve()
      await saves[1].promise
    })
    assert.equal(rootElement.textContent?.includes('✓ 已保存'), true)
    assert.doesNotMatch(saveButton().textContent ?? '', /\*$/)

    // 已成功后再次发起保存，等待期间必须清掉之前的成功提示。
    await act(async () => saveButton().click())
    assert.equal(rootElement.textContent?.includes('✓ 已保存'), false)
    await act(async () => {
      saves[2].control.resolve()
      await saves[2].promise
    })

    assert.equal(backCalls, 0)
  } finally {
    if (root) {
      const React = require('react') as typeof import('react')
      await React.act(async () => root!.unmount())
    }
    dom.window.close()
    restoreGlobals()
  }
})

test('SettingsPage keeps the draft and retry marker after a save failure', async () => {
  // Each test gets fresh DOM globals and a fresh bundle, matching ipc.ts module initialization.
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' })
  const restoreGlobals = installDomGlobals(dom)
  const saves: Array<{ control: Deferred; promise: Promise<void> }> = []
  dom.window.api = {
    saveSettings: () => {
      const pending = deferred()
      saves.push({ control: pending, promise: pending.promise })
      return pending.promise
    },
    listModels: async () => ({ ok: true, models: [], message: '' }),
    testLlm: async () => ({ ok: true, message: 'ok' })
  } as unknown as typeof dom.window.api

  let root: import('react-dom/client').Root | undefined
  try {
    const React = require('react') as typeof import('react')
    const { createRoot } = require('react-dom/client') as typeof import('react-dom/client')
    delete require.cache[require.resolve(bundlePath)]
    const SettingsPage = require(bundlePath).default as typeof import('./SettingsPage').default
    const rootElement = dom.window.document.getElementById('root')!
    root = createRoot(rootElement)
    let savedCalls = 0
    await React.act(async () => root!.render(React.createElement(SettingsPage, {
      settings: initialSettings, onSaved: () => { savedCalls++ }, onBack: () => {}
    })))
    const nameInput = rootElement.querySelector<HTMLInputElement>('input[placeholder="如：DeepSeek 日常用"]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    const saveButton = () => [...rootElement.querySelectorAll('button')].find((button) => button.textContent?.startsWith('保存'))!
    await React.act(async () => {
      setter.call(nameInput, 'Retry me')
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
      nameInput.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await React.act(async () => saveButton().click())
    await React.act(async () => {
      saves[0].control.reject(new Error('保存失败，请重试'))
      await saves[0].promise.catch(() => {})
    })
    assert.equal(nameInput.value, 'Retry me')
    assert.match(saveButton().textContent ?? '', /\*$/)
    assert.equal(rootElement.textContent?.includes('✗ 保存失败，请重试'), true)
    assert.equal(rootElement.textContent?.includes('✓ 已保存'), false)
    assert.equal(savedCalls, 0, '保存失败时不能通知父组件写盘成功')

    await React.act(async () => saveButton().click())
    assert.equal(saves.length, 2, '失败后应允许重试')
    saves[1].control.resolve()
    await React.act(async () => saves[1].promise)
    assert.equal(rootElement.textContent?.includes('✓ 已保存'), true)
  } finally {
    if (root) {
      const React = require('react') as typeof import('react')
      await React.act(async () => root!.unmount())
    }
    dom.window.close()
    restoreGlobals()
  }
})
