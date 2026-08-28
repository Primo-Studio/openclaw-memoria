/**
 * Coffre — les secrets (clés API, mots de passe…) détectés dans les
 * conversations sont automatiquement mis à l'abri : Memoria ne garde qu'une
 * RÉFÉRENCE, la valeur vit dans le coffre du système (Keychain macOS / coffre
 * chiffré). Cet écran montre ce qui est protégé — jamais la valeur.
 *
 * Migré sur shadcn : PageHeader, explication en Alert, DataTable triable
 * (référence, type, date), emplacement en Badge lisible (« Trousseau macOS »
 * plutôt que `keychain`), états chargement / erreur / vide.
 */
import { useState } from 'react'
import { Lock, ShieldCheck } from 'lucide-react'
import { getSecrets, type SecretRef } from '../api'
import { DataTable, EmptyState, ErrorBanner, PageHeader, SectionCard, formatDay, formatNumber, useLoad, type DataColumn } from '../components/ui'
import { DataCards } from '../components/DataCards'
import { MemRefreshButton } from '../components/MemRefreshButton'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Skeleton } from '../components/ui/skeleton'
import { useT } from '../i18n'
import { cn } from '../lib/utils'
import { nextSort, type SortState } from '../lib/sort'

type Translate = (key: string, vars?: Record<string, string | number>) => string

// Préfixes d'emplacement émis par core/secrets (`keychain:…`, `vault:…`) → libellé traduit.
const KNOWN_LOCATIONS = new Set(['keychain', 'vault'])

function locationLabel(t: Translate, location: string): string {
  const kind = location.split(':')[0] ?? location
  return KNOWN_LOCATIONS.has(kind) ? t(`vault.location.${kind}`) : kind
}

type SortKey = 'name' | 'service' | 'location' | 'created_at'
const DATE_KEYS: readonly SortKey[] = ['created_at']

function sortValue(t: Translate, s: SecretRef, key: SortKey): string {
  switch (key) {
    case 'name':
      return s.name
    case 'service':
      return s.service ?? ''
    case 'location':
      return locationLabel(t, s.location)
    case 'created_at':
      return s.created_at
  }
}

export function Vault() {
  const { t } = useT()
  const { state, reload } = useLoad(getSecrets)

  return (
    <>
      <PageHeader
        title={t('vault.title')}
        description={t('vault.lead')}
        actions={
          <MemRefreshButton label={t('common.refresh')} onClick={reload} disabled={state.status === 'loading'} spinning={state.status === 'loading'} />
        }
      />

      <Alert className="mb-4 border-success/30 bg-success/5">
        <Lock />
        <AlertTitle>{t('vault.explainer.title')}</AlertTitle>
        <AlertDescription>
          <p>
            {t('vault.explainer.before')}
            <code className="mx-0.5 rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">[secret:…]</code>
            {t('vault.explainer.mid')} <strong className="text-foreground">{t('vault.explainer.never')}</strong>
            {t('vault.explainer.after')}
          </p>
        </AlertDescription>
      </Alert>

      {state.status === 'loading' && <Skeleton className="h-40 w-full rounded-xl" role="status" aria-label={t('common.loading')} />}
      {state.status === 'error' && <ErrorBanner message={state.message} onRetry={reload} />}
      {state.status === 'ready' &&
        (state.data.length === 0 ? (
          <EmptyState icon={<ShieldCheck className="size-5" />} title={t('vault.empty.title')} body={t('vault.empty.body')} />
        ) : (
          <SecretsTable secrets={state.data} />
        ))}
    </>
  )
}

function SecretsTable({ secrets }: { secrets: SecretRef[] }) {
  const { t } = useT()
  // Tri par défaut : les plus récents d'abord (même ordre que le daemon).
  const [sort, setSort] = useState<SortState<SortKey>>({ key: 'created_at', dir: 'desc' })

  const sorted = [...secrets].sort((a, b) => {
    const cmp = sortValue(t, a, sort.key).localeCompare(sortValue(t, b, sort.key), undefined, { numeric: true })
    return sort.dir === 'asc' ? cmp : -cmp
  })

  const columns: DataColumn<SecretRef>[] = [
    {
      id: 'name',
      header: t('vault.col.reference'),
      sortable: true,
      cell: s => <code className="font-mono text-xs">{s.name}</code>,
    },
    { id: 'service', header: t('vault.col.type'), sortable: true, cell: s => s.service ?? '—' },
    {
      id: 'location',
      header: t('vault.col.location'),
      sortable: true,
      cell: s => <Badge variant="secondary">{locationLabel(t, s.location)}</Badge>,
    },
    { id: 'created_at', header: t('vault.col.added'), sortable: true, cell: s => <span className="text-muted-foreground">{formatDay(s.created_at)}</span> },
  ]

  return (
    <SectionCard title={t('vault.list_title')} description={t(secrets.length > 1 ? 'vault.count_plural' : 'vault.count', { count: formatNumber(secrets.length) })}>
      {/* Sous 640 px : une fiche par référence. Une référence de coffre est une
          chaîne technique longue — dans un tableau à 4 colonnes, elle sortait
          de la carte sans le moindre indice de défilement. */}
      <div className="sm:hidden">
        <DataCards
          rows={sorted}
          rowKey={s => s.name}
          title={s => <code className="font-mono text-xs break-all">{s.name}</code>}
          fields={s => [
            { label: t('vault.col.type'), value: s.service ?? '—' },
            { label: t('vault.col.location'), value: <Badge variant="secondary">{locationLabel(t, s.location)}</Badge> },
            { label: t('vault.col.added'), value: <span className="text-muted-foreground">{formatDay(s.created_at)}</span> },
          ]}
        />
      </div>
      <div className="hidden sm:block">
        <DataTable
          columns={columns}
          rows={sorted}
          rowKey={s => s.name}
          sort={{ by: sort.key, dir: sort.dir }}
          onSort={next => setSort(s => nextSort(s, next.by as SortKey, DATE_KEYS))}
        />
      </div>
    </SectionCard>
  )
}
