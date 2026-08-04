/**
 * Contrôle & config (Réglages) : kill-switch, déplacement du stockage,
 * suppression définitive d'agent, lancement auto.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  autostartStatus,
  buildPlist,
  reloadService,
  isEnabled,
  Memoria,
  moveStorage,
  servicePath,
  setEnabled,
} from '../src/index.js'

describe('kill-switch (config.enabled)', () => {
  let dir: string
  let configPath: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memoria-killswitch-'))
    configPath = join(dir, 'config.toml')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('actif par défaut (absent = true)', () => {
    expect(isEnabled(configPath)).toBe(true)
  })

  it('setEnabled(false) persiste et isEnabled le relit', () => {
    setEnabled(false, configPath)
    expect(isEnabled(configPath)).toBe(false)
    expect(readFileSync(configPath, 'utf8')).toContain('enabled')
    setEnabled(true, configPath)
    expect(isEnabled(configPath)).toBe(true)
  })

  it('l’engine expose isEnabled/setEnabled cohérents avec la config', () => {
    const root = join(dir, 'data')
    const m = Memoria.init({ storageRoot: root, configPath, llm: { extraction: null } })
    try {
      expect(m.isEnabled()).toBe(true)
      m.setEnabled(false)
      expect(m.isEnabled()).toBe(false)
      // persisté sur disque → relisible hors-process
      expect(isEnabled(configPath)).toBe(false)
    } finally {
      m.close()
    }
  })
})

describe('storageInfo + moveStorage', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memoria-move-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('storageInfo renvoie la racine courante', () => {
    const root = join(dir, 'data')
    const configPath = join(dir, 'config.toml')
    const m = Memoria.init({ storageRoot: root, configPath, llm: { extraction: null } })
    try {
      const info = m.storageInfo()
      expect(info.root).toBe(root)
      expect(info.config_path).toBe(configPath)
      expect(typeof info.on_network_volume).toBe('boolean')
    } finally {
      m.close()
    }
  })

  it('déplace les fichiers et réécrit config.toml', () => {
    const from = join(dir, 'data')
    const to = join(dir, 'usb', 'memoria')
    const configPath = join(dir, 'config.toml')
    // poser un fait puis fermer (DB non ouverte pendant le move)
    const m = Memoria.init({ storageRoot: from, configPath, llm: { extraction: null } })
    const a = m.pairAssistant({ type: 'claude-code' })
    m.storeFact({ instance: a.assistant_instance_id, content: 'Néto utilise une clé USB pour la mémoire portable' })
    m.close()

    const res = moveStorage({ from, to, configPath })
    expect(res.to).toBe(to)
    expect(existsSync(from)).toBe(false)
    expect(existsSync(join(to, 'registry.sqlite'))).toBe(true)
    // config pointe désormais sur la destination
    expect(readFileSync(configPath, 'utf8')).toContain(to)

    // ré-ouverture au nouvel emplacement → le fait survit
    const m2 = Memoria.init({ configPath, llm: { extraction: null } })
    try {
      expect(m2.paths.root).toBe(to)
      const agents = m2.listAgents()
      expect(agents.length).toBeGreaterThan(0)
    } finally {
      m2.close()
    }
  })

  it('refuse une destination déjà occupée', () => {
    const from = join(dir, 'data')
    const to = join(dir, 'occupe')
    const configPath = join(dir, 'config.toml')
    Memoria.init({ storageRoot: from, configPath, llm: { extraction: null } }).close()
    // destination NON vide
    writeFileSync(join(dir, 'placeholder.txt'), 'x') // garde-fou : le parent existe déjà (mkdtemp)
    Memoria.init({ storageRoot: to, configPath: join(dir, 'other.toml'), llm: { extraction: null } }).close()
    expect(() => moveStorage({ from, to, configPath })).toThrow(/déjà occupée/)
  })
})

describe('deleteInstance (suppression définitive)', () => {
  let dir: string
  let m: Memoria
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memoria-delagent-'))
    m = Memoria.init({ storageRoot: join(dir, 'data'), configPath: join(dir, 'config.toml'), llm: { extraction: null } })
  })
  afterEach(() => {
    m.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('efface l’agent, sa DB privée et le retire de la liste', () => {
    const a = m.pairAssistant({ type: 'codex' })
    m.storeFact({ instance: a.assistant_instance_id, content: 'fait privé à effacer' })
    const dbPath = m.paths.assistantDb(a.assistant_instance_id)
    expect(existsSync(dbPath)).toBe(true)
    expect(m.listAgents().some(x => x.instance.id === a.assistant_instance_id)).toBe(true)

    const res = m.deleteInstance(a.assistant_instance_id)
    expect(res.deleted).toBe(true)
    expect(existsSync(dbPath)).toBe(false)
    expect(m.listAgents().some(x => x.instance.id === a.assistant_instance_id)).toBe(false)
  })

  it('renvoie deleted:false pour une instance inconnue', () => {
    expect(m.deleteInstance('inconnu').deleted).toBe(false)
  })
})

describe('autostartStatus', () => {
  it('renvoie un plistPath et un drapeau supported', () => {
    const s = autostartStatus()
    expect(typeof s.supported).toBe('boolean')
    expect(s.plistPath).toContain('fr.primo-studio.memoria.plist')
    // sur cette machine (darwin) c'est pris en charge, mais on n'installe rien ici
    expect(typeof s.installed).toBe('boolean')
  })
})

/**
 * Régression vécue : `memoria autostart on` a affiché « ✓ Lancement auto
 * installé » alors que le service n'était PAS chargé — daemon à terre, sorti
 * seulement par un `launchctl bootstrap` manuel.
 *
 * Deux pièges combinés : launchd ne libère pas le nom du service instantanément
 * après un `bootout` (le `bootstrap` immédiat échoue), et le repli
 * `launchctl load -w` est un shim déprécié qui rend 0 SANS RIEN FAIRE — donc
 * aucune exception, donc un faux succès.
 */
