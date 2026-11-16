/**
 * Texte qui n'entre jamais dans l'espace d'équipe et ne voyage jamais entre
 * les Mac : un sujet sensible (filtre local du tri : paie, impôts, santé,
 * identité…) ou un secret (référence `[secret:…]` posée par le masquage, ou
 * secret encore en clair que le masqueur repère).
 *
 * Même règle partout : écriture d'un agent (assertTeamWrite), partage
 * (teamShareRefusal), et synchro à l'ENVOI comme à l'ARRIVÉE, sur le hub et
 * sur les Mac reliés. Un Mac sur un ancien code, ou modifié, ne fait donc
 * rien passer par la synchro que l'écriture directe aurait refusé.
 *
 * Ne fait que REPÉRER : rien n'est masqué ni mis au coffre (un fait refusé ne
 * laisse rien nulle part).
 */
import { RegexRedactor } from '../secrets/redaction.js'
import type { Redactor } from '../secrets/types.js'
import { isSensitive } from '../triage/sensitive.js'

/** Référence posée par le masquage à la place d'un secret (`[secret:<nom>]`). */
export const SECRET_REF = '[secret:'

const defaultRedactor = new RegexRedactor()

/** Raison d'écarter ce texte de l'espace d'équipe, ou null s'il peut y entrer. */
export function teamTextRefusal(text: string, redactor: Redactor = defaultRedactor): 'sensitive' | 'secret' | null {
  if (isSensitive(text)) return 'sensitive'
  if (hasSecret(text, redactor)) return 'secret'
  return null
}

/** Le texte porte un secret : référence au coffre ou valeur en clair. */
export function hasSecret(text: string, redactor: Redactor = defaultRedactor): boolean {
  return text.includes(SECRET_REF) || redactor.redact(text).found.length > 0
}
