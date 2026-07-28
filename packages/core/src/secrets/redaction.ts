/**
 * Redaction par regex (spec §9, D2 — gate dur) : détecte les secrets connus
 * AVANT storeFact et les remplace par `[secret:<name>]`. La valeur part au
 * coffre, jamais dans facts/.md/logs/audit/projection.
 *
 * Ordre des patterns = du plus spécifique au plus générique (le générique ne
 * doit jamais re-capturer un placeholder déjà posé).
 */
import { sha256Hex } from '../util.js'
import type { DetectedSecret, RedactionResult, Redactor } from './types.js'

interface SecretPattern {
  kind: string
  /** DOIT porter les flags `g` et `d` (indices de groupes). */
  regex: RegExp
  /** Si défini, seul ce groupe de capture est redacté (le contexte est gardé). */
  group?: number
  /**
   * Contrôle final sur la valeur capturée : `false` = ce n'est pas un secret,
   * on laisse le texte intact. Indispensable pour les formats à somme de
   * contrôle (IBAN mod-97, carte Luhn) : une regex seule y produirait un flot
   * de faux positifs sur n'importe quelle suite de chiffres.
   */
  validate?: (value: string) => boolean
}

/**
 * NB faux positifs : un hash git fait 40 hex — le pattern aws-secret exige donc
 * un contexte `aws…secret/key/token…=` ; le token générique exige un mot-clé
 * (`password|token|secret|api key`) suivi de `:`/`=`.
 */