describe('reloadService (régression « ✓ affiché, service absent »)', () => {
  /** Faux launchctl : `loaded` est l'état, les compteurs disent qui a été appelé. */
  function fakeOps(init: {
    loaded: boolean
    /** Nb d'appels bootstrap avant que le service se charge réellement. */
    bootstrapWorksOnAttempt?: number
    /** bootstrap lève-t-il ? (macOS ancien) */
    bootstrapThrows?: boolean
    /** load -w charge-t-il vraiment, ou rend-il 0 sans rien faire ? */
    legacyWorks?: boolean
    /** Nb de sondages avant que le bootout soit effectif. */
    unloadAfterPolls?: number
  }) {
    const calls = { bootout: 0, bootstrap: 0, legacy: 0, sleep: 0 }
    let loaded = init.loaded
    let unloadPending = 0
    const ops = {
      isLoaded: () => {
        if (unloadPending > 0) {
          unloadPending--
          return true // pas encore libéré par launchd
        }
        return loaded
      },
      bootout: () => {
        calls.bootout++
        unloadPending = init.unloadAfterPolls ?? 0
        loaded = false
      },
      bootstrap: () => {
        calls.bootstrap++
        if (init.bootstrapThrows) throw new Error('Bootstrap failed: 5: Input/output error')
        if (calls.bootstrap >= (init.bootstrapWorksOnAttempt ?? 1)) loaded = true
      },
      loadLegacy: () => {
        calls.legacy++
        // Défaut : le shim rend 0 sans charger — le piège exact rencontré.
        if (init.legacyWorks) loaded = true
      },
      sleep: () => {
        calls.sleep++
      },
    }
    return { ops, calls, isLoaded: () => loaded }
  }

  it('cas nominal : bootout puis bootstrap, service chargé', () => {
    const f = fakeOps({ loaded: true })
    expect(() => reloadService(f.ops)).not.toThrow()
    expect(f.calls.bootout).toBe(1)
    expect(f.calls.bootstrap).toBe(1)
    expect(f.isLoaded()).toBe(true)
  })

  it('service pas encore chargé → pas de bootout inutile', () => {
    const f = fakeOps({ loaded: false })
    reloadService(f.ops)
    expect(f.calls.bootout).toBe(0)
    expect(f.isLoaded()).toBe(true)
  })

  it('attend la libération du nom avant de rebootstraper', () => {
    // launchd met 3 sondages à libérer : sans attente, le bootstrap partirait trop tôt.
    const f = fakeOps({ loaded: true, unloadAfterPolls: 3 })
    reloadService(f.ops)
    expect(f.calls.sleep).toBeGreaterThan(0)
    expect(f.isLoaded()).toBe(true)
  })

  it('bootstrap qui échoue au 1er essai → retenté, et ça passe', () => {
    const f = fakeOps({ loaded: false, bootstrapWorksOnAttempt: 2 })
    expect(() => reloadService(f.ops)).not.toThrow()
    expect(f.calls.bootstrap).toBe(2)
  })

  it('LE piège : bootstrap lève, load -w rend 0 sans charger → THROW au lieu d’un faux succès', () => {
    const f = fakeOps({ loaded: false, bootstrapThrows: true, legacyWorks: false })
    expect(() => reloadService(f.ops)).toThrow(/n’est pas chargé après/)
    expect(f.calls.legacy).toBeGreaterThan(0)
    expect(f.isLoaded()).toBe(false)
  })

  it('le message d’échec donne la commande de secours', () => {
    const f = fakeOps({ loaded: false, bootstrapThrows: true })
    expect(() => reloadService(f.ops)).toThrow(/launchctl bootstrap/)
  })

  it('macOS ancien : bootstrap lève mais load -w charge vraiment → succès', () => {
    const f = fakeOps({ loaded: false, bootstrapThrows: true, legacyWorks: true })
    expect(() => reloadService(f.ops)).not.toThrow()
    expect(f.isLoaded()).toBe(true)
  })
})

describe('PATH du service (régression « spawn npm ENOENT »)', () => {
  it('servicePath place le dossier du node courant en tête, sans doublon', () => {
    const p = servicePath('/opt/node/v24/bin/node').split(':')
    expect(p[0]).toBe('/opt/node/v24/bin')
    expect(p).toContain('/opt/homebrew/bin')
    expect(p).toContain('/usr/local/bin')
    expect(p).toContain('/usr/bin')
    expect(new Set(p).size).toBe(p.length)
  })

  it('n’ajoute pas deux fois un dossier déjà dans le PATH par défaut', () => {
    const p = servicePath('/usr/bin/node').split(':')
    expect(p.filter(d => d === '/usr/bin')).toHaveLength(1)
  })

  it('le plist déclare un PATH — sans lui launchd n’en donne aucun où npm existe', () => {
    const plist = buildPlist({
      label: 'test.memoria',
      programArguments: ['/opt/node/v24/bin/node', '/x/bin.js'],
      path: servicePath('/opt/node/v24/bin/node'),
    })
    expect(plist).toContain('<key>EnvironmentVariables</key>')
    expect(plist).toContain('<key>PATH</key>')
    expect(plist).toContain('/opt/node/v24/bin:')
  })

  it('échappe le XML du PATH (un & dans un chemin casserait le plist)', () => {
    const plist = buildPlist({
      label: 'test.memoria',
      programArguments: ['/x/node'],
      path: '/Users/a&b/bin',
    })
    expect(plist).toContain('/Users/a&amp;b/bin')
  })
})
