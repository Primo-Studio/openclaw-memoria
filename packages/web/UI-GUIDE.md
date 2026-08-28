# UI-GUIDE — interface web Memoria sur shadcn/ui

Ce guide dit **comment écrire ou migrer un écran** de `packages/web` depuis la
refonte shadcn (branche `feat/ui-shadcn`). Lecteur : un agent (Claude Code,
Codex…) ou un humain qui touche à l'UI. Utilisateur final : Néto, non
technicien — chaque décision ci-dessous sert la lisibilité, pas la technique.

## 1. Pile et fichiers

| Quoi | Où |
|---|---|
| Tailwind v4 + jetons de thème | `src/index.css` (entrée), `src/styles/tokens.css` (couleurs, radius, polices) |
| Composants shadcn générés (radix-nova) | `src/components/ui/*.tsx` — Button, Card, Badge, Alert, AlertDialog, Dialog, Sheet, DropdownMenu, Select, Tabs, Table, Input, Textarea, Checkbox, Switch, Label, Popover, Tooltip, Progress, ScrollArea, Separator, Skeleton, Collapsible, Sonner (toasts) |
| **Primitives d'écran (point d'entrée unique)** | `src/components/ui.tsx` — `PageHeader`, `SectionCard`, `StatCard`, `DataTable`, `Spinner`, `ErrorBanner`, `EmptyState`, `ConfirmButton`, `CopyButton` + helpers (`useLoad`, `listPhase`, `humanError`, `formatDate/Number/Bytes…`, `agentTypeLabel`) |
| Coquille (sidebar, barre supérieure, capture, préférences) | `src/app/Shell.tsx`, `src/app/nav.ts` (routes, icônes, groupes, écrans migrés), `src/app/CaptureModeSwitch.tsx`, `src/app/shell-context.ts` |
| Thème | `src/lib/theme.ts` (résolution Système → light/dark, `?theme=`), script inline dans `index.html` (anti-flash) |
| Ancien CSS (écrans non migrés) | `src/styles.css`, scopé sous `.legacy-screen` — **ne rien y ajouter** |
| Aperçu + captures | `node scripts/ui-preview.mjs [--screenshot DIR]` (racine du dépôt, `npm run ui:preview`) |

Écran de référence : `src/screens/Dashboard.tsx`.

## 2. Migrer un écran, pas à pas

1. **Ajouter l'écran à `MIGRATED_SCREENS`** dans `src/app/nav.ts` : App.tsx cesse
   de l'envelopper dans `.legacy-screen` — l'ancien CSS n'existe plus pour lui.
2. **Remplacer `screen-head`** par `PageHeader` :
   ```tsx
   <PageHeader
     title={t('agents.title')}
     description={t('agents.lead')}          // facultatif, reste dans le flux
     actions={<Button variant="outline" size="sm" onClick={reload}><RefreshCw />{t('common.refresh')}</Button>}
   />
   ```
   Le titre et les actions sont **projetés dans la barre supérieure** (portail,
   `app/shell-context.ts`) : ne pas rendre de `<h1>` ailleurs.
3. **Structurer en `SectionCard`** (un bloc titré par sujet) :
   ```tsx
   <SectionCard title={t('agents.list.title')} description={…} actions={…}>
     …contenu…
   </SectionCard>
   ```
4. **Tableaux → `DataTable`** (jamais `<table className="table">`, jamais `<th onClick>`) :
   ```tsx
   const columns: DataColumn<AuditEntry>[] = [
     { id: 'ts', header: t('audit.col.date'), sortable: true, cell: e => formatDate(e.ts) },
     { id: 'action', header: t('audit.col.action'), cell: e => e.action },
     { id: 'size', header: t('…'), align: 'right', cell: e => formatBytes(e.size) },
   ]
   <DataTable columns={columns} rows={sorted} rowKey={e => e.id} sort={sort} onSort={setSort} />
   ```
   Le tri reste à l'appelant (`lib/sort.ts`) ; l'en-tête triable est un **bouton**
   avec `aria-sort`, le tableau défile horizontalement à l'intérieur de sa carte.
