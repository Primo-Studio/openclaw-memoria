/**
 * Indexeur d'embeddings (bucket B — async, jamais dans le chemin de réponse).
 * Vérité = table `embeddings` (model/dimensions gravés) ; l'index vec0 est
 * reconstructible. Idempotent : ne ré-embedde jamais un fait déjà couvert
 * pour CE modèle.
 */
import type { ContentStore } from '../storage/content.js'
import type { EmbeddingProvider } from '../llm/provider.js'
import { containsSensitive } from '../llm/sensitive-gate.js'
import { newId, nowISO, vectorToBuffer } from '../util.js'
import {
  embeddingsMark,
  ensureVecTable,
  removeVectors,
  repairVecIndex,
  repairVecIndexSince,
  sameMark,
  upsertVectors,
  type VecIndexKey,
  type VecRepairMark,
} from './vec-table.js'

export interface IndexerRunResult {
  indexed: number
  remaining: number
  vec_available: boolean
}

/** Intervalle minimal entre deux réparations complètes de l'index par un même indexeur. */
const REPAIR_INTERVAL_MS = 10 * 60_000

/** Faits relus par page quand la garde sensible écarte des faits (voir `nextCleanBatch`). */
const SENSITIVE_SCAN_PAGE = 200
/** Tranche de calcul maximale avant de rendre la main (règle des 200 ms). */
const SLICE_MS = 20

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

export class EmbeddingIndexer {
  private readonly store: ContentStore
  private readonly provider: EmbeddingProvider
  private readonly batchSize: number
  /**
   * Garde sensible active (`llm.sensitive_gate`) : les faits sensibles sont
   * écartés AVANT l'envoi. Ils restent sans vecteur (trouvés par le plein
   * texte seul) et n'empêchent pas le reste du lot de partir.
   */
  private readonly skipSensitive: boolean
  /**
   * Faits déjà reconnus sensibles par cet indexeur : sautés sans refaire le
   * test à chaque passage. Clé = id + longueur du texte (un fait corrigé sur
   * place est retesté).
   */
  private readonly sensitiveSeen = new Set<string>()

  constructor(opts: { store: ContentStore; provider: EmbeddingProvider; batchSize?: number; skipSensitive?: boolean }) {
    this.store = opts.store
    this.provider = opts.provider
    this.batchSize = opts.batchSize ?? 16
    this.skipSensitive = opts.skipSensitive ?? false
  }

  /** Dernière vérification COMPLÈTE de l'index par cet indexeur (0 = jamais). */
  private repairedAt = 0
  /** Repère de la dernière vérification (null : jamais vérifié depuis le démarrage). */
  private verified: VecRepairMark | null = null
  /** Réparation en cours : les passages simultanés (un par store_fact) l'attendent au lieu d'en lancer une autre. */
  private repairing: Promise<number> | null = null

  /** Identité de l'index de CE provider : modèle + dimensions (jamais la dimension seule). */
  private get key(): VecIndexKey {
    return { model: this.provider.model, dimensions: this.provider.dimensions }
  }

  /**
   * Faits actifs sans embedding pour ce modèle. Un fait DORMANT (quarantaine
   * d'import ou capture review-first, pas encore approuvé) n'est pas embeddé :
   * l'envoyer au cloud avant la revue coûtait pour rien — et son vecteur était
   * effacé s'il était rejeté. L'approbation le rend `active`, donc éligible.
   * Un fait `critical` (paie validée à la main, par exemple) n'est jamais
   * envoyé au fournisseur de vecteurs : il est gardé, invisible au rappel.
   */
  pendingFacts(limit = this.batchSize): Array<{ id: string; fact: string }> {
    return this.store.db
      .prepare(
        `SELECT f.id, f.fact FROM facts f
         WHERE f.superseded = 0 AND f.lifecycle_state = 'active' AND f.sensitivity != 'critical'
           AND NOT EXISTS (
             SELECT 1 FROM embeddings e
             WHERE e.owner_type = 'fact' AND e.owner_id = f.id AND e.model = ?
           )
         ORDER BY f.created_at
         LIMIT ?`,
      )
      .all(this.provider.model, limit) as Array<{ id: string; fact: string }>
  }

