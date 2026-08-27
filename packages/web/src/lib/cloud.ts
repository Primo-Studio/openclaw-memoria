/**
 * Données envoyées au cloud — côté UI, fonctions PURES (testables sans DOM).
 *
 * Le journal cloud (core/llm/cloud-audit.ts) existe pour le retour bêta
 * « l'interface devrait indiquer clairement ce qui a été envoyé ». Or il
 * n'était lu que par `memoria doctor` : un utilisateur non technicien ne
 * voyait jamais que des envois partaient chez OpenAI. Ici :
 *  - `summarizeCloudSends` : à partir du rapport de consommation (même route
 *    que le panneau Consommation, même fenêtre 24 h/7 j/30 j/total), ne garde
 *    que ce qui a QUITTÉ la machine (local=false) ;
 *  - `parseKeyValues` / `humanReason` : rendent lisible la raison technique
 *    d'une ligne du Journal (`provider=openai model=… chars=1357 ms=1238 ok=true`).
 */
import type { LlmUsageRow } from '../api'
import { translate } from '../i18n'
import { formatCompact, formatDecimal, providerLabel } from '../components/ui'

export interface CloudSendRow {
  provider: string
  model: string
  purpose: LlmUsageRow['purpose']
  calls: number
  failures: number
  items: number
  chars: number
  last_ts: string | null
}

export interface CloudSummary {
  rows: CloudSendRow[]
  calls: number
  failures: number
  chars: number
  /** Fournisseurs distincts, libellés lisibles (« OpenAI »), ordre d'apparition. */
  providers: string[]
  last_ts: string | null
}

export function summarizeCloudSends(rows: readonly LlmUsageRow[]): CloudSummary {
  const out: CloudSummary = { rows: [], calls: 0, failures: 0, chars: 0, providers: [], last_ts: null }
  for (const r of rows) {
    if (r.local) continue
    out.rows.push({
      provider: r.provider,
      model: r.model,
      purpose: r.purpose,
      calls: r.calls,
      failures: r.failures,
      items: r.items,
      chars: r.chars,
      last_ts: r.last_ts,
    })
    out.calls += r.calls
    out.failures += r.failures
    out.chars += r.chars
    const label = providerLabel(r.provider)
    if (!out.providers.includes(label)) out.providers.push(label)
    if (r.last_ts && (out.last_ts === null || r.last_ts > out.last_ts)) out.last_ts = r.last_ts
  }
  return out
}

/** `clé=valeur clé=valeur` (format de l'audit core) → objet. Robuste : ignore le reste. */
export function parseKeyValues(reason: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of reason.matchAll(/(\w+)=([^\s;]+)/g)) {
    const [, k, v] = m
    if (k !== undefined && v !== undefined) out[k] = v
  }
  return out
}

function int(v: string | undefined): number | null {
  if (v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Raison lisible d'une entrée du Journal. Seules les actions dont on connaît
 * le format sont traduites ; sinon on rend la raison brute (mieux que rien,
 * jamais vide). Ex. cloud_send → « OpenAI · gpt-4o-mini · extraction · ≈ 1,4 k
 * caractères · 1,2 s ».
 */
export function humanReason(action: string, reason: string | null): string | null {
  if (!reason) return null
  const kv = parseKeyValues(reason)
  switch (action) {
    case 'cloud_send': {
      if (!kv.provider || !kv.model) return reason
      const parts = [providerLabel(kv.provider), kv.model]
      if (kv.purpose === 'extraction' || kv.purpose === 'embeddings') parts.push(translate(`settings.usage.purpose.${kv.purpose}`))
      const chars = int(kv.chars)
      if (chars !== null) parts.push(translate('audit.reason.chars', { n: formatCompact(chars) }))
      const ms = int(kv.ms)
      if (ms !== null) parts.push(translate('audit.reason.duration', { s: formatDecimal(ms / 1000, 1) }))
      if (kv.ok === 'false') parts.push(translate('audit.reason.failed'))
      return parts.join(' · ')
    }
    case 'capture_turn': {
      const facts = int(kv.facts)
      const ms = int(kv.ms)
      if (facts === null || ms === null) return reason
      return translate('audit.reason.capture', { facts, ms })
    }
    case 'wal_entry_abandoned': {
      const attempts = int(kv.attempts)
      return attempts === null ? reason : translate('audit.reason.abandoned', { attempts })
    }
    default:
      return reason
  }
}
