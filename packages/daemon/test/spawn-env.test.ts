/**
 * Environnement transmis aux process détachés : les marqueurs posés par launchd
 * ne doivent jamais fuir vers un daemon direct (voir spawn-env.ts et le test
 * de bout en bout dans lifecycle.test.ts).
 */
import { describe, expect, it } from 'vitest'
import { AUTOSTART_LABEL } from '@memoria/core'
import { stripLaunchdEnv } from '../src/spawn-env.js'

describe('stripLaunchdEnv', () => {
  it('retire XPC_SERVICE_NAME et XPC_FLAGS, garde le reste, sans toucher l’original', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', HOME: '/Users/x', XPC_SERVICE_NAME: AUTOSTART_LABEL, XPC_FLAGS: '0x0' }
    const out = stripLaunchdEnv(env)
    expect(out).toEqual({ PATH: '/usr/bin:/bin', HOME: '/Users/x' })
    expect(env['XPC_SERVICE_NAME']).toBe(AUTOSTART_LABEL) // copie, pas mutation
  })

  it('sans marqueur launchd → environnement équivalent', () => {
    expect(stripLaunchdEnv({ PATH: '/bin' })).toEqual({ PATH: '/bin' })
  })
})
