/**
 * Sous-système secrets (spec §9, D2 — gate dur).
 * `createSecretProvider()` choisit le coffre : Keychain macOS si disponible,
 * sinon fallback AES-256-GCM. L'appelant peut forcer un kind (tests, doctor).
 */
import type { SecretProvider } from './types.js'
import { KeychainMacProvider } from './keychain-macos.js'
import { AesVaultProvider } from './aes-vault.js'

export type {
  SecretProvider,
  Redactor,
  RedactionResult,
  DetectedSecret,
} from './types.js'
export { KeychainMacProvider } from './keychain-macos.js'
export type { KeychainMacOptions } from './keychain-macos.js'
export { AesVaultProvider } from './aes-vault.js'
export type { AesVaultOptions } from './aes-vault.js'
export { RegexRedactor } from './redaction.js'

export interface CreateSecretProviderOptions {
  /** Force un coffre précis (sinon : keychain si dispo, sinon aes-vault). */
  force?: 'keychain-macos' | 'aes-vault'
  /** Environnement injectable pour les tests (MEMORIA_VAULT_KEY). */
  env?: NodeJS.ProcessEnv
}

export function createSecretProvider(
  secretsDir: string,
  opts: CreateSecretProviderOptions = {},
): SecretProvider {
  if (opts.force === 'keychain-macos') return new KeychainMacProvider()
  if (opts.force === 'aes-vault') return new AesVaultProvider(secretsDir, { env: opts.env })

  const keychain = new KeychainMacProvider()
  if (keychain.isAvailable()) return keychain
  return new AesVaultProvider(secretsDir, { env: opts.env })
}
