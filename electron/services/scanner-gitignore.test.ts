// 扫描器嵌套 .gitignore 的 fixture 测试（issue #16）
//
// 每个用例在临时目录里搭出真实的目录树 + 多层 .gitignore，
// 跑一遍 scanProject 后断言哪些相对路径出现在结果里。
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import test from 'node:test'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import ignore from 'ignore'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { prefixGitignoreRules, scanProject } from './scanner.ts'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { captureProjectSnapshot } from './project-snapshot.ts'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { ProjectScanCache } from './scan-cache.ts'

const createdRoots = new Set<string>()
const tempRoot = path.resolve(os.tmpdir())

async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pl-gitignore-'))
  createdRoots.add(path.resolve(root))
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, content, 'utf-8')
  }
  return root
}

async function removeProject(root: string): Promise<void> {
  const resolved = path.resolve(root)
  const relative = path.relative(tempRoot, resolved)
  if (!createdRoots.has(resolved) || !relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`拒绝删除非本测试创建的临时目录: ${resolved}`)
  }
  await fs.rm(resolved, { recursive: true, force: true })
  createdRoots.delete(resolved)
}

async function scannedRelPaths(root: string): Promise<Set<string>> {
  const result = await scanProject(root)
  return new Set(result.files.map((f) => f.relPath))
}

test('验收：根目录与多层嵌套 .gitignore 均正确生效', async () => {
  const root = await makeProject({
    '.gitignore': 'root-skip.txt\n',
    'packages/app/.gitignore': 'debug.log\n',
    'packages/app/debug.log': 'x',
    'packages/app/nested/debug.log': 'x',
    'packages/lib/debug.log': 'x',
    'packages/app/keep.txt': 'x',
    'packages/lib/keep.txt': 'x',
    'root-skip.txt': 'x'
  })
  try {
    const seen = await scannedRelPaths(root)
    assert.ok(seen.has('packages/app/keep.txt'), '正常文件应保留')
    assert.ok(seen.has('packages/lib/debug.log'), '嵌套规则只作用于所在子树，其他目录不受影响')
    assert.ok(!seen.has('packages/app/debug.log'), '嵌套 basename 规则应忽略所在目录树内的同名文件')
    assert.ok(!seen.has('packages/app/nested/debug.log'), 'basename 规则应覆盖所在子树的更深层级')
    assert.ok(!seen.has('root-skip.txt'), '根目录规则照常生效')
  } finally {
    await removeProject(root)
  }
})

test('验收：内层否定规则优先于外层（Git 层级语义）', async () => {
  const root = await makeProject({
    '.gitignore': '*.log\n',
    'packages/app/.gitignore': '!keep.log\n',
    'packages/app/keep.log': 'x',
    'packages/app/other.log': 'x',
    'packages/lib/x.log': 'x'
  })
  try {
    const seen = await scannedRelPaths(root)
    assert.ok(seen.has('packages/app/keep.log'), '内层否定应重新纳入该目录树内的文件')
    assert.ok(!seen.has('packages/app/other.log'), '否定只影响列出的模式')
    assert.ok(!seen.has('packages/lib/x.log'), '外层规则对其他目录照常生效')
  } finally {
    await removeProject(root)
  }
})

test('锚定规则（以 / 开头）只作用于所在目录本身', async () => {
  const root = await makeProject({
    'packages/app/.gitignore': '/secret.txt\n',
    'packages/app/secret.txt': 'x',
    'packages/app/deep/secret.txt': 'x',
    'packages/lib/secret.txt': 'x'
  })
  try {
    const seen = await scannedRelPaths(root)
    assert.ok(!seen.has('packages/app/secret.txt'), '锚定规则应忽略所在目录下的该文件')
    assert.ok(seen.has('packages/app/deep/secret.txt'), '锚定规则不应影响更深层级')
    assert.ok(seen.has('packages/lib/secret.txt'), '锚定规则不应影响其他目录')
  } finally {
    await removeProject(root)
  }
})

test('目录限定规则（行尾 /）作用于所在子树', async () => {
  const root = await makeProject({
    'packages/app/.gitignore': 'logs/\n',
    'packages/app/logs/a.txt': 'x',
    'packages/lib/logs/b.txt': 'x',
    'packages/app/src/main.ts': 'x'
  })
  try {
    const seen = await scannedRelPaths(root)
    assert.ok(!seen.has('packages/app/logs/a.txt'), '目录规则应忽略所在子树内的同名目录')
    assert.ok(seen.has('packages/lib/logs/b.txt'), '其他目录不受影响')
    assert.ok(seen.has('packages/app/src/main.ts'))
  } finally {
    await removeProject(root)
  }
})

