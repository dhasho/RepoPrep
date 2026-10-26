import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore TS5097 -- direct Node tests need explicit TypeScript extensions.
import { resolveTermDefinition } from './term-glossary.ts'

test('built-in terms provide two concrete sentences and aliases resolve exactly', () => {
  const electron = resolveTermDefinition('Electron', 'generated')
  assert.ok(electron)
  assert.equal((electron.match(/。/g) ?? []).length, 2)
  assert.match(electron, /桌面应用/)
  assert.match(electron, /主进程/)
  assert.equal(resolveTermDefinition('TS'), resolveTermDefinition('TypeScript'))
  assert.equal(resolveTermDefinition('JS'), resolveTermDefinition('JavaScript'))
  assert.equal(resolveTermDefinition('IPC'), resolveTermDefinition(' IPC '))
  for (const term of ['几何平均', '最大余数法', 'safeStorage', 'Linux']) {
    const definition = resolveTermDefinition(term)
    assert.ok(definition)
    assert.equal((definition.match(/。/g) ?? []).length, 2)
  }
})

test('custom definitions are trimmed and unknown or prototype-named terms are safe', () => {
  assert.equal(resolveTermDefinition('ProjectWidget', '  project-specific fact  '), 'project-specific fact')
  assert.equal(resolveTermDefinition('ProjectWidget', '  '), undefined)
  assert.equal(resolveTermDefinition('ProjectWidget'), undefined)
  assert.equal(resolveTermDefinition('constructor', '  custom constructor meaning  '), 'custom constructor meaning')
  assert.equal(resolveTermDefinition('__proto__', '  safe fallback  '), 'safe fallback')
  assert.equal(resolveTermDefinition('toString'), undefined)
})
