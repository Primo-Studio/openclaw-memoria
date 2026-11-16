/**
 * `memoria sync …` — synchro inter-machines (SYNC-INTER-MACHINES.md).
 *
 *   memoria sync init-hub [--listen lan:47600] [--scopes org]   désigne CETTE machine comme hub
 *   memoria sync invite [--name "Mac de l'équipe"] [--scopes org] code one-shot à donner au spoke
 *   memoria sync join --hub <ip:port> --code XXXX                 relie CETTE machine au hub (+ bootstrap)
 *   memoria sync now | status | revoke <id> | leave
 *
 * Ce qui part vers un Mac relié : l'espace d'équipe `org` (par défaut), jamais
 * l'espace `user` du propriétaire ni les mémoires privées des agents.
 *
 * Toutes passent par le daemon (il détient les DB). Le join/bootstrap réel
 * tourne DANS le daemon (accès réseau + écriture registry/scopes).
 */
import { Command, Option } from 'clipanion/lib/advanced/index.js'
import { fail, findAliveDaemon } from '../index.js'

abstract class SyncBase extends Command {
  storageRoot = Option.String('--storage-root', { description: 'Racine du stockage' })
  config = Option.String('--config', { description: 'Fichier de découverte' })

  protected async daemon() {
    const d = await findAliveDaemon({ storageRoot: this.storageRoot, configPath: this.config })
    if (!d) throw new Error('daemon arrêté — lance « memoria start » d’abord (la synchro vit dans le daemon).')
    return d
  }
}

/** « org,project » → ['org', 'project'] (le daemon valide : jamais user ni privé). */
function scopeList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined
  return raw.split(',').map(s => s.trim()).filter(s => s.length > 0)
}

interface StatusPeer {
  display_name: string
  role: string
  machine_id: string
  last_seen_at: string | null
  revoked_at: string | null
  pending?: boolean
  allowed?: Array<{ id: string; type: string | null; name: string | null }>
}

interface StatusPayload {
  enabled: boolean
  role: string
  machine_id: string
  hub: string | null
  listen_lan: string | null
  listen_resolved?: string | null
  lan_listening?: boolean
  hub_addresses?: { primary: string | null; alternatives: string[] } | null
  scope_types?: string[]
  peers: StatusPeer[]
  auto?: { armed: boolean; interval_sec: number | null }
  last_sync?: { at: string; ok: boolean; pulled: number; pushed: number; refused: number; errors: string[] } | null
}