test('验收：内置 ALWAYS_IGNORE 优先级最高，否定规则不能重新纳入', async () => {
  const root = await makeProject({
    'packages/app/.gitignore': '!node_modules\n!node_modules/keep.js\n',
    'packages/app/node_modules/keep.js': 'x',
    'packages/app/real.ts': 'x'
  })
  try {
    const seen = await scannedRelPaths(root)
    assert.ok(!seen.has('packages/app/node_modules/keep.js'), '内置忽略目录不能被 .gitignore 否定规则重新纳入')
    assert.ok(seen.has('packages/app/real.ts'))
  } finally {
    await removeProject(root)
  }
})

test('多层嵌套叠加：每层规则都在其子树内生效', async () => {
  const root = await makeProject({
    '.gitignore': 'gen0/\n',
    'a/.gitignore': 'gen1/\n',
    'a/b/.gitignore': 'gen2/\n',
    'a/b/gen2/x.txt': 'x',
    'a/gen1/y.txt': 'x',
    'a/b/keep.txt': 'x',
    'gen0/z.txt': 'x'
  })
  try {
    const seen = await scannedRelPaths(root)
    assert.ok(!seen.has('a/b/gen2/x.txt'), '第三层规则生效')
    assert.ok(!seen.has('a/gen1/y.txt'), '第二层规则生效')
    assert.ok(!seen.has('gen0/z.txt'), '根规则生效')
    assert.ok(seen.has('a/b/keep.txt'), '未被忽略的文件正常保留')
  } finally {
    await removeProject(root)
  }
})

test('目录名含 glob 元字符时规则仍正确定位（不漏本目录、不误伤兄弟）', async () => {
  const root = await makeProject({
    'a[1]/.gitignore': 'skipme.txt\n',
    'a[1]/skipme.txt': 'x',
    'a[1]/keep.txt': 'x',
    'a1/skipme.txt': 'x'
  })
  try {
    const seen = await scannedRelPaths(root)
    assert.ok(!seen.has('a[1]/skipme.txt'), '元字符目录内的规则应正常生效')
    assert.ok(seen.has('a[1]/keep.txt'), '元字符目录内其他文件不受影响')
    assert.ok(seen.has('a1/skipme.txt'), '目录名不能被当作字符类去匹配兄弟目录')
  } finally {
    await removeProject(root)
  }
})

test('CRLF 行尾的 .gitignore 正常解析', async () => {
  const root = await makeProject({
    '.gitignore': 'root-skip.txt\r\n',
    'sub/.gitignore': 'skipme.txt\r\n',
    'sub/skipme.txt': 'x',
    'sub/keep.txt': 'x',
    'root-skip.txt': 'x'
  })
  try {
    const seen = await scannedRelPaths(root)
    assert.ok(!seen.has('sub/skipme.txt'), 'CRLF 文件的嵌套规则应生效')
    assert.ok(!seen.has('root-skip.txt'), 'CRLF 文件的根规则应生效')
    assert.ok(seen.has('sub/keep.txt'))
  } finally {
    await removeProject(root)
  }
})

test('被忽略的嵌套 .gitignore 也记录进快照（内容变更必须使扫描缓存失效）', async () => {
  const root = await makeProject({
    '.gitignore': 'sub/.gitignore\n',
    'sub/.gitignore': 'skipme.txt\n',
    'sub/skipme.txt': 'x',
    'sub/keep.txt': 'x'
  })
  try {
    const result = await scanProject(root)
    const snapshot = await captureProjectSnapshot(result)
    assert.ok(
      snapshot.entries.some((e) => e.type === 'file' && e.path === 'sub/.gitignore'),
      '被忽略的嵌套 .gitignore 也必须有快照条目，否则其变更不会使扫描缓存失效'
    )
    const seen = new Set(result.files.map((f) => f.relPath))
    assert.ok(!seen.has('sub/skipme.txt'), '规则本身仍应生效')
  } finally {
    await removeProject(root)
  }
})

test('prefixGitignoreRules：模式改写与注释/空行/行尾空白处理', () => {
  assert.deepEqual(
    prefixGitignoreRules(['*.log', '!keep.log', '# 注释', '', '/logs/', 'build/output.txt', '*.tmp   '].join('\n'), 'sub'),
    ['sub/**/*.log', '!sub/**/keep.log', 'sub/logs/', 'sub/build/output.txt', 'sub/**/*.tmp']
  )
})

test('prefixGitignoreRules：目录名元字符被转义，特殊形态保持语义', () => {
  assert.deepEqual(prefixGitignoreRules('x\n', 'a[1]'), ['a\\[1\\]/**/x'])
  assert.deepEqual(prefixGitignoreRules('!/x\n', 'sub'), ['!sub/x'])
  assert.deepEqual(prefixGitignoreRules('**/x\n', 'sub'), ['sub/**/x'])
})

