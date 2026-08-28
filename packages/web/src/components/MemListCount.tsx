/**
 * Compteur d'une liste pleine largeur — UNE seule forme pour Mémoire, Revue,
 * Maintenance et Révisions.
 *
 * POURQUOI : le même renseignement — combien d'éléments dans la liste —
 * était formulé et placé autrement sur chaque écran : « 35 souvenirs trouvés »
 * avec un sous-titre redondant, « 35 souvenirs affichés », « 6 souvenirs en
 * attente » précédé d'une icône presse-papier, « 1 proposition » précédée
 * d'une autre icône. L'œil devait rechercher le compteur à un endroit
 * différent à chaque onglet.
 *
 * Deux formes seulement dans l'application : cette ligne au-dessus des listes
 * pleine largeur, et la pastille chiffrée dans l'en-tête d'une SectionCard
 * quand la liste vit dans une carte (Thèmes, Personnes, Journal).
 */
import type { ReactNode } from 'react'

export function MemListCount({ label, hint, children }: { label: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0">
        <h2 className="text-sm font-medium">{label}</h2>
        {/* Sous-titre SEULEMENT quand il ajoute quelque chose (la recherche en
            cours) — jamais une paraphrase du compteur. */}
        {hint && <p className="truncate text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </div>
  )
}
