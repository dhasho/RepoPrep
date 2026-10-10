import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
// @ts-ignore TS5097 -- Node executes this test source directly.
import { ProjectScanCache } from './scan-cache.ts'
// @ts-ignore TS5097 -- Node executes this test source directly.
import { buildContext } from './context-builder.ts'
// @ts-ignore TS5097 -- Node executes this test source directly.
import { generateInterview } from './generator.ts'
// @ts-ignore TS5097 -- Node executes this test source directly.
import { scanProject } from './scanner.ts'
// @ts-ignore TS5097 -- Node executes this test source directly.
import { createProjectContentReader, ProjectContentBoundaryError, readProjectContent } from './project-content-reader.ts'

const workspaces: string[] = []

function checkedFixturePath(candidate: string): string {
  const resolved = path.resolve(candidate)
  assert.ok(workspaces.some((base) => resolved.startsWith(`${path.resolve(base)}${path.sep}`)), 'move target must remain inside a generated fixture workspace')
  return resolved
}

async function workspace(): Promise<{ base: string; root: string; outside: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'projectlens-read-boundary-'))
  workspaces.push(base)
  const root = path.join(base, 'project')
  const outside = path.join(base, 'outside')
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.mkdir(outside)
  await fs.writeFile(path.join(root, 'src', 'app.ts'), 'export const value = "inside"\n')
  await fs.writeFile(path.join(root, 'README.md'), '# Boundary fixture\n')
  await fs.writeFile(path.join(outside, 'app.ts'), 'OUTSIDE_SENTINEL_DO_NOT_READ')
  return { base, root, outside }
}

