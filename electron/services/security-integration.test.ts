import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
// @ts-ignore TS5097 -- Node executes this test source directly.
import { scanProject, treeToText } from './scanner.ts'
// @ts-ignore TS5097 -- Node executes this test source directly.
import { buildContext, renderBatch } from './context-builder.ts'
// @ts-ignore TS5097 -- Node executes this test source directly.
import { ProjectScanCache } from './scan-cache.ts'

async function removeFixture(root: string): Promise<void> {
  const resolvedRoot = path.resolve(root)
  const resolvedTemp = path.resolve(os.tmpdir())
  assert.equal(path.dirname(resolvedRoot), resolvedTemp, 'cleanup target must be a direct child of the temporary directory')
  assert.match(path.basename(resolvedRoot), /^projectlens-security-root-/)
  await fs.rm(resolvedRoot, { recursive: true, force: true })
}

test('excludes sensitive paths and redacts ordinary source before rendering', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'projectlens-security-'))
  try {
    await fs.mkdir(path.join(root, '.ssh'), { recursive: true })
    await fs.mkdir(path.join(root, '.aws'), { recursive: true })
    await fs.writeFile(path.join(root, '.env'), 'API_KEY=obviously-fake-env-secret\n')
    await fs.writeFile(path.join(root, '.ssh', 'id_ed25519'), 'obviously-fake-private-key\n')
    await fs.writeFile(path.join(root, '.aws', 'credentials.db'), Buffer.from([0, 1, 2, 3]))
    await fs.writeFile(path.join(root, 'src.ts'), 'const apiKey = "obviously-fake-source-secret"\nexport const value = 1\n')
    await fs.writeFile(path.join(root, 'README.md'), '# Safe fixture\n')

    const scan = await scanProject(root)
    const env = scan.files.find((file) => file.relPath === '.env')
    const key = scan.files.find((file) => file.relPath === '.ssh/id_ed25519')
    const source = scan.files.find((file) => file.relPath === 'src.ts')
    assert.ok(env && key && source)
    assert.equal(env.isContentCandidate, false)
    assert.equal(key.isContentCandidate, false)
    assert.equal(source.isContentCandidate, true)
    assert.equal(scan.security.excludedFiles, 3)
    assert.equal(scan.security.categories['env-file'], 1)
    assert.equal(scan.security.categories['private-key-file'], 1)
    assert.equal(scan.security.categories['secret-directory'], 1)
    assert.equal(scan.files.some((file) => file.relPath === '.aws/credentials.db'), false)

    const hasNode = (nodes: Array<{ path: string; children?: Array<{ path: string; children?: unknown[] }> }>, target: string): boolean =>
      nodes.some((node) => node.path === target || hasNode((node.children ?? []) as Array<{ path: string; children?: Array<{ path: string; children?: unknown[] }> }>, target))
    assert.equal(hasNode(scan.tree.children ?? [], '.env'), true)
    assert.equal(hasNode(scan.tree.children ?? [], '.ssh'), true)
    assert.equal(hasNode(scan.tree.children ?? [], '.ssh/id_ed25519'), true)
    assert.equal(hasNode(scan.tree.children ?? [], '.aws/credentials.db'), true)

    const built = await buildContext(scan, 'medium')
    const treeText = treeToText(scan.tree)
    const rendered = built.batches.flatMap((batch) => [
      ...batch.files.map((file) => file.content),
      renderBatch(built.headerText, treeText, batch)
    ]).join('\n')
    assert.equal(built.contentSecurity.redactedFiles, 1)
    assert.equal(built.contentSecurity.redactionMatches, 1)
    assert.match(rendered, /\[REDACTED:secret-assignment\]/)
    assert.doesNotMatch(rendered, /obviously-fake-(?:env|source)-secret/)
    assert.doesNotMatch(rendered, /\.env|\.ssh|id_ed25519|\.aws|credentials\.db/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('real scan-to-generation path keeps inline fake credentials out of context, progress, result, and request body', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'projectlens-security-generation-'))
  const jsonSource = '{"apiKey":"inline-json-secret","password":"json-password-secret","accessToken":"json-access-secret","clientSecret":"json-client-secret"}'
  const codeSource = [
    'const config={apiKey:"inline-api-secret", password:\'inline-password-secret\', accessToken:`inline-access-secret`, clientSecret:"inline-client-secret"};',
    'const commentObject = { apiKey: /* value follows a comment */ "fake-inline-comment" };',
    'const password=/* initializer is separated by a comment */\'fake-comment-init\';',
    'const accessToken =\n  /* trivia before the value on the next line */\n  "fake-comment-newline";',
    'const apiKey = "prefix" + "fake-concat-inline-secret";',
    'class Client { OPENAI_API_KEY: string="fake-prefixed-openai-key"; }',
    'const callConfig={apiKey:getKey("name","fake-colon-call-secret"),safe:"keep-call"};',
    'const arrayConfig={password:[wrap(() => ({ value: "fake-password-array-secret" })), "fake-password-array-tail-secret"],safe:"keep-array"};',
    'const nestedPassword = wrap({ password: "fake-equals-nested-secret" }, "fake-equals-tail-secret");',
    'const runtime = wrap({ nested: { apiKey: "fake-runtime-object-secret" } }, function () { return { password: "fake-function-body-secret" }; });',
    'const anonymous = function (value: { apiKey: CustomApiKey; nested?: { password: CustomPassword } }) { return value; };',
    'const arrow = (value: { token: CustomToken; nested?: { clientSecret: CustomClientSecret } }) => value;',
    'class Safe { method(value: { apiKey: CustomMethodKey; nested?: { password: CustomMethodPassword } }) { return value; } }',
    'function withDefault(options:{apiKey:CustomDefaultKey;password?:CustomDefaultPassword}={apiKey:"fake-parameter-default-secret"}){return options;}'
  ].join('\n')
  const jsonSecrets = [
    'inline-json-secret', 'json-password-secret', 'json-access-secret', 'json-client-secret',
  ]
  const codeSecrets = [
    'inline-api-secret', 'inline-password-secret', 'inline-access-secret', 'inline-client-secret',
    'fake-inline-comment', 'fake-comment-init', 'fake-comment-newline', 'fake-concat-inline-secret',
    'fake-prefixed-openai-key', 'fake-colon-call-secret', 'fake-password-array-secret',
    'fake-password-array-tail-secret', 'fake-equals-nested-secret', 'fake-equals-tail-secret',
    'fake-runtime-object-secret', 'fake-function-body-secret', 'fake-parameter-default-secret'
  ]
  const fakeSecrets = [...jsonSecrets, ...codeSecrets]
  const fakeModelResult = {
    projectSummary: 'Synthetic project summary.',
    sections: [{
      title: 'Configuration',
      summary: 'Configuration handling.',
      questions: Array.from({ length: 20 }, (_, index) => ({
        question: `Synthetic question ${index + 1}?`,
        answer: `Synthetic answer ${index + 1}.`,
        followUps: []
      }))
    }],
    glossary: {}
  }
  const profile = {
    id: 'synthetic-profile', name: 'Synthetic only', baseUrl: 'https://example.invalid/v1',
    apiKey: 'synthetic-profile-key', model: 'mock-model'
  }
  const originalFetch = globalThis.fetch
  const capturedBodies: Array<{ messages: Array<{ role: string; content: string }> }> = []
  try {
    await fs.mkdir(path.join(root, 'src'), { recursive: true })
    await fs.writeFile(path.join(root, 'config.json'), jsonSource)
    await fs.writeFile(path.join(root, 'src', 'config.ts'), codeSource)
    const scan = await scanProject(root)
    const candidateFiles = scan.files.filter((file) =>
      ['config.json', 'src/config.ts'].includes(file.relPath) && file.isContentCandidate
    )
    assert.equal(candidateFiles.length, 2)

    const built = await buildContext(scan, 'medium')
    assert.equal(built.batches.length, 1)
    assert.equal(built.batches[0].files.length, 2, 'both real files should become ContextFiles in the batch')
    assert.equal(built.contentSecurity.redactedFiles, 2)
    const expectedMatches = fakeSecrets.length - 2 // array and nested call assignments each contain a trailing fake value
    assert.equal(built.contentSecurity.redactionMatches, expectedMatches)
    assert.equal(built.contentSecurity.matchesByCategory['secret-assignment'], expectedMatches)
    for (const [filePath, secrets, expectedCount] of [['config.json', jsonSecrets, 4], ['src/config.ts', codeSecrets, 15]] as const) {
      const file = built.batches[0].files.find((item) => item.relPath === filePath)
      assert.ok(file, `${filePath} should be present in the real context batch`)
      assert.equal(file.redactionMatches, expectedCount, `${filePath} should contain the expected replaced values`)
      assert.equal((file.content.match(/\[REDACTED:secret-assignment\]/g) ?? []).length, expectedCount)
      for (const secret of secrets) assert.doesNotMatch(file.content, new RegExp(secret))
    }
    const typescriptContext = built.batches[0].files.find((item) => item.relPath === 'src/config.ts')?.content ?? ''
    const preservedTypeNames = ['CustomApiKey', 'CustomPassword', 'CustomToken', 'CustomClientSecret', 'CustomMethodKey', 'CustomMethodPassword', 'CustomDefaultKey', 'CustomDefaultPassword']
    for (const typeName of preservedTypeNames) {
      assert.ok(typescriptContext.includes(typeName), `${typeName} should remain in parameter type annotations`)
    }
    assert.match(typescriptContext, /options:\{apiKey:CustomDefaultKey;password\?:CustomDefaultPassword\}=\{apiKey:"\[REDACTED:secret-assignment\]"\}/)

    const rendered = renderBatch(built.headerText, treeToText(scan.tree), built.batches[0])
    assert.match(rendered, /\[REDACTED:secret-assignment\]/)
    for (const secret of fakeSecrets) assert.doesNotMatch(rendered, new RegExp(secret))
    for (const safeValue of ['keep-call', 'keep-array']) assert.ok(rendered.includes(safeValue), `${safeValue} should remain in rendered context`)
    for (const typeName of preservedTypeNames) assert.ok(rendered.includes(typeName), `${typeName} should remain in rendered context`)

    // Register the repo's normal direct-Node import alias before loading the real generator.
    // @ts-ignore TS5097 -- intentional dynamic Node test imports.
    await import('../../tests/register-shared-alias.mjs')
    // @ts-ignore TS5097 -- generator.ts uses the bundler's @shared alias by design.
    const { generateInterview } = await import('./generator.ts')
    globalThis.fetch = async (_input, init) => {
      capturedBodies.push(JSON.parse(String(init?.body)) as typeof capturedBodies[number])
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(fakeModelResult) } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    const progress: Array<{ step: string; detail?: string }> = []
    const generated = await generateInterview({
      scan,
      granularity: 'medium',
      roleFocus: 'general',
      profile,
      signal: new AbortController().signal,
      onProgress: (step, detail) => progress.push({ step, detail })
    })
    globalThis.fetch = originalFetch

    assert.equal(capturedBodies.length, 1, '20 mocked questions meet the medium-granularity quota without compensation')
    const serializedRequest = JSON.stringify(capturedBodies[0])
    for (const secret of fakeSecrets) assert.doesNotMatch(serializedRequest, new RegExp(secret))
    for (const safeValue of ['keep-call', 'keep-array']) assert.ok(serializedRequest.includes(safeValue), `${safeValue} should remain in request`)
    for (const typeName of preservedTypeNames) assert.ok(serializedRequest.includes(typeName), `${typeName} should remain in request`)
    const contextReady = progress.find((item) => item.step === '上下文就绪')
    assert.ok(contextReady?.detail?.includes(`脱敏 2 个文件（${expectedMatches} 处）`))
    for (const secret of fakeSecrets) assert.doesNotMatch(JSON.stringify(progress), new RegExp(secret))
    assert.equal(generated.sections.reduce((sum, section) => sum + section.questions.length, 0), 20)
    assert.equal(generated.security?.redactedFiles, 2)
    assert.equal(generated.security?.redactionMatches, expectedMatches)
    assert.equal(generated.security?.categories['secret-assignment'], expectedMatches)
    for (const secret of fakeSecrets) assert.doesNotMatch(JSON.stringify(generated), new RegExp(secret))
  } finally {
    globalThis.fetch = originalFetch
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('real scan-to-generation path redacts empty-username Redis URI credentials and preserves URI controls', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'projectlens-redis-uri-security-'))
  const redisCredential = 'issue88-fake-redis-credential'
  const redissCredential = 'issue88-fake%2Drediss%40credential'
  const namedCredential = 'issue88-named-user-control-credential'
  const redisUri = `redis://:${redisCredential}@redis.example.invalid:6379/4?client=issue88-redis-control`
  const redissUri = `rediss://:${redissCredential}@secure.example.invalid:6380/5?client=issue88-rediss-control`
  const namedUri = `redis://cache-reader:${namedCredential}@named.example.invalid:6379/6?client=issue88-named-control`
  const noUserInfoUri = 'redis://public.example.invalid:6379/7?client=issue88-public-control'
  const emptyPasswordUri = 'redis://empty-user:@empty.example.invalid:6379/8?client=issue88-empty-password-control'
  const credentials = [redisCredential, redissCredential, namedCredential]
  const fakeModelResult = {
    projectSummary: 'Synthetic Redis configuration summary.',
    sections: [{
      title: 'Connection configuration',
      summary: 'Synthetic configuration coverage.',
      questions: Array.from({ length: 20 }, (_, index) => ({
        question: `Synthetic Redis question ${index + 1}?`,
        answer: `Synthetic Redis answer ${index + 1}.`,
        followUps: []
      }))
    }],
    glossary: {}
  }
  const profile = {
    id: 'synthetic-redis-profile', name: 'Synthetic only', baseUrl: 'https://example.invalid/v1',
    apiKey: 'synthetic-profile-key', model: 'mock-model'
  }
  const originalFetch = globalThis.fetch
  const capturedBodies: Array<{ messages: Array<{ role: string; content: string }> }> = []
  try {
    await fs.mkdir(path.join(root, 'src'), { recursive: true })
    await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({ cacheAddress: redisUri, publicAddress: noUserInfoUri }, null, 2))
    await fs.writeFile(path.join(root, 'src', 'cache.ts'), [
      `export const secureCacheAddress = '${redissUri}'`,
      `export const namedCacheAddress = '${namedUri}'`
    ].join('\n'))
    await fs.writeFile(path.join(root, 'cache.txt'), `cache_address=${emptyPasswordUri}\npublic_address=${noUserInfoUri}\n`)

    // scanProject records the private policy and approved-file snapshot used by
    // buildContext/readProjectContent; the generation path must consume that scan.
    const scan = await scanProject(root)
    const filePaths = ['config.json', 'src/cache.ts', 'cache.txt']
    const candidateFiles = scan.files.filter((file) => filePaths.includes(file.relPath) && file.isContentCandidate)
    assert.equal(candidateFiles.length, filePaths.length)

    const built = await buildContext(scan, 'medium')
    assert.equal(built.batches.length, 1)
    assert.equal(built.batches[0].files.length, filePaths.length)
    assert.equal(built.contentSecurity.redactedFiles, 2)
    assert.equal(built.contentSecurity.redactionMatches, 3)
    assert.equal(built.contentSecurity.matchesByCategory['connection-string'], 3)

    const expectedByFile = new Map([
      ['config.json', { matches: 1, safeUris: [noUserInfoUri] }],
      ['src/cache.ts', { matches: 2, safeUris: [
        'rediss://:[REDACTED:connection-string]@secure.example.invalid:6380/5?client=issue88-rediss-control',
        'redis://cache-reader:[REDACTED:connection-string]@named.example.invalid:6379/6?client=issue88-named-control'
      ] }],
      ['cache.txt', { matches: 0, safeUris: [emptyPasswordUri, noUserInfoUri] }]
    ])
    for (const [filePath, expected] of expectedByFile) {
      const file = built.batches[0].files.find((item) => item.relPath === filePath)
      assert.ok(file, `${filePath} should be present in the real context batch`)
      assert.equal(file.redactionMatches, expected.matches, `${filePath} should have the exact URI redaction count`)
      assert.equal((file.content.match(/\[REDACTED:connection-string\]/g) ?? []).length, expected.matches)
      for (const safeUri of expected.safeUris) assert.ok(file.content.includes(safeUri), `${filePath} should preserve ${safeUri}`)
    }
    const contextText = JSON.stringify(built.batches)
    for (const credential of credentials) assert.doesNotMatch(contextText, new RegExp(credential))

    const rendered = built.batches
      .map((batch) => renderBatch(built.headerText, treeToText(scan.tree), batch))
      .join('\n')
    assert.equal((rendered.match(/\[REDACTED:connection-string\]/g) ?? []).length, 3)
    for (const credential of credentials) assert.doesNotMatch(rendered, new RegExp(credential))
    for (const safeUri of [
      `redis://:[REDACTED:connection-string]@redis.example.invalid:6379/4?client=issue88-redis-control`,
      `rediss://:[REDACTED:connection-string]@secure.example.invalid:6380/5?client=issue88-rediss-control`,
      `redis://cache-reader:[REDACTED:connection-string]@named.example.invalid:6379/6?client=issue88-named-control`,
      noUserInfoUri,
      emptyPasswordUri
    ]) assert.ok(rendered.includes(safeUri), `rendered context should preserve ${safeUri}`)

    // Register the repo's normal direct-Node import alias before loading the real generator.
    // @ts-ignore TS5097 -- intentional dynamic Node test imports.
    await import('../../tests/register-shared-alias.mjs')
    // @ts-ignore TS5097 -- generator.ts uses the bundler's @shared alias by design.
    const { generateInterview } = await import('./generator.ts')
    globalThis.fetch = async (_input, init) => {
      capturedBodies.push(JSON.parse(String(init?.body)) as typeof capturedBodies[number])
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(fakeModelResult) } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    const progress: Array<{ step: string; detail?: string }> = []
    const generated = await generateInterview({
      scan,
      granularity: 'medium',
      roleFocus: 'general',
      profile,
      signal: new AbortController().signal,
      onProgress: (step, detail) => progress.push({ step, detail })
    })
    globalThis.fetch = originalFetch

    assert.equal(capturedBodies.length, 1, '20 mocked questions meet the medium-granularity quota without compensation')
    const serializedRequest = JSON.stringify(capturedBodies[0])
    assert.equal((serializedRequest.match(/\[REDACTED:connection-string\]/g) ?? []).length, 3)
    for (const credential of credentials) assert.doesNotMatch(serializedRequest, new RegExp(credential))
    for (const safeUri of [noUserInfoUri, emptyPasswordUri, 'cache-reader', 'redis.example.invalid', 'secure.example.invalid', 'issue88-rediss-control']) {
      assert.ok(serializedRequest.includes(safeUri), `request should preserve ${safeUri}`)
    }
    const contextReady = progress.find((item) => item.step === '上下文就绪')
    assert.ok(contextReady?.detail?.includes('脱敏 2 个文件（3 处）'))
    for (const credential of credentials) assert.doesNotMatch(JSON.stringify(progress), new RegExp(credential))
    assert.equal(generated.sections.reduce((sum, section) => sum + section.questions.length, 0), 20)
    assert.equal(generated.security?.redactedFiles, 2)
    assert.equal(generated.security?.redactionMatches, 3)
    assert.equal(generated.security?.categories['connection-string'], 3)
    for (const credential of credentials) assert.doesNotMatch(JSON.stringify(generated), new RegExp(credential))
  } finally {
    globalThis.fetch = originalFetch
    const resolvedRoot = path.resolve(root)
    const resolvedTemp = path.resolve(os.tmpdir())
    assert.ok(resolvedRoot.startsWith(`${resolvedTemp}${path.sep}`), `fixture cleanup must stay in temp directory: ${resolvedRoot}`)
    assert.ok(path.basename(resolvedRoot).startsWith('projectlens-redis-uri-security-'), `unexpected fixture cleanup path: ${resolvedRoot}`)
    await fs.rm(resolvedRoot, { recursive: true, force: true })
  }
})

