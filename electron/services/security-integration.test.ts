import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
// @ts-ignore TS5097 -- Node executes this test source directly.
import { scanProject, treeToText } from './scanner.ts'
// @ts-ignore TS5097 -- Node executes this test source directly.
import { buildContext, renderBatch } from './context-builder.ts'

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
