/**
 * Navigation de la coquille : identifiants d'écran (= routes par hash
 * `#/<id>` et clés i18n `nav.<id>`), groupes et icônes.
 */
import {
  BookOpen,
  Bot,
  Brain,
  ClipboardCheck,
  Cpu,
  GitCompareArrows,
  LayoutDashboard,
  ListOrdered,
  Repeat,
  ScrollText,
  Settings,
  Share2,
  Tags,
  Users,
  Vault,
  Wrench,
  type LucideIcon,
} from 'lucide-react'

export type ScreenId =
  | 'dashboard' | 'agents' | 'memory' | 'themes' | 'patterns' | 'procedures'
  | 'review' | 'revisions' | 'maintenance' | 'sharing' | 'persons' | 'vault' | 'system' | 'audit' | 'settings' | 'docs'

export interface NavItemDef {
  id: ScreenId
  icon: LucideIcon
}

export interface NavGroupDef {
  /** clé i18n : nav.<id> (« Essentiel » / « Ce qu'elle a compris » / « Avancé »). */
  id: 'essential' | 'insights' | 'advanced'
  items: NavItemDef[]
}

/*
 * TROIS groupes, et pas deux.
 *
 * POURQUOI : « Avancé » comptait onze entrées d'affilée — un mur qu'on ne lit
 * plus, où « Personnes » (ce que Memoria a retenu de tes interlocuteurs) voisine
 * avec « Maintenance » (l'entretien de la base). Ce sont deux natures de choses.
 * Le groupe du milieu réunit ce que Memoria a DÉDUIT tout seul de tes souvenirs
 * — les personnes, les habitudes repérées, les savoir-faire, les contradictions
 * à arbitrer : quatre écrans qu'on ouvre par curiosité. « Avancé » ne garde que
 * le contrôle et le diagnostic, du plus courant (Partage) au plus rare
 * (Système), et se ferme sur l'aide puis les réglages.
 *
 * Aucune route ni aucune clé `nav.<écran>` ne change : seuls le regroupement et
 * l'ordre bougent.
 */
export const NAV_GROUPS: NavGroupDef[] = [
  {
    id: 'essential',
    items: [
      { id: 'dashboard', icon: LayoutDashboard },
      { id: 'agents', icon: Bot },
      { id: 'memory', icon: Brain },
      { id: 'review', icon: ClipboardCheck },
      { id: 'themes', icon: Tags },
    ],
  },
  {
    id: 'insights',
    items: [
      { id: 'persons', icon: Users },
      { id: 'patterns', icon: Repeat },
      { id: 'procedures', icon: ListOrdered },
      { id: 'revisions', icon: GitCompareArrows },
    ],
  },
  {
    id: 'advanced',
    items: [
      { id: 'sharing', icon: Share2 },
      { id: 'vault', icon: Vault },
      { id: 'audit', icon: ScrollText },
      { id: 'maintenance', icon: Wrench },
      { id: 'system', icon: Cpu },
      { id: 'docs', icon: BookOpen },
      { id: 'settings', icon: Settings },
    ],
  },
]

export const NAV_IDS: ScreenId[] = NAV_GROUPS.flatMap(g => g.items.map(i => i.id))

/** Écran courant depuis le hash d'URL (`#/memory`) — pur, testable. Inconnu → tableau de bord. */
export function screenFromHash(hash: string): ScreenId {
  const h = hash.replace(/^#\/?/, '')
  return (NAV_IDS as string[]).includes(h) ? (h as ScreenId) : 'dashboard'
}
