/**
 * Plancher tactile des boutons d'action d'une ligne / d'une carte.
 *
 * POURQUOI : `size="sm"` fait 28 px de haut. Au doigt, la cible recommandée
 * est de 44 px ; à 28 px, sur l'écran Revue, « Approuver » et « Rejeter »
 * (irréversible) sont deux cibles minuscules côte à côte. Sous 640 px on
 * remonte donc la hauteur à 40 px et on élargit un peu le bouton, sans rien
 * changer sur bureau où la souris est précise et où la densité est utile.
 *
 * ADAPTATION LOCALE : le vrai correctif est un plancher dans le variant `sm`
 * de `components/ui/button.tsx` (fichier transverse, hors de ce lot) —
 * cette constante fait le même travail écran par écran en attendant.
 */
export const TOUCH_ROW_ACTION = 'max-sm:h-10 max-sm:px-3'
