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
import type { LlmProfile, Settings, TestConnectionResult } from '../../shared/types.ts'

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

async function mountSettingsPage(
  settings: Settings,
  saveSettings: (settings: Settings) => Promise<void>
) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' })
  const restoreGlobals = installDomGlobals(dom)
  dom.window.api = {
    saveSettings,
    listModels: async () => ({ ok: true, models: [], message: '' }),
    testLlm: async () => ({ ok: true, message: 'ok' })
  } as unknown as typeof dom.window.api

  const React = require('react') as typeof import('react')
  const { createRoot } = require('react-dom/client') as typeof import('react-dom/client')
  delete require.cache[require.resolve(bundlePath)]
  const SettingsPage = require(bundlePath).default as typeof import('./SettingsPage').default
  const rootElement = dom.window.document.getElementById('root')!
  const root = createRoot(rootElement)
  let savedSettings: Settings | null = null
  let savedCalls = 0
  let backCalls = 0
  const render = (current: Settings) => React.createElement(SettingsPage, {
    settings: current,
    onSaved: (next: Settings) => {
      savedSettings = structuredClone(next)
      savedCalls++
      root.render(render(next))
    },
    onBack: () => { backCalls++ }
  })
  await React.act(async () => root.render(render(settings)))

  return {
    dom,
    React,
    root,
    rootElement,
    get savedSettings() { return savedSettings },
    get savedCalls() { return savedCalls },
    get backCalls() { return backCalls },
    saveButton: () => [...rootElement.querySelectorAll('button')].find((button) => button.textContent?.startsWith('保存'))!,
    limit: (name: string) => rootElement.querySelector<HTMLInputElement>(`#scan-limit-${name}`)!,
    async unmount() {
      await React.act(async () => root.unmount())
      dom.window.close()
      restoreGlobals()
    }
  }
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
    const contentLimit = () => rootElement.querySelector<HTMLInputElement>('#scan-limit-maxContentFileBytes')!
    const saveButton = () => [...rootElement.querySelectorAll('button')].find((button) => button.textContent?.startsWith('保存'))!
    const backButton = () => [...rootElement.querySelectorAll('button')].find((button) => button.textContent?.includes('返回') && !button.textContent?.includes('放弃'))!

    await act(async () => setInput(nameInput(), 'A'))
    for (const digit of ['1', '0', '2', '4']) {
      const currentValue = contentLimit().value
      await act(async () => setInput(contentLimit(), currentValue + digit))
      assert.equal(contentLimit().value, currentValue + digit, '输入草稿应保留每次键入的原文')
    }
    await act(async () => saveButton().click())
    assert.equal(saves.length, 1)
    assert.equal(saves[0].settings.scanLimits?.maxContentFileBytes, 1024)
    assert.equal(saveButton().disabled, true, '保存进行中按钮应禁用')
    await act(async () => saveButton().click())
    await act(async () => setInput(nameInput(), 'B'))
    await act(async () => setInput(contentLimit(), '1'))
    assert.equal(saves.length, 1, '保存进行中再次点击不能重复提交')

    await act(async () => {
      saves[0].control.resolve()
      await saves[0].promise
    })
    assert.equal(saves[0].settings.profiles[0].name, 'A')
    assert.equal(parentSettings.profiles[0].name, 'A', '成功写盘的快照应回调给父组件')
    assert.equal(nameInput().value, 'B', '保存窗口中新编辑的草稿应继续显示')
    assert.equal(contentLimit().value, '1', '父组件收到已保存快照后不应覆盖未完成的输入')
    assert.match(saveButton().textContent ?? '', /\*$/, '新草稿仍应标记未保存')
    assert.equal(rootElement.textContent?.includes('✓ 已保存'), false)
    await act(async () => backButton().click())
    assert.equal(rootElement.textContent?.includes('有未保存的修改'), true, '返回应要求确认未保存修改')

    let callsBeforeInvalidSave = saves.length
    await act(async () => saveButton().click())
    assert.equal(saves.length, callsBeforeInvalidSave, '未失焦的非法值也必须阻止保存')
    assert.equal(rootElement.querySelector('#scan-limit-maxContentFileBytes-error')?.textContent?.includes('1024'), true)
    await act(async () => setInput(contentLimit(), '1024'))
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

