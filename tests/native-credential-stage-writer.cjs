const fs = require('node:fs')
const path = require('node:path')
const { createHash, randomBytes } = require('node:crypto')
const { app, safeStorage, session } = require('electron')

const root = path.resolve(process.argv[2] || '')
const userData = path.join(root, 'source-user-data')
const paths = {
  appData: path.join(root, 'app-data'),
  sessionData: userData,
  logs: path.join(root, 'logs'),
  userData
}
let stage = 'startup'

try {
  if (!process.versions.electron || !root || !fs.existsSync(root)) throw new Error('invalid-fixture-root')
  for (const directory of new Set(Object.values(paths))) fs.mkdirSync(directory, { recursive: false })
  for (const [name, directory] of Object.entries(paths)) app.setPath(name, directory)
} catch {
  app.exit(1)
}

app.whenReady().then(async () => {
  try {
    stage = 'initialize-native-profile'
    await session.defaultSession.cookies.get({})
    stage = 'availability-check'
    if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('native-encryption-unavailable')
    stage = 'encrypt-synthetic-value'
    const syntheticCredential = `synthetic-${randomBytes(24).toString('hex')}`
    const expectedDigest = createHash('sha256').update(syntheticCredential).digest('hex')
    const ciphertext = await safeStorage.encryptStringAsync(syntheticCredential)
    const settings = {
      schemaVersion: 2,
      defaultProfileId: 'synthetic-stage-profile',
      profiles: [{
        id: 'synthetic-stage-profile',
        name: `synthetic-stage-sha256-${expectedDigest}`,
        baseUrl: 'https://api.example.invalid/v1',
        model: 'synthetic-stage-model',
        credential: { version: 1, ciphertext: ciphertext.toString('base64') }
      }]
    }
    stage = 'write-encrypted-settings'
    const settingsBytes = Buffer.from(JSON.stringify(settings), 'utf8')
    if (settingsBytes.includes(Buffer.from(syntheticCredential))) throw new Error('plaintext-fixture')
    fs.writeFileSync(path.join(userData, 'settings.json'), settingsBytes, { flag: 'wx', mode: 0o600 })
    stage = 'flush-native-state'
    await new Promise(resolve => setTimeout(resolve, 250))
    app.quit()
  } catch {
    process.stderr.write(`[native-fixture] failed stage: ${stage}\n`)
    app.exit(1)
  }
}).catch(() => {
  process.stderr.write('[native-fixture] failed stage: when-ready\n')
  app.exit(1)
})