5. **Chiffres clés → `StatCard`** (`tone="warn"` quand il faut regarder, `ok`, `danger`).
6. **États** — toujours les trois, jamais un vide muet :
   ```tsx
   {state.status === 'loading' && <Spinner />}            // ou un <Skeleton> à la forme de l'écran
   {state.status === 'error' && <ErrorBanner message={state.message} onRetry={reload} />}
   {state.status === 'ready' && items.length === 0 && <EmptyState title={…} body={…} action={…} />}
   ```
   `useLoad` et `listPhase` sont inchangés.
7. **Formulaires** : `Label` + `Input`/`Textarea`/`Select`/`Checkbox`/`Switch`
   (`src/components/ui/*`), `Button` pour soumettre (`variant="default"` = action
   principale orange, une seule par écran ; `outline`/`ghost` pour le reste ;
   `destructive` pour ce qui supprime). Choix parmi une liste courte → `Select`
   shadcn ; deux ou trois modes → segmented control (voir `CaptureModeSwitch`).
8. **Confirmations** : `ConfirmButton` ouvre un `AlertDialog` (titre = libellé,
   `description` facultative, action en style destructif). Plus de double-clic armé.
9. **Retour d'action** : `toast.success(t('…'))` / `toast.error(…)` de `sonner`
   (le `Toaster` est monté dans App.tsx). `CopyButton` le fait déjà.
10. **i18n** : chaque chaîne visible passe par `t('…')` ; nouvelle clé = **dans
    les 5 catalogues** (`src/messages/{fr,en,es,pt,de}.ts`, parité stricte
    vérifiée par `test/i18n-parity.test.ts`). Les composants générés qui
    portaient du texte en dur (`Sheet` « Close ») prennent une prop `closeLabel`.
11. **Vérifier** : `npx tsc -p packages/web/tsconfig.json --noEmit`,
    `npm run build`, `npx vitest run packages/web/test`, puis
    `node scripts/ui-preview.mjs --screenshot /tmp/ui` et **regarder** les 4
    captures de l'écran (clair/sombre × bureau/mobile).
12. Supprimer du `styles.css` les règles que plus aucun écran n'utilise.

## 3. Interdits

- **Couleur codée en dur** (`#fff`, `rgb(…)`, `text-[#e85a1f]`) : uniquement les
  jetons (`bg-primary`, `text-muted-foreground`, `border-border`, `bg-success/10`…).
  Le thème clair/sombre est piloté par `data-theme` sur `<html>` ; la variante
  `dark:` de Tailwind suit cet attribut, jamais `prefers-color-scheme` directement.
- **`<select>` natif nu** dans un écran migré → `Select` shadcn (ou segmented control).
- **`<th onClick>`** / en-tête cliquable qui n'est pas un bouton → `DataTable`.
- **Texte hors `t()`** (y compris `aria-label`, `title`, `sr-only`, placeholders).
- **`<h1>` dans le corps d'un écran migré** : le titre vit dans `PageHeader`.
- **Classes de l'ancien CSS** (`btn`, `card`, `badge`, `table`, `muted`, `screen-head`…)
  dans un écran migré : elles n'existent plus hors `.legacy-screen`.
- **Largeur qui déborde** : un contenu large (tableau, chemin, JSON) défile dans
  son conteneur (`overflow-x-auto`), jamais la page.
- **Styles inline** pour la couleur ou l'espacement.

## 4. Jetons (`src/styles/tokens.css`)

