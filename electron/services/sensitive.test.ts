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
  const repeated = redactSensitiveContent(result.content)
  assert.equal(repeated.content, result.content)
  assert.equal(repeated.totalMatches, 0, 'existing connection placeholders must not count as new replacements')
})

test('redacts non-empty URI passwords with empty usernames and preserves URI boundaries', () => {
  const source = [
    'redis://:FAKE_EMPTY_USER_REDIS_PASSWORD@cache.invalid:6379/0?keep=redis-query-value',
    'rediss://:FAKE_EMPTY_USER_TLS_PASSWORD@cache.invalid:6380/1#keep-fragment',
    'postgres://named-user:FAKE_NAMED_USER_GENERIC_PASSWORD@db.invalid/app?keep=generic-query',
    'redis://encoded%3Auser:FAKE%40%3A%2F_ENCODED_PASSWORD@cache.invalid/path%40name?keep=query',
    'redis://:@cache.invalid/path',
    'redis://user:@cache.invalid/path',
    'redis://user@cache.invalid/path',
    'redis://cache.invalid:6379/0',
    'redis://[2001:db8::1]:6379/0'
  ].join('\n')
  const result = redactSensitiveContent(source)

  assert.equal(result.totalMatches, 4)
  assert.deepEqual(result.matches, [{ category: 'connection-string', count: 4 }])
  for (const secret of [
    'FAKE_EMPTY_USER_REDIS_PASSWORD',
    'FAKE_EMPTY_USER_TLS_PASSWORD',
    'FAKE_NAMED_USER_GENERIC_PASSWORD',
    'FAKE%40%3A%2F_ENCODED_PASSWORD'
  ]) {
    assert.doesNotMatch(result.content, new RegExp(secret))
  }
  assert.match(result.content, /redis:\/\/:\[REDACTED:connection-string\]@cache\.invalid:6379\/0\?keep=redis-query-value/)
  assert.match(result.content, /rediss:\/\/:\[REDACTED:connection-string\]@cache\.invalid:6380\/1#keep-fragment/)
  assert.match(result.content, /postgres:\/\/named-user:\[REDACTED:connection-string\]@db\.invalid\/app\?keep=generic-query/)
  assert.match(result.content, /redis:\/\/encoded%3Auser:\[REDACTED:connection-string\]@cache\.invalid\/path%40name\?keep=query/)
  assert.match(result.content, /redis:\/\/:@cache\.invalid\/path/)
  assert.match(result.content, /redis:\/\/user:@cache\.invalid\/path/)
  assert.match(result.content, /redis:\/\/user@cache\.invalid\/path/)
  assert.match(result.content, /redis:\/\/cache\.invalid:6379\/0/)
  assert.match(result.content, /redis:\/\/\[2001:db8::1\]:6379\/0/)

  const repeated = redactSensitiveContent(result.content)
  assert.equal(repeated.content, result.content)
  assert.equal(repeated.totalMatches, 0)
})

test('URI credential scanning stays usable on large values and finds multiple credentials', () => {
  const filler = 'ordinary-value-'.repeat(20_000)
  const source = `${filler}\nredis://:FAKE_LARGE_EMPTY_USER_PASSWORD@cache.invalid/0\nrediss://user:FAKE_LARGE_NAMED_USER_PASSWORD@cache.invalid/1`
  const result = redactSensitiveContent(source)

  assert.equal(result.totalMatches, 2)
  assert.deepEqual(result.matches, [{ category: 'connection-string', count: 2 }])
  assert.ok(result.content.startsWith(filler))
  assert.doesNotMatch(result.content, /FAKE_LARGE_EMPTY_USER_PASSWORD|FAKE_LARGE_NAMED_USER_PASSWORD/)
  assert.equal(redactSensitiveContent(result.content).totalMatches, 0)
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

test('redacts compact JSON and inline object secrets independently while preserving keys and separators', () => {
  const source = [
    '{"apiKey":"inline-json-secret","password":"json-password-secret","accessToken":"json-access-secret","clientSecret":"json-client-secret"}',
    'const config={apiKey:"inline-api-secret", password:\'inline-password-secret\', accessToken:`inline-access-secret`, clientSecret:"inline-client-secret"};',
    'const last = "safe";'
  ].join('\n')
  const result = redactSensitiveContent(source)
  assert.equal(result.totalMatches, 8)
  for (const secret of [
    'inline-json-secret', 'json-password-secret', 'json-access-secret', 'json-client-secret',
    'inline-api-secret', 'inline-password-secret', 'inline-access-secret', 'inline-client-secret'
  ]) {
    assert.doesNotMatch(result.content, new RegExp(secret))
  }
  assert.match(result.content, /"apiKey":"\[REDACTED:secret-assignment\]","password":"\[REDACTED:secret-assignment\]"/)
  assert.match(result.content, /const config=\{apiKey:"\[REDACTED:secret-assignment\]", password:'\[REDACTED:secret-assignment\]', accessToken:`\[REDACTED:secret-assignment\]`, clientSecret:"\[REDACTED:secret-assignment\]"\};/)
  assert.match(result.content, /const last = "safe";/)

  const again = redactSensitiveContent(result.content)
  assert.equal(again.content, result.content, 'redaction must be idempotent')
  assert.equal(again.totalMatches, 0, 'placeholders are not counted as new secrets')
})

test('escaped quotes do not truncate a JSON secret value before its closing delimiter', () => {
  const source = '{"apiKey":"escaped \\" quote inline-json-escaped-secret","clientSecret":"second-inline-secret"}'
  const result = redactSensitiveContent(source)
  assert.equal(result.totalMatches, 2)
  assert.doesNotMatch(result.content, /inline-json-escaped-secret|second-inline-secret/)
  assert.match(result.content, /"apiKey":"\[REDACTED:secret-assignment\]","clientSecret":"\[REDACTED:secret-assignment\]"/)
})

test('large and malformed source values are handled without losing identified secrets or recursing', () => {
  const longValue = 'large-inline-fake-secret-'.repeat(8_000)
  const source = `{"apiKey":"${longValue}","password":"next-secret"}`
  const result = redactSensitiveContent(source)
  assert.equal(result.totalMatches, 2)
  assert.doesNotMatch(result.content, /large-inline-fake-secret|next-secret/)
  assert.match(result.content, /"apiKey":"\[REDACTED:secret-assignment\]","password":"\[REDACTED:secret-assignment\]"/)

  const malformed = `${'{"apiKey":"unterminated\n'.repeat(4_000)}const password = `
  const damaged = redactSensitiveContent(malformed)
  assert.ok(Number.isSafeInteger(damaged.totalMatches))
  assert.ok(damaged.content.length <= malformed.length + 4_000 * '[REDACTED:secret-assignment]'.length + 64)
})

test('redacts multiple assignments inside one source line, including typed and bracket properties', () => {
  const source = 'function f(){ config.apiKey="fake-inline-assignment"; obj[\'password\']=\'fake-inline-bracket\'; let accessToken: string="fake-inline-typed"; const other = "safe"; }'
  const result = redactSensitiveContent(source)
  assert.equal(result.totalMatches, 3)
  for (const secret of ['fake-inline-assignment', 'fake-inline-bracket', 'fake-inline-typed']) {
    assert.doesNotMatch(result.content, new RegExp(secret))
  }
  assert.match(result.content, /config\.apiKey="\[REDACTED:secret-assignment\]"/)
  assert.match(result.content, /obj\['password'\]='\[REDACTED:secret-assignment\]'/)
  assert.match(result.content, /let accessToken: string="\[REDACTED:secret-assignment\]"/)
  assert.match(result.content, /const other = "safe"/)
})

test('inline placeholders, type declarations, similarly named keys, and escaped quote values follow boundaries', () => {
  const tick = String.fromCharCode(96)
  const slash = String.fromCharCode(92)
  const escapedSingle = `const single = { apiKey: 'prefix ${slash}' fake-single-secret' };`
  const escapedTemplate = `const templated = { accessToken: ${tick}prefix ${slash}${tick} fake-template-secret${tick} };`
  const source = [
    '{"apiKey":"your_api_key","password":"changeme","accessToken":"<access_token>"}',
    'const examples = { apiKey: "your_api_key", password: "changeme", accessToken: "<access_token>" };',
    'interface Config { apiKey: string; password?: string }',
    'type Config = { clientSecret: string; label: string };',
    'const normal = { notApiKey: "not-a-secret", label: "ordinary-string" };',
    escapedSingle,
    escapedTemplate
  ].join('\n')
  const result = redactSensitiveContent(source)
  assert.equal(result.totalMatches, 2)
  assert.doesNotMatch(result.content, /fake-single-secret|fake-template-secret/)
  assert.match(result.content, /apiKey: '\[REDACTED:secret-assignment\]'/)
  assert.match(result.content, /accessToken: `\[REDACTED:secret-assignment\]`/)
  assert.match(result.content, /"apiKey":"your_api_key","password":"changeme","accessToken":"<access_token>"/)
  assert.match(result.content, /apiKey: "your_api_key", password: "changeme", accessToken: "<access_token>"/)
  assert.match(result.content, /interface Config \{ apiKey: string; password\?: string \}/)
  assert.match(result.content, /type Config = \{ clientSecret: string; label: string \}/)
  assert.match(result.content, /notApiKey: "not-a-secret", label: "ordinary-string"/)
})

test('long ordinary identifiers and interleaved type/secret assignments stay bounded', () => {
  const longIdentifier = `ordinary${'x'.repeat(20_000)}`
  const parts = [`const ${longIdentifier} = "ordinary-value";`]
  const secretCount = 300
  for (let index = 0; index < secretCount; index++) {
    parts.push(`type SafeShape${index} = { apiKey: string; password?: string; label: string; };`)
    parts.push(`const config${index} = { label: "safe-${index}", apiKey: "fake-boundary-secret-${index}" };`)
  }
  parts.push('const finalConfig = { apiKey: "fake-final-boundary-secret" };')
  const source = parts.join(' ')
  assert.ok(source.length < 200_000, 'fixture remains below the project content-size boundary')

  const result = redactSensitiveContent(source)
  assert.equal(result.totalMatches, secretCount + 1)
  assert.ok(result.content.includes(longIdentifier), 'a long non-secret identifier must be preserved')
  assert.match(result.content, /label: "safe-299"/)
  assert.match(result.content, /type SafeShape299 = \{ apiKey: string; password\?: string; label: string; \}/)
  assert.doesNotMatch(result.content, /fake-final-boundary-secret|fake-boundary-secret-/)
})

test('independent credential assignments inside block comments are still redacted', () => {
  const source = [
    '/*',
    ' * apiKey = "fake-comment-block-api";',
    ' * password: \'fake-comment-block-password\';',
    ' */',
    'const safe = "nearby-safe-value";'
  ].join('\n')
  const result = redactSensitiveContent(source)
  assert.equal(result.totalMatches, 2)
  assert.doesNotMatch(result.content, /fake-comment-block-api|fake-comment-block-password/)
  assert.match(result.content, /\* apiKey = "\[REDACTED:secret-assignment\]";/)
  assert.match(result.content, /\* password: '\[REDACTED:secret-assignment\]';/)
  assert.match(result.content, /const safe = "nearby-safe-value";/)
})

test('pure typed parameters, methods, class fields and generic declarations stay unchanged', () => {
  const source = [
    'type Credentials = { apiKey: string; password?: string };',
    'interface Options<T = string> { accessToken: T; clientSecret: string; label: string }',
    'function readCredential(apiKey: Credentials, password: SecretValue): void { return; }',
    'class Client { apiKey: Credentials; password?: SecretValue; connect(clientSecret: Credentials): void {} }'
  ].join('\n')
  const result = redactSensitiveContent(source)
  assert.equal(result.totalMatches, 0)
  assert.equal(result.content, source)
})

test('typed initializers and object arguments remain real assignments despite surrounding delimiters', () => {
  const source = [
    'function connect(apiKey: Credential = "fake-typed-parameter-default") {}',
    'call({apiKey:"fake-call-object"});',
    'const config: Config = { password: "fake-typed-object" };'
  ].join('\n')
  const result = redactSensitiveContent(source)
  assert.equal(result.totalMatches, 3)
  for (const secret of ['fake-typed-parameter-default', 'fake-call-object', 'fake-typed-object']) {
    assert.doesNotMatch(result.content, new RegExp(secret))
  }
  assert.match(result.content, /function connect\(apiKey: Credential = "\[REDACTED:secret-assignment\]"\)/)
  assert.match(result.content, /call\(\{apiKey:"\[REDACTED:secret-assignment\]"\}\);/)
  assert.match(result.content, /const config: Config = \{ password: "\[REDACTED:secret-assignment\]" \};/)
})

test('sensitive string concatenation replaces the whole expression without altering the next field', () => {
  const source = 'const apiKey = "prefix" + "FAKE_CONCAT_SECRET"; const config = { password: "prefix" + "FAKE_SECOND_PART", safe: "keep" };'
  const result = redactSensitiveContent(source)
  assert.equal(result.totalMatches, 2)
  assert.doesNotMatch(result.content, /prefix|FAKE_CONCAT_SECRET|FAKE_SECOND_PART/)
  assert.match(result.content, /safe: "keep"/)
})

test('redacts complete nested expressions and arrays without leaking comma-separated arguments', () => {
  const source = [
    "const c={apiKey:getKey('name','FAKE_SECRET'),safe:'keep'}",
    "const values = { password: [getKey('name', 'FAKE_ARRAY_SECRET'), 'FAKE_ARRAY_TAIL_SECRET'], safe: 'stay' }",
    "const apiKey=getKey('name',password='FAKE_PART','FAKE_TAIL_SECRET');",
    "const nested = { apiKey: build({ value: [1, wrap('FAKE_NESTED_SECRET')] }), safe: 'preserve' }"
  ].join('\n')
  const result = redactSensitiveContent(source)
  assert.equal(result.totalMatches, 4)
  assert.doesNotMatch(result.content, /FAKE_SECRET|FAKE_ARRAY_SECRET|FAKE_ARRAY_TAIL_SECRET|FAKE_PART|FAKE_TAIL_SECRET|FAKE_NESTED_SECRET/)
  assert.match(result.content, /safe:'keep'/)
  assert.match(result.content, /safe: 'stay'/)
  assert.match(result.content, /safe: 'preserve'/)
  assert.equal(redactSensitiveContent(result.content).totalMatches, 0)
})

test('treats quoted delimiters and comments as atomic expression content', () => {
  const source = "const apiKey = make('a,b)', /* , ) } */ wrap('FAKE_COMMENTED_ARG_SECRET')); const config = { password: [ 'FAKE_QUOTED_DELIMITER_SECRET,)]', 2 ], safe: 'keep' }"
  const result = redactSensitiveContent(source)
  assert.equal(result.totalMatches, 2)
  assert.doesNotMatch(result.content, /FAKE_COMMENTED_ARG_SECRET|FAKE_QUOTED_DELIMITER_SECRET/)
  assert.match(result.content, /safe: 'keep'/)
})

test('mismatched nested delimiters conservatively redact the remaining sensitive tail', () => {
  const source = "const apiKey = call([1, { broken: 2)], safe='FAKE_MALFORMED_TAIL_SECRET';"
  const result = redactSensitiveContent(source)
  assert.equal(result.totalMatches, 1)
  assert.doesNotMatch(result.content, /FAKE_MALFORMED_TAIL_SECRET/)
})

test('nested runtime objects remain scannable after call and function delimiters', () => {
  const source = [
    "call({ config: { apiKey: 'FAKE_NESTED_OBJECT_SECRET' } });",
    "call({ safe:'x', config:{password:'FAKE_NESTED_PASSWORD'} });",
    "function f(){const c={nested:{clientSecret:'FAKE_FUNCTION_OBJECT'}};}"
  ].join('\n')
  const result = redactSensitiveContent(source)
  assert.equal(result.totalMatches, 3)
  assert.doesNotMatch(result.content, /FAKE_NESTED_OBJECT_SECRET|FAKE_NESTED_PASSWORD|FAKE_FUNCTION_OBJECT/)
  assert.match(result.content, /safe:'x'/)
})

test('anonymous parameter type literals are ignored while defaults and call objects are scanned', () => {
  const source = [
    'function f(options: { apiKey: SecretValue; password?: Credential; nested: { clientSecret: Token } }) {}',
    'const arrow = (options: { apiKey: SecretValue; nested?: { password: Credential } }) => options',
    'class Client { connect(options: { accessToken: Token; nested: { apiKey?: SecretValue } }): void {} }',
    "function withDefault(options: { apiKey: SecretValue } = { apiKey: 'FAKE_DEFAULT_SECRET' }) {}",
    "call({ apiKey: 'FAKE_CALL_SECRET', safe: 'keep' })"
  ].join('\n')
  const result = redactSensitiveContent(source)
  assert.equal(result.totalMatches, 2)
  assert.doesNotMatch(result.content, /FAKE_DEFAULT_SECRET|FAKE_CALL_SECRET/)
  assert.match(result.content, /apiKey: SecretValue/)
  assert.match(result.content, /password\?: Credential/)
  assert.match(result.content, /safe: 'keep'/)
})

test('Ruby-style named argument hashes inside calls remain runtime data', () => {
  const source = [
    "foo(options: { apiKey: 'FAKE_RUNTIME_SECRET' })",
    "configure(opts:{nested:{password:'FAKE_NAMED_HASH'}})",
    "def ruby_method(options: { apiKey: 'FAKE_RUBY_METHOD_HASH' })\nend",
    'function typed(options: { apiKey: SecretValue }) {}',
    'const typedArrow = (options: { password: Credential }) => options',
    'class Service { method(options: { clientSecret: Token }): void {} }'
  ].join('\n')
  const result = redactSensitiveContent(source)
  assert.equal(result.totalMatches, 3)
  assert.doesNotMatch(result.content, /FAKE_RUNTIME_SECRET|FAKE_NAMED_HASH|FAKE_RUBY_METHOD_HASH/)
  assert.match(result.content, /apiKey: SecretValue/)
  assert.match(result.content, /password: Credential/)
  assert.match(result.content, /clientSecret: Token/)
})

test('object member calls cannot borrow a later member lambda as their method body', () => {
  const source = [
    "outer = { value: foo(options: { apiKey:'FAKE_HASH_SECRET' }), later: -> { 1 } }",
    "const obj={ field: call(options:{apiKey:'FAKE_FIELD_CALL_SECRET'}), other(){return 1;} }"
  ].join('\n')
  const result = redactSensitiveContent(source)
  assert.equal(result.totalMatches, 2)
  assert.doesNotMatch(result.content, /FAKE_HASH_SECRET|FAKE_FIELD_CALL_SECRET/)
  assert.match(result.content, /later: -> \{ 1 \}/)
  assert.match(result.content, /other\(\)\{return 1;\}/)
})

test('parameter type tracking handles multiple and multiline segments without masking defaults', () => {
  const source = [
    'function configure(first: string, options?: { apiKey: SecretValue; nested: { password: Credential } }): void {}',
    'const arrow = (',
    '  options: { clientSecret: SecretValue },',
    '  password: string = "FAKE_ARROW_DEFAULT_SECRET"',
    ') => options',
    'class Service { method(',
    '  options: { accessToken: Token } = { accessToken: "FAKE_METHOD_DEFAULT_SECRET" }',
    '): void {} }'
  ].join('\n')
  const result = redactSensitiveContent(source)
  assert.equal(result.totalMatches, 2)
  assert.doesNotMatch(result.content, /FAKE_ARROW_DEFAULT_SECRET|FAKE_METHOD_DEFAULT_SECRET/)
  assert.match(result.content, /apiKey: SecretValue/)
  assert.match(result.content, /clientSecret: SecretValue/)
  assert.match(result.content, /accessToken: Token/)
})

test('comments and line breaks are trivia before anonymous parameter type literals', () => {
  const source = [
    'function documented(options: /* doc */ { apiKey: SecretValue; nested: { password: Credential } }) {}',
    'const arrow = (options /* name */ ?:\n  /* annotation */ { clientSecret: Token }) => options',
    "function withDefault(options: /* docs */ { accessToken: Token } = { accessToken: 'FAKE_COMMENTED_DEFAULT_SECRET' }) {}",
    "call({ config: { password: 'FAKE_COMMENTED_RUNTIME_SECRET' } })"
  ].join('\n')
  const result = redactSensitiveContent(source)
  assert.equal(result.totalMatches, 2)
  assert.doesNotMatch(result.content, /FAKE_COMMENTED_DEFAULT_SECRET|FAKE_COMMENTED_RUNTIME_SECRET/)
  assert.match(result.content, /apiKey: SecretValue/)
  assert.match(result.content, /clientSecret: Token/)
  assert.match(result.content, /accessToken: Token/)
})

test('long parameter segments classify their first brace once and still scan later defaults', () => {
  const parameterName = `options${'x'.repeat(20_000)}`
  const source = `function configure(${parameterName}: { apiKey: SecretValue } = { apiKey: 'FAKE_LONG_DEFAULT_SECRET' }) {}`
  const result = redactSensitiveContent(source)
  assert.equal(result.totalMatches, 1)
  assert.doesNotMatch(result.content, /FAKE_LONG_DEFAULT_SECRET/)
  assert.match(result.content, /apiKey: SecretValue/)
})

test('line comments inside nested expressions do not alter delimiter matching and unquoted URLs remain intact', () => {
  const source = [
    "const apiKey = getKey(// a ) ]\n'FAKE_COMMENT_LINE_SECRET');",
    'password: https://example.test/path'
  ].join('\n')
  const result = redactSensitiveContent(source)
  assert.equal(result.totalMatches, 1)
  assert.doesNotMatch(result.content, /FAKE_COMMENT_LINE_SECRET/)
  assert.match(result.content, /password: https:\/\/example\.test\/path/)
})

test('multiline concatenation redacts through continuation without consuming adjacent fields', () => {
  const source = [
    'const c={apiKey: "prefix"',
    ' + "FAKE_MULTILINE_OBJECT_TAIL", safe:"keep"};',
    'const apiKey="prefix"',
    ' + "FAKE_MULTILINE_ASSIGNMENT_TAIL";'
  ].join('\n')
  const result = redactSensitiveContent(source)
  assert.equal(result.totalMatches, 2)
  assert.doesNotMatch(result.content, /FAKE_MULTILINE_OBJECT_TAIL|FAKE_MULTILINE_ASSIGNMENT_TAIL/)
  assert.match(result.content, /safe:"keep"/)
})

test('legacy sensitive-key suffix assignments remain redacted without masking reads or lookalike keys', () => {
  const source = [
    'const OPENAI_API_KEY="FAKE_PREFIXED_OPENAI_KEY";',
    "const APP_PASSWORD='FAKE_PREFIXED_PASSWORD';",
    'service.githubAccessToken = `FAKE_PREFIXED_GITHUB_TOKEN`;',
    'const readValue = obj.OPENAI_API_KEY;',
    'if (obj.APP_PASSWORD === candidate) {}',
    'const normal = { notApiKey: "ordinary inline value" };'
  ].join('\n')
  const result = redactSensitiveContent(source)
  assert.equal(result.totalMatches, 3)
  assert.doesNotMatch(result.content, /FAKE_PREFIXED_OPENAI_KEY|FAKE_PREFIXED_PASSWORD|FAKE_PREFIXED_GITHUB_TOKEN/)
  assert.match(result.content, /const readValue = obj\.OPENAI_API_KEY;/)
  assert.match(result.content, /obj\.APP_PASSWORD === candidate/)
  assert.match(result.content, /const normal = \{ notApiKey: "ordinary inline value" \};/)
})

test('typed legacy source keys reach their initializer while declarations and colon lookalikes remain intact', () => {
  const source = [
    'const OPENAI_API_KEY: string = "FAKE_TYPED_PREFIX_KEY";',
    'let APP_PASSWORD: Credential = "FAKE_TYPED_PREFIX_PASSWORD";',
    'function configure(githubAccessToken: Credential = "FAKE_TYPED_PREFIX_TOKEN") {}',
    'class Client { OPENAI_API_KEY: string = "FAKE_CLASS_PREFIX_KEY"; }',
    `class Distant { ${'ordinary = 1; '.repeat(40)} APP_PASSWORD: Credential = "FAKE_DISTANT_CLASS_PASSWORD"; }`,
    'declare const OPENAI_API_KEY: string;',
    'const normal = { notApiKey: "safe", OPENAI_API_KEY: "documented-field" };'
  ].join('\n')
  const result = redactSensitiveContent(source)
  assert.equal(result.totalMatches, 5)
  assert.doesNotMatch(result.content, /FAKE_TYPED_PREFIX_KEY|FAKE_TYPED_PREFIX_PASSWORD|FAKE_TYPED_PREFIX_TOKEN|FAKE_CLASS_PREFIX_KEY|FAKE_DISTANT_CLASS_PASSWORD/)
  assert.match(result.content, /declare const OPENAI_API_KEY: string;/)
  assert.match(result.content, /notApiKey: "safe", OPENAI_API_KEY: "documented-field"/)
})