  /**
   * Prochain lot à envoyer quand la garde sensible est active : les faits en
   * attente sont parcourus dans l'ordre de `pendingFacts`, page par page, en
   * écartant les sensibles, jusqu'à un lot plein ou la fin de la file. Filtrer
   * le seul lot de tête ne suffisait pas : 16 faits sensibles en tête de file
   * rendaient un lot vide à chaque passage, et plus aucun fait ne recevait de
   * vecteur. Le test est synchrone : la main est rendue entre deux tranches.
   */
  private async nextCleanBatch(): Promise<Array<{ id: string; fact: string }>> {
    const page = this.store.db.prepare(
      `SELECT f.id, f.fact, f.created_at FROM facts f
       WHERE f.superseded = 0 AND f.lifecycle_state = 'active' AND f.sensitivity != 'critical'
         AND NOT EXISTS (
           SELECT 1 FROM embeddings e
           WHERE e.owner_type = 'fact' AND e.owner_id = f.id AND e.model = @model
         )
         AND (@ca IS NULL OR f.created_at > @ca OR (f.created_at = @ca AND f.id > @id))
       ORDER BY f.created_at, f.id
       LIMIT @limit`,
    )
    const out: Array<{ id: string; fact: string }> = []
    let cursor: { ca: string | null; id: string } = { ca: null, id: '' }
    let started = Date.now()
    for (;;) {
      const rows = page.all({ model: this.provider.model, ca: cursor.ca, id: cursor.id, limit: SENSITIVE_SCAN_PAGE }) as Array<{
        id: string
        fact: string
        created_at: string
      }>
      for (const r of rows) {
        if (Date.now() - started >= SLICE_MS) {
          await yieldToEventLoop()
          started = Date.now()
        }
        const seenKey = `${r.id}:${r.fact.length}`
        if (this.sensitiveSeen.has(seenKey)) continue
        if (await containsSensitive(r.fact)) {
          this.sensitiveSeen.add(seenKey)
          continue
        }
        out.push({ id: r.id, fact: r.fact })
        if (out.length >= this.batchSize) return out
      }
      if (rows.length < SENSITIVE_SCAN_PAGE || !this.store.db.open) return out
      const last = rows[rows.length - 1]!
      cursor = { ca: last.created_at, id: last.id }
    }
  }

  pendingCount(): number {
    const r = this.store.db
      .prepare(
        `SELECT COUNT(*) AS c FROM facts f
         WHERE f.superseded = 0 AND f.lifecycle_state = 'active' AND f.sensitivity != 'critical'
           AND NOT EXISTS (
             SELECT 1 FROM embeddings e
             WHERE e.owner_type = 'fact' AND e.owner_id = f.id AND e.model = ?
           )`,
      )
      .get(this.provider.model) as { c: number }
    return r.c
  }

  /**
   * Un lot : embed → table embeddings → index vec0. Erreur provider = THROW
   * (l'appelant décide : retry plus tard) — jamais d'avalement.
   */
  async runOnce(): Promise<IndexerRunResult> {
    const batch = this.skipSensitive ? await this.nextCleanBatch() : this.pendingFacts()
    if (batch.length === 0) {
      return { indexed: 0, remaining: 0, vec_available: ensureVecTable(this.store.db, this.key) }
    }

    const vectors = await this.provider.embed(batch.map(f => f.fact))
    if (vectors.length !== batch.length) {
      throw new Error(`embed : ${vectors.length} vecteurs pour ${batch.length} textes`)
    }

    const db = this.store.db
    const vecOk = ensureVecTable(db, this.key)
    const insert = db.prepare(
      `INSERT OR REPLACE INTO embeddings (id, owner_type, owner_id, model, dimensions, vector, created_at)
       VALUES (?, 'fact', ?, ?, ?, ?, ?)`,
    )
    const tx = db.transaction((): VecRepairMark | null => {
      // Rien d'écrit par d'autres depuis la dernière vérification : nos lignes
      // seront les seules après le repère, et elles entrent dans l'index ici même.
      const contiguous = vecOk && this.verified !== null && sameMark(embeddingsMark(db), this.verified)
      for (let i = 0; i < batch.length; i++) {
        const vec = vectors[i]!
        if (vec.length !== this.provider.dimensions) {
          throw new Error(
            `embed : vecteur ${vec.length}d pour un modèle déclaré ${this.provider.dimensions}d (${this.provider.model}) — interdit`,
          )
        }
        insert.run(newId(), batch[i]!.id, this.provider.model, this.provider.dimensions, vectorToBuffer(vec), nowISO())
      }
      if (vecOk) upsertVectors(db, this.key, batch.map((f, i) => ({ factId: f.id, vector: vectors[i]! })))
      return contiguous ? embeddingsMark(db) : null
    })
    const advanced = tx()
    // Le repère n'avance qu'après la validation : la vérification suivante n'a rien à relire.
    if (advanced) this.verified = advanced

    return { indexed: batch.length, remaining: this.pendingCount(), vec_available: vecOk }
  }