test('目录 candidate 保留目录限定和内层重新包含规则的语义', async () => {
  const root = await makeProject({
    '.gitignore': 'sub/*\n',
    'sub/.gitignore': '!deep/\n',
    'sub/deep/index.ts': 'x',
    'sub/other/index.ts': 'x'
  })
  try {
    const seen = await scannedRelPaths(root)
    assert.ok(seen.has('sub/deep/index.ts'), '内层否定应恢复该目录及其文件')
    assert.ok(!seen.has('sub/other/index.ts'), '未否定的兄弟目录仍应排除')
    assert.ok(!seen.has('sub/.gitignore'))
  } finally {
    await removeProject(root)
  }
})

test('父目录被排除时，子目录否定不能重新纳入', async () => {
  const root = await makeProject({
    '.gitignore': 'sub/\n',
    'sub/.gitignore': '!deep/\n',
    'sub/deep/index.ts': 'x'
  })
  try {
    const seen = await scannedRelPaths(root)
    assert.ok(!seen.has('sub/deep/index.ts'))
  } finally {
    await removeProject(root)
  }
})

test('目录限定规则只忽略目录，不忽略同名普通文件', async () => {
  const root = await makeProject({
    '.gitignore': 'logs/\n',
    'logs/a.txt': 'x',
    'sub/logs': 'plain file',
    'sub/keep.txt': 'x'
  })
  try {
    const seen = await scannedRelPaths(root)
    assert.ok(!seen.has('logs/a.txt'), 'logs/ 应忽略 logs 目录下的文件')
    assert.ok(seen.has('sub/logs'), '目录限定规则不应忽略同名普通文件')
  } finally {
    await removeProject(root)
  }
})

test('目录限定否定规则不能重新纳入同名普通文件', async () => {
  const root = await makeProject({
    '.gitignore': 'sub/*\n',
    'sub/.gitignore': '!deep/\n',
    'sub/deep': 'plain file'
  })
  try {
    const seen = await scannedRelPaths(root)
    assert.ok(!seen.has('sub/deep'), '目录限定否定不能匹配同名普通文件')
  } finally {
    await removeProject(root)
  }
})

test('问号规则经前缀化后由 ignore matcher 正确匹配', () => {
  const basenameMatcher = ignore().add(prefixGitignoreRules('skipme.txt\n', 'docs?'))
  assert.ok(basenameMatcher.ignores('docs?/skipme.txt'))
  assert.ok(basenameMatcher.ignores('docs?/nested/skipme.txt'))
  assert.ok(basenameMatcher.ignores('docs?/nested/other/skipme.txt'))
  assert.ok(!basenameMatcher.ignores('docsa/skipme.txt'))

  const anchoredMatcher = ignore().add(prefixGitignoreRules('/skipme.txt\n', 'docs?'))
  assert.ok(anchoredMatcher.ignores('docs?/skipme.txt'))
  assert.ok(!anchoredMatcher.ignores('docs?/nested/skipme.txt'))
})

test('POSIX 问号目录中的真实 .gitignore 生效', { skip: process.platform === 'win32' ? 'Windows 文件名不能包含 ?' : false }, async () => {
  const root = await makeProject({
    'docs?/.gitignore': 'skipme.txt\n/anchored.txt\n',
    'docs?/skipme.txt': 'x',
    'docs?/nested/skipme.txt': 'x',
    'docs?/anchored.txt': 'x',
    'docs?/nested/anchored.txt': 'x',
    'docs?/keep.txt': 'x',
    'docsa/skipme.txt': 'x'
  })
  try {
    const seen = await scannedRelPaths(root)
    assert.ok(!seen.has('docs?/skipme.txt'))
    assert.ok(!seen.has('docs?/nested/skipme.txt'))
    assert.ok(!seen.has('docs?/anchored.txt'))
    assert.ok(seen.has('docs?/nested/anchored.txt'))
    assert.ok(seen.has('docs?/keep.txt'))
    assert.ok(seen.has('docsa/skipme.txt'))
  } finally {
    await removeProject(root)
  }
})

test('编辑被忽略的嵌套 .gitignore 后缓存触发新扫描', async () => {
  const root = await makeProject({
    '.gitignore': 'sub/.gitignore\n',
    'sub/.gitignore': 'skipme.txt\n',
    'sub/skipme.txt': 'x',
    'sub/keep.txt': 'x'
  })
  try {
    const cache = new ProjectScanCache()
    const first = await cache.getFresh(root)
    assert.equal(first.status, 'scanned')
    assert.ok(!first.scan.files.some((file) => file.relPath === 'sub/skipme.txt'))
    assert.equal((await cache.getFresh(root)).status, 'reused', '编辑前应命中已缓存扫描')
    await fs.writeFile(path.join(root, 'sub/.gitignore'), 'keep.txt\n', 'utf-8')
    const updated = await cache.getFresh(root)
    assert.equal(updated.status, 'scanned')
    assert.equal(updated.reason, 'changed')
    assert.ok(updated.scan.files.some((file) => file.relPath === 'sub/skipme.txt'))
    assert.ok(!updated.scan.files.some((file) => file.relPath === 'sub/keep.txt'))
  } finally {
    await removeProject(root)
  }
})
