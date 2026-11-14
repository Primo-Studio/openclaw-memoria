/**
 * Import de l'export ChatGPT, avec des données ENTIÈREMENT fictives :
 *  - parseur : branche affichée seulement (message modifié = branche), tours
 *    système / outils / cachés / pensées écartés avec une raison par filtre,
 *    multimodal et vocal, conversation vide, current_node absent ou sur la
 *    racine, feuille orpheline, cycle, citations et marqueurs privés, dates
 *    en microsecondes ou hors limites ;
 *  - lecture en flux : morceaux minuscules, emoji coupé, guillemets échappés,
 *    éléments illisibles, fichier tronqué, fichier qui n'est pas un tableau ;
 *  - export découpé en plusieurs fichiers, doublons entre morceaux (seule la
 *    version retenue entre dans les compteurs) ;
 *  - estimation : tranches de sortie lues sur l'extrait seul ;
 *  - zip : extraction (stored, deflate, ZIP64, descripteur de données),
 *    dossier temporaire supprimé, zip-slip, lien symbolique, chemin absolu,
 *    bombe de décompression ;
 *  - import : quarantaine dans l'instance ChatGPT, prompt dédié, aucun
 *    plafond qui perd le début d'une conversation, ré-import idempotent,
 *    conversation qui a grandi, titre renommé, dry-run sans instance ni appel.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as zlib from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Memoria } from '../src/engine/memoria.js'
import { ContentStore } from '../src/storage/content.js'
import {
  CHATGPT_EXTRACTION_SYSTEM,
  JsonArraySplitter,
  NotAnArrayError,
  chatGptUnits,
  emptyChatGptStats,
  parseChatGptConversation,
  readChatGptExport,
} from '../src/migration/chatgpt-export.js'
import { readZipEntries } from '../src/migration/zip-extract.js'
import {
  CALIBRATION_SYSTEM_CHARS,
  addWindowToEstimate,
  emptyEstimate,
  estimateExtractionCost,
  estimateInputTokens,
  estimateOutputTokens,
} from '../src/migration/extraction-estimate.js'
import type { CompleteOptions, LlmProvider } from '../src/llm/provider.js'

// ───────────────────────────── Export fictif ─────────────────────────────

interface Msg {
  id: string
  parent: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  text?: string
  contentType?: string
  parts?: unknown[]
  content?: Record<string, unknown>
  time?: number | string
  recipient?: string
  hidden?: boolean
  metadata?: Record<string, unknown>
  channel?: string
  weight?: number
}

/** Conversation au format de l'export (mapping en arbre, racine sans message). */
function conversation(
  id: string,
  title: string,
  msgs: Msg[],
  opts: { current?: string | null; create?: number; update?: number; idField?: 'id' | 'conversation_id' | 'none' } = {},
): Record<string, unknown> {
  const mapping: Record<string, Record<string, unknown>> = {
    root: { id: 'root', parent: null, children: [], message: null },
  }
  for (const m of msgs) {
    mapping[m.id] = {
      id: m.id,
      parent: m.parent,
      children: [],
      message: {
        id: m.id,
        author: { role: m.role, name: null, metadata: {} },
        create_time: m.time ?? null,
        content: m.content ?? { content_type: m.contentType ?? 'text', parts: m.parts ?? [m.text ?? ''] },
        status: 'finished_successfully',
        end_turn: true,
        weight: m.weight ?? 1,
        metadata: m.metadata ?? (m.hidden ? { is_visually_hidden_from_conversation: true } : {}),
        recipient: m.recipient ?? 'all',
        channel: m.channel ?? null,
      },
    }
  }
  // Parent absent du mapping (orphelin) : rien à relier.
  for (const m of msgs) (mapping[m.parent]?.['children'] as string[] | undefined)?.push(m.id)
  const last = msgs.at(-1)?.id ?? 'root'
  const conv: Record<string, unknown> = {
    title,
    create_time: opts.create ?? 1_735_725_600.5, // 2025-01-01
    update_time: opts.update ?? 1_735_729_200.25,
    mapping,
    moderation_results: [],
    current_node: opts.current === undefined ? last : opts.current,
    plugin_ids: null,
    gizmo_id: null,
    is_archived: false,
    default_model_slug: 'modele-fictif',
  }
  if (opts.idField !== 'none') conv[opts.idField ?? 'id'] = id
  if (opts.idField === undefined) conv['conversation_id'] = id
  return conv
}

/** Conversation linéaire de `n` échanges sur un sujet fictif. */
function linear(id: string, title: string, topic: string, exchanges: number, opts: { chars?: number; start?: number } = {}): Record<string, unknown> {
  const msgs: Msg[] = []
  let parent = 'root'
  const pad = (s: string): string => (opts.chars && s.length < opts.chars ? s + ' détail'.repeat(Math.ceil((opts.chars - s.length) / 7)) : s)
  for (let i = 0; i < exchanges; i++) {
    const u = `${id}-u${i}`
    const a = `${id}-a${i}`
    msgs.push({ id: u, parent, role: 'user', text: pad(`Question ${i} sur ${topic} (IDEE-${topic}-${i})`), time: (opts.start ?? 1_735_725_600) + i * 60 })
    msgs.push({ id: a, parent: u, role: 'assistant', text: pad(`Réponse ${i} sur ${topic}`), time: (opts.start ?? 1_735_725_600) + i * 60 + 30 })
    parent = a
  }
  return conversation(id, title, msgs)
}

// ───────────────────────────── Zip de test ─────────────────────────────

interface ZipItem {
  name: string
  data?: Buffer | string
  method?: 0 | 8
  symlink?: boolean
  /** Taille décompressée annoncée (pour simuler une bombe). */
  declaredSize?: number
  dataDescriptor?: boolean
}

