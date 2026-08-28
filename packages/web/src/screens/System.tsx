/**
 * Système — les couches de Memoria, rendues visibles. Les 24 couches cognitives
 * regroupées par rôle, avec leur compteur LIVE (entités, thèmes, procédures…) :
 * on voit la machine tourner. C'est « le cerveau » de Memoria.
 *
 * Migré sur shadcn : une SectionCard par famille (socle, enrichissement,
 * optionnel, sur validation), une tuile par couche avec son numéro, son
 * compteur en Badge quand il est non nul, et un résumé chiffré en tête.
 * Même source de données qu'avant (GET /v1/admin/cognitive_stats) — la santé
 * du stockage vit sur le Tableau de bord, la consommation dans Réglages.
 */
import { getCognitiveStats } from '../api'
import { MemRefreshButton } from '../components/MemRefreshButton'
import { ErrorBanner, PageHeader, SectionCard, StatCard, formatNumber, useLoad } from '../components/ui'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Skeleton } from '../components/ui/skeleton'
import { useT } from '../i18n'
import { cn } from '../lib/utils'

interface Layer {
  n: number
  nameKey: string
  descKey: string
  /** Clé de stat live (cognitive_stats) — optionnel. */
  stat?: string
}

const BUCKETS: Array<{ titleKey: string; subtitleKey: string; layers: Layer[] }> = [
  {
    titleKey: 'system.bucket_active_title',
    subtitleKey: 'system.bucket_active_subtitle',
    layers: [
      { n: 1, nameKey: 'system.layer_1_name', descKey: 'system.layer_1_desc', stat: 'facts' },
      { n: 2, nameKey: 'system.layer_2_name', descKey: 'system.layer_2_desc' },
      { n: 3, nameKey: 'system.layer_3_name', descKey: 'system.layer_3_desc' },
      { n: 4, nameKey: 'system.layer_4_name', descKey: 'system.layer_4_desc' },
      { n: 5, nameKey: 'system.layer_5_name', descKey: 'system.layer_5_desc' },
      { n: 6, nameKey: 'system.layer_6_name', descKey: 'system.layer_6_desc', stat: 'procedures' },
      { n: 7, nameKey: 'system.layer_7_name', descKey: 'system.layer_7_desc' },
      { n: 8, nameKey: 'system.layer_8_name', descKey: 'system.layer_8_desc' },
      { n: 9, nameKey: 'system.layer_9_name', descKey: 'system.layer_9_desc' },
      { n: 10, nameKey: 'system.layer_10_name', descKey: 'system.layer_10_desc' },
      { n: 11, nameKey: 'system.layer_11_name', descKey: 'system.layer_11_desc', stat: 'wal_buffer' },
    ],
  },
  {
    titleKey: 'system.bucket_enrichment_title',
    subtitleKey: 'system.bucket_enrichment_subtitle',
    layers: [
      { n: 12, nameKey: 'system.layer_12_name', descKey: 'system.layer_12_desc', stat: 'embeddings' },
      { n: 13, nameKey: 'system.layer_13_name', descKey: 'system.layer_13_desc', stat: 'relations' },
      { n: 14, nameKey: 'system.layer_14_name', descKey: 'system.layer_14_desc', stat: 'topics' },
      { n: 15, nameKey: 'system.layer_15_name', descKey: 'system.layer_15_desc', stat: 'observations' },
      { n: 16, nameKey: 'system.layer_16_name', descKey: 'system.layer_16_desc', stat: 'fact_clusters' },
      { n: 17, nameKey: 'system.layer_17_name', descKey: 'system.layer_17_desc' },
      { n: 18, nameKey: 'system.layer_18_name', descKey: 'system.layer_18_desc', stat: 'revision_proposals' },
    ],
  },
  {
    titleKey: 'system.bucket_optional_title',
    subtitleKey: 'system.bucket_optional_subtitle',
    layers: [
      { n: 19, nameKey: 'system.layer_19_name', descKey: 'system.layer_19_desc', stat: 'self_observations' },
      { n: 20, nameKey: 'system.layer_20_name', descKey: 'system.layer_20_desc' },
      { n: 21, nameKey: 'system.layer_21_name', descKey: 'system.layer_21_desc' },
    ],
  },
  {
    titleKey: 'system.bucket_validation_title',
    subtitleKey: 'system.bucket_validation_subtitle',
    layers: [
      { n: 22, nameKey: 'system.layer_22_name', descKey: 'system.layer_22_desc', stat: 'patterns' },
      { n: 23, nameKey: 'system.layer_23_name', descKey: 'system.layer_23_desc' },
      { n: 24, nameKey: 'system.layer_24_name', descKey: 'system.layer_24_desc' },
    ],
  },
]