test('SettingsPage validates blurred scan limits, converts boundary values, and clears one override', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' })
  const restoreGlobals = installDomGlobals(dom)
  const saves: Settings[] = []
  dom.window.api = {
    saveSettings: async (settings: Settings) => { saves.push(structuredClone(settings)) },
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
    const initial: Settings = {
      ...initialSettings,
      scanLimits: { maxFiles: 100, maxTreeNodes: 200, maxContentFileBytes: 2048 }
    }
    let savedCalls = 0
    await React.act(async () => root!.render(React.createElement(SettingsPage, {
      settings: initial, onSaved: () => { savedCalls++ }, onBack: () => {}
    })))
    const field = (name: string) => rootElement.querySelector<HTMLInputElement>(`#scan-limit-${name}`)!
    const saveButton = () => [...rootElement.querySelectorAll('button')].find((button) => button.textContent?.startsWith('保存'))!

    await React.act(async () => {
      const input = field('maxContentFileBytes')
      input.focus()
      setInput(input, '0')
      input.blur()
    })
    assert.equal(field('maxContentFileBytes').value, '0', '失焦验证不得改写原始输入')
    assert.equal(field('maxContentFileBytes').getAttribute('aria-invalid'), 'true')
    assert.match(rootElement.querySelector('#scan-limit-maxContentFileBytes-error')?.textContent ?? '', /1024/)
    await React.act(async () => saveButton().click())
    assert.equal(saves.length, 0, '非法上限应阻止 IPC 保存')
    assert.equal(savedCalls, 0, '非法上限应阻止 onSaved')

    await React.act(async () => {
      setInput(field('maxFiles'), '1')
      setInput(field('maxTreeNodes'), '10000')
      setInput(field('maxContentFileBytes'), '524288')
    })
    await React.act(async () => saveButton().click())
    assert.equal(saves.length, 1)
    assert.deepEqual(saves[0].scanLimits, { maxFiles: 1, maxTreeNodes: 10000, maxContentFileBytes: 524288 })
    assert.equal(savedCalls, 1)

    await React.act(async () => setInput(field('maxFiles'), ''))
    await React.act(async () => saveButton().click())
    assert.equal(saves.length, 2)
    assert.equal(Object.hasOwn(saves[1].scanLimits ?? {}, 'maxFiles'), false, '清空覆盖项应省略该字段')
    assert.equal(saves[1].scanLimits?.maxTreeNodes, 10000, '清空一项应保留其他覆盖项')
    assert.equal(saves[1].scanLimits?.maxContentFileBytes, 524288)
    assert.equal(savedCalls, 2)
  } finally {
    if (root) {
      const React = require('react') as typeof import('react')
      await React.act(async () => root!.unmount())
    }
    dom.window.close()
    restoreGlobals()
  }
})

test('SettingsPage saves deletion of the only profile, reads back an empty store, and remounts without a draft', async () => {
  const initial: Settings = {
    profiles: [{ ...initialSettings.profiles[0], apiKey: 'synthetic-issue-68-key' }],
    defaultProfileId: 'profile-1',
    scanLimits: { maxFiles: 120, maxTreeNodes: 240, maxContentFileBytes: 4096 }
  }
  let backend = structuredClone(initial)
  const pending = deferred()
  let submitted: Settings | null = null
  const saveSettings = async (next: Settings) => {
    submitted = structuredClone(next)
    await pending.promise
    backend = structuredClone(next)
  }
  const page = await mountSettingsPage(initial, saveSettings)
  try {
    const deleteButton = [...page.rootElement.querySelectorAll('button')].find((button) => button.textContent?.trim() === '删除')!
    await page.React.act(async () => deleteButton.click())
    assert.equal(page.rootElement.textContent?.includes('Original'), false)
    assert.ok(page.saveButton(), 'the Settings-level save control should remain available without a profile')
    assert.deepEqual(backend, initial, 'deleting is a local draft until the save succeeds')

    await page.React.act(async () => page.saveButton().click())
    assert.equal(page.saveButton().disabled, true)
    assert.equal(page.saveButton().textContent, '保存中…')
    assert.equal(backend.profiles[0].apiKey, 'synthetic-issue-68-key', 'the backend remains unchanged while IPC is pending')
    pending.resolve()
    await page.React.act(async () => pending.promise)

    assert.deepEqual(submitted, {
      profiles: [],
      defaultProfileId: null,
      scanLimits: { maxFiles: 120, maxTreeNodes: 240, maxContentFileBytes: 4096 }
    })
    assert.deepEqual(backend, submitted, 'readback after IPC success should contain the empty profile list and valid limits')
    assert.equal(JSON.stringify(backend).includes('synthetic-issue-68-key'), false)
    assert.deepEqual(page.savedSettings, backend)
    assert.equal(page.savedCalls, 1)
  } finally {
    await page.unmount()
  }

  const remounted = await mountSettingsPage(backend, async () => {})
  try {
    assert.equal(remounted.rootElement.textContent?.includes('Original'), false)
    assert.equal(remounted.rootElement.querySelector('input[placeholder="如：DeepSeek 日常用"]'), null,
      'remounting legitimately empty settings must not create an implicit profile draft')
    assert.ok(remounted.saveButton(), 'the global save control remains present for empty settings')
    assert.equal(remounted.savedCalls, 0)
  } finally {
    await remounted.unmount()
  }
})