/** Petit écrivain ZIP : stored / deflate, ZIP64 forcé, descripteur de données, lien symbolique. */
function makeZip(items: ZipItem[], opts: { zip64?: boolean } = {}): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const it of items) {
    const raw = Buffer.isBuffer(it.data) ? it.data : Buffer.from(it.data ?? '', 'utf8')
    const method = it.method ?? 8
    const comp = method === 8 ? zlib.deflateRawSync(raw) : raw
    const crc = zlib.crc32(raw) >>> 0
    const size = it.declaredSize ?? raw.length
    const name = Buffer.from(it.name, 'utf8')
    const flags = 0x800 | (it.dataDescriptor ? 0x08 : 0)
    const z64 = opts.zip64 === true
    const localExtra = z64 ? Buffer.alloc(20) : Buffer.alloc(0)
    if (z64) {
      localExtra.writeUInt16LE(1, 0)
      localExtra.writeUInt16LE(16, 2)
      localExtra.writeBigUInt64LE(BigInt(it.dataDescriptor ? 0 : size), 4)
      localExtra.writeBigUInt64LE(BigInt(it.dataDescriptor ? 0 : comp.length), 12)
    }
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(z64 ? 45 : 20, 4)
    lh.writeUInt16LE(flags, 6)
    lh.writeUInt16LE(method, 8)
    lh.writeUInt16LE(0, 10)
    lh.writeUInt16LE(0x21, 12)
    lh.writeUInt32LE(it.dataDescriptor ? 0 : crc, 14)
    lh.writeUInt32LE(z64 ? 0xffffffff : it.dataDescriptor ? 0 : comp.length, 18)
    lh.writeUInt32LE(z64 ? 0xffffffff : it.dataDescriptor ? 0 : size, 22)
    lh.writeUInt16LE(name.length, 26)
    lh.writeUInt16LE(localExtra.length, 28)
    const parts = [lh, name, localExtra, comp]
    if (it.dataDescriptor) {
      const dd = Buffer.alloc(16)
      dd.writeUInt32LE(0x08074b50, 0)
      dd.writeUInt32LE(crc, 4)
      dd.writeUInt32LE(comp.length, 8)
      dd.writeUInt32LE(size, 12)
      parts.push(dd)
    }
    const local = Buffer.concat(parts)
    const cdExtra = z64 ? Buffer.alloc(28) : Buffer.alloc(0)
    if (z64) {
      cdExtra.writeUInt16LE(1, 0)
      cdExtra.writeUInt16LE(24, 2)
      cdExtra.writeBigUInt64LE(BigInt(size), 4)
      cdExtra.writeBigUInt64LE(BigInt(comp.length), 12)
      cdExtra.writeBigUInt64LE(BigInt(offset), 20)
    }
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE((3 << 8) | 45, 4)
    ch.writeUInt16LE(z64 ? 45 : 20, 6)
    ch.writeUInt16LE(flags, 8)
    ch.writeUInt16LE(method, 10)
    ch.writeUInt16LE(0, 12)
    ch.writeUInt16LE(0x21, 14)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(z64 ? 0xffffffff : comp.length, 20)
    ch.writeUInt32LE(z64 ? 0xffffffff : size, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt16LE(cdExtra.length, 30)
    ch.writeUInt16LE(0, 32)
    ch.writeUInt16LE(0, 34)
    ch.writeUInt16LE(0, 36)
    ch.writeUInt32LE(((it.symlink ? 0o120777 : 0o100644) << 16) >>> 0, 38)
    ch.writeUInt32LE(z64 ? 0xffffffff : offset, 42)
    centrals.push(Buffer.concat([ch, name, cdExtra]))
    locals.push(local)
    offset += local.length
  }
  const cd = Buffer.concat(centrals)
  const tailParts: Buffer[] = []
  if (opts.zip64) {
    const rec = Buffer.alloc(56)
    rec.writeUInt32LE(0x06064b50, 0)
    rec.writeBigUInt64LE(44n, 4)
    rec.writeUInt16LE(45, 12)
    rec.writeUInt16LE(45, 14)
    rec.writeBigUInt64LE(BigInt(items.length), 24)
    rec.writeBigUInt64LE(BigInt(items.length), 32)
    rec.writeBigUInt64LE(BigInt(cd.length), 40)
    rec.writeBigUInt64LE(BigInt(offset), 48)
    const loc = Buffer.alloc(20)
    loc.writeUInt32LE(0x07064b50, 0)
    loc.writeBigUInt64LE(BigInt(offset + cd.length), 8)
    loc.writeUInt32LE(1, 16)
    tailParts.push(rec, loc)
  }
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(opts.zip64 ? 0xffff : items.length, 8)
  eocd.writeUInt16LE(opts.zip64 ? 0xffff : items.length, 10)
  eocd.writeUInt32LE(opts.zip64 ? 0xffffffff : cd.length, 12)
  eocd.writeUInt32LE(opts.zip64 ? 0xffffffff : offset, 16)
  return Buffer.concat([...locals, cd, ...tailParts, eocd])
}

// ───────────────────────────── Faux LLM ─────────────────────────────

/** Un fait par fenêtre, tiré du mot IDEE-… de l'extrait ; garde le prompt système et les prompts. */
class FakeExtraction implements LlmProvider {
  calls = 0
  availability = 0
  systems: string[] = []
  prompts: string[] = []
  constructor(
    readonly name = 'fake',
    readonly model = 'fake',
  ) {}
  isAvailable(): Promise<boolean> {
    this.availability++
    return Promise.resolve(true)
  }
  complete(opts: CompleteOptions): Promise<string> {
    this.calls++
    this.systems.push(opts.system ?? '')
    this.prompts.push(opts.prompt)
    const ideas = [...opts.prompt.matchAll(/IDEE-([\w-]+)/g)].map(m => m[1]!)
    const facts = ideas.slice(0, 1).map(idea => ({
      fact: `Idée notée par l'utilisateur, référence ${idea.replaceAll('-', ' ')}, à reprendre plus tard`,
      category: 'idea',
      confidence: 0.9,
    }))
    return Promise.resolve(JSON.stringify({ facts }))
  }
}

