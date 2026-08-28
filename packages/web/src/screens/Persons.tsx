/**
 * Personnes — qui peut parler aux agents ? Néto le plus souvent, mais aussi
 * Claire, des stagiaires, un client… Chaque personne a des identifiants
 * (numéro Telegram/WhatsApp, e-mail, handle) qui permettent à l'agent de
 * RECONNAÎTRE son interlocuteur, et des notes (rôle, ce qu'on peut partager).
 *
 * Migré sur shadcn : PageHeader avec « Ajouter une personne » (Dialog),
 * SectionCard « Tester l'identification » (Select + Input), SectionCard
 * « Personnes connues » avec une carte par personne (Label + Input/Textarea,
 * puces d'identifiants, suppressions derrière un AlertDialog), toasts,
 * squelette, états vide / erreur — voir UI-GUIDE.md. Après une action, la
 * liste est rafraîchie SANS repasser par le squelette (les cartes restent
 * montées, les saisies en cours ailleurs ne sont pas perdues).
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Loader2, Plus, Save, Search, Trash2, TriangleAlert, UserCheck, UserPlus, Users, UserX, X } from 'lucide-react'
import { toast } from 'sonner'
import {
  addPersonIdentifier,
  createPerson,
  deletePerson,
  getPersons,
  identifyInterlocutor,
  removePersonIdentifier,
  updatePerson,
  type InterlocutorMatch,
  type PersonIdentifier,
  type PersonProfile,
} from '../api'
import { CogConfirmButton } from '../components/CogConfirm'
import { EmptyState, ErrorBanner, PageHeader, SectionCard, formatNumber, humanError, listPhase } from '../components/ui'
import { Alert, AlertTitle } from '../components/ui/alert'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Card, CardContent } from '../components/ui/card'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '../components/ui/dialog'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { Skeleton } from '../components/ui/skeleton'
import { Textarea } from '../components/ui/textarea'
import { useT } from '../i18n'

type Translate = (key: string, vars?: Record<string, string | number>) => string
type Kind = PersonIdentifier['kind']

const KINDS: Array<{ id: Kind; labelKey: string; placeholderKey: string }> = [
  { id: 'telegram', labelKey: 'persons.kind.telegram', placeholderKey: 'persons.placeholder.telegram' },
  { id: 'whatsapp', labelKey: 'persons.kind.whatsapp', placeholderKey: 'persons.placeholder.whatsapp' },
  { id: 'phone', labelKey: 'persons.kind.phone', placeholderKey: 'persons.placeholder.phone' },
  { id: 'email', labelKey: 'persons.kind.email', placeholderKey: 'persons.placeholder.email' },
  { id: 'handle', labelKey: 'persons.kind.handle', placeholderKey: 'persons.placeholder.handle' },
  { id: 'other', labelKey: 'persons.kind.other', placeholderKey: 'persons.placeholder.other' },
]

function kindLabel(t: Translate, kind: string): string {
  const found = KINDS.find(k => k.id === kind)
  return found ? t(found.labelKey) : kind
}

function placeholderFor(t: Translate, kind: Kind): string {
  return t(KINDS.find(k => k.id === kind)?.placeholderKey ?? 'persons.placeholder.other')
}

/** Initiales (deux premiers mots) pour l'avatar de la carte. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0]?.toUpperCase() ?? '')
    .join('')
}

export function Persons() {
  const { t } = useT()
  const [persons, setPersons] = useState<PersonProfile[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  // Premier chargement (et « Réessayer ») : squelette puis liste ou erreur.
  useEffect(() => {
    let cancelled = false
    setError(null)
    setPersons(null)
    getPersons()
      .then(list => {
        if (!cancelled) setPersons(list)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        console.warn('memoria-ui : liste des personnes illisible', err)
        setError(humanError(err))
      })
    return () => {
      cancelled = true
    }
  }, [tick])

  // Après une action : resynchronisation silencieuse (pas de squelette).
  const refresh = useCallback(() => {
    getPersons()
      .then(setPersons)
      .catch((err: unknown) => toast.error(humanError(err)))
  }, [])

  const phase = listPhase(persons, error)

  return (
    <>
      <PageHeader
        title={t('persons.title')}
        actions={<AddPersonDialog onAdded={refresh} />}
        // En `description` et non en `children` : PageHeader place la
        // description AVANT les actions, donc au téléphone l'écran s'ouvre sur
        // sa phrase d'explication et non sur le bouton « Ajouter » tout seul.
        description={
          <>
            {t('persons.lead.before')}
            <strong className="font-medium text-foreground">{t('persons.lead.strong')}</strong>
            {t('persons.lead.after')}
          </>
        }
      />

      <div className="flex flex-col gap-4">
        {phase === 'loading' && <PersonsSkeleton />}
        {phase === 'failed' && error && <ErrorBanner message={error} onRetry={() => setTick(n => n + 1)} className="my-0" />}
        {phase === 'empty' && (
          <EmptyState
            icon={<Users className="size-5" />}
            title={t('persons.empty.title')}
            body={t('persons.empty.body')}
            action={
              <AddPersonDialog
                onAdded={refresh}
                trigger={
                  <Button size="lg">
                    <UserPlus aria-hidden="true" />
                    {t('persons.add.title')}
                  </Button>
                }
              />
            }
          />
        )}
        {phase === 'ready' && persons && (
          <SectionCard
            title={t('persons.list.title')}
            actions={<Badge variant="secondary" className="tabular-nums">{formatNumber(persons.length)}</Badge>}
            className="mb-0"
            contentClassName="flex flex-col gap-3"
          >
            {persons.map(p => (
              <PersonCard key={p.id} person={p} onChange={refresh} />
            ))}
          </SectionCard>
        )}

        {/* POURQUOI en dernier : « Tester l'identification » est un outil de
            diagnostic. Placé en tête, il repoussait les vraies personnes sous la
            ligne de flottaison — la page parle d'abord de son contenu. */}
        <IdentifyTester />
      </div>
    </>
  )
}