test('SettingsPage normalizes the default after deleting the selected default among multiple profiles', async () => {
  const initial: Settings = {
    profiles: [
      { ...initialSettings.profiles[0], id: 'first', name: 'First', apiKey: '' },
      { ...initialSettings.profiles[0], id: 'second', name: 'Second', apiKey: '' },
      { ...initialSettings.profiles[0], id: 'third', name: 'Third', apiKey: '' }
    ],
    defaultProfileId: 'first'
  }
  const writes: Settings[] = []
  const page = await mountSettingsPage(initial, async (next) => { writes.push(structuredClone(next)) })
  try {
    const deleteButton = [...page.rootElement.querySelectorAll('button')].find((button) => button.textContent?.trim() === '删除')!
    await page.React.act(async () => deleteButton.click())
    await page.React.act(async () => page.saveButton().click())

    assert.equal(writes.length, 1)
    assert.deepEqual(writes[0].profiles.map((profile) => profile.id), ['second', 'third'])
    assert.equal(writes[0].defaultProfileId, 'second', 'deleting the default should select a surviving profile as default')
    assert.deepEqual(page.savedSettings, writes[0])
  } finally {
    await page.unmount()
  }
})

function deferredConnection() {
  let resolve!: (result: TestConnectionResult) => void
  let reject!: (error: Error) => void
  const promise = new Promise<TestConnectionResult>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function mountConnectionSettingsPage(settings: Settings) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' })
  const restoreGlobals = installDomGlobals(dom)
  const requests: Array<{ profile: LlmProfile; pending: ReturnType<typeof deferredConnection> }> = []
  dom.window.api = {
    saveSettings: async () => {},
    listModels: async () => ({ ok: true, models: [], message: '' }),
    testLlm(profile: LlmProfile) {
      const pending = deferredConnection()
      requests.push({ profile: structuredClone(profile), pending })
      return pending.promise
    }
  } as unknown as typeof dom.window.api

  const React = require('react') as typeof import('react')
  const { createRoot } = require('react-dom/client') as typeof import('react-dom/client')
  delete require.cache[require.resolve(bundlePath)]
  const SettingsPage = require(bundlePath).default as typeof import('./SettingsPage').default
  const rootElement = dom.window.document.getElementById('root')!
  const root = createRoot(rootElement)
  await React.act(async () => root.render(React.createElement(SettingsPage, {
    settings,
    onSaved: () => {},
    onBack: () => {}
  })))

  return {
    React,
    root,
    rootElement,
    requests,
    testButton: () => [...rootElement.querySelectorAll('button')].find((button) =>
      button.textContent?.trim() === '测试连接' || button.textContent?.trim() === '测试中…')!,
    async unmount() {
      await React.act(async () => root.unmount())
      dom.window.close()
      restoreGlobals()
    }
  }
}