  /**
   * Répare l'index vec0 de ce modèle depuis la table `embeddings` (vérité) :
   * vecteurs déjà calculés mais absents de l'index → réinsérés, 0 appel
   * provider. C'est ce qui rend l'index reconstructible, et ce qui comble un
   * index créé après coup (nouveau nommage par modèle, table supprimée).
   */
  repairIndex(): Promise<number> {
    if (!this.repairing) {
      this.repairing = this.repair().finally(() => {
        this.repairing = null
      })
    }
    return this.repairing
  }

  /**
   * Vérification complète au premier passage de l'indexeur (donc au démarrage),
   * puis au plus toutes les REPAIR_INTERVAL_MS ; entre deux, seulement les
   * vecteurs écrits après le repère (en pratique aucun : runOnce alimente
   * l'index dans sa transaction et fait avancer le repère). Les deux rendent la
   * main entre leurs tranches (règle n°27).
   */
  private async repair(): Promise<number> {
    const db = this.store.db
    let repaired: number | null = null
    if (this.verified && Date.now() - this.repairedAt < REPAIR_INTERVAL_MS) {
      const since = await repairVecIndexSince(db, this.key, this.verified)
      if (since) {
        this.verified = since.mark
        repaired = since.repaired
      }
      // Repère qui ne tient plus (dernière ligne effacée, rowid réutilisé) : vérification complète.
    }
    if (repaired === null) {
      const full = await repairVecIndex(db, this.key)
      // Extension absente ou base fermée en route : rien n'a été vérifié.
      if (!full) return 0
      this.verified = full.mark
      this.repairedAt = Date.now()
      repaired = full.repaired
    }
    if (repaired > 0) console.warn(`[memoria] index vectoriel ${this.provider.model} : ${repaired} vecteur(s) réinséré(s) depuis la base`)
    return repaired
  }

  /** Boucle jusqu'à épuisement (réindexation complète, embedding_jobs). */
  async runAll(maxBatches = 1000): Promise<IndexerRunResult> {
    // Avant d'embedder quoi que ce soit : ce qui est déjà en base doit être
    // dans l'index. `pendingCount` ne voit que la table embeddings — sans ça,
    // un index vide avec une base pleine restait « à jour » et muet.
    // La vérification complète relit les identifiants de tout l'index : runAll
    // étant rejoué après CHAQUE fait stocké, elle n'est refaite qu'au plus toutes
    // les REPAIR_INTERVAL_MS (ticket #27) ; entre deux, seuls les vecteurs écrits
    // après le repère sont vérifiés.
    await this.repairIndex()
    // Base fermée pendant la vérification (arrêt, fin de test) : rien à indexer.
    if (!this.store.db.open) return { indexed: 0, remaining: 0, vec_available: false }
    let last: IndexerRunResult = { indexed: 0, remaining: this.pendingCount(), vec_available: false }
    let total = 0
    for (let i = 0; i < maxBatches && (i === 0 || last.remaining > 0); i++) {
      last = await this.runOnce()
      total += last.indexed
      if (last.indexed === 0) break
    }
    return { ...last, indexed: total }
  }

  /** Nettoyage à l'oubli (hard-delete) : embeddings + index. */
  removeFor(factIds: string[]): void {
    if (factIds.length === 0) return
    const placeholders = factIds.map(() => '?').join(',')
    this.store.db
      .prepare(`DELETE FROM embeddings WHERE owner_type = 'fact' AND owner_id IN (${placeholders})`)
      .run(...factIds)
    removeVectors(this.store.db, this.key, factIds)
  }
}
