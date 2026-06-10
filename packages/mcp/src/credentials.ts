/**
 * Credentials d'instance (issus du pairing) — `~/.memoria/credentials/<instance_id>.json`.
 * Le token d'instance est un secret local : fichier chmod 600, dossier chmod 700.
 * Le répertoire est injectable pour les tests (jamais le vrai HOME en test).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface InstanceCredentials {
  instance_token: string
  storage_root: string
  created_at: string
}

export function defaultCredentialsDir(): string {
  return join(homedir(), '.memoria', 'credentials')
}

export function credentialsPath(instanceId: string, dir: string = defaultCredentialsDir()): string {
  return join(dir, `${instanceId}.json`)
}

export function saveCredentials(
  instanceId: string,
  creds: InstanceCredentials,
  dir: string = defaultCredentialsDir(),
): string {
  // l'id sert de nom de fichier : refuser tout séparateur de chemin
  if (!/^[A-Za-z0-9_.@-]+$/.test(instanceId)) {
    throw new Error(`identifiant d'instance invalide : ${instanceId}`)
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const p = credentialsPath(instanceId, dir)
  writeFileSync(p, JSON.stringify(creds, null, 2), 'utf8')
  chmodSync(p, 0o600)
  return p
}

export function loadCredentials(
  instanceId: string,
  dir: string = defaultCredentialsDir(),
): InstanceCredentials | null {
  const p = credentialsPath(instanceId, dir)
  if (!existsSync(p)) return null
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as Partial<InstanceCredentials>
    if (typeof parsed.instance_token !== 'string' || typeof parsed.storage_root !== 'string') {
      console.warn(`[memoria-mcp] credentials incomplets, fichier ignoré : ${p}`)
      return null
    }
    return {
      instance_token: parsed.instance_token,
      storage_root: parsed.storage_root,
      created_at: typeof parsed.created_at === 'string' ? parsed.created_at : '',
    }
  } catch (err) {
    // anti « mort silencieuse » : un fichier corrompu doit se voir
    console.warn(`[memoria-mcp] credentials illisibles (${p}) : ${(err as Error).message}`)
    return null
  }
}