async function removeLink(linkPath: string): Promise<void> {
  try {
    const stat = await fs.lstat(linkPath)
    if (stat.isSymbolicLink()) await fs.unlink(linkPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function removeGeneratedLinks(root: string): Promise<void> {
  await Promise.all([
    removeLink(path.join(root, 'src')),
    removeLink(path.join(root, 'linked'))
  ])
}

async function replaceDirectoryWithJunction(root: string, outside: string): Promise<string> {
  const source = checkedFixturePath(path.join(root, 'src'))
  const parked = checkedFixturePath(path.join(root, 'src-boundary-test-original'))
  checkedFixturePath(outside)
  await fs.rename(source, parked)
  try {
    await fs.symlink(outside, source, 'junction')
  } catch (error) {
    await fs.rename(parked, source)
    throw error
  }
  return parked
}

async function withWorkspace(run: (paths: Awaited<ReturnType<typeof workspace>>) => Promise<void>): Promise<void> {
  const paths = await workspace()
  try {
    await run(paths)
  } finally {
    // The generated temp workspace is the deletion boundary. Remove links before
    // recursive cleanup so cleanup can never traverse an outside target.
    await removeGeneratedLinks(paths.root)
    const resolvedBase = path.resolve(paths.base)
    const resolvedTemp = path.resolve(os.tmpdir())
    assert.ok(resolvedBase.startsWith(`${resolvedTemp}${path.sep}`), 'cleanup target must be inside the generated temp directory')
    await fs.rm(resolvedBase, { recursive: true, force: true })
    workspaces.splice(workspaces.indexOf(paths.base), 1)
  }
}

afterEach(async () => {
  for (const base of workspaces.splice(0)) {
    const resolvedBase = path.resolve(base)
    const resolvedTemp = path.resolve(os.tmpdir())
    assert.ok(resolvedBase.startsWith(`${resolvedTemp}${path.sep}`), 'cleanup target must be inside the generated temp directory')
    await removeGeneratedLinks(path.join(base, 'project'))
    await fs.rm(resolvedBase, { recursive: true, force: true })
  }
})

async function scanFile(root: string, relPath = 'src/app.ts') {
  const result = await new ProjectScanCache().getFresh(root)
  const file = result.scan.files.find((entry) => entry.relPath === relPath)
  assert.ok(file, `expected scanner candidate ${relPath}`)
  return { scan: result.scan, file }
}

function staticBoundaryError(error: unknown): boolean {
  return error instanceof ProjectContentBoundaryError &&
    error.message === '项目文件在读取期间发生变化，请重新扫描后重试。'
}

describe('project content read boundary', () => {
  it('reads approved files from a persistent partial scan and still generates with the cache disabled', async (t) => {
    await withWorkspace(async ({ root }) => {
      const blocked = path.join(root, 'private')
      await fs.mkdir(blocked)
      await fs.writeFile(path.join(blocked, 'secret.ts'), 'private')
      const cache = new ProjectScanCache()
      const readdir = fs.readdir.bind(fs)
      t.mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => {
        if (String(args[0]) === blocked) throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
        return readdir(...args)
      })

      const first = await cache.getFresh(root)
      assert.equal(first.status, 'scanned')
      assert.equal(cache.size, 0)
      assert.match(await readProjectContent(first.scan, first.scan.files.find((file) => file.relPath === 'README.md')!), /Boundary fixture/)
      assert.equal(first.scan.files.some((file) => file.relPath.startsWith('private/')), false)
      const second = await cache.getFresh(root)
      assert.equal(second.status, 'scanned')
      assert.notEqual(second.scan, first.scan)
      assert.equal(cache.size, 0)

      const originalFetch = globalThis.fetch
      let fetchCalls = 0
      let readmeReachedModel = false
      let sourceReachedModel = false
      let privateFileReachedModel = false
      globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        fetchCalls++
        const request = (init?.body ? JSON.parse(String(init.body)) : {}) as { messages?: Array<{ content?: unknown }> }
        const messages = Array.isArray(request.messages)
          ? request.messages.map((message) => typeof message.content === 'string' ? message.content : '').join('\n')
          : ''
        readmeReachedModel = messages.includes('Boundary fixture')
        sourceReachedModel = messages.includes('export const value = "inside"')
        privateFileReachedModel = messages.includes('secret.ts')
        const questions = Array.from({ length: 20 }, (_, index) => ({
          question: `Question ${index + 1}?`,
          answer: `Answer ${index + 1}.`,
          followUps: []
        }))
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
          projectSummary: 'partial scan',
          sections: [{ title: 'Fixture questions', summary: 'Questions based on the fixture', questions }],
          glossary: {}
        }) } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }) as typeof fetch
      try {
        const result = await generateInterview({
          scan: first.scan,
          granularity: 'medium',
          roleFocus: 'general',
          profile: { id: 'test', name: 'test', baseUrl: 'https://example.invalid', apiKey: 'fake-test-key', model: 'test' },
          signal: new AbortController().signal,
          onProgress: () => undefined
        })
        assert.equal(fetchCalls > 0, true)
        assert.equal(readmeReachedModel, true)
        assert.equal(sourceReachedModel, true)
        assert.equal(privateFileReachedModel, false)
        assert.equal(result.projectSummary, 'partial scan')
        assert.equal(result.sections.reduce((count, section) => count + section.questions.length, 0) >= 15, true)
      } finally {
        globalThis.fetch = originalFetch
      }

      const approvedApp = first.scan.files.find((file) => file.relPath === 'src/app.ts')
      assert.ok(approvedApp)
      try {
        await replaceDirectoryWithJunction(root, path.join(root, '..', 'outside'))
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (['EPERM', 'EACCES', 'ENOTSUP'].includes(code ?? '')) return t.skip('directory junction creation is unavailable on this host')
        throw error
      }
      await assert.rejects(readProjectContent(first.scan, approvedApp), staticBoundaryError)
      await assert.rejects(buildContext(first.scan, 'medium'), staticBoundaryError)
    })
  })

  it('preserves POSIX backslashes as literal filename characters', { skip: process.platform === 'win32' }, async () => {
    await withWorkspace(async ({ root }) => {
      await fs.writeFile(path.join(root, 'src', 'foo\\bar.ts'), 'literal filename')
      await fs.mkdir(path.join(root, 'src', 'foo', 'bar'), { recursive: true })
      await fs.writeFile(path.join(root, 'src', 'foo', 'bar.ts'), 'slash path')
      await fs.mkdir(path.join(root, 'dir\\name'))
      await fs.writeFile(path.join(root, 'dir\\name', 'inside.ts'), 'literal directory')
      await fs.mkdir(path.join(root, 'dir', 'name'), { recursive: true })
      await fs.writeFile(path.join(root, 'dir', 'name', 'inside.ts'), 'slash directory')
      const scan = await scanProject(root)
      const literalFile = scan.files.find((file) => file.relPath === 'src/foo\\bar.ts')
      const slashFile = scan.files.find((file) => file.relPath === 'src/foo/bar.ts')
      const literalDirectoryFile = scan.files.find((file) => file.relPath === 'dir\\name/inside.ts')
      const slashDirectoryFile = scan.files.find((file) => file.relPath === 'dir/name/inside.ts')
      assert.ok(literalFile && slashFile && literalDirectoryFile && slashDirectoryFile)
      assert.equal(await readProjectContent(scan, literalFile), 'literal filename')
      assert.equal(await readProjectContent(scan, slashFile), 'slash path')
      assert.equal(await readProjectContent(scan, literalDirectoryFile), 'literal directory')
      assert.equal(await readProjectContent(scan, slashDirectoryFile), 'slash directory')
      const context = await buildContext(scan, 'medium')
      const contextFiles = context.batches.flatMap((batch) => batch.files)
      assert.ok(contextFiles.some((file) => file.relPath === 'src/foo\\bar.ts' && file.content === 'literal filename'))
      assert.ok(contextFiles.some((file) => file.relPath === 'dir\\name/inside.ts' && file.content === 'literal directory'))
      assert.ok(contextFiles.some((file) => file.relPath === 'src/foo/bar.ts' && file.content === 'slash path'))
      assert.ok(contextFiles.some((file) => file.relPath === 'dir/name/inside.ts' && file.content === 'slash directory'))
    })
  })

  it('reads an approved regular file and supports canonical root aliases and cache reuse', async (t) => {
    await withWorkspace(async ({ root }) => {
      const cache = new ProjectScanCache()
      await fs.writeFile(path.join(root, '.gitignore'), 'ignored/\n')
      const first = await cache.getFresh(root)
      const alias = `${root}${path.sep}`
      const reused = await cache.getFresh(alias)
      assert.equal(reused.status, 'reused')
      assert.equal(reused.scan, first.scan)
      const file = first.scan.files.find((entry) => entry.relPath === 'src/app.ts')
      assert.ok(file)
      assert.match(await readProjectContent(first.scan, file), /inside/)
      const context = await buildContext(first.scan, 'medium')
      assert.ok(context.batches.flatMap((batch) => batch.files).some((entry) => entry.relPath === 'src/app.ts' && /inside/.test(entry.content)))
      assert.ok(context.batches.flatMap((batch) => batch.files).some((entry) => entry.relPath === '.gitignore'), 'policy snapshot records must not hide the approved content record')

      const linkedRoot = `${root}-alias`
      try {
        await fs.symlink(root, linkedRoot, 'junction')
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (['EPERM', 'EACCES', 'ENOTSUP'].includes(code ?? '')) return t.skip('directory alias creation is unavailable on this host')
        throw error
      }
      try {
        const aliasResult = await cache.getFresh(linkedRoot)
        assert.equal(aliasResult.status, 'reused')
        assert.equal(aliasResult.scan, first.scan)
      } finally {
        // This alias is a junction to a generated workspace; unlink the link itself.
        await removeLink(linkedRoot)
      }
    })
  })

  it('fails closed before generation when nested ignore policy is unreadable and there are no candidates', async (t) => {
    await withWorkspace(async ({ root }) => {
      await fs.rm(path.join(root, 'README.md'))
      await fs.rm(path.join(root, 'src', 'app.ts'))
      await fs.writeFile(path.join(root, '.gitignore'), '.gitignore\nsrc/.gitignore\n')
      const nested = path.join(root, 'src', '.gitignore')
      await fs.writeFile(nested, 'hidden.ts\n')
      await fs.writeFile(path.join(root, 'logo.png'), 'binary')
      const open = fs.open.bind(fs)
      t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
        if (String(args[0]) === nested) throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
        return open(...args)
      })

      const scan = await scanProject(root)
      assert.equal(scan.files.length, 0)
      await assert.rejects(buildContext(scan, 'medium'), staticBoundaryError)
      const originalFetch = globalThis.fetch
      let fetchCalls = 0
      globalThis.fetch = (async () => {
        fetchCalls++
        throw new Error('unexpected model request')
      }) as typeof fetch
      try {
        await assert.rejects(generateInterview({
          scan,
          granularity: 'medium',
          roleFocus: 'general',
          profile: { id: 'test', name: 'test', baseUrl: 'https://example.invalid', apiKey: 'fake-test-key', model: 'test' },
          signal: new AbortController().signal,
          onProgress: () => undefined
        }), staticBoundaryError)
        assert.equal(fetchCalls, 0)
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })

  it('blocks content after a root ignore read failure', async (t) => {
    await withWorkspace(async ({ root }) => {
      const ignorePath = path.join(root, '.gitignore')
      await fs.writeFile(ignorePath, 'hidden/\n')
      const open = fs.open.bind(fs)
      t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
        if (String(args[0]) === ignorePath) throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
        return open(...args)
      })
      const scan = await scanProject(root)
      const candidate = scan.files.find((file) => file.isContentCandidate)
      assert.ok(candidate)
      await assert.rejects(readProjectContent(scan, candidate), staticBoundaryError)
      await assert.rejects(buildContext(scan, 'medium'), staticBoundaryError)
    })
  })

  it('rejects traversal before opening any filesystem path', async () => {
    await withWorkspace(async ({ root }) => {
      const { scan, file } = await scanFile(root)
      let openCalls = 0
      const reader = createProjectContentReader({
        open: async (filePath, flags) => {
          openCalls++
          return fs.open(filePath, flags)
        }
      })
      const original = file.relPath
      file.relPath = '../outside/app.ts'
      try {
        await assert.rejects(reader(scan, file), staticBoundaryError)
        assert.equal(openCalls, 0)
      } finally {
        file.relPath = original
      }
    })
  })

  it('rejects backslash separators on Windows', { skip: process.platform !== 'win32' }, async () => {
    await withWorkspace(async ({ root }) => {
      const { scan, file } = await scanFile(root)
      const original = file.relPath
      file.relPath = 'src\\app.ts'
      try {
        await assert.rejects(readProjectContent(scan, file), staticBoundaryError)
      } finally {
        file.relPath = original
      }
    })
  })

  it('rejects scan-time content access when root identity is unavailable', async (t) => {
    await withWorkspace(async ({ root }) => {
      const lstat = fs.lstat.bind(fs)
      t.mock.method(fs, 'lstat', async (...args: Parameters<typeof fs.lstat>) => {
        const stats = await lstat(...args)
        if (String(args[0]) !== root) return stats
        return new Proxy(stats, {
          get(target, property, receiver) {
            if (property === 'ino' || property === 'dev') return 0n
            return Reflect.get(target, property, receiver)
          }
        })
      })
      const scan = await scanProject(root)
      const candidate = scan.files.find((file) => file.isContentCandidate)
      assert.ok(candidate)
      await assert.rejects(readProjectContent(scan, candidate), staticBoundaryError)
    })
  })

  it('rejects an outside handle opened after path checks, even if the in-root path is restored', async () => {
    await withWorkspace(async ({ root, outside }) => {
      const { scan, file } = await scanFile(root)
      const source = checkedFixturePath(path.join(root, 'src'))
      const parked = checkedFixturePath(path.join(root, 'src-boundary-test-original'))
      checkedFixturePath(outside)
      let opened: FileHandle | undefined
      let reads = 0
      let closes = 0
      const reader = createProjectContentReader({
        open: async (filePath, flags) => {
          await fs.rename(source, parked)
          await fs.symlink(outside, source, 'junction')
          opened = await fs.open(filePath, flags)
          await removeLink(source)
          await fs.rename(parked, source)
          return {
            stat: (...args) => opened!.stat(...args),
            read: async (...args) => { reads++; return opened!.read(...args) },
            close: async () => { closes++; await opened!.close() }
          }
        }
      })
      await assert.rejects(reader(scan, file), staticBoundaryError)
      assert.equal(reads, 0, 'unapproved handle bytes must not be read')
      assert.equal(closes, 1, 'opened handles must close after identity rejection')
    })
  })

  it('keeps approved bytes safe when an ancestor replacement is attempted during reading', async () => {
    await withWorkspace(async ({ root, outside }) => {
      const { scan, file } = await scanFile(root)
      const source = path.join(root, 'src')
      const parked = path.join(root, 'src-boundary-test-original')
      let entered!: () => void
      let release!: () => void
      const readEntered = new Promise<void>((resolve) => { entered = resolve })
      const readGate = new Promise<void>((resolve) => { release = resolve })
      let handle: FileHandle | undefined
      const reader = createProjectContentReader({
        open: async (filePath, flags) => {
          handle = await fs.open(filePath, flags)
          return {
            stat: (...args) => handle!.stat(...args),
            read: async (...args) => {
              entered()
              await readGate
              return handle!.read(...args)
            },
            close: async () => handle!.close()
          }
        }
      })
      const pending = reader(scan, file)
      try {
        const barrier = await Promise.race([
          readEntered.then(() => 'read' as const),
          pending.then(() => 'fulfilled' as const, () => 'rejected' as const)
        ])
        assert.equal(barrier, 'read', 'reader must reach the gated read before the path is changed')
        try {
          await replaceDirectoryWithJunction(root, outside)
        } catch (error) {
          const fsError = error as NodeJS.ErrnoException
          if (process.platform !== 'win32' || fsError.code !== 'EPERM' || fsError.syscall !== 'rename') throw error
          // NTFS may refuse the rename while this file handle is open. Verify
          // the attempted mutation was prevented, instead of skipping the case.
          assert.equal((await fs.lstat(source)).isSymbolicLink(), false)
          release()
          const content = await pending
          assert.match(content, /inside/)
          assert.doesNotMatch(content, /OUTSIDE_SENTINEL/)
          return
        }
        release()
        await assert.rejects(pending, staticBoundaryError)
      } catch (error) {
        release()
        throw error
      }
    })
  })

  it('rejects a changed ancestor observation after reading from the approved native handle', async () => {
    await withWorkspace(async ({ base, root, outside }) => {
      const observedLink = path.join(base, 'observed-link')
      await fs.symlink(outside, observedLink, 'junction')
      try {
        const { scan, file } = await scanFile(root)
        let readCompleted = false
        let reads = 0
        let closes = 0
        const reader = createProjectContentReader({
          lstat: async (filePath) => fs.lstat(readCompleted && filePath === path.join(root, 'src') ? observedLink : filePath, { bigint: true }),
          open: async (filePath, flags) => {
            const handle = await fs.open(filePath, flags)
            return {
              stat: (options) => handle.stat(options),
              read: async (...args) => {
                reads++
                const result = await handle.read(...args)
                readCompleted = true
                return result
              },
              close: async () => { closes++; await handle.close() }
            }
          }
        })
        await assert.rejects(reader(scan, file), staticBoundaryError)
        assert.equal(reads, 1, 'the approved handle must be read before the altered observation')
        assert.equal(closes, 1)
      } finally {
        await removeLink(observedLink)
      }
    })
  })

  it('rejects unavailable file identity before opening', async () => {
    await withWorkspace(async ({ root }) => {
      const { scan, file } = await scanFile(root)
      let openCalls = 0
      const noIdentity = createProjectContentReader({
        lstat: async (filePath) => new Proxy(await fs.lstat(filePath, { bigint: true }), {
          get(target, property, receiver) {
            if (property === 'ino' || property === 'dev') return 0n
            return Reflect.get(target, property, receiver)
          }
        }),
        open: async (filePath, flags) => {
          openCalls++
          return fs.open(filePath, flags)
        }
      })
      await assert.rejects(noIdentity(scan, file), staticBoundaryError)
      assert.equal(openCalls, 0, 'missing stable path identity must fail before opening')
    })
  })

  it('rejects captured-size growth, short reads, and post-read timestamp changes on independent fresh scans', async () => {
    const cases: Array<{
      name: string
      mutateDuringRead?: (filePath: string) => Promise<void>
      readShort?: boolean
      alterPostReadTime?: boolean
    }> = [
      { name: 'growth during read', mutateDuringRead: async (filePath) => fs.appendFile(filePath, 'growth') },
      { name: 'short read', readShort: true },
      { name: 'post-read time change', alterPostReadTime: true }
    ]

    for (const scenario of cases) {
      await withWorkspace(async ({ root }) => {
        const { scan, file } = await scanFile(root)
        let reads = 0
        let postReadStatReached = false
        let closes = 0
        let statCalls = 0
        const baseOpen = fs.open.bind(fs)
        const reader = createProjectContentReader({
          open: async (filePath, flags) => {
            const handle = await baseOpen(filePath, flags)
            return {
              stat: async (...args) => {
                statCalls++
                const stat = await handle.stat(...args)
                if (scenario.alterPostReadTime && statCalls > 1) {
                  postReadStatReached = true
                  return new Proxy(stat, {
                    get(target, property, receiver) {
                      if (property === 'mtimeNs') return target.mtimeNs + 1n
                      return Reflect.get(target, property, receiver)
                    }
                  })
                }
                return stat
              },
              read: async (...args) => {
                reads++
                if (scenario.mutateDuringRead) await scenario.mutateDuringRead(filePath)
                if (scenario.readShort) return { bytesRead: 0, buffer: args[0] }
                return handle.read(...args)
              },
              close: async () => { closes++; await handle.close() }
            }
          }
        })
        await assert.rejects(reader(scan, file), (error: unknown) => {
          return staticBoundaryError(error)
        }, scenario.name)
        assert.equal(reads, 1, `${scenario.name} must fail at its controlled read`)
        assert.ok(statCalls >= 1, `${scenario.name} must reach handle stat`)
        if (scenario.mutateDuringRead) assert.ok(statCalls >= 2, 'growth case must reach post-read handle stat')
        if (scenario.alterPostReadTime) assert.equal(postReadStatReached, true, 'timestamp case must reach post-read handle stat')
        assert.equal(closes, 1, `${scenario.name} must close the opened handle`)
      })
    }
  })

  it('fails closed for a symlink already present during scanning', async (t) => {
    await withWorkspace(async ({ root, outside }) => {
      const linkPath = path.join(root, 'linked')
      try {
        await fs.symlink(path.join(outside, 'app.ts'), linkPath, 'file')
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (['EPERM', 'EACCES', 'ENOTSUP'].includes(code ?? '')) return t.skip('file symlink creation is unavailable on this host')
        throw error
      }
      const { scan } = await scanFile(root)
      assert.equal(scan.files.some((entry) => entry.relPath === 'linked'), false)
    })
  })

  it('keeps changed project content out of context and prevents the model request', async () => {
    await withWorkspace(async ({ root, outside }) => {
      const cache = new ProjectScanCache()
      const { scan } = await cache.getFresh(root)
      const reused = await cache.getFresh(root)
      assert.equal(reused.status, 'reused')
      await replaceDirectoryWithJunction(root, outside)

      await assert.rejects(buildContext(scan, 'medium'), staticBoundaryError)
      let fetchCalls = 0
      const previousFetch = globalThis.fetch
      globalThis.fetch = (async () => {
        fetchCalls++
        throw new Error('unexpected model request')
      }) as typeof fetch
      try {
        await assert.rejects(generateInterview({
          scan,
          granularity: 'medium',
          roleFocus: 'general',
          profile: { id: 'test', name: 'test', baseUrl: 'https://example.invalid', apiKey: 'fake-test-key', model: 'test' },
          signal: new AbortController().signal,
          onProgress: () => undefined
        }), staticBoundaryError)
        assert.equal(fetchCalls, 0)
      } finally {
        globalThis.fetch = previousFetch
      }
    })
  })
})