let root: string
let m: Memoria | undefined

function newMemoria(extraction: LlmProvider | null): Memoria {
  m = Memoria.init({ storageRoot: join(root, 'storage'), configPath: join(root, 'config.toml'), llm: { extraction }, secretsVault: 'aes-vault' })
  return m
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memoria-chatgpt-'))
  m = undefined
})

afterEach(() => {
  m?.close()
  m = undefined
  rmSync(root, { recursive: true, force: true })
})

// ───────────────────────────── Parseur ─────────────────────────────

describe('parseur de conversation', () => {
  it('message modifié : seule la branche affichée (current_node) est gardée, dans l’ordre, avec ses dates', () => {
    const conv = conversation(
      'c-branches',
      'Projet fictif',
      [
        { id: 'u1', parent: 'root', role: 'user', text: 'Première version de ma question', time: 1_735_725_600 },
        { id: 'a1', parent: 'u1', role: 'assistant', text: 'Réponse à la première version', time: 1_735_725_660 },
        // L'utilisateur a modifié sa question : nouvelle branche depuis la racine.
        { id: 'u1b', parent: 'root', role: 'user', text: 'Question corrigée', time: 1_735_726_000 },
        { id: 'a1b', parent: 'u1b', role: 'assistant', text: 'Réponse à la question corrigée', time: 1_735_726_060 },
        { id: 'u2', parent: 'a1b', role: 'user', text: 'Suite', time: 1_735_726_100 },
        // Réponse régénérée : deux enfants de u2, la seconde est affichée.
        { id: 'a2-old', parent: 'u2', role: 'assistant', text: 'Ancienne réponse régénérée', time: 1_735_726_120 },
        { id: 'a2', parent: 'u2', role: 'assistant', text: 'Réponse retenue', time: 1_735_726_180 },
      ],
      { current: 'a2' },
    )
    const stats = emptyChatGptStats()
    const parsed = parseChatGptConversation(conv, stats)!
    expect(parsed.id).toBe('c-branches')
    expect(parsed.turns.map(t => t.text)).toEqual(['Question corrigée', 'Réponse à la question corrigée', 'Suite', 'Réponse retenue'])
    expect(parsed.turns.map(t => t.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(parsed.turns[0]!.ts).toBe('2025-01-01T10:06:40.000Z')
    expect(stats.nodes_off_branch).toBe(3)
  })

  it('écarte système, outils, appels d’outils, pensées, résumés de raisonnement, contexte caché, consigne système, commentary, analysis, poids nul : une raison par filtre', () => {
    const conv = conversation('c-bruit', 'Bruit', [
      { id: 's', parent: 'root', role: 'system', text: 'Tu es un assistant.' },
      { id: 'ctx', parent: 's', role: 'user', contentType: 'user_editable_context', content: { content_type: 'user_editable_context', user_profile: 'profil caché', user_instructions: 'consignes' }, hidden: true },
      { id: 'hid', parent: 'ctx', role: 'user', text: 'Contexte injecté invisible', hidden: true },
      { id: 'u', parent: 'hid', role: 'user', text: 'Ma vraie question' },
      { id: 'th', parent: 'u', role: 'assistant', content: { content_type: 'thoughts', thoughts: [{ summary: 'réflexion', content: 'pensée' }] } },
      { id: 'rr', parent: 'th', role: 'assistant', content: { content_type: 'reasoning_recap', content: 'Réfléchi pendant 5 s' } },
      { id: 'code', parent: 'rr', role: 'assistant', recipient: 'python', content: { content_type: 'code', language: 'python', text: 'print(1)' } },
      { id: 'out', parent: 'code', role: 'tool', content: { content_type: 'execution_output', text: '1' } },
      { id: 'web', parent: 'out', role: 'tool', content: { content_type: 'tether_quote', url: 'https://exemple.invalid', text: 'extrait' } },
      { id: 'com', parent: 'web', role: 'assistant', text: 'Je cherche…', channel: 'commentary' },
      { id: 'w0', parent: 'com', role: 'assistant', text: 'Message de poids nul', weight: 0 },
      // Texte ordinaire et visible : seul son drapeau le fait écarter.
      { id: 'us', parent: 'w0', role: 'user', text: 'Consigne système posée par l’utilisateur', metadata: { is_user_system_message: true } },
      { id: 'an', parent: 'us', role: 'assistant', text: 'Analyse interne du modèle', channel: 'analysis' },
      { id: 'a', parent: 'an', role: 'assistant', text: 'Ma vraie réponse' },
    ])
    const stats = emptyChatGptStats()
    const parsed = parseChatGptConversation(conv, stats)!
    expect(parsed.turns.map(t => t.text)).toEqual(['Ma vraie question', 'Ma vraie réponse'])
    expect(stats.messages_kept).toBe(2)
    expect(stats.dropped).toEqual({
      system: 1,
      tool: 2,
      hidden: 2,
      user_system: 1,
      weight0: 1,
      tool_call: 1,
      commentary: 1,
      analysis: 1,
      'type:thoughts': 1,
      'type:reasoning_recap': 1,
    })
  })

  it('multimodal : texte gardé, images ignorées, transcription vocale gardée ; message image seule écarté', () => {
    const conv = conversation('c-multi', 'Photos et voix', [
      {
        id: 'u1',
        parent: 'root',
        role: 'user',
        contentType: 'multimodal_text',
        parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://fictif', width: 10, height: 10 }, 'Que penses-tu de ce logo ?'],
      },
      { id: 'u2', parent: 'u1', role: 'user', contentType: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://autre' }] },
      {
        id: 'u3',
        parent: 'u2',
        role: 'user',
        contentType: 'multimodal_text',
        parts: [{ content_type: 'audio_transcription', text: 'Idée dictée à voix haute', direction: 'in' }, { content_type: 'audio_asset_pointer', asset_pointer: 'sediment://fictif' }],
      },
      { id: 'a', parent: 'u3', role: 'assistant', text: 'Réponse avec source 【3†source】 et citation \ue200cite\ue202turn0search1\ue201 fin.' },
    ])
    const stats = emptyChatGptStats()
    const parsed = parseChatGptConversation(conv, stats)!
    expect(parsed.turns.map(t => t.text)).toEqual(['Que penses-tu de ce logo ?', 'Idée dictée à voix haute', 'Réponse avec source  et citation  fin.'])
    expect(stats.dropped['empty']).toBe(1)
  })

  it('conversation vide (racine + système seul) : aucun tour ; current_node absent : la feuille la plus récente ; cycle sans boucle infinie', () => {
    const empty = parseChatGptConversation(conversation('c-vide', 'Vide', [{ id: 's', parent: 'root', role: 'system', text: 'consigne' }]))!
    expect(empty.turns).toEqual([])

    const noCurrent = conversation(
      'c-sans-courant',
      'Sans courant',
      [
        { id: 'u', parent: 'root', role: 'user', text: 'Q', time: 100 },
        { id: 'a-vieille', parent: 'u', role: 'assistant', text: 'Vieille', time: 200 },
        { id: 'a-recente', parent: 'u', role: 'assistant', text: 'Récente', time: 300 },
      ],
      { current: null },
    )
    expect(parseChatGptConversation(noCurrent)!.turns.map(t => t.text)).toEqual(['Q', 'Récente'])

    const cyclic = conversation('c-cycle', 'Cycle', [
      { id: 'x', parent: 'y', role: 'user', text: 'X' },
      { id: 'y', parent: 'x', role: 'assistant', text: 'Y' },
    ], { current: 'y' })
    expect(parseChatGptConversation(cyclic)!.turns.map(t => t.text)).toEqual(['X', 'Y'])
  })

  it('tolérant : champs absents ou d’un autre type ne cassent rien ; élément non objet compté illisible', () => {
    const stats = emptyChatGptStats()
    expect(parseChatGptConversation({ id: 'c-nu' }, stats)!.turns).toEqual([])
    expect(parseChatGptConversation({ id: 3, title: 5, mapping: 'x', current_node: 9 }, stats)!.title).toBe('Sans titre')
    expect(parseChatGptConversation(42, stats)).toBeNull()
    expect(stats.conversations_malformed).toBe(1)
    const noId = parseChatGptConversation(conversation('ignore', 'Sans identifiant', [{ id: 'u', parent: 'root', role: 'user', text: 'Bonjour' }], { idField: 'none' }))!
    expect(noId.id).toMatch(/^sans-id-[0-9a-f]{24}$/)
  })

  it('current_node absent : une feuille orpheline plus récente ne remplace pas la vraie branche ; sans feuille reliée, l’orpheline en dernier recours', () => {
    const msgs: Msg[] = [
      { id: 'u1', parent: 'root', role: 'user', text: 'Question principale', time: 1_735_725_600 },
      { id: 'a1', parent: 'u1', role: 'assistant', text: 'Réponse principale', time: 1_735_725_630 },
      { id: 'u2', parent: 'a1', role: 'user', text: 'Deuxième question', time: 1_735_725_660 },
      { id: 'a2', parent: 'u2', role: 'assistant', text: 'Deuxième réponse', time: 1_735_725_690 },
      // Parent introuvable : nœud orphelin, le plus récent de tous.
      { id: 'orph', parent: 'disparu', role: 'assistant', text: 'Orphelin récent', time: 1_900_000_000 },
    ]
    const parsed = parseChatGptConversation(conversation('c-orph', 'Orphelin', msgs, { current: null }))!
    expect(parsed.turns.map(t => t.text)).toEqual(['Question principale', 'Réponse principale', 'Deuxième question', 'Deuxième réponse'])

    // Plus aucune feuille reliée à une racine (racine disparue) : la plus récente quand même.
    const broken = conversation('c-casse', 'Cassé', msgs, { current: null }) as { mapping: Record<string, unknown> }
    delete broken.mapping['root']
    expect(parseChatGptConversation(broken)!.turns.map(t => t.text)).toEqual(['Orphelin récent'])
  })

  it('current_node sur la racine (sans message) : la branche de la feuille de secours, pas une conversation vide', () => {
    const conv = conversation(
      'c-racine',
      'Racine',
      [
        { id: 'u', parent: 'root', role: 'user', text: 'Bonjour', time: 1_735_725_600 },
        { id: 'a', parent: 'u', role: 'assistant', text: 'Salut', time: 1_735_725_630 },
      ],
      { current: 'root' },
    )
    const stats = emptyChatGptStats()
    expect(parseChatGptConversation(conv, stats)!.turns.map(t => t.text)).toEqual(['Bonjour', 'Salut'])
    expect(stats.messages_on_branch).toBe(2)
  })

  it('marqueurs privés : filecite retiré comme cite, entity garde son libellé sans délimiteurs, marqueur inconnu laissé', () => {
    const text =
      'Voir \ue200filecite\ue202turn0file0\ue202L1-L4\ue201 et \ue200entity\ue202["city","Lisbonne","capitale fictive"]\ue201 fin' +
      ' ; puis \ue200entity\ue202pas du json\ue201 et \ue200cite\ue202turn0search2\ue202turn0news1\ue201.'
    const conv = conversation('c-marq', 'Marqueurs', [
      { id: 'u', parent: 'root', role: 'user', text: 'Question' },
      { id: 'a', parent: 'u', role: 'assistant', text },
      { id: 'u2', parent: 'a', role: 'user', text: 'Garde \ue200navlist\ue202Titre\ue201 tel quel' },
    ])
    const turns = parseChatGptConversation(conv)!.turns.map(t => t.text)
    expect(turns[1]).toBe('Voir  et Lisbonne fin ; puis pas du json et .')
    expect(turns[1]).not.toMatch(/[\ue200-\ue202]/)
    expect(turns[2]).toBe('Garde \ue200navlist\ue202Titre\ue201 tel quel')
  })

  it('dates : microsecondes ramenées en ms ; au-delà de l’an 2100 rejetées (jamais « an 56972 »), le tour prend la date de la conversation', () => {
    const conv = conversation(
      'c-dates',
      'Dates',
      [
        { id: 'u', parent: 'root', role: 'user', text: 'En microsecondes', time: 1_735_725_690_000_000 },
        { id: 'a', parent: 'u', role: 'assistant', text: 'En l’an 3000', time: '3000-01-01T00:00:00Z' },
        { id: 'u2', parent: 'a', role: 'user', text: 'En ms, an 2200', time: Date.UTC(2200, 0, 1) },
        { id: 'a2', parent: 'u2', role: 'assistant', text: 'En ms', time: 1_735_725_720_000 },
      ],
      { create: 1_735_725_600_500_000 },
    )
    const parsed = parseChatGptConversation(conv)!
    expect(parsed.createTime).toBe('2025-01-01T10:00:00.500Z')
    expect(parsed.turns.map(t => t.ts)).toEqual([
      '2025-01-01T10:01:30.000Z',
      '2025-01-01T10:00:00.500Z',
      '2025-01-01T10:00:00.500Z',
      '2025-01-01T10:02:00.000Z',
    ])
  })
})

// ───────────────────────────── Lecture en flux ─────────────────────────────

describe('JsonArraySplitter', () => {
  it('morceaux de 7 octets : emoji coupé, guillemets échappés, crochets dans les chaînes', () => {
    const items = [
      { id: 'a', t: 'Idée 🚀 avec "guillemets" et \\ barre', n: [1, [2, { x: ']' }]] },
      { id: 'b', t: 'accolade } et crochet ] dans une chaîne', e: {} },
      { id: 'c', t: '日本語 et émojis 👨‍👩‍👧' },
      // Un seul guillemet échappé suivi de structure : sans gestion de « \\ », l'élément serait coupé ici.
      { id: 'd', t: 'un " seul } puis ] et {' },
    ]
    const bytes = Buffer.from(`\ufeff [\n${items.map(i => JSON.stringify(i)).join(' ,\n')}\n]\n`, 'utf8')
    const splitter = new JsonArraySplitter()
    const out: unknown[] = []
    for (let i = 0; i < bytes.length; i += 7) {
      for (const el of splitter.push(bytes.subarray(i, i + 7))) out.push(JSON.parse(el.toString('utf8')))
    }
    expect(out).toEqual(items)
    expect(splitter.end()).toEqual({ started: true, closed: true, truncated: false })
  })

  it('éléments scalaires sautés et comptés ; fichier tronqué signalé ; pas un tableau → erreur', () => {
    const splitter = new JsonArraySplitter()
    const got = splitter.push(Buffer.from('[{"a":1}, "texte, avec virgule", 12, null, {"b":2}, {"c":'))
    expect(got.map(b => b.toString())).toEqual(['{"a":1}', '{"b":2}'])
    expect(splitter.junk).toBe(3)
    expect(splitter.end().truncated).toBe(true)

    expect(() => new JsonArraySplitter().push(Buffer.from('{"conversations": []}'))).toThrow(NotAnArrayError)
  })
})

// ───────────────────────────── Lecture d'un export ─────────────────────────────

describe('readChatGptExport', () => {
  it('export découpé en plusieurs fichiers (dossier) : tout est lu, la version la plus récente d’un doublon gagne', async () => {
    const dir = join(root, 'export')
    mkdirSync(dir)
    // Version ancienne : un message système et une réponse régénérée, qui ne doivent rien compter.
    const old = conversation(
      'c-dup',
      'Doublon',
      [
        { id: 's', parent: 'root', role: 'system', text: 'consigne' },
        { id: 'u', parent: 's', role: 'user', text: 'Question ancien' },
        { id: 'a-old', parent: 'u', role: 'assistant', text: 'Réponse régénérée' },
        { id: 'a', parent: 'u', role: 'assistant', text: 'Réponse ancien' },
      ],
      { current: 'a' },
    )
    const fresh = { ...linear('c-dup', 'Doublon', 'recent', 2), update_time: 1_800_000_000 }
    writeJson(join(dir, 'conversations-000.json'), [linear('c-1', 'Un', 'velo', 1), old])
    writeJson(join(dir, 'conversations-001.json'), [fresh, linear('c-2', 'Deux', 'jardin', 1)])
    writeFileSync(join(dir, 'chat.html'), '<html></html>')
    writeJson(join(dir, 'user.json'), { id: 'user-fictif' })

    const read = await readChatGptExport(dir, { chunkSize: 64 })
    expect(read.errors).toEqual([])
    expect(read.stats.files).toBe(2)
    expect(read.stats.conversations_seen).toBe(4)
    expect(read.stats.conversations_duplicate).toBe(1)
    expect(read.conversations.map(c => c.id).sort()).toEqual(['c-1', 'c-2', 'c-dup'])
    expect(read.conversations.find(c => c.id === 'c-dup')!.turns.some(t => t.text.includes('recent'))).toBe(true)
    // c-1 (2) + c-dup retenue (4) + c-2 (2) : la version écartée ne gonfle rien.
    expect(read.stats.messages_kept).toBe(8)
    expect(read.stats.messages_on_branch).toBe(8)
    expect(read.stats.nodes_off_branch).toBe(0)
    expect(read.stats.dropped).toEqual({})
  })

  it('JSON malformé : la conversation illisible est sautée, les autres gardées ; fichier tronqué et fichier non tableau signalés', async () => {
    const dir = join(root, 'abime')
    mkdirSync(dir)
    const good1 = JSON.stringify(linear('c-ok1', 'Bonne 1', 'peche', 1))
    const good2 = JSON.stringify(linear('c-ok2', 'Bonne 2', 'cuisine', 1))
    writeFileSync(join(dir, 'conversations-000.json'), `[${good1}, {"id": "c-casse", "title": pas-du-json}, ${good2}]`)
    writeFileSync(join(dir, 'conversations-001.json'), `[${JSON.stringify(linear('c-ok3', 'Bonne 3', 'musique', 1))}, ${good1.slice(0, 40)}`)
    writeFileSync(join(dir, 'conversations-002.json'), '{"pas": "un tableau"}')

    const read = await readChatGptExport(dir)
    expect(read.conversations.map(c => c.id).sort()).toEqual(['c-ok1', 'c-ok2', 'c-ok3'])
    expect(read.stats.conversations_malformed).toBe(2) // l'objet cassé + la fin tronquée
    expect(read.errors.some(e => e.includes('conversations-001.json') && e.includes('tronqué'))).toBe(true)
    expect(read.errors.some(e => e.includes('conversations-002.json') && e.includes('tableau'))).toBe(true)
  })

  it('conversation vide comptée, jamais transformée en unité ; fichier conversations.json direct', async () => {
    const file = join(root, 'conversations.json')
    writeJson(file, [conversation('c-vide', 'Vide', []), linear('c-plein', 'Plein', 'velo', 1)])
    const read = await readChatGptExport(file)
    expect(read.stats.conversations_empty).toBe(1)
    expect(chatGptUnits(read.conversations).map(u => u.key)).toEqual(['chatgpt:c-plein'])
  })

  it('zip : seules les conversations sont extraites (stored + deflate, sous-dossier), dossier temporaire supprimé', async () => {
    const tmpRoot = join(root, 'tmp')
    mkdirSync(tmpRoot)
    const zip = join(root, 'export.zip')
    writeFileSync(
      zip,
      makeZip([
        { name: 'Export-fictif/', data: '', method: 0 },
        { name: 'Export-fictif/conversations-000.json', data: JSON.stringify([linear('c-z1', 'Zip 1', 'velo', 1)]), method: 0 },
        { name: 'Export-fictif/conversations-001.json', data: JSON.stringify([linear('c-z2', 'Zip 2', 'jardin', 1)]), method: 8 },
        { name: 'Export-fictif/file-fictif-image.png', data: Buffer.alloc(64, 7), method: 0 },
        { name: 'Export-fictif/chat.html', data: '<html></html>' },
      ]),
    )
    const read = await readChatGptExport(zip, { tmpRoot })
    expect(read.errors).toEqual([])
    expect(read.conversations.map(c => c.id).sort()).toEqual(['c-z1', 'c-z2'])
    expect(readdirSync(tmpRoot)).toEqual([])
  })

  it('zip ZIP64 et descripteurs de données : lus par le répertoire central', async () => {
    const zip = join(root, 'export64.zip')
    const payload = JSON.stringify([linear('c-64', 'Zip64', 'velo', 2)])
    writeFileSync(zip, makeZip([{ name: 'conversations.json', data: payload, dataDescriptor: true }], { zip64: true }))
    const entries = await readZipEntries(zip)
    expect(entries[0]).toMatchObject({ name: 'conversations.json', uncompressedSize: Buffer.byteLength(payload) })
    const read = await readChatGptExport(zip, { tmpRoot: root })
    expect(read.conversations.map(c => c.id)).toEqual(['c-64'])
  })

  it.each([
    ['zip-slip « .. »', { name: '../../evil/conversations.json', data: '[]' }, 'remonte'],
    ['zip-slip avec antislash', { name: 'a\\..\\..\\conversations.json', data: '[]' }, 'remonte'],
    ['chemin absolu', { name: '/tmp/conversations.json', data: '[]' }, 'chemin absolu'],
    ['lecteur Windows', { name: 'C:/conversations.json', data: '[]' }, 'lecteur'],
    ['lien symbolique', { name: 'conversations.json', data: '/etc/passwd', symlink: true }, 'lien symbolique'],
  ] as const)('zip refusé en entier : %s, rien n’est écrit, dossier temporaire supprimé', async (_label, bad, reason) => {
    const tmpRoot = join(root, 'tmp')
    mkdirSync(tmpRoot)
    const zip = join(root, 'piege.zip')
    writeFileSync(zip, makeZip([{ name: 'Export/conversations-000.json', data: JSON.stringify([linear('c-ok', 'Ok', 'velo', 1)]) }, bad]))
    await expect(readChatGptExport(zip, { tmpRoot })).rejects.toThrow(new RegExp(`archive refusée.*${reason}`))
    expect(readdirSync(tmpRoot)).toEqual([])
    expect(existsSync(join(root, 'evil'))).toBe(false)
  })

  it('bombe de décompression : une entrée plus grosse que sa taille annoncée est coupée', async () => {
    const tmpRoot = join(root, 'tmp')
    mkdirSync(tmpRoot)
    const zip = join(root, 'bombe.zip')
    writeFileSync(zip, makeZip([{ name: 'conversations.json', data: `[${'{"a":1},'.repeat(5000)}{"a":1}]`, declaredSize: 100 }]))
    await expect(readChatGptExport(zip, { tmpRoot })).rejects.toThrow(/plus grosse que sa taille annoncée/)
    expect(readdirSync(tmpRoot)).toEqual([])
  })

  it('reste d’un import interrompu (dossier temporaire ancien) : balayé ; dossier récent : laissé', async () => {
    const tmpRoot = join(root, 'tmp')
    const stale = join(tmpRoot, 'memoria-chatgpt-ancien')
    const fresh = join(tmpRoot, 'memoria-chatgpt-recent')
    mkdirSync(stale, { recursive: true })
    mkdirSync(fresh)
    writeFileSync(join(stale, 'conversations.json'), '[]')
    const old = new Date(Date.now() - 7 * 3600_000)
    utimesSync(stale, old, old)
    const zip = join(root, 'export.zip')
    writeFileSync(zip, makeZip([{ name: 'conversations.json', data: JSON.stringify([linear('c-1', 'Un', 'velo', 1)]) }]))
    await readChatGptExport(zip, { tmpRoot })
    expect(readdirSync(tmpRoot)).toEqual(['memoria-chatgpt-recent'])
  })

  it('chemin introuvable : message clair', async () => {
    await expect(readChatGptExport(join(root, 'absent.zip'))).rejects.toThrow(/export introuvable/)
  })
})

// ───────────────────────────── Estimation ─────────────────────────────

describe('estimation sans appel', () => {
  /** Tranches d'origine, mesurées sur système (transcripts, 906 caractères) + extrait. */
  const measured = (totalChars: number): number => (totalChars < 1500 ? 23 : totalChars < 3000 ? 136 : totalChars < 6000 ? 395 : 623)

  it('la tranche de sortie se lit sur l’extrait seul : le long prompt ChatGPT ne fait pas monter d’une tranche', () => {
    const system = CHATGPT_EXTRACTION_SYSTEM.length
    const e = emptyEstimate()
    addWindowToEstimate(e, system + 500, system)
    expect(e.output_tokens).toBe(23) // et non 136
    expect(e.input_tokens).toBe(estimateInputTokens(system + 500)) // l'entrée compte tout le prompt
    expect(e.prompt_chars).toBe(system + 500)
    expect(estimateOutputTokens(system + 1500, system)).toBe(136) // et non 395
  })

  it('prompt des transcripts (ou systemChars absent) : exactement les tranches mesurées', () => {
    for (const excerpt of [0, 100, 593, 594, 1500, 2093, 2094, 5093, 5094, 20_000]) {
      const total = CALIBRATION_SYSTEM_CHARS + excerpt
      expect(estimateOutputTokens(total, CALIBRATION_SYSTEM_CHARS)).toBe(measured(total))
      expect(estimateOutputTokens(total)).toBe(measured(total))
      const e = emptyEstimate()
      addWindowToEstimate(e, total)
      expect(e.output_tokens).toBe(measured(total))
    }
  })
})

// ───────────────────────────── Import ─────────────────────────────

async function unitsOf(path: string) {
  return chatGptUnits((await readChatGptExport(path)).conversations)
}

describe('import ChatGPT', () => {
  it('dry-run sans instance : compte et estime, AUCUN appel LLM (ni sonde), aucune instance ni écriture', async () => {
    const fake = new FakeExtraction('openai', 'gpt-4o-mini')
    const mem = newMemoria(fake)
    const file = join(root, 'conversations.json')
    writeJson(file, [linear('c-a', 'Idées vélo', 'velo', 3), linear('c-b', 'Idées jardin', 'jardin', 7)])
    const units = await unitsOf(file)

    const report = await mem.importChatGpt(null, units, { dryRun: true })
    expect(report.dry_run).toBe(true)
    expect(report.files_read).toBe(2)
    expect(report.turns).toBe(20)
    // 6 tours par fenêtre : 6 → 1 fenêtre ; 14 → 3 fenêtres.
    expect(report.windows).toBe(4)
    expect(report.estimate!.windows).toBe(4)
    expect(report.estimate!.input_tokens).toBeGreaterThan(CHATGPT_EXTRACTION_SYSTEM.length / 4)
    expect(fake.calls).toBe(0)
    expect(fake.availability).toBe(0)
    expect(mem.findChatGptInstance()).toBeNull()
    expect(mem.listAgents()).toHaveLength(0)

    const cost = estimateExtractionCost(report.estimate!, 'openai', 'gpt-4o-mini')
    expect(cost.usd).not.toBeNull()
    expect(cost.usd_max!).toBeGreaterThanOrEqual(cost.usd!)
    expect(estimateExtractionCost(report.estimate!, 'inconnu', 'modele-inconnu').usd).toBeNull()
  })

  it('import réel : instance chatgpt créée, faits dormants en revue, provenance par conversation, prompt dédié avec le titre', async () => {
    const fake = new FakeExtraction()
    const mem = newMemoria(fake)
    const file = join(root, 'conversations.json')
    writeJson(file, [linear('c-a', 'Idées vélo', 'velo', 3), linear('c-b', 'Idées jardin', 'jardin', 7)])
    const units = await unitsOf(file)

    const instance = mem.ensureChatGptInstance()
    expect(mem.listAgents().find(a => a.instance.id === instance)!.assistant_type).toBe('chatgpt')
    expect(mem.ensureChatGptInstance()).toBe(instance) // toujours la même

    const report = await mem.importChatGpt(instance, units)
    expect(report.errors).toEqual([])
    expect(report.windows).toBe(4)
    expect(fake.calls).toBe(4)
    expect(report.facts_quarantined).toBeGreaterThanOrEqual(2)
    expect(fake.systems.every(s => s === CHATGPT_EXTRACTION_SYSTEM)).toBe(true)
    expect(fake.prompts.some(p => p.startsWith('Conversation ChatGPT « Idées vélo » du 2025-01-01.'))).toBe(true)

    const store = new ContentStore(mem.paths.assistantDb(instance))
    try {
      const facts = store.db.prepare("SELECT lifecycle_state, category, source FROM facts").all() as Array<{ lifecycle_state: string; category: string; source: string }>
      expect(facts.length).toBe(report.facts_quarantined)
      expect(facts.every(f => f.lifecycle_state === 'dormant' && f.category === 'idea' && f.source === 'transcript-import')).toBe(true)
      const sources = store.db.prepare("SELECT source_path, metadata FROM memory_sources WHERE source_type = 'transcript' ORDER BY source_path").all() as Array<{ source_path: string; metadata: string }>
      expect(sources.map(s => s.source_path)).toEqual(['chatgpt:c-a', 'chatgpt:c-b'])
      expect(JSON.parse(sources[0]!.metadata)).toMatchObject({ format: 'chatgpt', title: 'Idées vélo', conversation_id: 'c-a', create_time: '2025-01-01T10:00:00.500Z' })
      const pending = store.db.prepare("SELECT COUNT(*) AS c FROM memory_import_items WHERE status = 'pending'").get() as { c: number }
      expect(pending.c).toBe(report.facts_quarantined)
    } finally {
      store.close()
    }
    expect(mem.listReview().length).toBe(report.facts_quarantined)
  })

  it('ré-import du même export : 0 appel, 0 nouveau ; dry-run ensuite : 0 fenêtre à extraire', async () => {
    const fake = new FakeExtraction()
    const mem = newMemoria(fake)
    const file = join(root, 'conversations.json')
    writeJson(file, [linear('c-a', 'Idées vélo', 'velo', 3), linear('c-b', 'Idées jardin', 'jardin', 7)])
    const instance = mem.ensureChatGptInstance()
    const first = await mem.importChatGpt(instance, await unitsOf(file))
    const calls = fake.calls

    const second = await mem.importChatGpt(instance, await unitsOf(file))
    expect(fake.calls).toBe(calls)
    expect(second.facts_quarantined).toBe(0)
    expect(second.files_skipped_already_imported).toBe(2)
    // Raccourci : même hash que l'état enregistré, rien n'est relu ni recompté.
    expect(second.notes.filter(n => n.startsWith('déjà importé (inchangé)'))).toHaveLength(2)
    expect(mem.listReview().length).toBe(first.facts_quarantined)

    const dry = await mem.importChatGpt(instance, await unitsOf(file), { dryRun: true })
    expect(dry.windows).toBe(0)
    expect(dry.estimate!.input_tokens).toBe(0)
  })

  it('conversation qui a grandi dans un nouvel export : seules ses nouvelles fenêtres partent ; titre renommé : rien ne repart', async () => {
    const fake = new FakeExtraction()
    const mem = newMemoria(fake)
    const instance = mem.ensureChatGptInstance()
    const file = join(root, 'conversations.json')
    writeJson(file, [linear('c-a', 'Idées vélo', 'velo', 6)]) // 12 tours → 2 fenêtres pleines
    await mem.importChatGpt(instance, await unitsOf(file))
    expect(fake.calls).toBe(2)

    writeJson(file, [linear('c-a', 'Idées vélo', 'velo', 9)]) // 18 tours → 3 fenêtres
    const grown = await mem.importChatGpt(instance, await unitsOf(file))
    expect(fake.calls).toBe(3)
    expect(grown.windows).toBe(1)
    expect(grown.windows_skipped_known).toBe(2)

    writeJson(file, [{ ...linear('c-a', 'Nouveau titre du vélo', 'velo', 9), update_time: 1_900_000_000 }])
    const renamed = await mem.importChatGpt(instance, await unitsOf(file))
    expect(fake.calls).toBe(3)
    expect(renamed.files_skipped_already_imported).toBe(1)
  })

  it('longue conversation : AUCUNE fenêtre perdue au-delà de 20 (pas de plafond par défaut)', async () => {
    const fake = new FakeExtraction()
    const mem = newMemoria(fake)
    const instance = mem.ensureChatGptInstance()
    const file = join(root, 'conversations.json')
    // 30 échanges de 2 100 caractères par tour → 60 fenêtres (une par tour).
    writeJson(file, [linear('c-long', 'Longue', 'velo', 30, { chars: 2100 })])
    const report = await mem.importChatGpt(instance, await unitsOf(file))
    expect(report.windows).toBe(60)
    expect(fake.calls).toBe(60)
    expect(report.notes.some(n => n.includes('ignorée'))).toBe(false)
  })

  it('plafond explicite : le surplus est REPORTÉ au passage suivant, jamais ignoré', async () => {
    const fake = new FakeExtraction()
    const mem = newMemoria(fake)
    const instance = mem.ensureChatGptInstance()
    const file = join(root, 'conversations.json')
    writeJson(file, [linear('c-long', 'Longue', 'velo', 10, { chars: 2100 })]) // 20 fenêtres
    const first = await mem.importChatGpt(instance, await unitsOf(file), { maxWindowsPerFile: 8 })
    expect(first.windows).toBe(8)
    expect(first.notes.some(n => n.includes('reportée'))).toBe(true)
    await mem.importChatGpt(instance, await unitsOf(file), { maxWindowsPerFile: 8 })
    await mem.importChatGpt(instance, await unitsOf(file), { maxWindowsPerFile: 8 })
    expect(fake.calls).toBe(20)
  })

  it('instance d’un autre type refusée ; import réel sans instance refusé', async () => {
    const mem = newMemoria(new FakeExtraction())
    const cc = mem.pairAssistant({ type: 'claude-code' }).assistant_instance_id
    await expect(mem.importChatGpt(cc, [])).rejects.toThrow(/pas chatgpt/)
    await expect(mem.importChatGpt(null, [])).rejects.toThrow(/instance cible manquante/)
  })
})
