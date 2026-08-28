/**
 * Coquille d'application : barre latérale (groupes Essentiel / Avancé, icônes,
 * repliable en rail sur bureau, tiroir sur mobile), barre supérieure (titre
 * de l'écran + actions projetées par PageHeader, préférences langue/thème),
 * mode de capture toujours visible, version.
 *
 * Aucune couleur en dur : tout passe par les jetons (bg-sidebar, text-primary…).
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Menu, Monitor, Moon, PanelLeftClose, PanelLeftOpen, SlidersHorizontal, Sun } from 'lucide-react'
import { getVersion } from '../api'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu'
import { Separator } from '../components/ui/separator'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '../components/ui/sheet'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../components/ui/tooltip'
import { LANGS, useT, type Lang } from '../i18n'
import { parseThemePref, useThemePref, type ThemePref } from '../lib/theme'
import { cn } from '../lib/utils'
import { BrandMark } from './BrandMark'
import { CaptureModeSwitch } from './CaptureModeSwitch'
import { NAV_GROUPS, type ScreenId } from './nav'
import { ShellSlotsContext } from './shell-context'

const SIDEBAR_KEY = 'memoria.sidebar'

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === 'rail'
  } catch {
    return false
  }
}

export function Shell({
  screen,
  onNavigate,
  reviewCount,
  /** Titre de repli pour les écrans qui n'ont pas encore de PageHeader (legacy). */
  title,
  children,
}: {
  screen: ScreenId
  onNavigate: (id: ScreenId) => void
  reviewCount: number
  title?: string
  children: ReactNode
}) {
  const { t } = useT()
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [mobileOpen, setMobileOpen] = useState(false)
  // Slots de la barre supérieure (cf. shell-context.ts) : refs de rappel → état,
  // pour que PageHeader se re-rende quand l'élément existe.
  const [titleEl, setTitleEl] = useState<HTMLElement | null>(null)
  const [actionsEl, setActionsEl] = useState<HTMLElement | null>(null)

  const toggleCollapsed = useCallback(() => {
    setCollapsed(c => {
      const next = !c
      try {
        localStorage.setItem(SIDEBAR_KEY, next ? 'rail' : 'open')
      } catch {
        /* préférence non persistée */
      }
      return next
    })
  }, [])

  const navigate = useCallback(
    (id: ScreenId) => {
      setMobileOpen(false)
      onNavigate(id)
    },
    [onNavigate],
  )

  return (
    <TooltipProvider delayDuration={300}>
      <ShellSlotsContext.Provider value={{ titleEl, actionsEl }}>
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:text-primary-foreground"
        >
          {t('a11y.skip')}
        </a>
        <div className="flex min-h-screen">
          {/* Barre latérale bureau (≥ 768 px) — rail d'icônes quand repliée. */}
          <aside
            className={cn(
              'sticky top-0 hidden h-screen shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 md:flex',
              collapsed ? 'w-[60px]' : 'w-60',
            )}
          >
            <SidebarInner
              screen={screen}
              onNavigate={navigate}
              reviewCount={reviewCount}
              collapsed={collapsed}
              onToggleCollapsed={toggleCollapsed}
            />
          </aside>

          <div className="flex min-w-0 flex-1 flex-col">
            <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/90 px-3 backdrop-blur supports-backdrop-filter:bg-background/75 md:px-6">
              {/* Mobile : tiroir de navigation (Sheet) + marque compacte. */}
              <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
                <SheetTrigger asChild>
                  <Button variant="ghost" size="icon" className="md:hidden" aria-label={t('a11y.menu')}>
                    <Menu />
                  </Button>
                </SheetTrigger>
                <SheetContent side="left" className="w-72 gap-0 p-0" closeLabel={t('common.close')}>
                  <SheetTitle className="sr-only">{t('a11y.nav')}</SheetTitle>
                  <SidebarInner screen={screen} onNavigate={navigate} reviewCount={reviewCount} collapsed={false} />
                </SheetContent>
              </Sheet>
              <BrandMark className="size-7 text-primary md:hidden" />
              <div ref={setTitleEl} className="min-w-0 flex-1">
                {title && <h1 className="truncate text-lg font-semibold tracking-tight">{title}</h1>}
              </div>
              <div ref={setActionsEl} className="flex shrink-0 items-center gap-2" />
              <PrefsMenu />
            </header>
            <main id="main-content" tabIndex={-1} className="w-full max-w-6xl flex-1 px-4 py-5 outline-none md:px-6 md:py-6">
              {children}
            </main>
          </div>
        </div>
      </ShellSlotsContext.Provider>
    </TooltipProvider>
  )
}