const PATTERNS: ReadonlyArray<SecretPattern> = [
  // Blocs PEM en premier : ils contiennent du base64 qui matcherait JWT/générique.
  {
    kind: 'pem-private-key',
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gd,
  },
  { kind: 'anthropic', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/gd },
  { kind: 'openai', regex: /\bsk-proj-[A-Za-z0-9_-]{20,}/gd },
  { kind: 'openai', regex: /\bsk-[A-Za-z0-9]{20,}\b/gd },
  { kind: 'aws-access-key', regex: /\bAKIA[0-9A-Z]{16}\b/gd },
  {
    kind: 'aws-secret-key',
    regex: /\baws[\w -]{0,32}(?:secret|access|key|token)[\w -]{0,16}["']?\s*[:=]\s*["']?([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+=])/gid,
    group: 1,
  },
  { kind: 'github', regex: /\b(?:gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/gd },
  { kind: 'google', regex: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/gd },
  { kind: 'google-oauth', regex: /\bya29\.[A-Za-z0-9_-]{20,}/gd },
  { kind: 'slack', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])/gd },
  { kind: 'slack-webhook', regex: /\bhttps:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/gd },
  // Stripe (écosystème Primo) : clés secrètes/restreintes/webhook + sessions live.
  { kind: 'stripe', regex: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/gd },
  { kind: 'stripe-webhook', regex: /\bwhsec_[A-Za-z0-9]{20,}/gd },
  { kind: 'stripe-session', regex: /\bcs_(?:live|test)_[A-Za-z0-9]{20,}/gd },
  // Canaux d'agent (Memoria identifie des interlocuteurs Telegram/WhatsApp) et
  // services couramment câblés côté Primo : un token de bot donne le contrôle
  // total du canal, il ne doit jamais transiter vers l'extraction cloud.
  { kind: 'telegram-bot', regex: /\b\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/gd },
  { kind: 'twilio', regex: /\b(?:AC|SK)[0-9a-f]{32}(?![0-9a-f])/gd },
  { kind: 'sendgrid', regex: /\bSG\.[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{16,64}(?![A-Za-z0-9_-])/gd },
  { kind: 'npm-token', regex: /\bnpm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/gd },
  // Chaîne de connexion avec credentials : proto://user:pass@host
  { kind: 'connection-string', regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s:/@]{3,})@[^\s/]+/gid, group: 1 },
  {
    kind: 'jwt',
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_.-])/gd,
  },
  // APRÈS jwt : un `Authorization: Bearer <jwt>` doit rester classé `jwt`. Ne
  // reste ici que le porteur OPAQUE, qui échappait entièrement au gate.
  // `(?!\[secret:)` : ne pas re-capturer un placeholder déjà posé.
  {
    kind: 'http-auth',
    regex: /\b(?:Bearer|Basic)\s+(?!\[secret:)([A-Za-z0-9+/=_.~-]{16,})/gid,
    group: 1,
  },
  // OTP / 2FA : exige un mot-clé EXPLICITE à proximité. Un « code » nu suivi de
  // chiffres serait un code postal, un code erreur ou une référence — d'où la
  // liste fermée de contextes et le `\D{0,12}` qui interdit d'enjamber un autre
  // nombre pour aller chercher le sien.
  {
    kind: 'otp-code',
    regex:
      /\b(?:otp|2fa|mfa|totp|one[-\s]?time[-\s]?(?:code|password|pass)|(?:verification|security|login|auth|confirmation)[-\s]code|code[-\s](?:de[-\s])?(?:v[ée]rification|confirmation|s[ée]curit[ée]|connexion|acc[èe]s))\D{0,12}(\d{4,8})(?!\d)/gid,
    group: 1,
  },
  // Données financières : la regex seule est ingérable en faux positifs (toute
  // suite de chiffres), la somme de contrôle tranche.
  { kind: 'iban', regex: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/gd, validate: isValidIban },
  { kind: 'payment-card', regex: /\b\d(?:[ -]?\d){12,18}\b/gd, validate: isPaymentCard },
  {
    kind: 'generic-token',
    // (?<!\[) : ne pas re-matcher le mot `secret` d'un placeholder `[secret:…]`
    // déjà posé ; (?!\[secret:) : ne pas capturer un placeholder comme valeur.
    regex: /(?<!\[)\b(?:password|passwd|pwd|token|secret|api[_-]?key|apikey)["']?\s*[:=]\s*["']?(?!\[secret:)([^\s"'`]{12,})/gid,
    group: 1,
  },
]

export class RegexRedactor implements Redactor {
  redact(text: string): RedactionResult {
    const found: DetectedSecret[] = []
    // Nom STABLE PAR VALEUR (hash court) : la même clé vue dans deux captures
    // différentes garde le même nom — deux clés distinctes du même kind ne se
    // disputent jamais la même entrée du coffre (anti-écrasement silencieux).
    const byValue = new Map<string, string>()

    const nameFor = (kind: string, value: string): string => {
      const existing = byValue.get(value)
      if (existing) return existing
      const name = `${kind}-${sha256Hex(value).slice(0, 8)}`
      byValue.set(value, name)
      found.push({ name, kind, value })
      return name
    }

    let out = text
    for (const pattern of PATTERNS) {
      out = applyPattern(out, pattern, nameFor)
    }
    return { text: out, found }
  }
}

function applyPattern(
  text: string,
  pattern: SecretPattern,
  nameFor: (kind: string, value: string) => string,
): string {
  let result = ''
  let last = 0
  for (const m of text.matchAll(pattern.regex)) {
    const span = m.indices?.[pattern.group ?? 0]
    if (!span) continue // groupe optionnel non matché — rien à redacter ici
    const [start, end] = span
    const value = text.slice(start, end)
    // Validation refusée = ce n'était pas un secret : on n'avance PAS `last`,
    // le texte d'origine est donc conservé tel quel.
    if (pattern.validate && !pattern.validate(value)) continue
    result += text.slice(last, start) + `[secret:${nameFor(pattern.kind, value)}]`
    last = end
  }
  return result + text.slice(last)
}

/**
 * Préfixes émetteurs (IIN) réellement attribués, avec les longueurs admises.
 *
 * Luhn SEUL ne suffit pas : environ une suite de chiffres aléatoire sur dix le
 * satisfait, si bien qu'une référence interne ou un identifiant de dossier
 * partait au coffre. Exiger en plus un préfixe d'émetteur réel élimine ces
 * collisions — aucun réseau n'émet de carte commençant par 1, 7, 8 ou 9.
 */
const CARD_ISSUERS: ReadonlyArray<{ prefix: RegExp; lengths: number[] }> = [
  { prefix: /^4/, lengths: [13, 16, 19] }, // Visa
  { prefix: /^5[1-5]/, lengths: [16] }, // Mastercard
  { prefix: /^2(?:2[2-9]|[3-6]\d|7[01])/, lengths: [16] }, // Mastercard (plage 2-séries)
  { prefix: /^3[47]/, lengths: [15] }, // American Express
  { prefix: /^3(?:0[0-5]|095|[689]\d)/, lengths: [14, 16, 19] }, // Diners Club
  { prefix: /^35(?:2[89]|[3-8]\d)/, lengths: [16, 19] }, // JCB
  { prefix: /^6(?:011|5\d\d|4[4-9]\d|22[1-9])/, lengths: [16, 19] }, // Discover
  { prefix: /^62/, lengths: [16, 17, 18, 19] }, // UnionPay
]

/** Numéro de carte plausible : émetteur réel, longueur admise, et Luhn valide. */
export function isPaymentCard(value: string): boolean {
  const digits = value.replace(/[^\d]/g, '')
  if (!CARD_ISSUERS.some(i => i.prefix.test(digits) && i.lengths.includes(digits.length))) return false
  return isLuhnValid(digits)
}

/**
 * Luhn (ISO/IEC 7812) — écarte les suites de chiffres qui ne sont pas des
 * numéros de carte (tailles de fichiers, identifiants, horodatages…).
 */
export function isLuhnValid(value: string): boolean {
  const digits = value.replace(/[^\d]/g, '')
  if (digits.length < 13 || digits.length > 19) return false
  // Un numéro entièrement répétitif (0000…, 1111…) est un remplissage, pas une
  // carte — et certains passent Luhn.
  if (/^(\d)\1+$/.test(digits)) return false
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

/**
 * IBAN mod-97 (ISO 13616) : les 4 premiers caractères passent à la fin, les
 * lettres deviennent A=10…Z=35, et le reste modulo 97 doit valoir 1. Calculé par
 * blocs pour rester exact au-delà de la précision d'un Number.
 */
export function isValidIban(value: string): boolean {
  const iban = value.replace(/\s+/g, '').toUpperCase()
  if (iban.length < 15 || iban.length > 34) return false
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) return false
  const rearranged = iban.slice(4) + iban.slice(0, 4)
  let remainder = 0
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0)
    const chunk = code >= 65 ? String(code - 55) : ch // A→10 … Z→35
    for (const digit of chunk) remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97
  }
  return remainder === 1
}