test('protected selected roots stay out of all granularity batches and mocked generation requests', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'projectlens-security-root-'))
  const protectedNames = ['.docker', '.aws', '.ssh', '.kube', '.gnupg', path.join('.config', 'gcloud')]
  const sentinels: string[] = []
  const originalFetch = globalThis.fetch
  const capturedBodies: Array<{ messages: Array<{ role: string; content: string }> }> = []
  const fakeModelResult = {
    projectSummary: 'Synthetic protected-root fixture.',
    sections: [{
      title: 'Fixture',
      summary: 'Synthetic test output.',
      questions: Array.from({ length: 40 }, (_, index) => ({
        question: `Synthetic question ${index + 1}?`,
        answer: 'Synthetic answer.',
        followUps: []
      }))
    }],
    glossary: {}
  }
  const profile = {
    id: 'synthetic-protected-root-profile',
    name: 'Synthetic only',
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'synthetic-profile-key',
    model: 'mock-model'
  }

  try {
    for (const protectedName of protectedNames) {
      const selectedRoot = path.join(workspace, protectedName)
      await fs.mkdir(path.join(selectedRoot, 'nested'), { recursive: true })
      const fixtureId = protectedName.replaceAll(/[\\/.]/g, '-')
      const rootSecret = `synthetic-root-secret-${fixtureId}`
      const rootCredentialSecret = `synthetic-root-credential-secret-${fixtureId}`
      const rootBinarySecret = `synthetic-root-binary-secret-${fixtureId}`
      const childSecret = `synthetic-child-secret-${fixtureId}`
      const childBinarySecret = `synthetic-child-binary-secret-${fixtureId}`
      sentinels.push(rootSecret, rootCredentialSecret, rootBinarySecret, childSecret, childBinarySecret)
      await fs.writeFile(path.join(selectedRoot, 'config.json'), `{"apiKey":"${rootSecret}"}`)
      await fs.writeFile(path.join(selectedRoot, 'credentials'), `password=${rootCredentialSecret}\n`)
      await fs.writeFile(path.join(selectedRoot, 'root-vault.db'), Buffer.from(rootBinarySecret))
      await fs.writeFile(path.join(selectedRoot, 'nested', 'source.ts'), `export const apiKey = '${childSecret}'\n`)
      await fs.writeFile(path.join(selectedRoot, 'nested', 'vault.db'), Buffer.from(childBinarySecret))

      const scan = await scanProject(selectedRoot)
      assert.equal(scan.files.length, 3, `${protectedName} root fixture should have three textual files`)
      assert.ok(scan.files.every((file) => !file.isContentCandidate), `${protectedName} files must not remain model candidates`)
      assert.equal(scan.security.excludedFiles, 5, `${protectedName} root should count three root files and two nested files`)
      assert.equal(Object.values(scan.security.categories).reduce((sum, count) => sum + count, 0), 5, `${protectedName} root category counts should cover every excluded file exactly once`)
      assert.equal(scan.tree.modelExcluded, true, `${protectedName} tree root should carry the model exclusion marker`)
      const markedNodes = (node: typeof scan.tree): boolean =>
        node.modelExcluded === true && (node.children ?? []).every(markedNodes)
      assert.ok(markedNodes(scan.tree), `${protectedName} tree descendants should carry exclusion markers`)

      const treeText = treeToText(scan.tree)
      for (const protectedSegment of protectedName.split(/[\\/]/)) {
        assert.doesNotMatch(treeText, new RegExp(protectedSegment.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      }
      assert.doesNotMatch(treeText, /config\.json|credentials|source\.ts|root-vault\.db|vault\.db/)
      assert.match(treeText, /保护|排除/)

      for (const granularity of ['coarse', 'medium', 'fine'] as const) {
        const built = await buildContext(scan, granularity)
        const treeText = built.treeText
        for (const protectedSegment of protectedName.split(/[\\/]/)) {
          assert.doesNotMatch(built.headerText, new RegExp(protectedSegment.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        }
        for (const batch of built.batches) {
          assert.equal(batch.files.length, 0, `${granularity} must not select content under ${protectedName}`)
          const rendered = renderBatch(built.headerText, treeText, batch)
          for (const sentinel of sentinels) assert.doesNotMatch(rendered, new RegExp(sentinel))
          assert.doesNotMatch(rendered, /config\.json|credentials|source\.ts|root-vault\.db|vault\.db/)
        }
      }

      const selectedNested = await scanProject(path.join(selectedRoot, 'nested'))
      assert.equal(selectedNested.files.length, 1, `${protectedName} nested selection should have one text candidate record`)
      assert.ok(selectedNested.files.every((file) => !file.isContentCandidate), `${protectedName} nested selection must inherit protected ancestry`)
      assert.equal(selectedNested.security.excludedFiles, 2, `${protectedName} nested selection should count its text and binary files`)
      assert.equal(Object.values(selectedNested.security.categories).reduce((sum, count) => sum + count, 0), 2, `${protectedName} nested category counts should cover both files exactly once`)
      assert.equal(selectedNested.tree.modelExcluded, true, `${protectedName} nested selected root should be marked protected`)
      for (const granularity of ['coarse', 'medium', 'fine'] as const) {
        const built = await buildContext(selectedNested, granularity)
        assert.ok(built.batches.every((batch) => batch.files.length === 0), `${granularity} must suppress content from selected ${protectedName}/nested`)
        for (const protectedSegment of protectedName.split(/[\\/]/)) {
          assert.doesNotMatch(built.headerText, new RegExp(protectedSegment.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        }
        const rendered = built.batches.map((batch) => renderBatch(built.headerText, built.treeText, batch)).join('\n')
        for (const sentinel of sentinels) assert.doesNotMatch(rendered, new RegExp(sentinel))
        assert.doesNotMatch(`${built.treeText}\n${rendered}`, /source\.ts|vault\.db/)
      }
    }

    // Exercise the actual generator request path for one protected root at each granularity.
    // @ts-ignore TS5097 -- intentional dynamic Node test imports.
    await import('../../tests/register-shared-alias.mjs')
    // @ts-ignore TS5097 -- generator.ts uses the bundler's @shared alias by design.
    const { generateInterview } = await import('./generator.ts')
    globalThis.fetch = async (_input, init) => {
      capturedBodies.push(JSON.parse(String(init?.body)) as typeof capturedBodies[number])
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(fakeModelResult) } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    const selectedRoot = path.join(workspace, '.aws')
    const scan = await scanProject(selectedRoot)
    const clearModelMarkers = (node: typeof scan.tree): void => {
      delete node.modelExcluded
      for (const child of node.children ?? []) clearModelMarkers(child)
    }
    clearModelMarkers(scan.tree)
    for (const file of scan.files) file.isContentCandidate = true
    for (const granularity of ['coarse', 'medium', 'fine'] as const) {
      const staleContext = await buildContext(scan, granularity)
      assert.ok(staleContext.batches.every((batch) => batch.files.length === 0), `${granularity} must recheck stale candidate flags against the protected scan root`)
      assert.doesNotMatch(staleContext.headerText, /\.aws/)
    }

    for (const granularity of ['coarse', 'medium', 'fine'] as const) {
      await generateInterview({
        scan,
        granularity,
        roleFocus: 'general',
        profile,
        signal: new AbortController().signal,
        onProgress: () => {}
      })
    }

    assert.equal(capturedBodies.length, 3, 'each granularity should make one mocked request for its stale tree-only context')
    for (const body of capturedBodies) {
      const serialized = JSON.stringify(body)
      for (const sentinel of sentinels) assert.doesNotMatch(serialized, new RegExp(sentinel))
      for (const protectedName of protectedNames) {
        for (const protectedSegment of protectedName.split(/[\\/]/)) {
          assert.doesNotMatch(serialized, new RegExp(protectedSegment.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        }
      }
      assert.doesNotMatch(serialized, /config\.json|credentials|source\.ts|root-vault\.db|vault\.db/)
      assert.match(serialized, /保护|排除/)
    }
  } finally {
    globalThis.fetch = originalFetch
    await removeFixture(workspace)
  }
})

test('stops before a model request when canonical project resolution fails', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'projectlens-security-root-'))
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  try {
    await fs.writeFile(path.join(root, 'config.json'), '{"apiKey":"canonicalization-synthetic-secret"}')
    const scan = await scanProject(root)
    // @ts-ignore TS5097 -- intentional dynamic Node test imports.
    await import('../../tests/register-shared-alias.mjs')
    // @ts-ignore TS5097 -- generator.ts uses the bundler's @shared alias by design.
    const { generateInterview } = await import('./generator.ts')
    t.mock.method(fs, 'realpath', async (..._args: Parameters<typeof fs.realpath>) => {
      throw Object.assign(new Error('synthetic canonicalization failure'), { code: 'EACCES' })
    })
    globalThis.fetch = async () => {
      fetchCalls++
      return new Response('unexpected model call', { status: 500 })
    }

    await assert.rejects(generateInterview({
      scan,
      granularity: 'coarse',
      roleFocus: 'general',
      profile: {
        id: 'synthetic-canonicalization-profile',
        name: 'Synthetic only',
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'synthetic-profile-key',
        model: 'mock-model'
      },
      signal: new AbortController().signal,
      onProgress: () => {}
    }), /无法安全解析所选项目路径，已停止分析/)
    assert.equal(fetchCalls, 0, 'canonicalization failure must stop before the model request')
  } finally {
    globalThis.fetch = originalFetch
    await removeFixture(root)
  }
})

test('POSIX literal backslashes remain visible through scan, context, and tree rendering', { skip: process.platform === 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'projectlens-security-root-'))
  const selectedRoot = path.join(root, 'ordinary\\.aws\\project')
  const safeMarker = 'safe-posix-literal-marker'
  const refreshedMarker = 'safe-posix-refreshed-marker'
  const secretMarker = 'secret-real-aws-marker'
  const nestedSafeMarker = 'safe-posix-backslash-directory-marker'
  const nestedRelativePath = 'ordinary\\.ssh\\module'
  const originalFetch = globalThis.fetch
  const capturedBodies: Array<{ messages: Array<{ role: string; content: string }> }> = []
  const cache = new ProjectScanCache()
  try {
    await fs.mkdir(path.join(selectedRoot, '.aws'), { recursive: true })
    await fs.writeFile(path.join(selectedRoot, 'README.md'), `# ${safeMarker}\n`)
    await fs.writeFile(path.join(selectedRoot, 'index.ts'), `export const marker = '${safeMarker}'\n`)
    await fs.writeFile(path.join(selectedRoot, '.aws', 'credentials'), `password=${secretMarker}\n`)
    const nestedDirectory = path.join(selectedRoot, nestedRelativePath)
    await fs.mkdir(nestedDirectory, { recursive: true })
    await fs.writeFile(path.join(nestedDirectory, 'README.md'), `# ${nestedSafeMarker}\n`)
    await fs.writeFile(path.join(nestedDirectory, 'index.ts'), `export const marker = '${nestedSafeMarker}'\n`)

    const first = await cache.getFresh(selectedRoot)
    assert.equal(first.status, 'scanned')
    const scan = first.scan
    assert.equal(scan.root, await fs.realpath(selectedRoot), 'the literal backslash path itself must be the selected scan root')
    const readme = scan.files.find((file) => file.relPath === 'README.md')
    const source = scan.files.find((file) => file.relPath === 'index.ts')
    assert.ok(readme?.isContentCandidate, 'README.md at the POSIX selected root must be a content candidate')
    assert.ok(source?.isContentCandidate, 'source at the POSIX selected root must be a content candidate')
    const nestedReadmePath = `${nestedRelativePath}/README.md`
    const nestedSourcePath = `${nestedRelativePath}/index.ts`
    const nestedReadme = scan.files.find((file) => file.relPath === nestedReadmePath)
    const nestedSource = scan.files.find((file) => file.relPath === nestedSourcePath)
    assert.ok(nestedReadme?.isContentCandidate, 'nested README must keep its literal-backslash relative path as a content candidate')
    assert.ok(nestedSource?.isContentCandidate, 'nested source must keep its literal-backslash relative path as a content candidate')
    const renderedTree = treeToText(scan.tree)
    assert.ok(renderedTree.includes('README.md'), 'default tree rendering must retain the selected root files')
    assert.ok(renderedTree.includes(nestedRelativePath), 'default tree rendering must retain the nested directory name including literal backslashes')
    assert.doesNotMatch(renderedTree, /credentials/)

    for (const granularity of ['coarse', 'medium', 'fine'] as const) {
      const built = await buildContext(scan, granularity)
      assert.ok(built.treeText.includes('README.md'), `${granularity} tree must retain the selected root files`)
      assert.ok(built.treeText.includes(nestedRelativePath), `${granularity} tree must retain the nested directory name including literal backslashes`)
      assert.ok(built.batches.some((batch) => batch.files.some((file) => file.content.includes(safeMarker))), `${granularity} context must include the safe marker`)
      assert.ok(built.batches.some((batch) => batch.files.some((file) => file.content.includes(nestedSafeMarker))), `${granularity} context must include the nested safe marker`)
      assert.doesNotMatch(JSON.stringify(built), new RegExp(secretMarker))
      assert.doesNotMatch(built.treeText, /credentials/)
    }

    const reused = await cache.getFresh(selectedRoot)
    assert.equal(reused.status, 'reused', 'same unchanged literal-root scan should be reused')
    assert.equal(reused.scan, scan)
    const reusedContext = await buildContext(reused.scan, 'medium')
    assert.ok(reusedContext.batches.some((batch) => batch.files.some((file) => file.content.includes(safeMarker))))

    await fs.writeFile(path.join(selectedRoot, 'README.md'), `# ${refreshedMarker}\n`)
    const changed = await cache.getFresh(selectedRoot)
    assert.equal(changed.status, 'scanned', 'changed snapshot must trigger a fresh scan')
    assert.notEqual(changed.scan, scan)
    assert.ok((await buildContext(changed.scan, 'coarse')).batches.some((batch) => batch.files.some((file) => file.content.includes(refreshedMarker))))
    const refreshed = await cache.refresh(selectedRoot)
    assert.equal(refreshed.status, 'scanned')
    assert.equal(refreshed.reason, 'forced')
    assert.ok((await buildContext(refreshed.scan, 'coarse')).batches.some((batch) => batch.files.some((file) => file.content.includes(refreshedMarker))))

    const generationAlias = path.join(root, 'ordinary-alias')
    await fs.symlink(selectedRoot, generationAlias, 'dir')
    // Keep the generated project name within the existing result-contract while scanning the same canonical literal-path root.
    const generationScan = await scanProject(generationAlias)
    assert.equal(await fs.realpath(generationAlias), scan.root, 'generation alias must resolve to the literal selected root')
    assert.equal(generationScan.name, path.basename(generationAlias), 'generation scan must retain its safe alias display name')
    assert.ok(generationScan.files.find((file) => file.relPath === nestedReadmePath)?.isContentCandidate, 'generation scan must retain the nested literal-backslash candidate')
    // @ts-ignore TS5097 -- intentional dynamic Node test imports.
    await import('../../tests/register-shared-alias.mjs')
    // @ts-ignore TS5097 -- generator.ts uses the bundler's @shared alias by design.
    const { generateInterview } = await import('./generator.ts')
    globalThis.fetch = async (_input, init) => {
      capturedBodies.push(JSON.parse(String(init?.body)) as typeof capturedBodies[number])
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        projectSummary: 'Synthetic POSIX path fixture.',
        sections: [{ title: 'Fixture', summary: 'Synthetic output.', questions: Array.from({ length: 20 }, (_, index) => ({ question: `Question ${index + 1}?`, answer: 'Synthetic answer.', followUps: [] })) }],
        glossary: {}
      }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    await generateInterview({
      scan: generationScan,
      granularity: 'medium',
      roleFocus: 'general',
      profile: { id: 'synthetic-posix-profile', name: 'Synthetic only', baseUrl: 'https://example.invalid/v1', apiKey: 'synthetic-profile-key', model: 'mock-model' },
      signal: new AbortController().signal,
      onProgress: () => {}
    })
    const requestBody = JSON.stringify(capturedBodies)
    assert.equal(capturedBodies.length, 1)
    assert.ok(requestBody.includes(safeMarker), 'mocked model request must include the safe literal-path content')
    assert.ok(requestBody.includes(nestedSafeMarker), 'mocked model request must include content from the literal-backslash directory')
    assert.ok(requestBody.includes(refreshedMarker), 'mocked model request must use the refreshed selected-root scan')
    assert.doesNotMatch(requestBody, new RegExp(secretMarker), 'mocked model request must exclude real sensitive-directory content')
    assert.doesNotMatch(requestBody, /credentials/)
  } finally {
    globalThis.fetch = originalFetch
    await removeFixture(root)
  }
})

test('real scan-to-generation path redacts refresh-token forms from ordinary project settings and source', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'projectlens-refresh-token-'))
  const settingsSource = JSON.stringify({
    refresh_token: 'FAKE_OAUTH_REFRESH_JSON_SNAKE_71C4',
    refreshToken: 'FAKE_OAUTH_REFRESH_JSON_CAMEL_82D5',
    'refresh-token': 'FAKE_OAUTH_REFRESH_JSON_DASH_93E6',
    access_token: 'FAKE_OAUTH_ACCESS_JSON_A14F',
    ordinaryLabel: 'keep-ordinary-settings-label'
  }, null, 2)
  const source = [
    'const APP_REFRESH_TOKEN = "FAKE_OAUTH_REFRESH_SOURCE_SNAKE_B25A";',
    "const partnerRefreshToken = 'FAKE_OAUTH_REFRESH_SOURCE_CAMEL_C36B';",
    'const CLIENT_REFRESH_TOKEN = `FAKE_OAUTH_REFRESH_SOURCE_BACKTICK_D47C`;',
    'const credentials = { "refresh-token": "FAKE_OAUTH_REFRESH_SOURCE_DASH_E58D", label: "keep-source-label" };',
    'const exampleRefreshToken = "YOUR_REFRESH_TOKEN";',
    'const alreadyRedactedRefreshToken = "[REDACTED:secret-assignment]";',
    'const refreshTokenCacheName = "keep-near-name-value";',
    'interface OAuthSettings { refreshToken: string; }',
    'type RefreshTokenExample = { refresh_token: "YOUR_REFRESH_TOKEN" };'
  ].join('\n')
  const fakeSecrets = [
    'FAKE_OAUTH_REFRESH_JSON_SNAKE_71C4',
    'FAKE_OAUTH_REFRESH_JSON_CAMEL_82D5',
    'FAKE_OAUTH_REFRESH_JSON_DASH_93E6',
    'FAKE_OAUTH_ACCESS_JSON_A14F',
    'FAKE_OAUTH_REFRESH_SOURCE_SNAKE_B25A',
    'FAKE_OAUTH_REFRESH_SOURCE_CAMEL_C36B',
    'FAKE_OAUTH_REFRESH_SOURCE_BACKTICK_D47C',
    'FAKE_OAUTH_REFRESH_SOURCE_DASH_E58D'
  ]
  const expectedMatches = fakeSecrets.length
  const fakeModelResult = {
    projectSummary: 'Synthetic settings and source fixture.',
    sections: [{
      title: 'Configuration',
      summary: 'Synthetic configuration behavior.',
      questions: Array.from({ length: 20 }, (_, index) => ({
        question: `Synthetic question ${index + 1}?`,
        answer: `Synthetic answer ${index + 1}.`,
        followUps: []
      }))
    }],
    glossary: {}
  }
  const profile = {
    id: 'synthetic-refresh-profile', name: 'Synthetic only', baseUrl: 'https://example.invalid/v1',
    apiKey: 'synthetic-refresh-profile-key', model: 'mock-model'
  }
  const originalFetch = globalThis.fetch
  const capturedBodies: Array<{ messages: Array<{ role: string; content: string }> }> = []
  try {
    await fs.writeFile(path.join(root, 'settings.json'), settingsSource)
    await fs.writeFile(path.join(root, 'oauth-settings.ts'), source)

    const scan = await scanProject(root)
    assert.equal(scan.security.excludedFiles, 0, 'ordinary settings.json must remain an eligible project file')
    for (const relPath of ['settings.json', 'oauth-settings.ts']) {
      assert.ok(scan.files.some((file) => file.relPath === relPath && file.isContentCandidate), `${relPath} should be scanned as ordinary content`)
    }

    const built = await buildContext(scan, 'medium')
    assert.equal(built.batches.length, 1)
    assert.equal(built.batches[0].files.length, 2)
    assert.equal(built.contentSecurity.redactedFiles, 2)
    assert.equal(built.contentSecurity.redactionMatches, expectedMatches)
    assert.equal(built.contentSecurity.matchesByCategory['secret-assignment'], expectedMatches)
    for (const [relPath, expectedCount] of [['settings.json', 4], ['oauth-settings.ts', 4]] as const) {
      const file = built.batches[0].files.find((item) => item.relPath === relPath)
      assert.ok(file, `${relPath} should be present in the real context batch`)
      assert.equal(file.redactionMatches, expectedCount)
      const markerCount = (file.content.match(/\[REDACTED:secret-assignment\]/g) ?? []).length
      assert.equal(markerCount, expectedCount + (relPath === 'oauth-settings.ts' ? 1 : 0))
    }
    const sourceContext = built.batches[0].files.find((file) => file.relPath === 'oauth-settings.ts')?.content ?? ''
    assert.match(sourceContext, /YOUR_REFRESH_TOKEN/)
    assert.match(sourceContext, /alreadyRedactedRefreshToken = "\[REDACTED:secret-assignment\]"/)
    assert.match(sourceContext, /refreshToken: string/)
    assert.match(sourceContext, /keep-near-name-value/)
    assert.match(sourceContext, /keep-source-label/)

    const rendered = renderBatch(built.headerText, treeToText(scan.tree), built.batches[0])
    for (const secret of fakeSecrets) assert.doesNotMatch(rendered, new RegExp(secret))
    for (const safeValue of ['YOUR_REFRESH_TOKEN', 'keep-ordinary-settings-label', 'keep-near-name-value', 'keep-source-label', 'refreshToken: string']) {
      assert.ok(rendered.includes(safeValue), `${safeValue} should remain in rendered context`)
    }

    // Register the repo's normal direct-Node import alias before loading the real generator.
    // @ts-ignore TS5097 -- intentional dynamic Node test imports.
    await import('../../tests/register-shared-alias.mjs')
    // @ts-ignore TS5097 -- generator.ts uses the bundler's @shared alias by design.
    const { generateInterview } = await import('./generator.ts')
    globalThis.fetch = async (_input, init) => {
      capturedBodies.push(JSON.parse(String(init?.body)) as typeof capturedBodies[number])
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(fakeModelResult) } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    const progress: Array<{ step: string; detail?: string }> = []
    const generated = await generateInterview({
      scan,
      granularity: 'medium',
      roleFocus: 'general',
      profile,
      signal: new AbortController().signal,
      onProgress: (step, detail) => progress.push({ step, detail })
    })
    globalThis.fetch = originalFetch

    assert.equal(capturedBodies.length, 1)
    const serializedRequest = JSON.stringify(capturedBodies[0])
    for (const secret of fakeSecrets) assert.doesNotMatch(serializedRequest, new RegExp(secret))
    for (const safeValue of ['YOUR_REFRESH_TOKEN', 'keep-ordinary-settings-label', 'keep-near-name-value', 'keep-source-label', 'refreshToken: string']) {
      assert.ok(serializedRequest.includes(safeValue), `${safeValue} should remain in the mocked request`)
    }
    const contextReady = progress.find((item) => item.step === '上下文就绪')
    assert.ok(contextReady?.detail?.includes(`脱敏 2 个文件（${expectedMatches} 处）`))
    for (const secret of fakeSecrets) assert.doesNotMatch(JSON.stringify(progress), new RegExp(secret))
    assert.equal(generated.sections.reduce((sum, section) => sum + section.questions.length, 0), 20)
    assert.equal(generated.security?.redactedFiles, 2)
    assert.equal(generated.security?.redactionMatches, expectedMatches)
    assert.equal(generated.security?.categories['secret-assignment'], expectedMatches)
    for (const secret of fakeSecrets) assert.doesNotMatch(JSON.stringify(generated), new RegExp(secret))
  } finally {
    globalThis.fetch = originalFetch
    const tempRoot = path.resolve(os.tmpdir())
    const fixtureRoot = path.resolve(root)
    const relativeFixtureRoot = path.relative(tempRoot, fixtureRoot)
    assert.ok(relativeFixtureRoot !== '' && relativeFixtureRoot !== '..' && !relativeFixtureRoot.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeFixtureRoot), 'fixture cleanup must stay below the temp directory')
    await fs.rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('real scan-to-generation path keeps multiline YAML and TOML credentials out of the model request', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'projectlens-multiline-secret-'))
  const yamlSecrets = [
    'FAKE_YAML_REFRESH_MULTILINE_3A71_FIRST_LINE', 'FAKE_YAML_REFRESH_MULTILINE_3A71_SECOND_LINE',
    'FAKE_YAML_ACCESS_FOLDED_4B82_FIRST_LINE', 'FAKE_YAML_ACCESS_FOLDED_4B82_SECOND_LINE'
  ]
  const tomlSecrets = [
    'FAKE_TOML_REFRESH_BASIC_5C93_FIRST_LINE', 'FAKE_TOML_REFRESH_BASIC_5C93_SECOND_LINE',
    'FAKE_TOML_API_LITERAL_6DA4_FIRST_LINE', 'FAKE_TOML_API_LITERAL_6DA4_SECOND_LINE'
  ]
  const secrets = [...yamlSecrets, ...tomlSecrets]
  const assignmentCount = 4
  const yamlSource = [
    'refresh_token: |-',
    `  ${yamlSecrets[0]}`,
    `  ${yamlSecrets[1]}`,
    'safe_yaml_after_literal: KEEP_YAML_LITERAL_SETTING',
    'access_token: >+',
    `  ${yamlSecrets[2]}`,
    `  ${yamlSecrets[3]}`,
    'safe_yaml_after_folded: KEEP_YAML_FOLDED_SETTING'
  ].join('\n')
  const tomlSource = [
    'refreshToken = """',
    `${tomlSecrets[0]}`,
    `${tomlSecrets[1]}`,
    '"""',
    'safe_toml_after_basic = "KEEP_TOML_BASIC_SETTING"',
    "api_key = '''",
    `${tomlSecrets[2]}`,
    `${tomlSecrets[3]}`,
    "'''",
    'safe_toml_after_literal = "KEEP_TOML_LITERAL_SETTING"'
  ].join('\n')
  const fakeModelResult = {
    projectSummary: 'Synthetic multiline configuration summary.',
    sections: [{
      title: 'Configuration',
      summary: 'Synthetic multiline configuration behavior.',
      questions: Array.from({ length: 20 }, (_, index) => ({
        question: `Synthetic multiline question ${index + 1}?`,
        answer: `Synthetic multiline answer ${index + 1}.`,
        followUps: []
      }))
    }],
    glossary: {}
  }
  const profile = {
    id: 'synthetic-multiline-profile', name: 'Synthetic only', baseUrl: 'https://example.invalid/v1',
    apiKey: 'synthetic-multiline-profile-key', model: 'mock-model'
  }
  const originalFetch = globalThis.fetch
  const capturedBodies: Array<{ messages: Array<{ role: string; content: string }> }> = []
  try {
    await fs.writeFile(path.join(root, 'application.yaml'), yamlSource)
    await fs.writeFile(path.join(root, 'service.toml'), tomlSource)

    const scan = await scanProject(root)
    assert.equal(scan.security.excludedFiles, 0)
    for (const relPath of ['application.yaml', 'service.toml']) {
      assert.ok(scan.files.some((file) => file.relPath === relPath && file.isContentCandidate), `${relPath} should be eligible content`)
    }
    const built = await buildContext(scan, 'medium')
    assert.equal(built.batches.length, 1)
    assert.equal(built.contentSecurity.redactedFiles, 2)
    assert.equal(built.contentSecurity.redactionMatches, assignmentCount)
    assert.equal(built.contentSecurity.matchesByCategory['secret-assignment'], assignmentCount)

    for (const relPath of ['application.yaml', 'service.toml']) {
      const file = built.batches[0].files.find((item) => item.relPath === relPath)
      assert.ok(file, `${relPath} should remain in generated context`)
      assert.ok(file.redactionMatches > 0)
      for (const secret of secrets) assert.doesNotMatch(file.content, new RegExp(secret))
    }
    const safeValues = ['KEEP_YAML_LITERAL_SETTING', 'KEEP_YAML_FOLDED_SETTING', 'KEEP_TOML_BASIC_SETTING', 'KEEP_TOML_LITERAL_SETTING']
    const contextContents = built.batches[0].files.map((file) => file.content).join('\n')
    for (const value of safeValues) assert.ok(contextContents.includes(value), `${value} should remain in context`)
    const rendered = renderBatch(built.headerText, treeToText(scan.tree), built.batches[0])
    for (const secret of secrets) assert.doesNotMatch(rendered, new RegExp(secret))
    for (const value of safeValues) assert.ok(rendered.includes(value), `${value} should remain in rendered context`)

    // @ts-ignore TS5097 -- intentional dynamic Node test imports.
    await import('../../tests/register-shared-alias.mjs')
    // @ts-ignore TS5097 -- generator.ts uses the bundler's @shared alias by design.
    const { generateInterview } = await import('./generator.ts')
    globalThis.fetch = async (_input, init) => {
      capturedBodies.push(JSON.parse(String(init?.body)) as typeof capturedBodies[number])
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(fakeModelResult) } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    const progress: Array<{ step: string; detail?: string }> = []
    const generated = await generateInterview({
      scan,
      granularity: 'medium',
      roleFocus: 'general',
      profile,
      signal: new AbortController().signal,
      onProgress: (step, detail) => progress.push({ step, detail })
    })
    globalThis.fetch = originalFetch

    assert.equal(capturedBodies.length, 1)
    const serializedRequest = JSON.stringify(capturedBodies[0])
    for (const secret of secrets) assert.doesNotMatch(serializedRequest, new RegExp(secret))
    for (const value of safeValues) assert.ok(serializedRequest.includes(value), `${value} should reach the mocked request`)
    const contextReady = progress.find((item) => item.step === '上下文就绪')
    assert.ok(contextReady?.detail?.includes(`脱敏 2 个文件（${assignmentCount} 处）`))
    for (const secret of secrets) assert.doesNotMatch(JSON.stringify(progress), new RegExp(secret))
    assert.equal(generated.sections.reduce((sum, section) => sum + section.questions.length, 0), 20)
    assert.equal(generated.security?.redactedFiles, 2)
    assert.equal(generated.security?.redactionMatches, assignmentCount)
    assert.equal(generated.security?.categories['secret-assignment'], assignmentCount)
    for (const secret of secrets) assert.doesNotMatch(JSON.stringify(generated), new RegExp(secret))
  } finally {
    globalThis.fetch = originalFetch
    const fixtureRoot = path.resolve(root)
    const tempRoot = path.resolve(os.tmpdir())
    const relativeFixtureRoot = path.relative(tempRoot, fixtureRoot)
    assert.ok(relativeFixtureRoot !== '' && relativeFixtureRoot !== '..' && !relativeFixtureRoot.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeFixtureRoot), 'fixture cleanup must stay below the temp directory')
    await fs.rm(fixtureRoot, { recursive: true, force: true })
  }
})