| Jeton | Rôle | Classes Tailwind |
|---|---|---|
| `--background` / `--foreground` | fond et texte de page | `bg-background`, `text-foreground` |
| `--card` / `--card-foreground` | cartes | `bg-card` |
| `--popover` | menus, dialogues, tiroirs | `bg-popover` |
| `--primary` / `--primary-foreground` | **accent orange Primo** (`#e85a1f` sombre, `#d64f16` clair) : action principale, actif, marque | `bg-primary`, `text-primary`, `bg-primary/10` |
| `--secondary`, `--muted`, `--accent` | fonds neutres (boutons secondaires, zones atténuées, survol) | `bg-muted`, `hover:bg-accent` |
| `--muted-foreground` | texte secondaire | `text-muted-foreground` |
| `--destructive` | suppression, erreur | `text-destructive`, `bg-destructive/10` |
| `--success`, `--warning` (+ `-foreground`) | sain / à regarder | `text-success`, `text-warning`, `ring-warning/40` |
| `--border`, `--input`, `--ring` | bordures, champs, focus | `border-border`, `ring-ring/50` |
| `--sidebar*` | barre latérale | `bg-sidebar`, `border-sidebar-border`, `bg-sidebar-accent` |
| `--chart-1…5` | séries de graphiques (1 = orange) | `text-chart-2`… |
| `--radius` = 0.5rem | arrondis | `rounded-md` / `rounded-lg` / `rounded-xl` |
| `--font-sans` = system-ui ; `--font-mono` | polices | `font-sans`, `font-mono` |

Les deux palettes sont complètes ; en ajouter un jeton = l'ajouter dans `:root`,
`:root[data-theme='dark']` **et** `@theme inline`.

## 5. Coquille

- Groupes de navigation et icônes : `NAV_GROUPS` dans `src/app/nav.ts`. Une
  nouvelle route = un `ScreenId`, une entrée dans un groupe, la clé `nav.<id>`
  dans les 5 catalogues, le rendu dans `App.tsx`.
- Badge de la Revue : `reviewCount` passé par App.tsx (rafraîchi toutes les 20 s).
- Barre latérale repliable (préférence `memoria.sidebar`), tiroir `Sheet` sous 768 px.
- Mode de capture : `CaptureModeSwitch` — toujours visible (spec §13), gère
  l'échec de lecture et de changement sans disparaître.
- Préférences (langue, thème) : `DropdownMenu` à droite de la barre supérieure.

## 6. Transition (état au 27/08/2026)

- Migré : **Tableau de bord**.
- Legacy (sous `.legacy-screen`) : Agents, Mémoire, Revue, Thèmes, Personnes,
  Récurrences, Procédures, Révisions, Partage, Coffre, Journal, Maintenance,
  Système, Docs, Réglages, Onboarding, composants `Wizard` et `EmbeddingsChooser`.
- Mécanisme : `index.css` ordonne les couches `theme < base < legacy < components
  < utilities`. `styles.css` est importé dans `legacy` (il bat le preflight
  Tailwind, perd contre toute classe utilitaire) et intégralement imbriqué sous
  `.legacy-screen`. Ses variables (`--bg`, `--text`, `--brand` ex-`--accent`…)
  sont des alias des jetons : les écrans legacy suivent déjà le bon thème.
  Dans un écran legacy, le `<h1>` de `.screen-head` est masqué (le titre est
  affiché par la coquille) et les primitives de `ui.tsx` (déjà shadcn)
  fonctionnent telles quelles.
- Pièges connus des écrans legacy : lignes de recherche/filtres qui débordent
  sous 400 px (`Mémoire`, `Maintenance`) — se règlent en migrant l'écran (flex-wrap
  ou `grid`), pas en retouchant `styles.css`.

## 7. Captures de référence — Tableau de bord

Générées par `node scripts/ui-preview.mjs --screenshot <dossier>` (données de
démo, faux moteur d'extraction, aucun réseau) ; fichiers
`dashboard-{light,dark}-{desktop,mobile}.png`. Copies de référence dans
`packages/web/docs/ui-reference/`.

| | Bureau 1280×900 | Mobile 390×844 |
|---|---|---|
| Clair | ![Tableau de bord clair bureau](docs/ui-reference/dashboard-light-desktop.png) | ![Tableau de bord clair mobile](docs/ui-reference/dashboard-light-mobile.png) |
| Sombre | ![Tableau de bord sombre bureau](docs/ui-reference/dashboard-dark-desktop.png) | ![Tableau de bord sombre mobile](docs/ui-reference/dashboard-dark-mobile.png) |
