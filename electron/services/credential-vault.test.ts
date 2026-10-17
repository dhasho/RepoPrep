import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore Node 24 direct TypeScript tests require runtime .ts suffixes.
import { decryptCredential, encryptCredential, isSupportedCredentialBackend, type CredentialCrypto } from './credential-vault.ts'

const fakeCrypto = (overrides: Partial<CredentialCrypto> = {}): CredentialCrypto => ({
  isAvailable: async () => true,
  encrypt: async (plaintext) => Buffer.from(`cipher:${plaintext}`),
  decrypt: async (ciphertext) => ciphertext.toString().replace(/^cipher:/, ''),
  ...overrides
})

test('async credential adapter encrypts and decrypts without exposing failures', async () => {
  const key = 'synthetic-credential-only'
  const encrypted = await encryptCredential(key, fakeCrypto())
  assert.equal(encrypted.version, 1)
  assert.notEqual(encrypted.ciphertext, key)
  assert.equal(await decryptCredential(encrypted, fakeCrypto()), key)
  await assert.rejects(encryptCredential(key, fakeCrypto({ encrypt: async () => { throw new Error(`raw ${key}`) } })), /credential-encryption-failed/)
  await assert.rejects(decryptCredential(encrypted, fakeCrypto({ decrypt: async () => { throw new Error(`raw ${key}`) } })), /credential-decryption-failed/)
})

test('unavailable crypto and malformed ciphertext fail closed', async () => {
  const unavailable = fakeCrypto({ isAvailable: async () => false })
  await assert.rejects(encryptCredential('synthetic', unavailable), /credential-store-unavailable/)
  await assert.rejects(decryptCredential({ version: 1, ciphertext: 'not base64!' }, fakeCrypto()), /credential-format-invalid/)
  await assert.rejects(decryptCredential({ version: 2, ciphertext: 'YQ==' }, fakeCrypto()), /credential-format-invalid/)
})

test('Linux text and unknown backends are rejected unless an OS credential provider is identified', () => {
  assert.equal(isSupportedCredentialBackend('linux', 'basic_text'), false)
  assert.equal(isSupportedCredentialBackend('linux', 'unknown'), false)
  assert.equal(isSupportedCredentialBackend('linux', null), false)
  assert.equal(isSupportedCredentialBackend('linux', 'gnome_libsecret'), true)
  assert.equal(isSupportedCredentialBackend('win32', null), true)
})
