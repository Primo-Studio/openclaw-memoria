/**
 * Liste de fiches — la version MOBILE d'un tableau de données.
 *
 * POURQUOI : un `DataTable` défile horizontalement à l'intérieur de sa carte,
 * mais la carte est en `overflow-hidden` : à 390 px, la coupe tombe pile au
 * bord, sans ombre ni barre de défilement. Rien ne dit qu'il reste des
 * colonnes — sur Partage, deux agents sur trois devenaient invisibles ; sur le
 * Journal, la colonne « Action » était tranchée en plein mot. Sous `sm`, on ne
 * montre donc plus un tableau rogné mais une fiche par ligne, où tout tient en
 * pleine largeur.
 *
 * DEPUIS LA PASSE SOCLE, `DataTable` bascule TOUT SEUL sur cette forme sous
 * 640 px (prop `mobile`, « cards » par défaut) : un écran n'a plus rien à faire
 * pour être correct au téléphone. Ce composant reste public pour les listes qui
 * ne passent pas par `DataTable` (colonnes composites, actions par ligne) —
 * usage : `<div className="sm:hidden"><DataCards …/></div>` +
 *         `<div className="hidden sm:block"><DataTable mobile="table" …/></div>`.
 * Les deux arbres coexistent dans le DOM : ne jamais y poser d'`id` (doublon),
 * les libellés accessibles passent par `aria-label`.
 */
import type { ReactNode } from 'react'
import { cn } from '../lib/utils'

export interface CardField {
  /** Libellé court (même vocabulaire que l'en-tête de colonne du tableau). */
  label: ReactNode
  /** Clé de rendu — requise quand `label` n'est pas une chaîne (en-tête composé). */
  key?: string
  value: ReactNode
}

export function DataCards<T>({
  rows,
  rowKey,
  title,
  subtitle,
  fields,
  className,
}: {
  rows: readonly T[]
  rowKey: (row: T) => string
  /** Ce qui identifie la ligne : lu en premier, en gras. */
  title: (row: T) => ReactNode
  /** Précision sous le titre (raison, détail) — facultatif. */
  subtitle?: (row: T) => ReactNode
  /** Le reste des colonnes, en paires libellé / valeur. */
  fields: (row: T) => CardField[]
  className?: string
}) {
  return (
    <ul className={cn('flex flex-col gap-2', className)}>
      {rows.map(row => {
        const sub = subtitle?.(row)
        return (
          <li key={rowKey(row)} className="rounded-lg border bg-card px-3 py-2.5">
            <div className="text-sm font-medium break-words">{title(row)}</div>
            {sub && <div className="mt-0.5 text-xs text-muted-foreground break-words">{sub}</div>}
            <dl className="mt-2 flex flex-col gap-1 text-sm">
              {fields(row).map(f => (
                <div key={f.key ?? String(f.label)} className="flex flex-wrap items-baseline gap-x-2">
                  <dt className="shrink-0 text-xs text-muted-foreground">{f.label}</dt>
                  <dd className="min-w-0 break-words">{f.value}</dd>
                </div>
              ))}
            </dl>
          </li>
        )
      })}
    </ul>
  )
}
