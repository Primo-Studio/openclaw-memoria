/**
 * Partage (spec §11) : deux outils.
 *  1. Matrice « qui peut lire quoi » : pour chaque mémoire partagée, un
 *     interrupteur par agent (lecture). Accorder ET retirer passent par une
 *     boîte de confirmation : accorder expose des souvenirs à un agent,
 *     retirer le coupe d'une mémoire qu'il utilisait peut-être — les deux
 *     méritent d'être nommés avant d'agir.
 *  2. Faits sur toi à partager : pour chaque agent, Memoria propose les faits
 *     qui parlent de l'utilisateur (identité/préférences) ; tu choisis ceux à
 *     remonter vers la mémoire partagée « user » (tous les agents y accèdent).
 * Rien n'est partagé sans ton clic — Memoria propose, tu décides.
 *
 * Écriture (can_write) : l'API POST /v1/admin/policy l'accepte, mais
 * GET /v1/admin/scopes ne renvoie que `readers` — sans l'état courant, une
 * colonne « écriture » mentirait. Elle attend une évolution du daemon.
 */
import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, RefreshCw, Share2, Users, X } from 'lucide-react'
import { toast } from 'sonner'
import {
  ApiError,
  getAgents,
  getIdentityCandidates,
  getScopeFacts,
  getScopes,
  setPolicy,
  shareFacts,
  type AdminFact,
  type AgentEntry,
  type AssistantInfo,
  type IdentityCandidate,
  type ScopeAccess,
} from '../api'
import {
  DataTable,
  EmptyState,
  ErrorBanner,
  PageHeader,
  SectionCard,
  Spinner,
  agentTypeLabel,
  formatNumber,
  humanError,
  listPhase,
  type DataColumn,
} from '../components/ui'
import { scopeLabel } from '../components/memory-names'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Checkbox } from '../components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible'
import { Label } from '../components/ui/label'
import { Skeleton } from '../components/ui/skeleton'
import { Switch } from '../components/ui/switch'
import { useT } from '../i18n'
import { cn } from '../lib/utils'

/** Bascule en attente de confirmation (accorder ou retirer la lecture). */
interface PendingToggle {
  assistant: AssistantInfo
  scope: ScopeAccess
  next: boolean
}