function PersonsSkeleton() {
  const { t } = useT()
  return (
    <div className="flex flex-col gap-3" role="status" aria-label={t('common.loading')}>
      {[0, 1].map(i => (
        <Skeleton key={i} className="h-44 rounded-xl" />
      ))}
    </div>
  )
}

/** « Ajouter une personne » : nom + relation dans une boîte de dialogue. */
function AddPersonDialog({ onAdded, trigger }: { onAdded: () => void; trigger?: React.ReactNode }) {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [relation, setRelation] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const display = name.trim()
    if (!display) return
    setBusy(true)
    try {
      await createPerson({ display_name: display, relation: relation.trim() || undefined })
      toast.success(t('persons.add.done_toast', { name: display }))
      setName('')
      setRelation('')
      setOpen(false)
      onAdded()
    } catch (err) {
      toast.error(humanError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" aria-label={t('persons.add.title')} data-testid="person-add">
            <UserPlus aria-hidden="true" />
            {/* Jamais d'icône muette : sous 640 px la barre est étroite, on met un
                libellé COURT (« Ajouter ») plutôt que rien. */}
            <span className="sm:hidden">{t('persons.add.short')}</span>
            <span className="hidden sm:inline">{t('persons.add.title')}</span>
          </Button>
        )}
      </DialogTrigger>
      {/* Le bouton « fermer » généré porte un libellé en dur : on s'en passe, Annuler suffit. */}
      <DialogContent showCloseButton={false}>
        <form onSubmit={e => void submit(e)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t('persons.add.title')}</DialogTitle>
            <DialogDescription>{t('persons.add.lead')}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="person-add-name">{t('persons.add.nameLabel')}</Label>
              <Input id="person-add-name" value={name} onChange={e => setName(e.target.value)} placeholder={t('persons.add.namePlaceholder')} autoFocus required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="person-add-relation">{t('persons.add.relationLabel')}</Label>
              <Input id="person-add-relation" value={relation} onChange={e => setRelation(e.target.value)} placeholder={t('persons.add.relationPlaceholder')} />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t('common.cancel')}
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
              {t('persons.add.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** « Qui l'agent reconnaîtrait-il ? » — on colle un numéro / e-mail / nom. */
function IdentifyTester() {
  const { t } = useT()
  const [kind, setKind] = useState<Kind | 'name'>('telegram')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<InterlocutorMatch | null | 'none'>(null)

  const test = async (e: FormEvent) => {
    e.preventDefault()
    const v = value.trim()
    if (!v) return
    setBusy(true)
    try {
      const input = kind === 'name' ? { name: v } : { [kind]: v }
      const match = await identifyInterlocutor(input)
      setResult(match ?? 'none')
    } catch (err) {
      toast.error(humanError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SectionCard title={t('persons.identify.title')} description={t('persons.identify.lead')} className="mb-0" contentClassName="flex flex-col gap-3">
      <form onSubmit={e => void test(e)} className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex flex-col gap-1.5 sm:w-44">
          <Label htmlFor="identify-kind">{t('persons.identify.kindLabel')}</Label>
          <Select value={kind} onValueChange={v => setKind(v as Kind | 'name')}>
            <SelectTrigger id="identify-kind" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KINDS.map(k => (
                <SelectItem key={k.id} value={k.id}>
                  {t(k.labelKey)}
                </SelectItem>
              ))}
              <SelectItem value="name">{t('persons.identify.name')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor="identify-value">{t('persons.identify.valueLabel')}</Label>
          <Input id="identify-value" value={value} onChange={e => setValue(e.target.value)} placeholder={t('persons.identify.placeholder')} />
        </div>
        {/* `max-sm:h-11` et non `size="sm"` : le plancher tactile de 44 px n'est
            porté que par la taille `sm`, qui vaut 28 px sur bureau — le bouton
            serait alors plus court de 4 px que le champ d'à côté, avec lequel il
            est aligné. On ajoute donc le plancher sans toucher au bureau. */}
        <Button type="submit" variant="outline" className="max-sm:h-11" disabled={busy || !value.trim()}>
          {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Search aria-hidden="true" />}
          {t('persons.identify.submit')}
        </Button>
      </form>

      {result === 'none' && (
        <Alert>
          <UserX />
          <AlertTitle>{t('persons.identify.noMatch')}</AlertTitle>
        </Alert>
      )}
      {result && result !== 'none' && (
        <Card size="sm" className="bg-muted/40 ring-0">
          <CardContent className="flex flex-col gap-2">
            <div className="text-xs text-muted-foreground">{t('persons.identify.result_title')}</div>
            <div className="flex flex-wrap items-center gap-2">
              <UserCheck className="size-4 text-success" aria-hidden="true" />
              <span className="font-medium">{result.person.display_name}</span>
              {result.person.relation && <Badge variant="secondary">{result.person.relation}</Badge>}
            </div>
            {result.person.notes && <p className="text-sm text-muted-foreground">{result.person.notes}</p>}
            {result.known.length > 0 && (
              <div>
                <div className="mb-1 text-xs text-muted-foreground">{t('persons.identify.known')}</div>
                <ul className="flex flex-col gap-1.5">
                  {result.known.slice(0, 5).map((f, i) => (
                    <li key={i} className="rounded-lg bg-background p-2 text-sm ring-1 ring-foreground/10">
                      {f}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </SectionCard>
  )
}

function PersonCard({ person, onChange }: { person: PersonProfile; onChange: () => void }) {
  const { t } = useT()
  const [notes, setNotes] = useState(person.notes ?? '')
  const [relation, setRelation] = useState(person.relation ?? '')
  const [saving, setSaving] = useState(false)
  const [idKind, setIdKind] = useState<Kind>('telegram')
  const [idValue, setIdValue] = useState('')
  const [adding, setAdding] = useState(false)

  const dirty = notes !== (person.notes ?? '') || relation !== (person.relation ?? '')

  const saveMeta = async () => {
    setSaving(true)
    try {
      await updatePerson(person.id, { relation: relation.trim() || null, notes: notes.trim() || null })
      toast.success(t('persons.card.saved_toast'))
      onChange()
    } catch (err) {
      toast.error(humanError(err))
    } finally {
      setSaving(false)
    }
  }

  const addId = async (e: FormEvent) => {
    e.preventDefault()
    const v = idValue.trim()
    if (!v) return
    setAdding(true)
    try {
      await addPersonIdentifier(person.id, idKind, v)
      setIdValue('')
      toast.success(t('persons.card.identAdded_toast'))
      onChange()
    } catch (err) {
      toast.error(humanError(err))
    } finally {
      setAdding(false)
    }
  }

  const removeId = async (id: string) => {
    try {
      await removePersonIdentifier(id)
      toast.success(t('persons.card.identRemoved_toast'))
      onChange()
    } catch (err) {
      toast.error(humanError(err))
    }
  }

  const remove = async () => {
    try {
      await deletePerson(person.id)
      toast.success(t('persons.card.deleted_toast'))
      onChange()
    } catch (err) {
      toast.error(humanError(err))
    }
  }

  return (
    <Card size="sm" className="bg-muted/40 ring-0">
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary" aria-hidden="true">
            {initials(person.display_name)}
          </span>
          <span className="font-medium">{person.display_name}</span>
          {person.user_id && (
            <Badge variant="outline" className="text-success">
              {t('persons.card.userBadge')}
            </Badge>
          )}
          <div className="ml-auto">
            <CogConfirmButton
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-destructive"
              icon={<Trash2 aria-hidden="true" />}
              label={t('persons.card.delete')}
              title={t('persons.card.deleteConfirm')}
              description={t('persons.card.deleteBody')}
              confirmLabel={t('persons.card.delete')}
              onConfirm={() => void remove()}
              testId="person-delete"
            />
          </div>
        </div>

        {/* POURQUOI deux colonnes égales : « Relation » contient presque toujours un
            nom d'organisation (« cliente — Mairie de Sainte-Colombe-du-Vallon ») que
            224 px coupaient en plein mot, pendant que « Notes » gardait 700 px inutilisés. */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`person-${person.id}-relation`}>{t('persons.card.relationLabel')}</Label>
            <Input id={`person-${person.id}-relation`} value={relation} onChange={e => setRelation(e.target.value)} placeholder={t('persons.card.relationPlaceholder')} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`person-${person.id}-notes`}>{t('persons.card.notesLabel')}</Label>
            <Textarea id={`person-${person.id}-notes`} value={notes} onChange={e => setNotes(e.target.value)} placeholder={t('persons.card.notesPlaceholder')} rows={2} className="min-h-8" />
          </div>
        </div>
        {dirty && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={saving} onClick={() => void saveMeta()}>
              {saving ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Save aria-hidden="true" />}
              {t('persons.card.save')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={saving}
              onClick={() => {
                setNotes(person.notes ?? '')
                setRelation(person.relation ?? '')
              }}
            >
              {t('common.cancel')}
            </Button>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-muted-foreground">{t('persons.card.identLabel')}</span>
          {person.identifiers.length === 0 ? (
            <p className="flex items-start gap-1.5 text-sm text-warning">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {t('persons.card.noIdent')}
            </p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {person.identifiers.map(id => (
                <li key={id.id} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background py-1 pr-1 pl-2.5 text-sm">
                  <span className="text-xs text-muted-foreground">{kindLabel(t, id.kind)}</span>
                  <span className="font-mono text-xs">{id.value}</span>
                  <CogConfirmButton
                    iconOnly
                    variant="ghost"
                    size="icon-sm"
                    /* Cible tactile : 28 px visibles + une zone invisible autour
                       (after:-inset-2) pour approcher les 44 px au doigt. */
                    className="relative rounded-full text-muted-foreground after:absolute after:-inset-2 after:content-[''] hover:text-destructive"
                    icon={<X aria-hidden="true" />}
                    label={t('persons.card.removeIdent')}
                    title={t('persons.card.removeIdentConfirm', { value: id.value })}
                    description={t('persons.card.removeIdentBody')}
                    confirmLabel={t('persons.card.removeIdent')}
                    onConfirm={() => void removeId(id.id)}
                    testId="ident-remove"
                  />
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={e => void addId(e)} className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Label htmlFor={`person-${person.id}-kind`} className="sr-only">
              {t('persons.card.kindLabel')}
            </Label>
            <Select value={idKind} onValueChange={v => setIdKind(v as Kind)}>
              <SelectTrigger id={`person-${person.id}-kind`} className="w-full sm:w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KINDS.map(k => (
                  <SelectItem key={k.id} value={k.id}>
                    {t(k.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Label htmlFor={`person-${person.id}-value`} className="sr-only">
              {t('persons.card.valueLabel')}
            </Label>
            <Input id={`person-${person.id}-value`} value={idValue} onChange={e => setIdValue(e.target.value)} placeholder={placeholderFor(t, idKind)} className="sm:flex-1" />
            {/* Plancher tactile de 44 px au téléphone, hauteur de bureau inchangée
                (même raison que le bouton « Identifier » plus haut). */}
            <Button type="submit" variant="outline" className="max-sm:h-11" disabled={adding || !idValue.trim()}>
              {adding ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Plus aria-hidden="true" />}
              {t('persons.card.addIdent')}
            </Button>
          </form>
        </div>
      </CardContent>
    </Card>
  )
}
