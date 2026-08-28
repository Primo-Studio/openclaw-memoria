/**
 * Plancher tactile des boutons d'action d'une ligne / d'une carte.
 *
 * VIDE DEPUIS LA PASSE SOCLE : le plancher vit désormais dans le variant `sm`
 * de `components/ui/button.tsx` (`max-sm:h-11`, soit 44 px sous 640 px), donc
 * pour TOUS les écrans — y compris ceux à écrire demain. La constante reste
 * exportée (chaîne vide) pour ne pas forcer une retouche des écrans qui
 * l'importent ; elle imposait 40 px, ce qui aurait battu le plancher de 44 px
 * du variant (tailwind-merge donne raison à la classe de l'appelant).
 *
 * À supprimer avec ses derniers imports (Agents, Review, Memory).
 */
export const TOUCH_ROW_ACTION = ''
