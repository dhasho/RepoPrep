import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { CODE_EXTS, isContentPolicyExcluded, isLockfilePath, LANGUAGE_BY_EXT } from './project-file-policy.ts'

test('language statistics and fine selection share the source, style, and markup classifications', () => {
  for (const ext of CODE_EXTS) {
    assert.ok(LANGUAGE_BY_EXT[ext], `${ext} must have a scanner language classification`)
  }
  for (const ext of ['hh', 'm', 'mm', 'r', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'css', 'html', 'xml']) {
    assert.ok(CODE_EXTS.has(ext), `${ext} must be eligible for fine context`)
  }
  for (const ext of ['json', 'jsonc', 'md', 'mdx', 'yaml', 'yml', 'toml']) {
    assert.ok(LANGUAGE_BY_EXT[ext], `${ext} should remain visible in language statistics`)
    assert.ok(!CODE_EXTS.has(ext), `${ext} is data/configuration/documentation, not source code`)
  }
})

test('lockfile exclusion matches names case-insensitively in nested Windows or POSIX paths', () => {
  const locks = [
    'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'pnpm-lock.yml', 'yarn.lock',
    'bun.lock', 'bun.lockb', 'Cargo.lock', 'poetry.lock', 'Pipfile.lock', 'uv.lock', 'composer.lock',
    'Gemfile.lock', 'go.sum', 'packages.lock.json', 'gradle.lockfile'
  ]
  for (const name of locks) {
    assert.ok(isLockfilePath(`nested\\vendor\\${name}`), `${name} should match a nested Windows path`)
    assert.ok(isContentPolicyExcluded(`nested/${name}`), `${name} body should be excluded`)
  }
  for (const name of ['custom.lock', 'app-lock.js', 'bundle.min.js', 'bundle.map', 'image.PNG']) {
    assert.ok(isContentPolicyExcluded(`src/${name}`), `${name} should preserve existing content exclusions`)
  }
  assert.equal(isContentPolicyExcluded('src/README.md'), false)
  assert.equal(isContentPolicyExcluded('src/app.ts'), false)
})
