/**
 * Lecture du `--storage-root` d'un plist launchd : c'est la garde qui évite
 * de kickstarter le service de l'utilisateur quand un autre stockage (tests,
 * second profil) demande un daemon.
 */
import { describe, expect, it } from 'vitest'
import { buildPlist, storageRootFromPlist } from '../src/control/autostart.js'

describe('storageRootFromPlist', () => {
  it('aller-retour avec buildPlist (chemin avec espace)', () => {
    const xml = buildPlist({
      label: 'fr.primo-studio.memoria',
      programArguments: ['/usr/local/bin/node', '/x/bin.js', '--storage-root', '/Users/a b/.memoria/data'],
      logDir: '/tmp',
    })
    expect(storageRootFromPlist(xml)).toBe('/Users/a b/.memoria/data')
  })

  it('désechappe le XML (& < >)', () => {
    const xml = buildPlist({
      label: 'fr.primo-studio.memoria',
      programArguments: ['/usr/local/bin/node', '/x/bin.js', '--storage-root', '/Users/r&d/<data>'],
      logDir: '/tmp',
    })
    expect(xml).toContain('r&amp;d')
    expect(storageRootFromPlist(xml)).toBe('/Users/r&d/<data>')
  })

  it('plist sans --storage-root → null (jamais un chemin inventé)', () => {
    expect(storageRootFromPlist('<plist version="1.0"><dict/></plist>')).toBeNull()
    expect(storageRootFromPlist('<string>--storage-root</string>')).toBeNull()
  })
})
