/**
 * Gate secrets — motifs ajoutés suite au retour bêta « confidentialité explicite » :
 * canaux d'agent (Telegram/Twilio/SendGrid/npm), porteurs HTTP opaques, codes OTP,
 * et données financières (IBAN mod-97, carte Luhn).
 *
 * Import DIRECT du module de redaction (pas de `src/index.js`) : ces tests sont
 * purs et ne doivent pas dépendre du binding natif SQLite.
 *
 * Fixtures construites par CONCATÉNATION : ne jamais écrire dans le source un
 * littéral qui ressemble à un vrai secret (GitHub Push Protection le bloque).
 */
import { describe, expect, it } from 'vitest'
import { isLuhnValid, isPaymentCard, isValidIban, RegexRedactor } from '../src/secrets/redaction.js'

const redactor = new RegexRedactor()

/** Vérifie : valeur absente de la sortie + kind attendu + placeholder posé. */
function expectRedacted(text: string, value: string, kind: string): void {
  const r = redactor.redact(text)
  expect(r.text, `la valeur devait disparaître de : ${text}`).not.toContain(value)
  const hit = r.found.find(f => f.kind === kind)
  expect(hit, `kind '${kind}' attendu dans ${JSON.stringify(r.found)}`).toBeDefined()
  expect(hit?.value).toBe(value)
  expect(r.text).toContain(`[secret:${hit?.name}]`)
}

describe('canaux d’agent et services', () => {
  it('token de bot Telegram', () => {
    const v = '1234567890' + ':' + 'AAH' + 'a'.repeat(32)
    expectRedacted(`le bot répond avec ${v} voilà`, v, 'telegram-bot')
  })

  it('Twilio (AC / SK + 32 hex)', () => {
    const v1 = 'AC' + 'a1b2c3d4'.repeat(4)
    expectRedacted(`compte ${v1} actif`, v1, 'twilio')
    const v2 = 'SK' + '0f1e2d3c'.repeat(4)
    expectRedacted(`clé ${v2} tournée`, v2, 'twilio')
  })

  it('SendGrid', () => {
    const v = 'SG.' + 'abcdefghij1234567890AB' + '.' + 'cdefghij1234567890ABCDEFGHIJ1234567890abcdefg'
    expectRedacted(`envoi via ${v} ok`, v, 'sendgrid')
  })

  it('token npm', () => {
    const v = 'npm_' + 'aBcDeF1234567890aBcDeF1234567890aBcD'
    expectRedacted(`publish avec ${v}`, v, 'npm-token')
  })
})

describe('porteurs HTTP opaques', () => {
  it('Bearer opaque (non-JWT) est capturé', () => {
    const v = 'aBcDeF1234567890opaqueTOKEN'
    expectRedacted(`Authorization: Bearer ${v}`, v, 'http-auth')
  })

  it('Basic est capturé', () => {
    const v = 'dXNlcjpwYXNzd29yZDEyMzQ1Ng=='
    expectRedacted(`Authorization: Basic ${v}`, v, 'http-auth')
  })

  it('un Bearer porteur d’un JWT reste classé `jwt` (le spécifique prime)', () => {
    const v =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    const r = redactor.redact(`Authorization: Bearer ${v}`)
    expect(r.text).not.toContain(v)
    expect(r.found.map(f => f.kind)).toEqual(['jwt'])
  })
})

describe('codes OTP / 2FA', () => {
  it('capture un code derrière un mot-clé explicite', () => {
    expectRedacted('ton code de vérification : 483920 (valable 5 min)', '483920', 'otp-code')
    expectRedacted('OTP 918273 reçu', '918273', 'otp-code')
    expectRedacted('the verification code is 55219', '55219', 'otp-code')
    expectRedacted('2FA = 100294', '100294', 'otp-code')
  })

  it('un « code » sans contexte d’authentification n’est PAS un OTP', () => {
    const samples = [
      'le code postal est 75011',
      'code erreur 50032 au déploiement',
      'code NAF 6201Z pour Primo',
      'on passe au code de la route demain',
    ]
    for (const s of samples) {
      const r = redactor.redact(s)
      expect(r.text, `faux positif OTP sur : ${s}`).toBe(s)
    }
  })
})