const LAYER_COUNT = BUCKETS.reduce((n, b) => n + b.layers.length, 0)

export function System() {
  const { t } = useT()
  const { state, reload } = useLoad(getCognitiveStats)

  return (
    <>
      <PageHeader
        title={t('system.title')}
        description={t('system.lead')}
        actions={
          <MemRefreshButton label={t('common.refresh')} onClick={reload} disabled={state.status === 'loading'} spinning={state.status === 'loading'} />
        }
      />

      {state.status === 'loading' && <SystemSkeleton />}
      {state.status === 'error' && <ErrorBanner message={state.message} onRetry={reload} />}
      {state.status === 'ready' && <SystemBody stats={state.data} />}
    </>
  )
}

/** Squelette à la forme de l'écran : 3 chiffres clés puis des grilles de tuiles. */
function SystemSkeleton() {
  const { t } = useT()
  return (
    <div className="flex flex-col gap-4" role="status" aria-label={t('common.loading')}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[0, 1, 2].map(i => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-64 w-full rounded-xl" />
      <Skeleton className="h-48 w-full rounded-xl" />
    </div>
  )
}

function SystemBody({ stats }: { stats: Record<string, number> }) {
  const { t } = useT()
  // Résumé : couches suivies par un compteur, et combien contiennent déjà quelque chose.
  const tracked = BUCKETS.flatMap(b => b.layers).filter(l => l.stat !== undefined)
  const live = tracked.filter(l => (stats[l.stat as string] ?? 0) > 0).length

  return (
    <div className="flex flex-col gap-4">
      {/* Deux colonnes sous 640 px : empilées, ces trois nombres mangeaient un
          tiers de l'écran avant la première couche. La 3e carte prend toute la
          largeur pour laisser respirer son libellé. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard value={LAYER_COUNT} label={t('system.stat.layers')} />
        <StatCard value={tracked.length} label={t('system.stat.tracked')} hint={t('system.stat.trackedHint')} />
        <StatCard
          value={live}
          label={t('system.stat.live')}
          tone={live > 0 ? 'ok' : 'default'}
          hint={live === 0 ? t('system.stat.liveHintEmpty') : undefined}
          className="col-span-2 sm:col-span-1"
        />
      </div>

      {BUCKETS.map(bucket => (
        <SectionCard key={bucket.titleKey} title={t(bucket.titleKey)} description={t(bucket.subtitleKey)} className="mb-0">
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {bucket.layers.map(l => {
              const value = l.stat ? stats[l.stat] : undefined
              return (
                <li key={l.n} className="flex flex-col gap-1 rounded-lg border bg-muted/40 px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 font-mono text-xs font-semibold text-primary tabular-nums" aria-hidden="true">
                      {l.n}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium">
                      <span className="sr-only">{t('system.layer_number', { n: l.n })} </span>
                      {t(l.nameKey)}
                    </span>
                    {/* Un badge même à 0 : sans lui, « suivie mais vide » et
                        « sans compteur » se ressemblaient exactement. */}
                    {value !== undefined && (
                      <Badge
                        variant={value > 0 ? 'secondary' : 'outline'}
                        className={cn('tabular-nums', value === 0 && 'text-muted-foreground')}
                        title={t('system.live_count')}
                      >
                        {formatNumber(value)}
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">{t(l.descKey)}</p>
                </li>
              )
            })}
          </ul>
        </SectionCard>
      ))}
    </div>
  )
}
