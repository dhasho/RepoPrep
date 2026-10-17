export interface CredentialCrypto {
  isAvailable(): boolean | Promise<boolean>
  encrypt(plaintext: string): Promise<Buffer>
  decrypt(ciphertext: Buffer): Promise<string>
}

export interface EncryptedCredential {
  version: 1
  ciphertext: string
}

export function isSupportedCredentialBackend(platform: string, backend: string | null): boolean {
  if (platform !== 'linux') return true
  return backend !== null && ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(backend)
}

async function isAvailable(crypto: CredentialCrypto): Promise<boolean> {
  try { return await crypto.isAvailable() } catch { return false }
}

export async function encryptCredential(plaintext: string, crypto: CredentialCrypto): Promise<EncryptedCredential> {
  if (!await isAvailable(crypto)) throw new Error('credential-store-unavailable')
  try {
    const bytes = await crypto.encrypt(plaintext)
    if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0) throw new Error('credential-encryption-failed')
    return { version: 1, ciphertext: bytes.toString('base64') }
  } catch {
    throw new Error('credential-encryption-failed')
  }
}

export async function decryptCredential(value: unknown, crypto: CredentialCrypto): Promise<string> {
  if (!await isAvailable(crypto)) throw new Error('credential-store-unavailable')
  if (!value || typeof value !== 'object' || (value as EncryptedCredential).version !== 1 || typeof (value as EncryptedCredential).ciphertext !== 'string') {
    throw new Error('credential-format-invalid')
  }
  const encoded = (value as EncryptedCredential).ciphertext
  if (!encoded || encoded.length > 64 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error('credential-format-invalid')
  }
  try {
    return await crypto.decrypt(Buffer.from(encoded, 'base64'))
  } catch {
    throw new Error('credential-decryption-failed')
  }
}
