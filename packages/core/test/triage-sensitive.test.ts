/**
 * Filtre sensible local du tri (règle du propriétaire : rien de la paie, des
 * impôts, de la santé, des accès… ne part vers une IA). Données fictives.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { isSensitive, sensitiveMatch } from '../src/index.js'
import { seedPending, setupTriage, triageRow, type TriageEnv } from './triage-fixtures.js'

describe('motifs', () => {
  it.each([
    'Le bulletin de paie de novembre est prêt',
    'Le salaire de Zorba passe à 2 100 euros',
    'Elle touche 1 800 € net par mois',
    'Le montant brut mensuel est de 2 400 euros',
    'La déclaration URSSAF du trimestre est en retard',
    'Les charges sociales ont augmenté',
    "L'IBAN du compte est enregistré",
    'Son numéro de sécurité sociale commence par 1',
    'Numéro : 1 85 05 78 006 084 36',
    'Le mot de passe du NAS est dans le carnet',
    'Arrêt maladie du 3 au 7 mars',
    'La mutuelle rembourse les lunettes',
    "L'avis d'impôt 2026 est arrivé",
    'Le taux horaire retenu est de 57 €/h',
    'Le coût employeur dépasse le budget',
    'Il a fait 6 heures sup cette semaine',
    "Joindre une pièce d'identité au dossier",
    'Un virement personnel de 300 euros',
    'Une optimisation fiscale est possible',
    'Rendez-vous chez le médecin jeudi',
    'Son état de santé s’améliore',
    // Trous trouvés par la contre-vérification (14/11) : données fictives.
    'Zorba a été payé 1 450 € le 3 mars pour son mois',
    'Il faut payer 820 € à Lila pour sa prime de fin d’année',
    'La fiche de paye de Zorba est fausse',
    'Le net à payer de Lila passe à 1 900',
    'Zorba touche le SMIC plus une prime',
    'Lila est malade depuis lundi, elle revient jeudi',
    'Zorba est à l’hôpital pour une opération du genou',
    'Lila est enceinte, congé maternité en mai',
    'Zorba est en arrêt de travail jusqu’au 12',
    'Le mot-de-passe du NAS fictif est rangé dans le tiroir',
    'motdepasse : tournesol42',
    'login zorba / pass tournesol42',
    'password=tournesol42',
    'La déclaration de revenus de Lila est à faire avant juin',
    'Lila touche les allocations de la CAF',
    'Zorba a une dette de 3 000 € envers Lila',
    'Le diagnostic du médecin : dépression',
    'Lila suit un traitement contre l’asthme',
    'Le crédit immobilier de Zorba coûte 900 € par mois',
    'acompte versé à Zorba : 300 €',
    'Le code secret de la carte bleue de Zorba',
    'Zorba a pris deux jours de récup la semaine dernière',
    'Lila a encore 12 jours de congés payés',
    'Zorba a fait 3 heures en plus samedi',
    'Sa date de naissance est dans le dossier',
  ])('« %s » est sensible', text => {
    expect(isSensitive(text)).toBe(true)
  })

  it.each([
    'Exporter les données en texte brut',
    'Le projet est écrit en ASP.NET',
    'Le bilan de santé du daemon est vert',
    'La santé du serveur est surveillée par une sonde',
    'Le site internet est en ligne',
    'Le logo doit rester net et lisible',
    'Le client règle ses factures à 60 jours',
    'Une app de suivi des colis pour les commerçants',
    // Mots de l'informatique et du studio qui ressemblent à des motifs sensibles.
    'Rembourser la dette technique du module d’import',
    'Le traitement des données se fait en local',
    'Les enceintes du studio sont branchées sur la console',
    'Voici ce qui se passe : le daemon redémarre',
    'Récupérer la liste des fichiers avant le tri',
    'Le login passe par Google',
    'L’acompte est versé à la commande',
  ])('« %s » n’est pas sensible', text => {
    expect(sensitiveMatch(text)).toBeNull()
  })
})

describe('un fait de paie n’est jamais envoyé', () => {
  let env: TriageEnv
  afterEach(() => env?.close())

  it('ni au LLM, ni aux vecteurs, même par le chemin des redites ; il reste visible, marqué sensible', async () => {
    env = setupTriage()
    const payroll = 'Le salaire net de Zorba est de 1 800 euros par mois'
    env.m.storeFact({ instance: env.instance, content: 'Le portail Lumen est hébergé chez Brumehost' })
    await env.m.indexEmbeddings()
    const id = seedPending(env, payroll, { path: '/fictif/session-paie.jsonl' })
    // Redite exacte d'un autre import : regroupée à l'identique, jamais par le sens.
    const twin = seedPending(env, `${payroll}.`, { path: '/fictif/session-paie-2.jsonl' })
    seedPending(env, 'On pourrait proposer une app de suivi des colis', { path: '/fictif/session-paie.jsonl' })

    const s = await env.m.triage.run()

    expect(s.state).toBe('done')
    const sent = [...env.llm.prompts, ...env.embedder.texts].join('\n')
    expect(sent).not.toContain('1 800')
    expect(sent).not.toMatch(/salaire/i)
    expect(sent).toContain('suivi des colis')
    expect(triageRow(env.db(), id)).toMatchObject({ sensible: 1, genre: null, raison: 'filtre sensible local' })
    expect(env.db().prepare('SELECT COUNT(*) AS n FROM fact_triage_vectors WHERE fact_id = ?').get(id)).toEqual({ n: 0 })
    void twin
  })
})
