/**
 * Garde-fous i18n (règle produit : 5 langues dès la V1, jamais de repli
 * silencieux sur le français) :
 *  - parité stricte des clés entre fr/en/es/pt/de, valeurs non vides,
 *    mêmes {variables} d'interpolation ;
 *  - chaque clé littérale utilisée dans le code existe dans le catalogue ;
 *  - aucune locale figée ('fr-FR', toLocaleString…) hors des helpers i18n.
 * Test node pur : lit les sources avec fs, pas de rendu React.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fr } from '../src/messages/fr'
import { en } from '../src/messages/en'
import { es } from '../src/messages/es'
import { pt } from '../src/messages/pt'
import { de } from '../src/messages/de'

const CATALOGS = { fr, en, es, pt, de } as const
const SRC = join(__dirname, '..', 'src')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') || p.endsWith('.tsx') ? [p] : []
  })
}

const sourceFiles = walk(SRC).filter(p => !p.includes('/messages/'))
const sources = sourceFiles.map(p => ({ path: relative(SRC, p), text: readFileSync(p, 'utf8') }))

function placeholders(v: string): string {
  return [...v.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',')
}

describe('catalogues i18n', () => {
  it('les 5 langues ont exactement les mêmes clés', () => {
    const ref = Object.keys(fr).sort()
    for (const [lang, cat] of Object.entries(CATALOGS)) {
      expect(Object.keys(cat).sort(), `catalogue ${lang}`).toEqual(ref)
    }
  })

  it('aucune valeur vide, et les {variables} sont identiques dans les 5 langues', () => {
    for (const [key, frValue] of Object.entries(fr)) {
      for (const [lang, cat] of Object.entries(CATALOGS)) {
        const v = cat[key]
        expect(v?.trim().length ?? 0, `${lang}:${key} vide`).toBeGreaterThan(0)
        expect(placeholders(v ?? ''), `${lang}:${key} variables`).toBe(placeholders(frValue))
      }
    }
  })

  it('chaque clé littérale t(\'…\') / translate(\'…\') du code existe dans le catalogue', () => {
    const missing: string[] = []
    for (const { path, text } of sources) {
      for (const m of text.matchAll(/\b(?:t|translate)\(\s*'([^']+)'/g)) {
        const key = m[1] ?? ''
        if (!(key in fr)) missing.push(`${path} → ${key}`)
      }
      // t(`prefix.${x}`) : au moins une clé doit porter ce préfixe.
      for (const m of text.matchAll(/\b(?:t|translate)\(\s*`([^`$]+)\$\{/g)) {
        const prefix = m[1] ?? ''
        if (!Object.keys(fr).some(k => k.startsWith(prefix))) missing.push(`${path} → ${prefix}*`)
      }
    }
    expect(missing).toEqual([])
  })

  it("aucune locale figée ('fr-FR', toLocaleString…) hors i18n.tsx", () => {
    const offenders: string[] = []
    for (const { path, text } of sources) {
      if (path === 'i18n.tsx') continue
      if (/'fr-FR'|toLocaleString\(|toLocaleDateString\(|toLocaleTimeString\(/.test(text)) offenders.push(path)
    }
    expect(offenders).toEqual([])
  })
})