describe('données financières (somme de contrôle)', () => {
  it('IBAN valide redacté, IBAN invalide laissé intact', () => {
    const valid = 'DE89370400440532013000'
    expectRedacted(`vire sur ${valid} stp`, valid, 'iban')

    const spaced = 'GB82 WEST 1234 5698 7654 32'
    const r = redactor.redact(`compte ${spaced} ouvert`)
    expect(r.text).not.toContain('WEST')
    expect(r.found[0]?.kind).toBe('iban')

    // Même forme, checksum fausse → ce n'est pas un IBAN.
    const invalid = 'DE89370400440532013001'
    const r2 = redactor.redact(`ref ${invalid} interne`)
    expect(r2.text).toBe(`ref ${invalid} interne`)
  })

  it('carte Luhn-valide redactée, suite de chiffres quelconque intacte', () => {
    const card = '4242' + '4242' + '4242' + '4242'
    expectRedacted(`la carte ${card} expire en 2029`, card, 'payment-card')

    const spaced = '4111 1111 1111 1111'
    const r = redactor.redact(`carte ${spaced} test`)
    expect(r.text).not.toContain('4111')
    expect(r.found[0]?.kind).toBe('payment-card')

    // `9876543210987` satisfait Luhn : c'est précisément le cas que le contrôle
    // d'émetteur doit rattraper (aucune carte ne commence par 9).
    for (const s of [
      'fichier taille 1234567890123 octets',
      'référence 9876543210987 du dossier',
      'facture 7000000000009 réglée',
    ]) {
      expect(redactor.redact(s).text, `faux positif carte sur : ${s}`).toBe(s)
    }
  })

  it('Luhn seul ne suffit pas : l’émetteur doit être réel', () => {
    expect(isLuhnValid('9876543210987')).toBe(true) // Luhn OK…
    expect(isPaymentCard('9876543210987')).toBe(false) // …mais aucun émetteur en 9

    expect(isPaymentCard('4242424242424242')).toBe(true) // Visa
    expect(isPaymentCard('4242424242424241')).toBe(false) // Luhn KO
    expect(isPaymentCard('378282246310005')).toBe(true) // Amex, 15 chiffres
    expect(isPaymentCard('4242424242424')).toBe(false) // Visa 13 mais Luhn KO
    expect(isPaymentCard('0000000000000000')).toBe(false) // remplissage
  })

  it('mod-97 : validation IBAN', () => {
    expect(isValidIban('DE89370400440532013000')).toBe(true)
    expect(isValidIban('GB82 WEST 1234 5698 7654 32')).toBe(true)
    expect(isValidIban('DE89370400440532013001')).toBe(false)
    expect(isValidIban('XX00')).toBe(false)
  })
})

describe('non-régression du gate', () => {
  it('les faux positifs historiques le restent', () => {
    const samples = [
      'commit 3f2b8a9c1d4e5f60718293a4b5c6d7e8f9012345 sur main',
      'id 550e8400-e29b-41d4-a716-446655440000 créé hier',
      'voir https://docs.example.com/guide/installation?page=2&lang=fr',
      'le secret est bien gardé, le mot de passe sera changé demain',
      'sk-court non plus, ni AKIA tout seul, ni eyJtropCourt.x.y',
      'fichier /usr/local/bin/security taille 1234567890123 octets',
    ]
    for (const s of samples) {
      const r = redactor.redact(s)
      expect(r.text, `faux positif sur : ${s}`).toBe(s)
      expect(r.found).toHaveLength(0)
    }
  })

  it('repasser un texte déjà redacté est idempotent', () => {
    const v = 'npm_' + 'aBcDeF1234567890aBcDeF1234567890aBcD'
    const once = redactor.redact(`token ${v} fin`)
    const twice = redactor.redact(once.text)
    expect(twice.text).toBe(once.text)
    expect(twice.found).toHaveLength(0)
  })
})