/** Contenu de la barre latérale — partagé entre le panneau bureau et le tiroir mobile. */
function SidebarInner({
  screen,
  onNavigate,
  reviewCount,
  collapsed,
  onToggleCollapsed,
}: {
  screen: ScreenId
  onNavigate: (id: ScreenId) => void
  reviewCount: number
  collapsed: boolean
  onToggleCollapsed?: () => void
}) {
  const { t } = useT()
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={cn('flex h-14 shrink-0 items-center gap-2 border-b border-sidebar-border px-3', collapsed && 'justify-center px-0')}>
        <BrandMark className="size-7 text-primary" />
        {!collapsed && (
          <div className="min-w-0 leading-tight">
            <div className="text-sm font-semibold">Memoria</div>
            <div className="truncate text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{t('brand.sub')}</div>
          </div>
        )}
        {onToggleCollapsed && !collapsed && (
          <Button variant="ghost" size="icon-sm" className="ml-auto text-muted-foreground" onClick={onToggleCollapsed} aria-label={t('nav.collapse')}>
            <PanelLeftClose />
          </Button>
        )}
      </div>
      {onToggleCollapsed && collapsed && (
        <div className="flex justify-center py-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="text-muted-foreground" onClick={onToggleCollapsed} aria-label={t('nav.expand')}>
                <PanelLeftOpen />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">{t('nav.expand')}</TooltipContent>
          </Tooltip>
        </div>
      )}

      <nav aria-label={t('a11y.nav')} className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {NAV_GROUPS.map((group, gi) => (
          <div key={group.id} className={cn(gi > 0 && 'mt-3')}>
            {collapsed ? (
              gi > 0 && <Separator className="mx-auto mb-2 w-6 bg-sidebar-border" />
            ) : (
              <div className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t(`nav.${group.id}`)}</div>
            )}
            <ul className="flex flex-col gap-0.5">
              {group.items.map(item => (
                <li key={item.id}>
                  <NavItem
                    id={item.id}
                    icon={<item.icon className="size-4 shrink-0" aria-hidden="true" />}
                    label={t(`nav.${item.id}`)}
                    active={screen === item.id}
                    badge={item.id === 'review' ? reviewCount : 0}
                    collapsed={collapsed}
                    onClick={() => onNavigate(item.id)}
                  />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className={cn('shrink-0 border-t border-sidebar-border p-2', collapsed && 'px-1.5')}>
        <CaptureModeSwitch collapsed={collapsed} />
        <VersionFoot collapsed={collapsed} />
      </div>
    </div>
  )
}

function NavItem({
  icon,
  label,
  active,
  badge,
  collapsed,
  onClick,
}: {
  id: ScreenId
  icon: ReactNode
  label: string
  active: boolean
  badge: number
  collapsed: boolean
  onClick: () => void
}) {
  const badgeText = badge > 500 ? '500+' : String(badge)
  const button = (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      className={cn(
        'relative flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
        active
          ? 'bg-primary/10 font-medium text-primary'
          : 'text-sidebar-foreground/85 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        collapsed && 'justify-center px-0',
      )}
    >
      {active && <span className="absolute top-1/2 left-0 h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-primary" aria-hidden="true" />}
      {icon}
      {!collapsed && <span className="truncate">{label}</span>}
      {badge > 0 &&
        (collapsed ? (
          <span className="absolute top-1 right-1.5 size-2 rounded-full bg-primary" aria-hidden="true" />
        ) : (
          <Badge className="ml-auto h-5 min-w-5 px-1.5 tabular-nums">{badgeText}</Badge>
        ))}
      {collapsed && badge > 0 && <span className="sr-only">{badgeText}</span>}
    </button>
  )
  if (!collapsed) return button
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right">
        {label}
        {badge > 0 && ` · ${badgeText}`}
      </TooltipContent>
    </Tooltip>
  )
}

/** Langue + thème regroupés dans un menu (plus de <select> nus dans la barre latérale). */
function PrefsMenu() {
  const { t, lang, setLang } = useT()
  const [theme, setTheme] = useThemePref()
  const THEMES: Array<{ id: ThemePref; icon: ReactNode; key: 'system' | 'light' | 'dark' }> = [
    { id: 'system', icon: <Monitor aria-hidden="true" />, key: 'system' },
    { id: 'light', icon: <Sun aria-hidden="true" />, key: 'light' },
    { id: 'dark', icon: <Moon aria-hidden="true" />, key: 'dark' },
  ]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('prefs.title')}>
          <SlidersHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel>{t('lang.title')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={lang} onValueChange={v => setLang(v as Lang)}>
          {LANGS.map(l => (
            <DropdownMenuRadioItem key={l.code} value={l.code}>
              <span aria-hidden="true">{l.flag}</span> {l.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t('theme.title')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme} onValueChange={v => setTheme(parseThemePref(v))}>
          {THEMES.map(th => (
            <DropdownMenuRadioItem key={th.id} value={th.id}>
              {th.icon} {t(`theme.${th.key}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Version installée, discrète en pied de barre latérale. */
function VersionFoot({ collapsed }: { collapsed: boolean }) {
  const [label, setLabel] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    getVersion()
      .then(v => {
        if (!cancelled) setLabel(v.sha ? `v${v.version} · ${v.sha}` : `v${v.version}`)
      })
      .catch(() => {
        if (!cancelled) setLabel(null)
      })
    return () => {
      cancelled = true
    }
  }, [])
  if (!label) return null
  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="mt-2 text-center text-[10px] text-muted-foreground tabular-nums" aria-label={label}>
            v
          </div>
        </TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    )
  }
  return <div className="mt-2 px-1 text-[11px] text-muted-foreground tabular-nums">{label}</div>
}
