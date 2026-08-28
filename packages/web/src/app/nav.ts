/**
 * Navigation de la coquille : identifiants d'écran (= routes par hash
 * `#/<id>` et clés i18n `nav.<id>`), groupes, icônes, et la liste des
 * écrans MIGRÉS sur shadcn (les autres sont enveloppés dans `.legacy-screen`
 * par App.tsx — voir UI-GUIDE.md, « Transition »).
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
  /** clé i18n : nav.<id> (« Essentiel » / « Avancé »). */
  id: 'essential' | 'advanced'
  items: NavItemDef[]
}

// « Essentiel » = ce qu'un non-technicien ouvre chaque jour ; « Avancé » =
// outils d'analyse et d'administration. Réglages ferme le second groupe
// (c'est là que se choisit le moteur d'extraction — il doit rester à un clic).
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
    id: 'advanced',
    items: [
      { id: 'persons', icon: Users },
      { id: 'patterns', icon: Repeat },
      { id: 'procedures', icon: ListOrdered },
      { id: 'revisions', icon: GitCompareArrows },
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

/** Écrans déjà réécrits sur la coquille + composants shadcn (sans wrapper legacy). */
export const MIGRATED_SCREENS: ReadonlySet<ScreenId> = new Set<ScreenId>(['dashboard', 'sharing'])
