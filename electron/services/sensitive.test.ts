import test from 'node:test'
import assert from 'node:assert/strict'
// Node 24 executes the TypeScript source directly; tsc accepts this explicit
// extension through the narrowly scoped suppression below.
// @ts-ignore TS5097 -- intentional node:test TypeScript source import
import { classifySensitivePath, redactSensitiveContent } from './sensitive.ts'

test('classifies secret paths without excluding ordinary config.json', () => {
  assert.equal(classifySensitivePath('.env.local')?.category, 'env-file')
  assert.equal(classifySensitivePath('config\\.aws\\credentials')?.category, 'cloud-credential')
  assert.equal(classifySensitivePath('.ssh/id_ed25519')?.category, 'private-key-file')
  assert.notEqual(classifySensitivePath('.ssh/id_ed25519.pub')?.category, 'private-key-file')
  assert.equal(classifySensitivePath('certs/service.p12')?.category, 'private-key-file')
  assert.equal(classifySensitivePath('gcp/service-account-prod.json')?.category, 'cloud-credential')
  assert.equal(classifySensitivePath('.docker/config.json')?.category, 'cloud-credential')
  assert.equal(classifySensitivePath('src/config.json'), null)
  assert.equal(classifySensitivePath('src/types.ts'), null)
})

test('covers Google AI, AWS secret assignments, JSON/YAML keys and examples', () => {
  const source = [
    'google = AIza123456789012345678901234567890',
    'AWS_SECRET_ACCESS_KEY: real-aws-secret',
    'aws_session_token = "real-session-token"',
    'const apiKey = "real-camel-key"',
    '"clientSecret": "real-json-secret",',
    'apiKey: your_api_key',
    'const token: string = "type declaration"',
    'export password: changeme'
  ].join('\n')
  const result = redactSensitiveContent(source)
  assert.equal(result.totalMatches, 5)
  assert.doesNotMatch(result.content, /AIza123|real-aws|real-session|real-camel|real-json/)
  assert.match(result.content, /apiKey: your_api_key/)
  assert.match(result.content, /token: string = "type declaration"/)
  assert.match(result.content, /password: changeme/)
})

test('redacts PEM, provider tokens, JWT, bearer and connection credentials', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'
  const source = `${pem}\nGH=ghp_1234567890abcdefghijkl\nJWT=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signaturepart123\nAuthorization: Bearer abcdefghijklmnop\npostgres://alice:super-secret@db.example.test/app`
  const result = redactSensitiveContent(source)
  assert.equal(result.totalMatches, 5)
  assert.match(result.content, /\[REDACTED:private-key\]/)
  assert.match(result.content, /\[REDACTED:token\]/)
  assert.match(result.content, /\[REDACTED:jwt\]/)
  assert.match(result.content, /Bearer \[REDACTED:bearer-token\]/)
  assert.match(result.content, /alice:\[REDACTED:connection-string\]@/)
  assert.doesNotMatch(result.content, /super-secret|ghp_123|BEGIN PRIVATE KEY/)
})

test('redacts assignment values while retaining key names and CRLF', () => {
  const result = redactSensitiveContent('API_KEY="abc123secret"\r\npassword: p@ssw0rd\r\nconst token: string = "safe type declaration"\r\n')
  assert.equal(result.totalMatches, 2)
  assert.match(result.content, /API_KEY="\[REDACTED:secret-assignment\]"\r\n/)
  assert.match(result.content, /password: \[REDACTED:secret-assignment\]\r\n/)
  assert.match(result.content, /const token: string = "safe type declaration"/)
  assert.match(result.content, /API_KEY/)
  assert.doesNotMatch(result.content, /abc123secret|p@ssw0rd/)
})

test('does not redact harmless declarations and handles case-insensitive keys', () => {
  const result = redactSensitiveContent('interface Config { token: string }\nconst normal = "hello"\nSeCrEt = placeholder')
  assert.equal(result.totalMatches, 0)
  assert.match(result.content, /SeCrEt = placeholder/)
  assert.match(result.content, /token: string/)
})

test('redacts typed, dotted, template, JSON and YAML assignments without type false positives', () => {
  const source = [
    'const apiKey: string = "typed-api-value";',
    'const password?: string = "optional-password";',
    'config.apiKey = "dotted-api-value";',
    'settings.password = "dotted-password";',
    'API_KEY = `template-api-value`',
    'password: yaml-password # comment',
    '"apiKey": "json-api-value",',
    'apiKey: unquoted-yaml-value',
    'interface Config { apiKey: string }',
    'apiKey?: string'
  ].join('\n')
  const result = redactSensitiveContent(source)
  assert.equal(result.totalMatches, 8)
  for (const secret of ['typed-api-value', 'optional-password', 'dotted-api-value', 'dotted-password', 'template-api-value', 'yaml-password', 'json-api-value', 'unquoted-yaml-value']) {
    assert.doesNotMatch(result.content, new RegExp(secret))
  }
  assert.match(result.content, /interface Config \{ apiKey: string \}/)
  assert.match(result.content, /apiKey\?: string/)
  assert.match(result.content, /password: \[REDACTED:secret-assignment\] # comment/)
})

test('redacts common property and bracket assignments, not reads or comparisons', () => {
  const source = [
    'module.exports.apiKey = "REAL-module"',
    'process.env.API_KEY = "REAL-env"',
    'settings.auth.credentials.clientSecret = `REAL-deep`',
    'obj["apiKey"] = "REAL-bracket-double"',
    "obj['password'] = 'REAL-bracket-single'",
    'console.log(obj.apiKey)',
    'if (obj.apiKey === value) {}',
    'interface Config { apiKey: string }',
    'obj.apiKey = your_api_key'
  ].join('\n')
  const result = redactSensitiveContent(source)
  assert.equal(result.totalMatches, 5)
  for (const secret of ['REAL-module', 'REAL-env', 'REAL-deep', 'REAL-bracket-double', 'REAL-bracket-single']) {
    assert.doesNotMatch(result.content, new RegExp(secret))
  }
  assert.match(result.content, /console\.log\(obj\.apiKey\)/)
  assert.match(result.content, /obj\.apiKey === value/)
  assert.match(result.content, /obj\.apiKey = your_api_key/)
})
