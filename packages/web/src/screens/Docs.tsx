/**
 * Docs — centre de documentation intégré. Aucune donnée, aucun appel réseau :
 * du contenu statique, organisé en SECTIONS regroupées par thème, pour que
 * quelqu'un qui ouvre Memoria comprenne le produit de fond en comble —
 * concepts, onglets, moteur d'IA, partage, multi-machines, CLI, FAQ.
 *
 * Migré sur shadcn : UNE longue page (toutes les sections rendues, lisibles
 * d'un trait ou par recherche navigateur) + sommaire collant à gauche sur
 * bureau, Select collant sous la barre sur mobile. La navigation interne ne
 * passe PAS par le hash (#/docs est la route de la coquille : un `#engine`
 * renverrait au Tableau de bord) : scrollIntoView + section active suivie au
 * défilement. Tableaux en DataTable, commandes en AdmCommand (bouton Copier).
 *
 * Tenir à jour quand on ajoute un écran, une commande CLI ou un provider
 * (16 écrans dans app/nav.ts, commandes dans cli/src/index.ts buildCli).
 * Le contenu reflète le code réel (cli/commands, core/llm, core/sync,
 * core/cognition, docs/v3). Pas de promesse non tenue : les modes de capture,
 * le scope partagé « user » et le journal cloud décrits ici sont ceux du daemon.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Info, Lightbulb, TriangleAlert } from 'lucide-react'
import { AdmCommand } from '../components/AdmCommand'
import { CopyButton, DataTable, PageHeader, type DataColumn } from '../components/ui'
import { Alert, AlertDescription } from '../components/ui/alert'
import { Badge } from '../components/ui/badge'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '../components/ui/select'
import { useT } from '../i18n'
import { cn } from '../lib/utils'

type Translate = (key: string, vars?: Record<string, string | number>) => string

// --------------------------------------------------------------- présentation
// Petites briques typographiques : le preflight Tailwind retire puces, marges
// et tailles des balises — on les redonne ici, une fois, pour toute la doc.

function Lead({ children }: { children: ReactNode }) {
  return <p className="mt-1 mb-4 text-[15px] leading-relaxed text-muted-foreground">{children}</p>
}

function Para({ muted = false, children }: { muted?: boolean; children: ReactNode }) {
  return <p className={cn('my-2 text-[15px] leading-relaxed', muted && 'text-sm text-muted-foreground')}>{children}</p>
}

function Bullets({ children }: { children: ReactNode }) {
  return <ul className="my-2 list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed marker:text-muted-foreground">{children}</ul>
}

function Steps({ children }: { children: ReactNode }) {
  return <ol className="my-2 list-decimal space-y-1.5 pl-5 text-[15px] leading-relaxed marker:font-medium marker:text-primary">{children}</ol>
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground">{children}</code>
}

/** Sous-partie titrée d'une section (h3). */
function Sub({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-6">
      <h3 className="mb-1 text-base font-semibold">{title}</h3>
      {children}
    </div>
  )
}

function Callout({ kind = 'info', children }: { kind?: 'info' | 'tip' | 'warn'; children: ReactNode }) {
  // `!` : l'Alert force `*:[svg]:text-current` sur son icône ; on veut la
  // couleur du type de note sur l'icône seule, pas sur tout le texte.
  return (
    <Alert
      className={cn(
        'my-4',
        kind === 'tip' && 'border-success/30 bg-success/5 [&>svg]:text-success!',
        kind === 'warn' && 'border-warning/40 bg-warning/5 [&>svg]:text-warning!',
      )}
    >
      {kind === 'tip' ? <Lightbulb /> : kind === 'warn' ? <TriangleAlert /> : <Info />}
      <AlertDescription className="text-[15px] leading-relaxed text-foreground/90">{children}</AlertDescription>
    </Alert>
  )
}

