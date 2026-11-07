import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import Module from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createOneShotAuthorizationClaim } from './retrieval-eval.mjs'

const require = createRequire(import.meta.url)
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: {} }
  return originalLoad.call(this, request, parent, isMain)
}
const { args, prepareStartupSynchronously, runStartupStages, staticErrorCode } = require('../evaluation/run-retrieval-profile-entry.cjs')
const { parseArgs } = require('../evaluation/run-retrieval-profile.cjs')
Module._load = originalLoad

test('startup stages record the precise stage and stop after a safe failure', async () => {
  const observed = []
  const execute = runStartupStages([
    ['settings-staging', async () => { observed.push('staged'); return { ok: true } }],
    ['app-ready', async () => { throw new Error('os-crypt-app-bound-unsupported') }],
    ['profile-decrypt', async () => { observed.push('must-not-run') }]
  ])
  let stage = ''
  await assert.rejects(execute({ setStage: value => { stage = value } }), /os-crypt-app-bound-unsupported/)
  assert.equal(stage, 'app-ready')
  assert.deepEqual(observed, ['staged'])
})

test('startup diagnostics expose only allowlisted static codes', () => {
  assert.equal(staticErrorCode(new Error('os-crypt-app-bound-unsupported')), 'os-crypt-app-bound-unsupported')
  assert.equal(staticErrorCode(new Error('secret ciphertext or credential data')), 'startup-failed')
  assert.equal(staticErrorCode(new Error('profile-binding-mismatch')), 'profile-binding-mismatch')
})

test('credential preflight is an explicit option and keeps authorization mandatory', () => {
  const parsed = parseArgs(['--authorization', 'approval.json', '--settings-dir', 'settings', '--credential-preflight'])
  assert.equal(parsed.credentialPreflight, true)
  assert.throws(() => parseArgs(['--settings-dir', 'settings', '--credential-preflight']))
  const electronArgs = args(['--runtime-root', 'runtime', '--repo-root', 'repo', '--settings-dir', 'settings', '--authorization', 'approval.json', '--output', 'out', '--credential-preflight'])
  assert.equal(electronArgs.credentialPreflight, true)
})

test('synchronous startup stages encrypted state and Electron paths before readiness', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm06-startup-order-'))
  try {
    const repo = path.join(root, 'repo'), settingsDir = path.join(root, 'source-user-data'), runtimeRoot = path.join(root, 'runtime')
    fs.mkdirSync(repo); fs.mkdirSync(settingsDir); fs.mkdirSync(runtimeRoot)
    const sourceCommit = 'a'.repeat(40), retrievalDataHash = 'b'.repeat(64)
    const authorization = {
      purpose: 'm06-retrieval-v1', reference: 'startup-test', sourceCommit, retrievalDataHash,
      endpointFingerprint: createHash('sha256').update('https://example.invalid/v1').digest('hex'),
      model: 'approved-test-model', protocol: 'openai', temperature: 0.4, reasoningEffort: null,
      contextWindowTokens: 4096, maxOutputTokens: 2000, maxRuns: 40, maxRequests: 120,
      maxInputTokens: 720000, maxOutputTokensTotal: 240000
    }
    const authorizationPath = path.join(root, 'authorization.json')
    fs.writeFileSync(authorizationPath, JSON.stringify(authorization))
    const binding = { sourceCommit, retrievalDataHash, reference: authorization.reference }
    const claimsDir = path.join(repo, '.validation', 'agentic', 'claims')
    fs.mkdirSync(claimsDir, { recursive: true })
    const canonicalClaim = await createOneShotAuthorizationClaim(claimsDir, binding)
    const profile = {
      id: 'synthetic-profile', baseUrl: 'https://example.invalid/v1', model: authorization.model,
      protocol: 'openai', temperature: 0.4, contextWindowTokens: 4096,
      credential: { version: 1, ciphertext: 'synthetic-ciphertext' }
    }
    fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify({ schemaVersion: 2, defaultProfileId: profile.id, profiles: [profile] }))
    fs.writeFileSync(path.join(settingsDir, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: Buffer.from('DPAPI-synthetic-key').toString('base64') } }))
    const appCalls = [], stages = []
    const prepared = prepareStartupSynchronously({
      repoRoot: repo, authorizationPath, settingsDir, runtimeRoot, outputDir: path.join(root, 'unused'), credentialPreflight: true
    }, {
      appApi: { setPath: (key, value) => appCalls.push([key, value]) },
      secureRuntime: () => true,
      checkAuthorization: () => ({ ...binding, authorization }),
      setStage: stage => stages.push(stage)
    })
    assert.equal(prepared.claim.claimId, canonicalClaim.claimId)
    assert.equal(prepared.claim.claimPath, canonicalClaim.claimPath)
    assert.deepEqual(appCalls.map(([key]) => key), ['appData', 'sessionData', 'logs', 'userData'])
    assert.equal(fs.existsSync(path.join(prepared.isolated, 'Local State')), true)
    assert.equal(fs.existsSync(path.join(prepared.isolated, 'settings.json')), true)
    assert.deepEqual(stages, ['authorization', 'claim', 'private-runtime', 'saved-public-profile', 'settings-staging', 'electron-paths'])
    assert.equal(fs.existsSync(path.join(claimsDir, `${canonicalClaim.claimId}.started`)), false)
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    assert.match(path.basename(root), /^m06-startup-order-/u)
    assert.equal(fs.lstatSync(root).isSymbolicLink(), false)
    fs.rmSync(root, { recursive: true, force: true })
  }
})