test('SettingsPage ignores a late result from A after selection moves to B and shows B result', async () => {
  const settings: Settings = {
    profiles: [
      { ...initialSettings.profiles[0], id: 'A', name: 'Profile A', apiKey: 'synthetic-A-secret' },
      { ...initialSettings.profiles[0], id: 'B', name: 'Profile B', apiKey: 'synthetic-B-secret' }
    ],
    defaultProfileId: 'A'
  }
  const page = await mountConnectionSettingsPage(settings)
  try {
    await page.React.act(async () => page.testButton().click())
    assert.equal(page.requests.length, 1)
    assert.equal(page.requests[0].profile.id, 'A')
    assert.equal(page.testButton().textContent?.trim(), '测试中…')

    const profileB = [...page.rootElement.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Profile B'))!
    await page.React.act(async () => profileB.click())
    assert.equal(page.testButton().textContent?.trim(), '测试连接', 'selecting B should release A loading state')
    await page.React.act(async () => page.testButton().click())
    assert.equal(page.requests.length, 2)
    assert.equal(page.requests[1].profile.id, 'B')
    assert.equal(page.testButton().textContent?.trim(), '测试中…')

    await page.React.act(async () => {
      page.requests[0].pending.resolve({ ok: true, message: 'late A success' })
      await page.requests[0].pending.promise
    })
    assert.equal(page.testButton().textContent?.trim(), '测试中…', 'A finally must not clear B loading')
    assert.equal(page.rootElement.textContent?.includes('late A success'), false)

    await page.React.act(async () => {
      page.requests[1].pending.resolve({ ok: true, message: 'B connected' })
      await page.requests[1].pending.promise
    })
    assert.equal(page.rootElement.textContent?.includes('B connected'), true)
    assert.equal(page.rootElement.textContent?.includes('late A success'), false)
  } finally {
    await page.unmount()
  }
})

test('SettingsPage invalidates in-flight tests for edits to each request configuration field', async () => {
  const edits: Array<{
    field: 'baseUrl' | 'apiKey' | 'model'
    selector: string
    value: string
  }> = [
    { field: 'baseUrl', selector: 'input[placeholder="https://api.deepseek.com/v1"]', value: 'https://edited.invalid/v2' },
    { field: 'apiKey', selector: 'input[type="password"]', value: 'synthetic-edited-key' },
    { field: 'model', selector: 'input[placeholder="deepseek-chat，或点右侧按钮检测"]', value: 'edited-model' }
  ]

  for (const edit of edits) {
    const settings: Settings = {
      profiles: [{ ...initialSettings.profiles[0], id: 'A', apiKey: 'synthetic-A-secret' }],
      defaultProfileId: 'A'
    }
    const page = await mountConnectionSettingsPage(settings)
    try {
      await page.React.act(async () => page.testButton().click())
      assert.equal(page.requests.length, 1)

      const field = page.rootElement.querySelector<HTMLInputElement>(edit.selector)!
      await page.React.act(async () => setInput(field, edit.value))
      await page.React.act(async () => page.testButton().click())
      assert.equal(page.requests.length, 2, `${edit.field} edit should allow a request with the new configuration`)
      assert.equal(page.requests[0].profile[edit.field], settings.profiles[0][edit.field])
      assert.equal(page.requests[1].profile[edit.field], edit.value, `${edit.field} should be captured in the new request`)
      assert.equal(page.testButton().textContent?.trim(), '测试中…')

      await page.React.act(async () => {
        page.requests[0].pending.resolve({ ok: false, message: `stale ${edit.field} failure` })
        await page.requests[0].pending.promise
      })
      assert.equal(page.testButton().textContent?.trim(), '测试中…', 'old finally must not clear the new request loading state')
      assert.equal(page.rootElement.textContent?.includes(`stale ${edit.field} failure`), false,
        'the old result must not be shown against the edited profile')

      await page.React.act(async () => {
        page.requests[1].pending.resolve({ ok: true, message: `edited ${edit.field} connected` })
        await page.requests[1].pending.promise
      })
      assert.equal(page.rootElement.textContent?.includes(`edited ${edit.field} connected`), true)
    } finally {
      await page.unmount()
    }
  }
})

test('SettingsPage ignores a deferred connection response after deleting the only profile', async () => {
  const settings: Settings = {
    profiles: [{ ...initialSettings.profiles[0], id: 'A', apiKey: 'synthetic-A-secret' }],
    defaultProfileId: 'A'
  }
  const page = await mountConnectionSettingsPage(settings)
  try {
    await page.React.act(async () => page.testButton().click())
    assert.equal(page.requests.length, 1)
    const deleteButton = [...page.rootElement.querySelectorAll('button')].find((button) =>
      button.textContent?.trim() === '删除')!
    await page.React.act(async () => deleteButton.click())
    assert.equal([...page.rootElement.querySelectorAll('button')].some((button) =>
      button.textContent?.trim() === '测试连接' || button.textContent?.trim() === '测试中…'), false)
    assert.equal(page.rootElement.textContent?.includes('Profile A'), false)

    await page.React.act(async () => {
      page.requests[0].pending.resolve({ ok: true, message: 'deleted A response' })
      await page.requests[0].pending.promise
    })
    assert.equal(page.rootElement.textContent?.includes('deleted A response'), false)
    assert.equal(page.rootElement.textContent?.includes('deleted A'), false)
  } finally {
    await page.unmount()
  }
})

test('SettingsPage keeps an empty-list draft after a failed save, blocks duplicate retry, and preserves edits made while retry saves', async () => {
  const initial: Settings = {
    profiles: [{ ...initialSettings.profiles[0], apiKey: 'synthetic-issue-68-key' }],
    defaultProfileId: 'profile-1'
  }
  let backend = structuredClone(initial)
  const requests: Array<{ snapshot: Settings; control: ReturnType<typeof deferred> }> = []
  const page = await mountSettingsPage(initial, (next) => {
    const control = deferred()
    requests.push({ snapshot: structuredClone(next), control })
    return control.promise.then(() => { backend = structuredClone(next) })
  })
  try {
    const deleteButton = [...page.rootElement.querySelectorAll('button')].find((button) => button.textContent?.trim() === '删除')!
    await page.React.act(async () => deleteButton.click())
    await page.React.act(async () => page.saveButton().click())
    assert.equal(requests.length, 1)
    await page.React.act(async () => {
      requests[0].control.reject(new Error('保存失败，请重试'))
      await requests[0].control.promise.catch(() => {})
    })

    assert.equal(JSON.stringify(backend).includes('synthetic-issue-68-key'), true, 'a failed save must leave persisted settings intact')
    assert.equal(page.savedCalls, 0, 'onSaved must run only after IPC success')
    assert.match(page.saveButton().textContent ?? '', /\*$/, 'the failed deletion remains a dirty draft')
    assert.equal(page.rootElement.textContent?.includes('✗ 保存失败，请重试'), true, 'the error should remain visible outside the editor')

    await page.React.act(async () => page.saveButton().click())
    assert.equal(requests.length, 2, 'a failed save should be retryable')
    assert.equal(page.saveButton().disabled, true)
    await page.React.act(async () => page.saveButton().click())
    assert.equal(requests.length, 2, 'double-clicking during retry must not issue another IPC write')
    const addButton = [...page.rootElement.querySelectorAll('button')].find((button) => button.textContent?.includes('新增配置'))!
    await page.React.act(async () => addButton.click())
    requests[1].control.resolve()
    await page.React.act(async () => requests[1].control.promise)

    assert.deepEqual(requests[1].snapshot.profiles, [], 'the pending write is the empty-list snapshot')
    assert.deepEqual(backend.profiles, [], 'the successful retry persists only its captured snapshot')
    assert.equal(page.savedCalls, 1)
    assert.match(page.saveButton().textContent ?? '', /\*$/, 'a new profile created while saving remains dirty')
    assert.ok(page.rootElement.querySelector('input[placeholder="如：DeepSeek 日常用"]'), 'the new profile draft should remain visible')
  } finally {
    await page.unmount()
  }
})

test('SettingsPage discard after profile deletion does not write or change persisted settings', async () => {
  const initial: Settings = {
    profiles: [{ ...initialSettings.profiles[0], apiKey: 'synthetic-issue-68-key' }],
    defaultProfileId: 'profile-1'
  }
  let backend = structuredClone(initial)
  let writes = 0
  const page = await mountSettingsPage(initial, async (next) => {
    writes++
    backend = structuredClone(next)
  })
  try {
    const deleteButton = [...page.rootElement.querySelectorAll('button')].find((button) => button.textContent?.trim() === '删除')!
    await page.React.act(async () => deleteButton.click())
    const backButton = [...page.rootElement.querySelectorAll('button')].find((button) => button.textContent?.includes('返回') && !button.textContent?.includes('放弃'))!
    await page.React.act(async () => backButton.click())
    const discardButton = [...page.rootElement.querySelectorAll('button')].find((button) => button.textContent?.includes('放弃修改并返回'))!
    await page.React.act(async () => discardButton.click())

    assert.equal(page.backCalls, 1)
    assert.equal(writes, 0, 'discarding a deletion must not call settings persistence')
    assert.deepEqual(backend, initial)
  } finally {
    await page.unmount()
  }
})