/** Grille de tuiles (pièces du moteur, modes, familles de couches, onglets). */
function Tiles({ items, columns = 2 }: { items: Array<{ title: string; body?: string; points?: string[] }>; columns?: 2 | 3 }) {
  return (
    <div className={cn('my-3 grid gap-3', columns === 3 ? 'sm:grid-cols-2 xl:grid-cols-3' : 'sm:grid-cols-2')}>
      {items.map(item => (
        <div key={item.title} className="rounded-lg border bg-muted/40 px-3 py-2.5">
          <div className="font-medium">{item.title}</div>
          {item.body && <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{item.body}</p>}
          {item.points && (
            <ul className="mt-1.5 list-disc space-y-1 pl-4 text-sm leading-snug text-muted-foreground marker:text-muted-foreground/60">
              {item.points.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------- sections

function Bienvenue() {
  const { t } = useT()
  return (
    <>
      <Lead>{t('docs.welcome.lead')}</Lead>

      <Callout>
        <strong className="text-foreground">{t('docs.welcome.oneline.label')}</strong> {t('docs.welcome.oneline.body')}
      </Callout>

      <Sub title={t('docs.welcome.principles.title')}>
        <Bullets>
          <li>
            <strong>{t('docs.welcome.principle.local.title')}</strong> {t('docs.welcome.principle.local.body')}
          </li>
          <li>
            <strong>{t('docs.welcome.principle.peragent.title')}</strong> {t('docs.welcome.principle.peragent.body')}
          </li>
          <li>
            <strong>{t('docs.welcome.principle.govern.title')}</strong> {t('docs.welcome.principle.govern.body')}
          </li>
          <li>
            <strong>{t('docs.welcome.principle.secrets.title')}</strong> {t('docs.welcome.principle.secrets.body')}
          </li>
          <li>
            <strong>{t('docs.welcome.principle.isolation.title')}</strong> {t('docs.welcome.principle.isolation.body')}
          </li>
        </Bullets>
      </Sub>

      <Callout kind="tip">
        {t('docs.welcome.cta.p1')} <strong className="text-foreground">{t('docs.welcome.cta.quickstart')}</strong> {t('docs.welcome.cta.p2')}{' '}
        <strong className="text-foreground">{t('docs.welcome.cta.how')}</strong> {t('docs.welcome.cta.p3')}
      </Callout>
    </>
  )
}

const INSTALL_COMMAND = 'curl -fsSL https://raw.githubusercontent.com/Primo-Studio/openclaw-memoria/memoria-v1/scripts/install-memoria.sh | sh'

function Demarrage() {
  const { t } = useT()
  return (
    <>
      <Lead>{t('docs.start.lead')}</Lead>

      <Sub title={t('docs.start.install.title')}>
        <Para>{t('docs.start.install.p')}</Para>
        <AdmCommand command={INSTALL_COMMAND} />
        <Para muted>
          {t('docs.start.install.note1')} <Code>memoria ui</Code>.
        </Para>
      </Sub>

      <Sub title={t('docs.start.engine.title')}>
        <Para>{t('docs.start.engine.p')}</Para>
        <Bullets>
          <li>
            <strong>OpenAI</strong> {t('docs.start.engine.openai')}
          </li>
          <li>
            <strong>Ollama</strong> {t('docs.start.engine.ollama')}
          </li>
          <li>
            <strong>LM Studio</strong> {t('docs.start.engine.lmstudio')}
          </li>
          <li>
            <strong>{t('docs.start.engine.apikey.label')}</strong> {t('docs.start.engine.apikey.desc')}
          </li>
        </Bullets>
        <Para muted>
          {t('docs.start.engine.more.p1')} <strong>{t('docs.start.engine.more.link')}</strong>
          {t('docs.start.engine.more.p2')} <strong>{t('docs.start.engine.more.settings')}</strong>.
        </Para>
      </Sub>

      <Sub title={t('docs.start.connect.title')}>
        <Para>
          {t('docs.start.connect.p1')} <strong>{t('docs.start.connect.agents')}</strong> {t('docs.start.connect.p2')}{' '}
          <strong>{t('docs.start.connect.button')}</strong> {t('docs.start.connect.p3')}
        </Para>
        <Para muted>
          {t('docs.start.connect.remote.p1')} <strong>{t('docs.start.connect.remote.pairing')}</strong> {t('docs.start.connect.remote.p2')}{' '}
          <Code>memoria pair claude-code</Code>.
        </Para>
      </Sub>

      <Sub title={t('docs.start.import.title')}>
        <Para>
          {t('docs.start.import.p1')} <strong>{t('docs.start.import.agents')}</strong>
          {t('docs.start.import.p2')} <strong>{t('docs.start.import.button')}</strong> {t('docs.start.import.p3')}{' '}
          <strong>{t('docs.start.import.review')}</strong> {t('docs.start.import.p4')}
        </Para>
      </Sub>

      <Callout kind="tip">
        {t('docs.start.cta.p1')} <strong className="text-foreground">{t('docs.start.cta.autocapture')}</strong>
        {t('docs.start.cta.p2')} <strong className="text-foreground">{t('docs.start.cta.themes')}</strong> {t('docs.start.cta.p3')}
      </Callout>
    </>
  )
}

function CommentCaMarche() {
  const { t } = useT()
  const pieces = [
    { title: t('docs.how.piece.daemon.title'), body: t('docs.how.piece.daemon.body') },
    { title: t('docs.how.piece.mcp.title'), body: t('docs.how.piece.mcp.body') },
    { title: t('docs.how.piece.core.title'), body: t('docs.how.piece.core.body') },
    { title: t('docs.how.piece.ui.title'), body: t('docs.how.piece.ui.body') },
  ]
  return (
    <>
      <Lead>{t('docs.how.lead')}</Lead>

      <Sub title={t('docs.how.pieces.title')}>
        <Tiles items={pieces} />
      </Sub>

      <Sub title={t('docs.how.cycle.title')}>
        <Steps>
          <li>
            <strong>{t('docs.how.cycle.capture.title')}</strong> {t('docs.how.cycle.capture.body')}
          </li>
          <li>
            <strong>{t('docs.how.cycle.extraction.title')}</strong> {t('docs.how.cycle.extraction.body')}
          </li>
          <li>
            <strong>{t('docs.how.cycle.sort.title')}</strong> {t('docs.how.cycle.sort.body')}
          </li>
          <li>
            <strong>{t('docs.how.cycle.recall.title')}</strong> {t('docs.how.cycle.recall.body')}
          </li>
        </Steps>
      </Sub>

      <Callout>
        {t('docs.how.callout.p1')} <strong className="text-foreground">{t('docs.how.callout.mode')}</strong>
        {t('docs.how.callout.p2')}
      </Callout>
    </>
  )
}

function Souvenirs() {
  const { t } = useT()
  return (
    <>
      <Lead>{t('docs.memories.lead')}</Lead>

      <Sub title={t('docs.memories.what.title')}>
        <Para>
          {t('docs.memories.what.p1')} <strong>{t('docs.memories.what.provenance')}</strong> {t('docs.memories.what.p2')}{' '}
          <strong>{t('docs.memories.what.really')}</strong> {t('docs.memories.what.p3')}
        </Para>
      </Sub>

      <Sub title={t('docs.memories.spaces.title')}>
        <Para>
          {t('docs.memories.spaces.p1')} <strong>{t('docs.memories.spaces.private')}</strong> {t('docs.memories.spaces.p2')}{' '}
          <strong>{t('docs.memories.spaces.shared')}</strong> {t('docs.memories.spaces.p3')}
        </Para>
        <Bullets>
          <li>
            <strong>user</strong> {t('docs.memories.scope.user')}
          </li>
          <li>
            <strong>org</strong> {t('docs.memories.scope.org')}
          </li>
          <li>
            <strong>client</strong> / <strong>project</strong> {t('docs.memories.scope.clientproject')}
          </li>
          <li>
            <strong>{t('docs.memories.scope.subject.label')}</strong> {t('docs.memories.scope.subject.desc')}
          </li>
        </Bullets>
        <Para muted>
          {t('docs.memories.spaces.note.p1')} <strong>{t('docs.memories.spaces.note.sharing')}</strong>). {t('docs.memories.spaces.note.p2')}
        </Para>
      </Sub>

      <Callout kind="tip">
        {t('docs.memories.cta.p1')} <strong className="text-foreground">{t('docs.memories.cta.themes')}</strong> {t('docs.memories.cta.p2')}
      </Callout>
    </>
  )
}

function Capture() {
  const { t } = useT()
  const modes = [
    { title: t('docs.capture.mode.auto.label'), body: t('docs.capture.mode.auto.body') },
    { title: t('docs.capture.mode.review.label'), body: t('docs.capture.mode.review.body') },
    { title: t('docs.capture.mode.pause.label'), body: t('docs.capture.mode.pause.body') },
  ]
  return (
    <>
      <Lead>{t('docs.capture.lead')}</Lead>
      <Tiles items={modes} columns={3} />
      <Callout>
        {t('docs.capture.callout.p1')} <Code>memoria disable</Code> {t('docs.capture.callout.p2')} <Code>memoria enable</Code> {t('docs.capture.callout.p3')}
      </Callout>
    </>
  )
}

interface ProviderRow {
  provider: string
  recommended: boolean
  type: 'cloud' | 'local'
  model: ReactNode
  note: string
}

function Moteur() {
  const { t } = useT()
  const rows: ProviderRow[] = [
    { provider: 'OpenAI', recommended: true, type: 'cloud', model: <Code>gpt-4o-mini</Code>, note: t('docs.engine.row.openai.note') },
    { provider: 'Ollama', recommended: false, type: 'local', model: <Code>qwen2.5:3b</Code>, note: t('docs.engine.row.ollama.note') },
    { provider: 'LM Studio', recommended: false, type: 'local', model: t('docs.engine.row.lmstudio.model'), note: t('docs.engine.row.lmstudio.note') },
    { provider: 'Anthropic', recommended: false, type: 'cloud', model: <Code>claude-haiku-4-5</Code>, note: t('docs.engine.row.anthropic.note') },
    { provider: 'OpenRouter', recommended: false, type: 'cloud', model: t('docs.engine.row.openrouter.model'), note: t('docs.engine.row.openrouter.note') },
  ]
  const columns: DataColumn<ProviderRow>[] = [
    { id: 'provider', header: t('docs.engine.table.provider'), cell: r => <span className={cn(r.recommended && 'font-semibold')}>{r.provider}</span> },
    {
      id: 'type',
      header: t('docs.engine.table.type'),
      cell: r => <Badge variant={r.type === 'local' ? 'secondary' : 'outline'}>{t(r.type === 'local' ? 'docs.engine.type.local' : 'docs.engine.type.cloud')}</Badge>,
    },
    { id: 'model', header: t('docs.engine.table.model'), cell: r => r.model },
    { id: 'note', header: t('docs.engine.table.note'), className: 'min-w-48 whitespace-normal', cell: r => r.note },
  ]
  return (
    <>
      <Lead>
        {t('docs.engine.lead.p1')} <strong className="text-foreground">{t('docs.engine.lead.settings')}</strong>.
      </Lead>

      <Sub title={t('docs.engine.providers.title')}>
        <div className="my-2 rounded-lg border">
          <DataTable columns={columns} rows={rows} rowKey={r => r.provider} dense />
        </div>
        <Para muted>{t('docs.engine.providers.note')}</Para>
      </Sub>

      <Sub title={t('docs.engine.embeddings.title')}>
        <Para>
          {t('docs.engine.embeddings.p1')} <em>{t('docs.engine.embeddings.sens')}</em> {t('docs.engine.embeddings.p2')}
        </Para>
        <Bullets>
          <li>
            <strong>OpenAI</strong> {t('docs.engine.embeddings.openai')}
          </li>
          <li>
            <strong>Ollama</strong> {t('docs.engine.embeddings.ollama')}
          </li>
        </Bullets>
        <Para muted>{t('docs.engine.embeddings.p4')}</Para>
      </Sub>

      <Sub title={t('docs.engine.cloud.title')}>
        <Para>
          {t('docs.engine.cloud.p1')} <Code>memoria doctor</Code>.
        </Para>
      </Sub>

      <Sub title={t('docs.engine.degraded.title')}>
        <Para>
          {t('docs.engine.degraded.p1')} <strong>{t('docs.engine.degraded.strong')}</strong>
          {t('docs.engine.degraded.p2')}
        </Para>
      </Sub>

      <Callout kind="tip">
        {t('docs.engine.callout.p1')} <Code>ollama pull qwen2.5:3b</Code> {t('docs.engine.callout.p2')} <Code>ollama pull nomic-embed-text</Code>
        {t('docs.engine.callout.p3')}
      </Callout>
    </>
  )
}

function Couches() {
  const { t } = useT()
  const buckets = [
    { title: t('docs.layers.bucket.a.name'), body: t('docs.layers.bucket.a.desc') },
    { title: t('docs.layers.bucket.b.name'), body: t('docs.layers.bucket.b.desc') },
    { title: t('docs.layers.bucket.c.name'), body: t('docs.layers.bucket.c.desc') },
    { title: t('docs.layers.bucket.d.name'), body: t('docs.layers.bucket.d.desc') },
  ]
  return (
    <>
      <Lead>
        {t('docs.layers.lead.p1')} <strong className="text-foreground">{t('docs.layers.lead.layers')}</strong> {t('docs.layers.lead.p2')}{' '}
        <strong className="text-foreground">{t('docs.layers.lead.system')}</strong>.
      </Lead>
      <Tiles items={buckets} />

      <Sub title={t('docs.layers.recall.title')}>
        <Para>{t('docs.layers.recall.p')}</Para>
        <Bullets>
          <li>
            <strong>{t('docs.layers.recall.fulltext.label')}</strong> {t('docs.layers.recall.fulltext.desc')}
          </li>
          <li>
            <strong>{t('docs.layers.recall.semantic.label')}</strong> {t('docs.layers.recall.semantic.desc')}
          </li>
          <li>
            <strong>{t('docs.layers.recall.graph.label')}</strong> {t('docs.layers.recall.graph.desc')}
          </li>
          <li>
            <strong>Hot-tier</strong> {t('docs.layers.recall.hottier.desc')}
          </li>
        </Bullets>
        <Para muted>{t('docs.layers.recall.note')}</Para>
      </Sub>
    </>
  )
}

function tabGroups(t: Translate): Array<{ title: string; tabs: Array<{ title: string; body: string; points: string[] }> }> {
  return [
    {
      title: t('docs.tabs.group.pilotage'),
      tabs: [
        {
          title: t('docs.tabs.dashboard.label'),
          body: t('docs.tabs.dashboard.goal'),
          points: [t('docs.tabs.dashboard.detail.1'), t('docs.tabs.dashboard.detail.2'), t('docs.tabs.dashboard.detail.3')],
        },
        {
          title: t('docs.tabs.agents.label'),
          body: t('docs.tabs.agents.goal'),
          points: [t('docs.tabs.agents.detail.1'), t('docs.tabs.agents.detail.2'), t('docs.tabs.agents.detail.3')],
        },
      ],
    },
    {
      title: t('docs.tabs.group.memory'),
      tabs: [
        { title: t('docs.tabs.memory.label'), body: t('docs.tabs.memory.goal'), points: [t('docs.tabs.memory.detail.1'), t('docs.tabs.memory.detail.2')] },
        { title: t('docs.tabs.themes.label'), body: t('docs.tabs.themes.goal'), points: [t('docs.tabs.themes.detail.1'), t('docs.tabs.themes.detail.2')] },
        {
          title: t('docs.tabs.recurrences.label'),
          body: t('docs.tabs.recurrences.goal'),
          points: [t('docs.tabs.recurrences.detail.1'), t('docs.tabs.recurrences.detail.2')],
        },
        {
          title: t('docs.tabs.procedures.label'),
          body: t('docs.tabs.procedures.goal'),
          points: [t('docs.tabs.procedures.detail.1'), t('docs.tabs.procedures.detail.2')],
        },
      ],
    },
    {
      title: t('docs.tabs.group.control'),
      tabs: [
        { title: t('docs.tabs.review.label'), body: t('docs.tabs.review.goal'), points: [t('docs.tabs.review.detail.1'), t('docs.tabs.review.detail.2')] },
        {
          title: t('docs.tabs.revisions.label'),
          body: t('docs.tabs.revisions.goal'),
          points: [t('docs.tabs.revisions.detail.1'), t('docs.tabs.revisions.detail.2')],
        },
        {
          title: t('docs.tabs.maintenance.label'),
          body: t('docs.tabs.maintenance.goal'),
          points: [t('docs.tabs.maintenance.detail.1'), t('docs.tabs.maintenance.detail.2')],
        },
      ],
    },
    {
      title: t('docs.tabs.group.sharing'),
      tabs: [
        {
          title: t('docs.tabs.sharing.label'),
          body: t('docs.tabs.sharing.goal'),
          points: [t('docs.tabs.sharing.detail.1'), t('docs.tabs.sharing.detail.2'), t('docs.tabs.sharing.detail.3')],
        },
        { title: t('docs.tabs.people.label'), body: t('docs.tabs.people.goal'), points: [t('docs.tabs.people.detail.1'), t('docs.tabs.people.detail.2')] },
      ],
    },
    {
      title: t('docs.tabs.group.security'),
      tabs: [
        {
          title: t('docs.tabs.vault.label'),
          body: t('docs.tabs.vault.goal'),
          points: [t('docs.tabs.vault.detail.1'), t('docs.tabs.vault.detail.2'), t('docs.tabs.vault.detail.3')],
        },
        { title: t('docs.tabs.system.label'), body: t('docs.tabs.system.goal'), points: [t('docs.tabs.system.detail.1'), t('docs.tabs.system.detail.2')] },
        { title: t('docs.tabs.journal.label'), body: t('docs.tabs.journal.goal'), points: [t('docs.tabs.journal.detail.1'), t('docs.tabs.journal.detail.2')] },
        {
          title: t('docs.tabs.settings.label'),
          body: t('docs.tabs.settings.goal'),
          points: [t('docs.tabs.settings.detail.1'), t('docs.tabs.settings.detail.2'), t('docs.tabs.settings.detail.3')],
        },
        { title: t('docs.tabs.docs.label'), body: t('docs.tabs.docs.goal'), points: [t('docs.tabs.docs.detail.1')] },
      ],
    },
  ]
}

function GuideOnglets() {
  const { t } = useT()
  return (
    <>
      <Lead>{t('docs.tabs.lead')}</Lead>
      {tabGroups(t).map(group => (
        <Sub key={group.title} title={group.title}>
          <Tiles items={group.tabs} />
        </Sub>
      ))}
    </>
  )
}

function Partage() {
  const { t } = useT()
  return (
    <>
      <Lead>{t('docs.sharing.lead')}</Lead>

      <Sub title={t('docs.sharing.tools.title')}>
        <Bullets>
          <li>
            <strong>{t('docs.sharing.tools.matrix.label')}</strong> {t('docs.sharing.tools.matrix.desc')}
          </li>
          <li>
            <strong>{t('docs.sharing.tools.facts.label')}</strong> {t('docs.sharing.tools.facts.desc')}
          </li>
        </Bullets>
      </Sub>

      <Sub title={t('docs.sharing.direct.title')}>
        <Para>{t('docs.sharing.direct.p')}</Para>
      </Sub>

      <Sub title={t('docs.sharing.people.title')}>
        <Para>
          {t('docs.sharing.people.p1')} <strong>{t('docs.sharing.people.tab')}</strong> {t('docs.sharing.people.p2')} <em>{t('docs.sharing.people.q')}</em>{' '}
          {t('docs.sharing.people.p3')} <strong>{t('docs.sharing.people.recognizes')}</strong> {t('docs.sharing.people.p4')}
        </Para>
      </Sub>

      <Callout kind="warn">
        {t('docs.sharing.callout.p1')} <strong className="text-foreground">{t('docs.sharing.callout.strong')}</strong> {t('docs.sharing.callout.p2')}
      </Callout>
    </>
  )
}

function MultiMachines() {
  const { t } = useT()
  return (
    <>
      <Lead>{t('docs.sync.lead')}</Lead>

      <Sub title={t('docs.sync.model.title')}>
        <Para>
          {t('docs.sync.model.p1')} <strong>{t('docs.sync.model.hub')}</strong> {t('docs.sync.model.p2')}
          <strong>{t('docs.sync.model.spokes')}</strong>
          {t('docs.sync.model.p3')} <strong>{t('docs.sync.model.offline')}</strong> {t('docs.sync.model.p4')}
        </Para>
      </Sub>

      <Sub title={t('docs.sync.setup.title')}>
        <Steps>
          <li>
            {t('docs.sync.setup.step1.p1')} <Code>memoria sync init-hub</Code>
            {t('docs.sync.setup.step1.p2')}
          </li>
          <li>
            {t('docs.sync.setup.step2.p1')} <Code>memoria sync invite</Code> {t('docs.sync.setup.step2.p2')}
          </li>
          <li>
            {t('docs.sync.setup.step3.p1')} <Code>{'memoria sync join --hub <ip:port> --code XXXX-XXXX'}</Code>.
          </li>
        </Steps>
        <Para muted>{t('docs.sync.setup.note')}</Para>
      </Sub>

      <Sub title={t('docs.sync.flow.title')}>
        <Bullets>
          <li>
            <strong>{t('docs.sync.flow.synced.label')}</strong> {t('docs.sync.flow.synced.desc')}
          </li>
          <li>
            <strong>{t('docs.sync.flow.never.label')}</strong> {t('docs.sync.flow.never.desc')}
          </li>
        </Bullets>
      </Sub>

      <Callout>{t('docs.sync.callout')}</Callout>
    </>
  )
}

function Securite() {
  const { t } = useT()
  return (
    <>
      <Lead>{t('docs.security.lead')}</Lead>

      <Sub title={t('docs.security.local.title')}>
        <Para>{t('docs.security.local.body')}</Para>
      </Sub>

      <Sub title={t('docs.security.cloud.title')}>
        <Para>
          {t('docs.security.cloud.p1')} <Code>memoria doctor</Code>.
        </Para>
      </Sub>

      <Sub title={t('docs.security.secrets.title')}>
        <Para>
          {t('docs.security.secrets.p1')} <strong>{t('docs.security.secrets.vault')}</strong> {t('docs.security.secrets.p2')}{' '}
          <strong>{t('docs.security.secrets.reference')}</strong>
          {t('docs.security.secrets.p3')}
        </Para>
      </Sub>

      <Sub title={t('docs.security.isolation.title')}>
        <Para>
          {t('docs.security.isolation.p1')} <strong>{t('docs.security.isolation.strong')}</strong>.
        </Para>
      </Sub>

      <Sub title={t('docs.security.trace.title')}>
        <Para>
          {t('docs.security.trace.p1')} <strong>{t('docs.security.trace.journal')}</strong> {t('docs.security.trace.p2')} <em>{t('docs.security.trace.never')}</em>{' '}
          {t('docs.security.trace.p3')} <Code>forget</Code> {t('docs.security.trace.p4')}
        </Para>
      </Sub>
    </>
  )
}

interface CliRow {
  cmd: string
  desc: string
}

function cliGroups(t: Translate): Array<{ title: string; cmds: CliRow[] }> {
  const row = (cmd: string, desc: string): CliRow => ({ cmd, desc })
  return [
    {
      title: t('docs.cli.group.start'),
      cmds: [
        row('memoria', t('docs.cli.memoria')),
        row('memoria init', t('docs.cli.init')),
        row('memoria start / stop', t('docs.cli.startstop')),
        row('memoria autostart on|off', t('docs.cli.autostart')),
        row('memoria daemon', t('docs.cli.daemon')),
        row('memoria update', t('docs.cli.update')),
      ],
    },
    {
      title: t('docs.cli.group.agents'),
      cmds: [
        row('memoria pair <type>', t('docs.cli.pair')),
        row('memoria agents', t('docs.cli.agents')),
        row('memoria revoke <id>', t('docs.cli.revoke')),
        row('memoria delete-agent <id>', t('docs.cli.deleteagent')),
      ],
    },
    {
      title: t('docs.cli.group.memory'),
      cmds: [
        row('memoria import --instance <id> --transcripts | --legacy <chemin>', t('docs.cli.import')),
        row('memoria export [--agent <type>] [--flat]', t('docs.cli.export')),
        row('memoria forget --id … / --query …', t('docs.cli.forget')),
        row('memoria stats', t('docs.cli.stats')),
        row('memoria doctor', t('docs.cli.doctor')),
        row('memoria audit', t('docs.cli.audit')),
      ],
    },
    {
      title: t('docs.cli.group.control'),
      cmds: [row('memoria disable / enable', t('docs.cli.disableenable')), row('memoria move --to <chemin>', t('docs.cli.move'))],
    },
    {
      title: t('docs.cli.group.sync'),
      cmds: [
        row('memoria sync status', t('docs.cli.syncstatus')),
        row('memoria sync init-hub', t('docs.cli.syncinithub')),
        row('memoria sync invite', t('docs.cli.syncinvite')),
        row('memoria sync join --hub … --code …', t('docs.cli.syncjoin')),
        row('memoria sync now', t('docs.cli.syncnow')),
        row('memoria sync revoke <machine_id>', t('docs.cli.syncrevoke')),
        row('memoria sync leave', t('docs.cli.syncleave')),
      ],
    },
  ]
}

function Cli() {
  const { t } = useT()
  const columns: DataColumn<CliRow>[] = [
    {
      id: 'cmd',
      header: t('docs.cli.col.command'),
      className: 'whitespace-normal',
      cell: r => (
        <span className="inline-flex max-w-full items-center gap-1">
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs break-all">{r.cmd}</code>
          <CopyButton text={r.cmd} variant="ghost" size="sm" className="shrink-0 text-muted-foreground" />
        </span>
      ),
    },
    { id: 'desc', header: t('docs.cli.col.desc'), className: 'min-w-56 whitespace-normal', cell: r => r.desc },
  ]
  return (
    <>
      <Lead>
        {t('docs.cli.lead.p1')} <Code>memoria</Code>. {t('docs.cli.lead.p2')} <Code>--help</Code> {t('docs.cli.lead.p3')}
      </Lead>
      {cliGroups(t).map(group => (
        <Sub key={group.title} title={group.title}>
          <div className="my-2 rounded-lg border">
            <DataTable columns={columns} rows={group.cmds} rowKey={r => r.cmd} dense />
          </div>
        </Sub>
      ))}
    </>
  )
}

function faqItems(t: Translate): Array<{ q: string; a: ReactNode }> {
  return [
    {
      q: t('docs.faq.engine.q'),
      a: (
        <>
          {t('docs.faq.engine.a1')} <strong>{t('docs.faq.engine.settings')}</strong>
          {t('docs.faq.engine.a2')}
        </>
      ),
    },
    {
      q: t('docs.faq.down.q'),
      a: (
        <>
          {t('docs.faq.down.a1')} <Code>memoria start</Code> {t('docs.faq.down.a2')} <Code>memoria</Code> {t('docs.faq.down.a3')}
        </>
      ),
    },
    {
      q: t('docs.faq.cache.q'),
      a: (
        <>
          {t('docs.faq.cache.a1')}
          <Code>{'memoria stop && memoria start'}</Code>
          {t('docs.faq.cache.a2')}
        </>
      ),
    },
    { q: t('docs.faq.cost.q'), a: <>{t('docs.faq.cost.a')}</> },
    {
      q: t('docs.faq.nomemory.q'),
      a: (
        <>
          {t('docs.faq.nomemory.a1')} <strong>{t('docs.faq.nomemory.capture')}</strong> {t('docs.faq.nomemory.a2')}{' '}
          <strong>{t('docs.faq.nomemory.pause')}</strong>
          {t('docs.faq.nomemory.a3')} <strong>{t('docs.faq.nomemory.agents')}</strong>
          {t('docs.faq.nomemory.a4')}
        </>
      ),
    },
    {
      q: t('docs.faq.delete.q'),
      a: (
        <>
          {t('docs.faq.delete.a1')} <strong>{t('docs.faq.delete.memory')}</strong> {t('docs.faq.delete.a2')} <Code>{'memoria forget --query "…"'}</Code>.
        </>
      ),
    },
    {
      q: t('docs.faq.data.q'),
      a: (
        <>
          {t('docs.faq.data.a1')} <em>{t('docs.faq.data.cloud')}</em> {t('docs.faq.data.a2')}
        </>
      ),
    },
    {
      q: t('docs.faq.update.q'),
      a: (
        <>
          <Code>memoria update</Code> {t('docs.faq.update.a1')} <strong>{t('docs.faq.update.settings')}</strong>.
        </>
      ),
    },
  ]
}

function Faq() {
  const { t } = useT()
  return (
    <>
      <Lead>{t('docs.faq.lead')}</Lead>
      {faqItems(t).map((item, i) => (
        <Sub key={i} title={item.q}>
          <Para>{item.a}</Para>
        </Sub>
      ))}
      <Callout kind="tip">
        {t('docs.faq.callout.p1')} <Code>memoria doctor</Code> {t('docs.faq.callout.p2')}
      </Callout>
    </>
  )
}

// --------------------------------------------------------------------- navigation

type DocSection = { id: string; group: string; titleKey: string; render: () => ReactNode }

const SECTIONS: DocSection[] = [
  { id: 'welcome', group: 'start', titleKey: 'docs.welcome.title', render: () => <Bienvenue /> },
  { id: 'start', group: 'start', titleKey: 'docs.start.title', render: () => <Demarrage /> },
  { id: 'how', group: 'start', titleKey: 'docs.how.title', render: () => <CommentCaMarche /> },
  { id: 'memories', group: 'concepts', titleKey: 'docs.memories.title', render: () => <Souvenirs /> },
  { id: 'capture', group: 'concepts', titleKey: 'docs.capture.title', render: () => <Capture /> },
  { id: 'engine', group: 'concepts', titleKey: 'docs.engine.title', render: () => <Moteur /> },
  { id: 'layers', group: 'concepts', titleKey: 'docs.layers.title', render: () => <Couches /> },
  { id: 'tabs', group: 'use', titleKey: 'docs.tabs.title', render: () => <GuideOnglets /> },
  { id: 'sharing', group: 'use', titleKey: 'docs.sharing.title', render: () => <Partage /> },
  { id: 'sync', group: 'use', titleKey: 'docs.sync.title', render: () => <MultiMachines /> },
  { id: 'security', group: 'reference', titleKey: 'docs.security.title', render: () => <Securite /> },
  { id: 'cli', group: 'reference', titleKey: 'docs.cli.title', render: () => <Cli /> },
  { id: 'faq', group: 'reference', titleKey: 'docs.faq.title', render: () => <Faq /> },
]

const GROUP_ORDER = ['start', 'concepts', 'use', 'reference']
const FIRST_SECTION = SECTIONS[0]?.id ?? 'welcome'

const anchorId = (id: string) => `docs-${id}`

/**
 * Section active = la dernière dont le haut est passé sous la barre
 * supérieure (+ le Select collant sur mobile). Recalculée au défilement via
 * requestAnimationFrame — pas d'IntersectionObserver : avec 13 sections de
 * hauteurs très différentes, « la dernière passée » est plus stable que
 * « la plus visible ».
 */
function useActiveSection(): [string, (id: string) => void] {
  const [active, setActive] = useState(FIRST_SECTION)

  useEffect(() => {
    let raf = 0
    const update = () => {
      raf = 0
      const offset = window.innerWidth < 1024 ? 132 : 100
      let current = FIRST_SECTION
      for (const s of SECTIONS) {
        const el = document.getElementById(anchorId(s.id))
        if (el && el.getBoundingClientRect().top <= offset) current = s.id
      }
      // Tout en bas, la dernière section est active même si elle est courte.
      const last = SECTIONS[SECTIONS.length - 1]
      if (last && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) current = last.id
      setActive(current)
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    update()
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  const jump = useCallback((id: string) => {
    const el = document.getElementById(anchorId(id))
    if (!el) return
    setActive(id)
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' })
    // Le focus suit (clavier, lecteur d'écran) sans re-défiler.
    el.querySelector('h2')?.focus({ preventScroll: true })
  }, [])

  return [active, jump]
}

export function Docs() {
  const { t } = useT()
  const [active, jump] = useActiveSection()

  return (
    <>
      <PageHeader title={t('docs.header.title')} description={t('docs.header.lead')} />

      {/* Mobile / tablette : sélecteur de section collé sous la barre supérieure. */}
      <div className="sticky top-14 z-20 -mx-4 mb-4 border-b bg-background/95 px-4 py-2 backdrop-blur supports-backdrop-filter:bg-background/80 md:-mx-6 md:px-6 lg:hidden">
        <Select value={active} onValueChange={jump}>
          <SelectTrigger className="w-full" aria-label={t('docs.nav.jump')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {GROUP_ORDER.map(group => (
              <SelectGroup key={group}>
                <SelectLabel>{t(`docs.group.${group}`)}</SelectLabel>
                {SECTIONS.filter(s => s.group === group).map(s => (
                  <SelectItem key={s.id} value={s.id}>
                    {t(`docs.nav.${s.id}`)}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-start gap-8">
        {/* Bureau : sommaire collant. */}
        <nav aria-label={t('docs.nav.aria')} className="sticky top-20 hidden max-h-[calc(100vh-6rem)] w-52 shrink-0 overflow-y-auto lg:block">
          <div className="mb-2 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">{t('docs.toc')}</div>
          {GROUP_ORDER.map((group, gi) => (
            <div key={group} className={cn(gi > 0 && 'mt-5')}>
              {/* POURQUOI en capitales espacées : à deux centimètres, la barre
                  latérale titre ses groupes « ESSENTIEL » / « AVANCÉ » ainsi. En
                  minuscules grises et à la même indentation que les entrées, ces
                  titres passaient pour des liens désactivés. */}
              <div className="px-2 pb-1.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">{t(`docs.group.${group}`)}</div>
              <ul className="flex flex-col gap-0.5">
                {SECTIONS.filter(s => s.group === group).map(s => {
                  const isActive = active === s.id
                  return (
                    <li key={s.id}>
                      <button
                        type="button"
                        aria-current={isActive ? 'location' : undefined}
                        onClick={() => jump(s.id)}
                        className={cn(
                          'w-full rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60',
                          isActive ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                        )}
                      >
                        {t(`docs.nav.${s.id}`)}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="min-w-0 max-w-3xl flex-1">
          {SECTIONS.map((s, i) => (
            <section key={s.id} id={anchorId(s.id)} className={cn('scroll-mt-32 lg:scroll-mt-24', i > 0 && 'mt-8 border-t pt-8')}>
              <h2 tabIndex={-1} className="text-xl font-semibold tracking-tight outline-none">
                {t(s.titleKey)}
              </h2>
              {s.render()}
            </section>
          ))}
        </div>
      </div>
    </>
  )
}