export function Sharing() {
  const { t } = useT()
  const [scopes, setScopes] = useState<ScopeAccess[] | null>(null)
  const [assistants, setAssistants] = useState<AssistantInfo[]>([])
  const [agents, setAgents] = useState<AgentEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [exploring, setExploring] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingToggle | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [s, a] = await Promise.all([getScopes(), getAgents()])
      setScopes(s.scopes.filter(sc => sc.type !== 'private' && sc.type !== 'legacy_to_review'))
      setAssistants(s.assistants)
      setAgents(a)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : humanError(err))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const phase = listPhase(scopes, error)

  // Appliqué seulement après confirmation dans la boîte de dialogue.
  const applyToggle = useCallback(async () => {
    if (!pending) return
    const { assistant, scope, next } = pending
    setPending(null)
    setBusy(true)
    const vars = { agent: assistant.display_name, scope: scopeLabel(t, scope) }
    try {
      await setPolicy(assistant.id, scope.id, { can_read: next })
      await refresh()
      toast.success(t(next ? 'sharing.toast_granted' : 'sharing.toast_revoked', vars))
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('sharing.error_toggle'))
    } finally {
      setBusy(false)
    }
  }, [pending, refresh, t])

  const columns: DataColumn<ScopeAccess>[] = [
    {
      id: 'scope',
      header: t('sharing.col_scope'),
      cell: scope => {
        const open = exploring === scope.id
        return (
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-sm font-medium outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/60"
            aria-expanded={open}
            onClick={() => setExploring(open ? null : scope.id)}
          >
            {open ? <ChevronDown className="size-4 text-muted-foreground" aria-hidden="true" /> : <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />}
            {scopeLabel(t, scope)}
          </button>
        )
      },
    },
    { id: 'facts', header: t('sharing.col_facts'), align: 'right', cell: scope => formatNumber(scope.facts) },
    ...assistants.map<DataColumn<ScopeAccess>>(a => ({
      id: `assistant:${a.id}`,
      align: 'center',
      // Le type sous le nom seulement s'il apporte quelque chose (« Koda » → OpenClaw),
      // pas « Claude Code » sous « Claude Code ».
      header: (
        <span className="inline-flex flex-col items-center leading-tight">
          <span>{a.display_name}</span>
          {agentTypeLabel(a.type) !== a.display_name && <span className="text-xs font-normal text-muted-foreground">{agentTypeLabel(a.type)}</span>}
        </span>
      ),
      cell: scope => (
        <Switch
          checked={scope.readers.includes(a.id)}
          disabled={busy}
          aria-label={t('sharing.reader_aria', { agent: a.display_name, scope: scopeLabel(t, scope) })}
          onCheckedChange={next => setPending({ assistant: a, scope, next })}
        />
      ),
    })),
  ]

  const exploringScope = exploring ? (scopes?.find(s => s.id === exploring) ?? null) : null
  const identityAgents = agents.filter(a => a.assistant_type !== 'generic')

  return (
    <>
      <PageHeader
        title={t('sharing.title')}
        description={t('sharing.lead')}
        actions={
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={busy}>
            <RefreshCw aria-hidden="true" />
            {t('common.refresh')}
          </Button>
        }
      />

      {error && <ErrorBanner message={error} onRetry={() => void refresh()} />}

      <SectionCard title={t('sharing.matrix_title')} description={t('sharing.matrix_lead')}>
        {phase === 'loading' && <Skeleton className="h-28 w-full rounded-lg" />}
        {phase === 'empty' && <EmptyState icon={<Share2 className="size-5" />} title={t('sharing.matrix_empty')} body={t('sharing.matrix_empty_body')} />}
        {phase === 'ready' && scopes && (
          <>
            {/* Sous 640 px, le tableau serait rogné au bord de la carte et les
                derniers agents deviendraient invisibles : une fiche par mémoire
                partagée, un interrupteur par ligne, tout en pleine largeur. */}
            <ul className="flex flex-col gap-3 sm:hidden">
              {scopes.map(scope => (
                <li key={scope.id} className="overflow-hidden rounded-lg border">
                  <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2">
                    <button
                      type="button"
                      className="inline-flex min-w-0 items-center gap-1 rounded-sm text-sm font-medium outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/60"
                      aria-expanded={exploring === scope.id}
                      onClick={() => setExploring(exploring === scope.id ? null : scope.id)}
                    >
                      {exploring === scope.id ? (
                        <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      ) : (
                        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      )}
                      <span className="truncate">{scopeLabel(t, scope)}</span>
                    </button>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {t('sharing.facts_short', { count: formatNumber(scope.facts) })}
                    </span>
                  </div>
                  <ul className="divide-y">
                    {assistants.map(a => (
                      <li key={a.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">{a.display_name}</span>
                          {agentTypeLabel(a.type) !== a.display_name && <span className="block truncate text-xs text-muted-foreground">{agentTypeLabel(a.type)}</span>}
                        </span>
                        <Switch
                          checked={scope.readers.includes(a.id)}
                          disabled={busy}
                          aria-label={t('sharing.reader_aria', { agent: a.display_name, scope: scopeLabel(t, scope) })}
                          onCheckedChange={next => setPending({ assistant: a, scope, next })}
                        />
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            <div className="hidden sm:block">
              <DataTable columns={columns} rows={scopes} rowKey={s => s.id} />
            </div>
            {/* Rendu UNE fois, hors des deux arbres : sinon deux chargements du contenu. */}
            {exploringScope && <ScopeContent scope={exploringScope} onClose={() => setExploring(null)} />}
          </>
        )}
      </SectionCard>

      <SectionCard title={t('sharing.identity_title')} description={t('sharing.identity_lead')}>
        {phase === 'loading' && <Skeleton className="h-16 w-full rounded-lg" />}
        {phase !== 'loading' && phase !== 'failed' && identityAgents.length === 0 && (
          <EmptyState icon={<Users className="size-5" />} title={t('sharing.identity_no_agents')} />
        )}
        {phase !== 'loading' && identityAgents.length > 0 && (
          <div className="flex flex-col gap-2">
            {identityAgents.map(a => (
              <IdentityPanel key={a.instance.id} agent={a} onShared={() => void refresh()} />
            ))}
          </div>
        )}
      </SectionCard>

      {/* Boîte de confirmation : accorder (action principale) ou retirer (destructif). */}
      <AlertDialog
        open={pending !== null}
        onOpenChange={open => {
          if (!open) setPending(null)
        }}
      >
        {pending && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t(pending.next ? 'sharing.grant_confirm' : 'sharing.revoke_confirm', {
                  agent: pending.assistant.display_name,
                  scope: scopeLabel(t, pending.scope),
                })}
              </AlertDialogTitle>
              <AlertDialogDescription>{t(pending.next ? 'sharing.grant_body' : 'sharing.revoke_body')}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
              <AlertDialogAction variant={pending.next ? 'default' : 'destructive'} onClick={() => void applyToggle()}>
                {t(pending.next ? 'sharing.grant_action' : 'sharing.revoke_action')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </>
  )
}

/** Contenu d'une mémoire partagée (les souvenirs dans « Sur l'utilisateur », « Entreprise »…). */
function ScopeContent({ scope, onClose }: { scope: ScopeAccess; onClose: () => void }) {
  const { t } = useT()
  const [facts, setFacts] = useState<AdminFact[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    setFacts(null)
    setError(null)
    getScopeFacts(scope.id).then(
      f => {
        if (!cancelled) setFacts(f)
      },
      (err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : t('sharing.error_load'))
      },
    )
    return () => {
      cancelled = true
    }
  }, [scope.id, tick, t])

  const phase = listPhase(facts, error)
  return (
    <div className="mt-3 rounded-lg border bg-muted/30 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-sm font-medium">{t('sharing.scope_content_title', { scope: scopeLabel(t, scope) })}</div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t('common.close')}>
          <X />
        </Button>
      </div>
      {phase === 'loading' && <Spinner />}
      {phase === 'failed' && error && <ErrorBanner message={error} onRetry={() => setTick(n => n + 1)} className="my-0" />}
      {phase === 'empty' && <p className="text-sm text-muted-foreground">{t('sharing.scope_empty')}</p>}
      {phase === 'ready' && facts && (
        <ul className="flex flex-col gap-2">
          {facts.map(f => (
            <li key={f.id} className="rounded-md border bg-background px-3 py-2 text-sm">
              {f.fact}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * Faits d'identité proposés pour UN agent.
 * Le compteur est chargé DÈS L'AFFICHAGE : trois lignes rigoureusement
 * identiques n'annonçaient rien, il fallait les ouvrir une par une pour
 * découvrir que la plupart n'avaient rien à proposer. Le coût est nul côté
 * daemon (suggestIdentityFacts = lecture SQLite + score de mots-clés, aucun
 * appel au moteur d'IA) ; une ligne sans candidat ne s'ouvre plus.
 */
function IdentityPanel({ agent, onShared }: { agent: AgentEntry; onShared: () => void }) {
  const { t } = useT()
  const [candidates, setCandidates] = useState<IdentityCandidate[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    try {
      setCandidates(await getIdentityCandidates(agent.instance.id))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('sharing.error_load'))
    }
  }, [agent.instance.id, t])

  const share = useCallback(async () => {
    if (selected.size === 0) return
    setBusy(true)
    const count = selected.size
    try {
      await shareFacts([...selected], 'user')
      setSelected(new Set())
      await load()
      onShared()
      toast.success(t(count > 1 ? 'sharing.toast_shared_plural' : 'sharing.toast_shared', { count }))
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('sharing.error_share'))
    } finally {
      setBusy(false)
    }
  }, [selected, load, onShared, t])

  // Compteur connu d'emblée : l'œil va droit à l'agent qui a quelque chose.
  useEffect(() => {
    void load()
  }, [load])

  const phase = listPhase(candidates, error)
  const label = t('sharing.identity_panel_label', { agent: agentTypeLabel(agent.assistant_type) })
  const count = candidates?.length ?? null
  const counter =
    error !== null ? null : count === null ? (
      <Skeleton className="h-5 w-10 rounded-full" />
    ) : count === 0 ? (
      <span className="text-xs text-muted-foreground">{t('sharing.identity_nothing')}</span>
    ) : (
      <Badge variant="secondary" className="tabular-nums" title={t('sharing.identity_count', { count })}>
        {formatNumber(count)}
      </Badge>
    )

  // Rien à proposer : la ligne reste lisible mais n'invite plus au clic.
  if (count === 0) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2.5 text-sm">
        <span className="min-w-0 truncate text-muted-foreground">{label}</span>
        {counter}
      </div>
    )
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={next => {
        setOpen(next)
        if (next && candidates === null && !error) void load()
      }}
      className="rounded-lg border"
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60"
          aria-expanded={open}
        >
          <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform', !open && '-rotate-90')} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {counter}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t px-3 py-3">
          {phase === 'loading' && <Spinner label={t('sharing.analyzing')} />}
          {phase === 'failed' && error && <ErrorBanner message={error} onRetry={() => void load()} className="my-0" />}
          {phase === 'empty' && <p className="text-sm text-muted-foreground">{t('sharing.identity_empty')}</p>}
          {phase === 'ready' && candidates && (
            <div className="flex flex-col gap-3">
              <ul className="flex flex-col gap-2">
                {candidates.map(c => {
                  const id = `identity-${agent.instance.id}-${c.id}`
                  return (
                    <li key={c.id}>
                      <Label htmlFor={id} className="items-start gap-3 rounded-md border bg-background px-3 py-2 font-normal leading-snug">
                        <Checkbox
                          id={id}
                          className="mt-0.5"
                          checked={selected.has(c.id)}
                          onCheckedChange={checked => {
                            const next = new Set(selected)
                            if (checked === true) next.add(c.id)
                            else next.delete(c.id)
                            setSelected(next)
                          }}
                        />
                        <span>{c.content}</span>
                      </Label>
                    </li>
                  )
                })}
              </ul>
              <div>
                <Button size="sm" disabled={busy || selected.size === 0} onClick={() => void share()}>
                  <Share2 aria-hidden="true" />
                  {selected.size > 0 ? t('sharing.share_button_count', { count: selected.size }) : t('sharing.share_button')}
                </Button>
              </div>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