export class SyncStatusCommand extends SyncBase {
  static override paths = [['sync', 'status'], ['sync']]
  static override usage = Command.Usage({ description: 'État de la synchro inter-machines (rôle, hub, espaces partagés, pairs).' })
  override async execute(): Promise<number> {
    try {
      const { client } = await this.daemon()
      const s = (await client.syncStatus()) as StatusPayload
      const out = this.context.stdout
      out.write(`Synchro : ${s.enabled ? 'activée' : 'désactivée'} · rôle ${s.role} · machine ${s.machine_id}\n`)
      if (s.role === 'hub') {
        const resolved = s.listen_resolved ? ` → ${s.listen_resolved}` : s.listen_lan ? ' → aucune adresse de réseau local pour l’instant' : ''
        out.write(`  écoute LAN : ${s.listen_lan ?? '(non configuré)'}${resolved}${s.lan_listening ? ' (active)' : s.listen_lan ? ' (inactive : redémarre après init-hub)' : ''}\n`)
        const addr = s.hub_addresses
        if (addr?.primary) out.write(`  à donner aux autres Mac : ${addr.primary}${addr.alternatives.length ? ` (ou ${addr.alternatives.join(', ')})` : ''}\n`)
        out.write(`  espaces partagés avec les Mac reliés : ${(s.scope_types ?? []).join(', ') || '(aucun)'}\n`)
      }
      if (s.role === 'spoke') out.write(`  hub : ${s.hub ?? '(aucun)'}\n`)
      if (s.peers.length === 0) out.write('  aucun pair.\n')
      for (const p of s.peers) {
        const allowed = (p.allowed ?? []).map(a => a.type ?? `inconnu:${a.id.slice(0, 8)}`).join(', ') || '(aucun)'
        const flags = [p.revoked_at ? 'révoqué' : null, p.pending ? 'appairage en cours' : null].filter(Boolean).join(', ')
        out.write(`  • ${p.display_name} [${p.role}]${flags ? ` (${flags})` : ''} — ${p.machine_id} · espaces : ${allowed}${p.last_seen_at ? ` · vu ${p.last_seen_at}` : ''}\n`)
      }
      if (s.role === 'spoke' && s.enabled) {
        out.write(`  synchro automatique : ${s.auto?.armed ? `armée (toutes les ${s.auto.interval_sec ?? '?'} s)` : 'non armée'}\n`)
        const last = s.last_sync
        if (last) {
          out.write(`  dernière passe : ${last.at} · ${last.ok ? 'ok' : 'en échec'} · ${last.pulled} reçus, ${last.pushed} poussés${last.refused ? `, ${last.refused} refusés par le hub` : ''}\n`)
          for (const e of last.errors) out.write(`    ⚠ ${e}\n`)
        }
      }
      return 0
    } catch (err) {
      return fail(this.context.stderr, `sync status : ${(err as Error).message}`)
    }
  }
}

export class SyncInitHubCommand extends SyncBase {
  static override paths = [['sync', 'init-hub']]
  static override usage = Command.Usage({
    description: 'Désigne cette machine comme HUB de synchro (redémarrage requis).',
    details:
      'Par défaut, le hub écoute sur l’adresse de son réseau local (`lan:47600`, résolue à chaque démarrage) et ne partage que l’espace d’équipe `org`. ' +
      'Les clés du groupe sont tirées neuves tant qu’aucun Mac n’est relié. L’appairage passe en clair : à faire seulement sur le réseau du bureau.',
  })
  listen = Option.String('--listen', { description: 'Adresse d’écoute « hôte:port » (défaut lan:47600 = IP du réseau local ; 0.0.0.0 = toutes les interfaces, déconseillé)' })
  scopes = Option.String('--scopes', { description: 'Espaces partagés, séparés par des virgules (défaut org ; jamais user)' })
  override async execute(): Promise<number> {
    try {
      const { client } = await this.daemon()
      const r = await client.syncInitHub(this.listen ?? 'lan:47600', scopeList(this.scopes))
      this.context.stdout.write(
        `✓ Hub configuré (écoute ${r.listen_lan}, espaces partagés : ${r.scopes.join(', ')}, machine ${r.machine_id}).\n` +
          (r.keys === 'new' ? '  Clés du groupe : neuves.\n' : '  Clés du groupe : gardées (des Mac sont déjà reliés).\n') +
          '  Redémarre : memoria stop && memoria start — puis « memoria sync invite ».\n',
      )
      return 0
    } catch (err) {
      return fail(this.context.stderr, `sync init-hub : ${(err as Error).message}`)
    }
  }
}

export class SyncInviteCommand extends SyncBase {
  static override paths = [['sync', 'invite']]
  static override usage = Command.Usage({ description: 'Génère un code one-shot pour relier une nouvelle machine (spoke).' })
  name = Option.String('--name', { description: 'Nom de la machine invitée (ex. « Mac de l’équipe »)' })
  scopes = Option.String('--scopes', { description: 'Espaces que ce Mac recevra, séparés par des virgules (défaut org)' })
  override async execute(): Promise<number> {
    try {
      const { client } = await this.daemon()
      const r = await client.syncInvite(this.name, scopeList(this.scopes))
      const alt = r.hub_alternatives?.length ? `  (si l’adresse a changé : --hub ${r.hub_alternatives[0]})\n` : ''
      this.context.stdout.write(
        `Code de synchro : ${r.code}  (valable 10 min)\n` +
          `Espaces que ce Mac recevra : ${(r.scopes ?? ['org']).join(', ')}\n` +
          `Sur l’autre machine (même réseau de bureau) :\n    memoria sync join --hub ${r.hub_lan ?? '<ip-de-ce-mac>:47600'} --code ${r.code}\n` +
          alt,
      )
      return 0
    } catch (err) {
      return fail(this.context.stderr, `sync invite : ${(err as Error).message}`)
    }
  }
}

