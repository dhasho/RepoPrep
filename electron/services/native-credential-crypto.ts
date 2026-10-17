import { safeStorage } from 'electron'
import { isSupportedCredentialBackend, type CredentialCrypto } from './credential-vault'

export const nativeCredentialCrypto: CredentialCrypto = {
  isAvailable: async () => {
    if (!await safeStorage.isAsyncEncryptionAvailable()) return false
    if (process.platform === 'linux') {
      const backend = typeof safeStorage.getSelectedStorageBackend === 'function'
        ? safeStorage.getSelectedStorageBackend()
        : null
      if (!isSupportedCredentialBackend(process.platform, backend)) return false
    }
    return true
  },
  encrypt: (plaintext) => safeStorage.encryptStringAsync(plaintext),
  decrypt: async (ciphertext) => (await safeStorage.decryptStringAsync(ciphertext)).result
}
