/**
 * PROVENANCE d'un fait : date de la CONVERSATION (pas created_at, qui date
 * l'import) et origine (session ou sous-agent).
 *
 * Chaîne : fait → memory_import_items.target_memory_id → memory_sources.source_path.
 * Ordre des sources de date, de la plus sûre à la plus approximative :
 *  1. fichier source encore présent : premier horodatage des 64 premiers Ko ;
 *  2. copie d'archive (sessions principales seulement) : idem ;
 *  3. transcript_file_state.mtime_ms (date de modification notée par l'import) ;
 *  4. metadata.first_message_at de la source (export ChatGPT) ;
 *  5. imported_at de la source (date l'import, pas la conversation).
 * Un fait sans source d'import (capture en direct, déclaration) prend sa date
 * de création, qui est alors bien celle de la conversation.
 *
 * Lecture asynchrone et bornée (certains fichiers font plusieurs dizaines de
 * Mo) ; résultat en cache par source pendant un passage.
 */
import { open, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { ConversationAtSource, Origine, TriageRoots } from './types.js'

/** Octets lus au début d'un fichier source pour y trouver le premier horodatage. */
export const PROVENANCE_HEAD_BYTES = 64 * 1024

export interface SourceRecord {
  source_id: string
  source_type: string
  source_path: string | null
  imported_at: string
  metadata: string | null
}

export interface Provenance {
  conversation_at: string | null
  conversation_at_source: ConversationAtSource
  origine: Origine | null
  /** Transcription lisible (fichier ou archive), pour vérifier l'auteur dans les vrais messages. */
  transcript_path: string | null
}

/** Sous-agent : transcription d'un agent lancé par un autre agent (« l'utilisateur » y est l'agent chef). */
export function originOf(sourcePath: string | null): Origine | null {
  if (!sourcePath) return null
  return sourcePath.includes(`${sep}subagents${sep}`) || sourcePath.includes('/subagents/') ? 'sous-agent' : 'session'
}

function toIso(value: string | number): string | null {
  const ms = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value)
  if (!Number.isFinite(ms)) return null
  const d = new Date(ms)
  // Une date hors de toute vraisemblance (horodatage mal lu) ne vaut rien.
  if (d.getUTCFullYear() < 2000 || d.getUTCFullYear() > 2100) return null
  return d.toISOString()
}

/**
 * Premier horodatage lisible dans les `maxBytes` premiers octets d'un JSONL
 * (Claude Code : `timestamp` ISO ; Codex : `timestamp` ISO ou `ts` en secondes).
 */
export async function firstTimestamp(path: string, maxBytes = PROVENANCE_HEAD_BYTES): Promise<string | null> {
  let handle
  try {
    handle = await open(path, 'r')
    const buf = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buf, 0, maxBytes, 0)
    const head = buf.subarray(0, bytesRead).toString('utf8')
    for (const line of head.split('\n')) {
      const iso = /"timestamp"\s*:\s*"([^"]+)"/.exec(line)
      if (iso) {
        const v = toIso(iso[1]!)
        if (v) return v
      }
      const epoch = /"ts"\s*:\s*(\d{9,13})\b/.exec(line)
      if (epoch) {
        const v = toIso(Number(epoch[1]))
        if (v) return v
      }
    }
    return null
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** Copie d'archive d'une session Claude Code (même chemin relatif sous la racine d'archive), ou null. */
export function archiveCandidate(sourcePath: string, roots: TriageRoots): string | null {
  if (!isAbsolute(sourcePath)) return null
  const rel = relative(roots.claudeProjectsDir, sourcePath)
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  return join(roots.archiveDir, rel)
}

function metadataDate(metadata: string | null): string | null {
  if (!metadata) return null
  try {
    const m = JSON.parse(metadata) as Record<string, unknown>
    for (const k of ['first_message_at', 'started_at', 'created_at']) {
      const v = m[k]
      if (typeof v === 'string' || typeof v === 'number') {
        const iso = toIso(v)
        if (iso) return iso
      }
    }
  } catch {
    /* métadonnées illisibles */
  }
  return null
}

export interface ProvenanceContext {
  roots: TriageRoots
  /** mtime noté par l'import pour ce chemin (transcript_file_state), ou null. */
  fileMtime(path: string): number | null
}

/** Provenance d'une source (à mettre en cache par source_id). */
export async function resolveSourceProvenance(source: SourceRecord, ctx: ProvenanceContext): Promise<Provenance> {
  const path = source.source_path
  // Capture en direct mise en revue : la date de création du fait est celle
  // de la conversation (l'appelant la pose, cette source est commune à tous).
  if (source.source_type === 'capture-review') {
    return { conversation_at: null, conversation_at_source: 'creation', origine: 'session', transcript_path: null }
  }
  const origine = originOf(path)
  if (path && source.source_type === 'transcript' && isAbsolute(path)) {
    if (await exists(path)) {
      const ts = await firstTimestamp(path)
      if (ts) return { conversation_at: ts, conversation_at_source: 'fichier', origine, transcript_path: path }
    }
    const archived = archiveCandidate(path, ctx.roots)
    if (archived && (await exists(archived))) {
      const ts = await firstTimestamp(archived)
      if (ts) return { conversation_at: ts, conversation_at_source: 'archive', origine, transcript_path: archived }
    }
    const mtime = ctx.fileMtime(path)
    if (mtime !== null) {
      const iso = toIso(mtime)
      if (iso) return { conversation_at: iso, conversation_at_source: 'etat', origine, transcript_path: null }
    }
  }
  const meta = metadataDate(source.metadata)
  if (meta) return { conversation_at: meta, conversation_at_source: 'metadata', origine, transcript_path: null }
  const imported = toIso(source.imported_at)
  return { conversation_at: imported, conversation_at_source: imported ? 'import' : 'inconnu', origine, transcript_path: null }
}

/** Provenance d'un fait sans source d'import (capture en direct, déclaration) : sa date de création. */
export function directProvenance(createdAt: string): Provenance {
  const iso = toIso(createdAt)
  return { conversation_at: iso, conversation_at_source: iso ? 'creation' : 'inconnu', origine: null, transcript_path: null }
}
