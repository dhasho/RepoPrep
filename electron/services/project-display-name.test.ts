// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import test from 'node:test'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import assert from 'node:assert/strict'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { projectDisplayName } from './project-display-name.ts'

test('project display names cover roots, UNC shares, ordinary paths, and trailing separators', () => {
  assert.equal(projectDisplayName('C:\\'), '磁盘 C')
  assert.equal(projectDisplayName('c:/'), '磁盘 C')
  assert.equal(projectDisplayName('/'), '文件系统根目录')
  assert.equal(projectDisplayName('\\\\server\\share\\'), 'share')
  assert.equal(projectDisplayName('/workspace/project/'), 'project')
  assert.equal(projectDisplayName('C:\\workspace\\project\\'), 'project')
})