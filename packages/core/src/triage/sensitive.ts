/**
 * FILTRE SENSIBLE LOCAL du tri : appliqué AVANT tout envoi à une IA (LLM ou
 * vecteurs). Règle du propriétaire : paie, salaire, impôts, URSSAF, charges
 * sociales, IBAN, santé, mot de passe, pièces d'identité… ne partent jamais.
 *
 * Un fait sensible reçoit `sensible = 1`, genre NULL, aucun vecteur ; ses
 * redites ne sont cherchées qu'en exact. Il reste visible à l'administration
 * (onglet « sensible ») et ne se valide que par une action explicite.
 *
 * Choix de précision :
 *  - « brut » et « net » seuls sont des mots courants en informatique
 *    (« texte brut », « .NET ») : ils ne comptent qu'en contexte de paie
 *    (« salaire net », « 1 800 € brut », « net par mois ») ;
 *  - « santé » technique (« bilan de santé du daemon ») est écartée avant le test.
 * Le texte est comparé sans casse ni accents.
 */
import { normalizeText } from '../storage/content.js'

/** Motifs (texte normalisé : minuscules, sans accents, apostrophes droites). */
export const SENSITIVE_PATTERNS: readonly RegExp[] = [
  // Paie et rémunération
  /\bpaies?\b/,
  /\bpayroll\b/,
  /\bsalaires?\b/,
  /\bsalaria(l|le|les|ux)\b/,
  /\bremunerations?\b/,
  /\bbulletins?\b/,
  /\bfiches? de paie\b/,
  /\bcout employeur\b/,
  /\btaux horaires?\b/,
  /€\s*\/\s*(h|heure|mois)\b/,
  /\beuros?\s*(\/|par|de l')\s*(h|heure|mois)\b/,
  /\bheures? sup(p|plementaires?)?\b/,
  /\bheures? en plus\b/,
  // Récupération d'heures et congés d'un salarié (« récupérer » seul est technique).
  /\b(jours?|heures?|journees?|demi-journees?) de recup(eration)?\b/,
  /\ben recup(eration)?\b/,
  /\bconges? (payes|annuels?|sans solde|parentals?|sabbatiques?)\b/,
  /\b(solde|jours?|semaines?|demande|prise) de conges?\b/,
  /\b(salaire|montant|revenu|remuneration|paie|mensuel|annuel|horaire|euros?|k?€)\s+(brut|net)s?\b/,
  /(^|[^.\w])(brut|net)s?\s+(mensuel|annuel|horaire|imposable|a payer|par mois|par an|de l'heure)\b/,
  /\d\s*(k?€|euros?)\s*(brut|net)s?\b/,
  // « payé » s'écrit « paye » une fois normalisé : fiche de paye, net à payer.
  /\bfiches? de paye\b/,
  /\bnet a payer\b/,
  // Somme payée ou versée (à une personne, le plus souvent) : le verbe et un montant dans la même phrase.
  // Le montant est BORNÉ (AMOUNT) : `[\d\s.,]*` coûtait un temps quadratique sur
  // une longue suite de chiffres (tableau, CSV), 0,5 s pour 20 000 caractères.
  /\b(paye|payee|payes|payees|payer|verse|versee|verses|versees|verser|touche|touchee|toucher|percoit|percu|percue|percevoir|gagne|gagnes|gagnent|gagner|gagnait|gagnera)\b[^.\n]{0,40}\d[\d\s.,]{0,20}\s?(k?€|euros?)/,
  // `\b` après « € » exigeait une lettre collée : « 1 850 € versés » passait, seul « euros » comptait.
  /\d[\d\s.,]{0,20}\s?(k?€|euros?\b)[^.\n]{0,40}\b(paye|payee|payes|payees|verse|versee|verses|versees)\b/,
  // « Le net de Camille est de 1 850 € » : le net (d'une paie) suivi d'un montant.
  /(^|[^.\w])(le|son|sa|mon|ma|ton|leur|notre|votre) net\b[^.\n]{0,40}\d[\d\s.,]{0,20}\s?(k?€|euros?)/,
  // Virement d'un montant À QUELQU'UN (« à Camille ») ; « à la banque », « pour la facture » restent permis.
  /\bvirements?\b[^.\n]{0,40}\d[\d\s.,]{0,20}\s?(k?€|euros?)\s+a\s+(?!(la|l'|le|les|un|une|des|notre|votre|nos|vos|leur|leurs|mon|ma|mes|ton|ta|tes|son|sa|ses|ce|cet|cette|ces)\b)[a-z]/,
  // Anglais et portugais : les mêmes mots de la paie (un tour Codex ou Claude Code peut être en anglais).
  /\bsalar(y|ies)\b/,
  /\bpay ?(slips?|stubs?|checks?|cheques?)\b/,
  /\bwages?\b/,
  /\bsalarios?\b/,
  /\bholerites?\b/,
  /\bcontracheques?\b/,
  /\bsmic\b/,
  /\bprimes? (de fin d'annee|exceptionnelles?|d'anciennete|de rendement|de precarite|annuelles?|mensuelles?|de noel|d'objectifs?|macron|de partage|d'activite|de naissance)\b/,
  /\b(sa|ta|ma|leur|une|des|ses|mes|tes) primes?\b/,
  /\bacomptes? (sur|de) salaire\b/,
  /\bavances? sur salaire\b/,
  /\bacomptes? verses? a (?!la |l'|la commande|la signature)/,
  // Impôts, fiscalité, charges
  /\bimpots?\b/,
  /\bimposi(tion|ble|bles)\b/,
  /\bavis d'impo/,
  /\bfiscal(e|es|ite|aux)?\b/,
  /\bdefiscalis/,
  /\bprelevement a la source\b/,
  /\burssaf\b/,
  /\bcharges sociales\b/,
  /\bcotisations? sociales?\b/,
  /\bdsn\b/,
  /\bdeclarations? (de revenus|d'impots?|fiscales?)\b/,
  /\brevenus? (fiscal|imposable|du foyer|du menage)\b/,
  // « tax » seul est trop courant (tax rate d'un panier) : seulement les impôts d'une personne.
  /\btax (returns?|refunds?|bills?|ids?|numbers?|forms?)\b/,
  /\bincome tax(es)?\b/,
  /\bimpostos?\b/,
  // Aides et situation personnelle
  /\ballocations?\b/,
  /\bcaf\b/,
  /\bchomage\b/,
  /\bpole emploi\b/,
  /\b(rsa|apl)\b/,
  // Banque, dettes, crédits
  /\biban\b/,
  /\brib\b/,
  /\bvirements? personnels?\b/,
  /\bdettes?\b/,
  /\bsurendett/,
  /\bcredits? (immobiliers?|a la consommation|conso|auto|personnels?)\b/,
  /\bprets? (immobiliers?|personnels?|bancaires?|etudiants?)\b/,
  /\bcartes? (bleues?|bancaires?|de credit)\b/,
  /\bcode secret\b/,
  /\bcryptogramme\b/,
  /\bcvv\b/,
  // Identité
  /\bsecurite sociale\b/,
  /\bnumero de secu\b/,
  /\bcarte vitale\b/,
  /\bpasseports?\b/,
  /\bcartes? d'identite\b/,
  /\bpieces? d'identite\b/,
  /\bdates? de naissance\b/,
  /\bnee? le \d/,
  // Année de naissance d'une personne (« née en 1990 ») ; « l'idée est née en 2024 » reste permis.
  /\bnee?s? en (19\d{2}|20[01]\d)\b/,
  /\bsocial security\b/,
  // « Passport » seul est aussi une bibliothèque d'authentification (Passport.js) : seulement le document.
  /\bpassports? (numbers?|no|copy|copies|scans?|photos?|expir\w*|details|renewal)\b/,
  /\b(copy|scan|photo) of [^.\n]{0,20}\bpassports?\b/,
  /\bpassaportes?\b/,
  /\bdates? of birth\b/,
  /\bborn (on|in) \d/,
  // Numéro de sécurité sociale (NIR) : sexe, année, mois, département, commune, ordre, clé.
  /\b[12]\s?\d{2}\s?(0[1-9]|1[0-2])\s?(\d{2}|2a|2b)\s?\d{3}\s?\d{3}(\s?\d{2})?\b/,
  // Santé
  /\bsante\b/,
  /\barrets? maladie\b/,
  /\bconges? maladie\b/,
  /\bmaladies?\b/,
  /\bmutuelles?\b/,
  /\bprevoyance\b/,
  /\bmedecins?\b/,
  /\bmedic(al|ale|ales|aux|aments?)\b/,
  /\bhospitalis/,
  /\bmalades?\b/,
  /\bhopita(l|ux)\b/,
  /\bcliniques?\b/,
  /\barrets? de travail\b/,
  /\bordonnances?\b/,
  // « enceinte » seule désigne aussi un haut-parleur (studio) : seulement la grossesse.
  /\b(est|etait|suis|es|etre|tombee|serait) enceinte\b/,
  /\bgrossesse\b/,
  /\bmaternite\b/,
  /\bpaternite\b/,
  /\bfausse couche\b/,
  // « traitement » seul est un mot de l'informatique (traitement des données).
  /\b(suit|suivre|suivi|sous|prend|prendre|commence|arrete) (un |son |ce |le )?traitement\b/,
  /\btraitements? (medica|contre|pour (l'|la |le |les |son |sa )?(asthme|diabete|cancer|depression|douleur|tension))/,
  /\bdepression\b/,
  /\bburn.?out\b/,
  /\bpsychiatr/,
  /\bpsychologue\b/,
  /\boperations? (du|de la|des|de l') ?(genou|coeur|dos|hanche|epaule|yeux|oeil|appendicite|ventre|main|pied|cheville)\b/,
  /\bdeces\b/,
  /\bobseques\b/,
  /\benterrement\b/,
  /\bdentistes?\b/,
  /\bkine(s|sitherapeutes?|sitherapie)?\b/,
  /\bgrippe\b/,
  // Anglais : « doctor » seul est une commande (« memoria doctor », « brew doctor »).
  /\bdoctor'?s? (appointments?|visits?|notes?)\b/,
  /\bsick (leave|days?|notes?|pay)\b/,
  /\bhealth (insurance|conditions?|records?)\b/,
  // Portugais.
  /\bsaude\b/,
  /\bmedicos?\b/,
  /\batestados?\b/,
  // Accès. Les tirets ne sont pas retirés par la normalisation : « mot-de-passe », « motdepasse ».
  /\bmots?[\s_-]*de[\s_-]*passe\b/,
  /\bmotdepasse\b/,
  /\bmdp\b/,
  /\bpasswords?\b/,
  // « ce qui se passe : » est courant : seulement les formes anglaises.
  /\b(pass|passwd|pwd)\s*[:=]/,
  /\b(login|identifiants?|user(name)?)\b[^.\n]{0,40}\bpass(wd)?\b/,
  /\bidentifiants? (de connexion|et (le )?mot)/,
  /\bcodes? (pin|d'acces|wifi|wi-fi|de deverrouillage)\b/,
  /\bpassphrase\b/,
]

/** Tournures techniques écartées avant le test (« santé » d'un logiciel). */
const TECHNICAL_ALLOWED: readonly RegExp[] = [
  /\b(sonde|check|test|indicateur)s? de sante\b/g,
  /\bsante (du|de la|des|de l'|d'un|d'une) ?(daemon|serveur|systeme|base|service|api|app|application|site|machine|disque|nas|llm|moteur|code|projet|index|reseau|memoire|memoria|pipeline|cluster|stockage|import)s?\b/g,
  // La dette technique d'un code n'a rien de personnel.
  /\bdettes? (techniques?|de code|de design|d'architecture|de tests?|de documentation)\b/g,
]

function prepare(text: string): string {
  let t = normalizeText(text).replace(/[’‘`]/g, "'").replace(/[  ]/g, ' ')
  for (const re of TECHNICAL_ALLOWED) t = t.replace(re, ' ')
  return t
}

/** Motif qui fait d'un texte un texte sensible (pour expliquer un classement), ou null. */
export function sensitiveMatch(text: string): string | null {
  const t = prepare(text)
  for (const re of SENSITIVE_PATTERNS) {
    const m = re.exec(t)
    if (m) return m[0].trim()
  }
  return null
}

/** Vrai si le texte ne doit JAMAIS partir vers une IA (LLM ou vecteurs). */
export function isSensitive(text: string): boolean {
  return sensitiveMatch(text) !== null
}