export class SyncJoinCommand extends SyncBase {
  static override paths = [['sync', 'join']]
  static override usage = Command.Usage({ description: 'Relie cette machine à un hub et récupère la mémoire d’équipe partagée.' })
  hub = Option.String('--hub', { required: true, description: 'Adresse du hub « ip:port » ou « nom.local:port »' })
  code = Option.String('--code', { required: true, description: 'Code one-shot affiché par « memoria sync invite »' })
  override async execute(): Promise<number> {
    try {
      const { client } = await this.daemon()
      const r = await client.syncJoin(this.hub, this.code)
      this.context.stdout.write(
        `✓ Relié au hub. Reçu : ${r.facts} souvenirs partagés, ${r.secrets} secrets, sur ${r.scopes} espaces.\n` +
          (r.auto_sync ? '  Synchro automatique en marche (pas besoin de redémarrer).\n' : ''),
      )
      return 0
    } catch (err) {
      return fail(this.context.stderr, `sync join : ${(err as Error).message}`)
    }
  }
}

export class SyncNowCommand extends SyncBase {
  static override paths = [['sync', 'now']]
  static override usage = Command.Usage({ description: 'Force une passe de synchro maintenant.' })
  override async execute(): Promise<number> {
    try {
      const { client } = await this.daemon()
      const r = await client.syncNow()
      this.context.stdout.write(`✓ Synchro : ${r.pulled} reçus, ${r.pushed} poussés${r.refused ? `, ${r.refused} refusés par le hub` : ''}.\n`)
      for (const e of r.errors ?? []) this.context.stdout.write(`  ⚠ ${e}\n`)
      return r.errors && r.errors.length > 0 ? 1 : 0
    } catch (err) {
      return fail(this.context.stderr, `sync now : ${(err as Error).message}`)
    }
  }
}

export class SyncRevokeCommand extends SyncBase {
  static override paths = [['sync', 'revoke']]
  static override usage = Command.Usage({ description: 'Révoque un pair (par machine_id).' })
  machineId = Option.String({ required: true })
  override async execute(): Promise<number> {
    try {
      const { client } = await this.daemon()
      const r = await client.syncRevoke(this.machineId)
      this.context.stdout.write(r.revoked ? `✓ Pair révoqué : ${this.machineId}\n` : `Aucun pair actif « ${this.machineId} ».\n`)
      return 0
    } catch (err) {
      return fail(this.context.stderr, `sync revoke : ${(err as Error).message}`)
    }
  }
}

export class SyncLeaveCommand extends SyncBase {
  static override paths = [['sync', 'leave']]
  static override usage = Command.Usage({ description: 'Se déconnecte du hub (garde les souvenirs déjà reçus).' })
  override async execute(): Promise<number> {
    try {
      const { client } = await this.daemon()
      const r = await client.syncLeave()
      this.context.stdout.write(
        '✓ Déconnecté du hub. Les souvenirs et secrets déjà reçus restent disponibles.\n' +
          (r.hub_notified === false ? '  Hub injoignable : sur le hub, coupe aussi ce Mac (« memoria sync revoke <machine_id> »).\n' : ''),
      )
      return 0
    } catch (err) {
      return fail(this.context.stderr, `sync leave : ${(err as Error).message}`)
    }
  }
}
