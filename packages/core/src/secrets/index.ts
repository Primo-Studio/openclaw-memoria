/**
 * Sous-système secrets (spec §9, D2 — gate dur).
 * `createSecretProvider()` choisit le coffre : Keychain macOS si disponible,
 * sinon fallback AES-256-GCM. L'appelant peut forcer un kind (tests, doctor).
 */
import { randomBytes } from 'node:crypto'
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

  // SOUS UN LANCEUR DE TESTS : jamais le trousseau par auto-détection.
  //
  // Le trousseau est un état GLOBAL et PERSISTANT de la machine — il échappe au
  // tmpdir que chaque test croit isoler. Deux conséquences observées :
  // des exécutions parallèles se disputent le même item et échouent par
  // intermittence (`SecKeychainItemModifyContent: item already exists`), et
  // chaque exécution laisse des entrées derrière elle dans le trousseau RÉEL de
  // l'utilisateur. Douze fichiers de test appelaient `Memoria.init` sans
  // préciser de coffre et retombaient donc ici.
  //
  // `force: 'keychain-macos'` reste honoré : un test qui vise explicitement le
  // trousseau garde le droit de le faire.
  // On lit `process.env` et NON `opts.env` : ce dernier configure le coffre AES
  // (passphrase…), il ne dit rien du contexte d'exécution. S'en servir ici
  // rendrait la garde contournable dès qu'un appelant passe un environnement.
  if (process.env['VITEST'] || process.env['NODE_ENV'] === 'test') {
    return new AesVaultProvider(secretsDir, { env: opts.env })
  }

  const keychain = new KeychainMacProvider()
  if (keychain.isAvailable()) return keychain
  return new AesVaultProvider(secretsDir, { env: opts.env })
}

const GVK_NAME = '__group_vault_key'
const CPK_NAME = '__cluster_pairing_key'

/**
 * Clé du COFFRE PARTAGÉ (GVK, 32 o) : chiffre les valeurs de secrets en transit
 * entre machines. Vit uniquement dans le coffre local (Keychain/AES) — jamais
 * sur disque en clair, jamais dans le TOML. Créée au premier appel côté hub.
 */
export function groupVaultKey(provider: SecretProvider): Buffer {
  return getOrCreateKey(provider, GVK_NAME)
}

/** Clé de PAIRING de cluster (CPK, 32 o) : signe HMAC chaque requête de synchro. */
export function clusterPairingKey(provider: SecretProvider): Buffer {
  return getOrCreateKey(provider, CPK_NAME)
}

/** Installe une GVK/CPK reçue d'un pair (le spoke adopte celles du hub au pairing). */
export function setGroupVaultKey(provider: SecretProvider, key: Buffer): void {
  provider.set(GVK_NAME, key.toString('hex'))
}
export function setClusterPairingKey(provider: SecretProvider, key: Buffer): void {
  provider.set(CPK_NAME, key.toString('hex'))
}

function getOrCreateKey(provider: SecretProvider, name: string): Buffer {
  const existing = provider.get(name)
  if (existing) return Buffer.from(existing, 'hex')
  const key = randomBytes(32)
  provider.set(name, key.toString('hex'))
  return key
}
