/**
 * Tarifs INDICATIFS des modèles (USD par million de tokens) — pour estimer ce
 * que coûte la mémoire, modèle par modèle. Ce n'est PAS une facture : les
 * fournisseurs changent leurs prix, et un tarif inconnu vaut mieux qu'un
 * tarif inventé → `null` quand on ne sait pas, jamais un zéro trompeur.
 *
 * Les modèles LOCAUX (ollama, lmstudio) coûtent 0 : c'est l'information la
 * plus utile pour qui a choisi le local.
 *
 * Mise à jour : changer `PRICING_AS_OF` en même temps que la table, l'UI
 * affiche cette date à côté de l'estimation.
 */

/** Date de référence des tarifs ci-dessous (affichée à l'utilisateur). */
export const PRICING_AS_OF = '2026-08'

export interface ModelPrice {
  /** USD par 1M tokens en entrée. */
  input: number
  /** USD par 1M tokens en sortie (0 pour les embeddings). */
  output: number
}

/** Fournisseurs dont les modèles tournent sur la machine : coût nul. */
const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio', 'null'])

/**
 * Clé = nom de modèle NORMALISÉ (minuscules, sans préfixe fournisseur, sans
 * suffixe de date). Le `resolve` ci-dessous tente l'exact, puis le plus long
 * préfixe (« gpt-4o-mini-2024-07-18 » → « gpt-4o-mini »).
 */
const PRICES: Record<string, ModelPrice> = {
  // — OpenAI, chat —
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-5-nano': { input: 0.05, output: 0.4 },
  'gpt-5-mini': { input: 0.25, output: 2 },
  'gpt-5': { input: 1.25, output: 10 },
  'o4-mini': { input: 1.1, output: 4.4 },
  'o3-mini': { input: 1.1, output: 4.4 },
  o3: { input: 2, output: 8 },
  // — OpenAI, embeddings —
  'text-embedding-3-small': { input: 0.02, output: 0 },
  'text-embedding-3-large': { input: 0.13, output: 0 },
  'text-embedding-ada-002': { input: 0.1, output: 0 },
  // — Anthropic —
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-3-5-haiku': { input: 0.8, output: 4 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-opus-4-1': { input: 15, output: 75 },
  'claude-opus-4': { input: 15, output: 75 },
  // — Google (via OpenRouter) —
  'gemini-flash-1.5': { input: 0.075, output: 0.3 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
}

/** Nom de modèle → clé de table : minuscules, sans `openai/`, sans date finale. */
export function normalizeModelName(model: string): string {
  let m = model.trim().toLowerCase()
  // Préfixe fournisseur (OpenRouter) : « openai/gpt-4o-mini », « anthropic/claude-3.5-haiku »
  const slash = m.lastIndexOf('/')
  if (slash >= 0) m = m.slice(slash + 1)
  // Tag Ollama « :latest » ou « :3b » — sans effet sur le prix (local), mais
  // on normalise pour que la clé reste lisible.
  // Suffixes de date : « -20251001 » (Anthropic), « -2024-07-18 » (OpenAI).
  m = m.replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '')
  // « claude-3.5-haiku » (OpenRouter) ≡ « claude-3-5-haiku » (Anthropic)
  m = m.replace(/(\d)\.(\d)/g, '$1-$2')
  return m
}

/** Tarif d'un modèle, ou `null` si inconnu. Local → 0/0. */
export function priceFor(provider: string, model: string): ModelPrice | null {
  if (LOCAL_PROVIDERS.has(provider)) return { input: 0, output: 0 }
  const key = normalizeModelName(model)
  const exact = PRICES[key]
  if (exact) return exact
  // Plus long préfixe connu : « gpt-4o-mini-2024-07-18 » → « gpt-4o-mini » ;
  // mais « gpt-4o-mini » ne doit PAS matcher « gpt-4o » avant « gpt-4o-mini »
  // → on trie par longueur décroissante et on exige une frontière (« - » ou « : »).
  const candidates = Object.keys(PRICES)
    .filter(k => key.startsWith(k) && /^[-:]/.test(key.slice(k.length)))
    .sort((a, b) => b.length - a.length)
  const best = candidates[0]
  return best ? PRICES[best]! : null
}

/**
 * Coût estimé en USD, ou `null` si le tarif est inconnu OU si aucun token n'a
 * été mesuré (un appel non mesuré n'est pas gratuit : on ne sait pas).
 */
export function estimateCostUsd(
  provider: string,
  model: string,
  inputTokens: number | null,
  outputTokens: number | null,
): number | null {
  const price = priceFor(provider, model)
  if (!price) return null
  if (inputTokens === null && outputTokens === null) {
    // Local : coût nul même sans mesure — l'info « ça ne coûte rien » est vraie.
    return LOCAL_PROVIDERS.has(provider) ? 0 : null
  }
  const cost = ((inputTokens ?? 0) * price.input + (outputTokens ?? 0) * price.output) / 1_000_000
  return Math.round(cost * 1_000_000) / 1_000_000
}
