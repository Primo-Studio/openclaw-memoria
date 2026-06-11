/**
 * Système — les couches de Memoria, rendues visibles. Les 24 couches cognitives
 * regroupées par rôle, avec leur compteur LIVE (entités, thèmes, procédures…) :
 * on voit la machine tourner. C'est « le cerveau » de Memoria.
 */
import { getCognitiveStats } from '../api'
import { ErrorBanner, Spinner, useLoad } from '../components/ui'

interface Layer {
  n: number
  name: string
  desc: string
  /** Clé de stat live (cognitive_stats) — optionnel. */
  stat?: string
}

const BUCKETS: Array<{ title: string; subtitle: string; layers: Layer[] }> = [
  {
    title: 'Actif',
    subtitle: 'le socle — tourne en permanence',
    layers: [
      { n: 1, name: 'Base de données', desc: 'schéma gouverné, recherche plein-texte', stat: 'facts' },
      { n: 2, name: 'Scoring + hot-tier', desc: 'classe la pertinence ; les souvenirs récents sont « chauds »' },
      { n: 3, name: 'Sélection & contradictions', desc: 'dédup et repère les souvenirs qui se contredisent' },
      { n: 4, name: 'Cycle de vie', desc: 'actif / en sommeil / archivé' },
      { n: 5, name: 'Budget', desc: 'limite le bruit injecté (cap de tokens)' },
      { n: 6, name: 'Procédures', desc: 'savoir-faire avec taux de réussite', stat: 'procedures' },
      { n: 7, name: 'Feedback', desc: 'ce qui sert vraiment remonte avec l’usage' },
      { n: 8, name: 'Expertise', desc: 'domaines de maîtrise par agent' },
      { n: 9, name: 'Contexte', desc: 'projet → client → organisation' },
      { n: 10, name: 'Identité & config', desc: 'agents, instances, réglages' },
      { n: 11, name: 'Journal WAL', desc: 'rien ne se perd, rejeu au démarrage', stat: 'wal_buffer' },
    ],
  },
  {
    title: 'Enrichissement',
    subtitle: 'en arrière-plan, jamais dans la réponse',
    layers: [
      { n: 12, name: 'Embeddings', desc: 'recherche par le sens (vectoriel)', stat: 'embeddings' },
      { n: 13, name: 'Graphe', desc: 'entités et relations', stat: 'relations' },
      { n: 14, name: 'Thèmes', desc: 'où chaque souvenir est rangé', stat: 'topics' },
      { n: 15, name: 'Observations', desc: 'synthèses vivantes par sujet', stat: 'observations' },
      { n: 16, name: 'Clusters', desc: 'paquets de souvenirs liés', stat: 'fact_clusters' },
      { n: 17, name: 'Capture continue', desc: 'apprend à chaque échange' },
      { n: 18, name: 'Révision', desc: 'propose le ménage de la mémoire', stat: 'revision_proposals' },
    ],
  },
  {
    title: 'Optionnel',
    subtitle: 'à activer quand vous voulez',
    layers: [
      { n: 19, name: 'Auto-observation', desc: 'l’agent observe ses forces/faiblesses', stat: 'self_observations' },
      { n: 20, name: 'Export Markdown', desc: 'miroir lisible en fichiers .md' },
      { n: 21, name: 'Dialectique', desc: 'confronte les points de vue de la mémoire' },
    ],
  },
  {
    title: 'Sur validation',
    subtitle: 'ne s’applique jamais sans votre accord',
    layers: [
      { n: 22, name: 'Récurrences', desc: 'repère ce qui revient souvent', stat: 'patterns' },
      { n: 23, name: 'Auto-compétences', desc: 'propose des procédures depuis les récurrences' },
      { n: 24, name: 'Révision (mutations)', desc: 'applique la supersession sur validation' },
    ],
  },
]

export function System() {
  const { state, reload } = useLoad(getCognitiveStats)

  return (
    <section>
      <header className="screen-head">
        <div>
          <h1>Système</h1>
          <p className="muted">Les 24 couches qui font la mémoire de Memoria — et ce qu’elles contiennent en ce moment.</p>
        </div>
        <button type="button" className="btn btn-ghost" onClick={reload}>Actualiser</button>
      </header>

      {state.status === 'loading' && <Spinner />}
      {state.status === 'error' && <ErrorBanner message={state.message} onRetry={reload} />}
      {state.status === 'ready' && (
        <div className="system-buckets">
          {BUCKETS.map(bucket => (
            <div key={bucket.title} className="system-bucket">
              <div className="system-bucket-head">
                <h2>{bucket.title}</h2>
                <span className="muted">{bucket.subtitle}</span>
              </div>
              <div className="layer-grid">
                {bucket.layers.map(l => {
                  const value = l.stat ? state.data[l.stat] : undefined
                  return (
                    <div key={l.n} className="layer-card">
                      <div className="layer-top">
                        <span className="layer-num">{l.n}</span>
                        <strong>{l.name}</strong>
                        {value !== undefined && value > 0 && <span className="layer-stat">{value.toLocaleString('fr-FR')}</span>}
                      </div>
                      <p className="muted layer-desc">{l.desc}</p>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
