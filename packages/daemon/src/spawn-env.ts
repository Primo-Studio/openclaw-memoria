/**
 * Environnement des process DÉTACHÉS lancés par le daemon ou la CLI.
 *
 * launchd pose `XPC_SERVICE_NAME` (et `XPC_FLAGS`) sur le process qu'il lance :
 * c'est le marqueur « je SUIS le service » lu par server.ts (`isSupervised`).
 * Or `spawn` hérite de l'environnement par défaut, et la chaîne réelle est :
 * daemon launchd → `sh` détaché (passation) → `memoria autostart off` → ensureDaemon
 * → daemon DIRECT. Ce dernier héritait du marqueur et se croyait supervisé :
 * `memoria autostart on` répondait « déjà actif » sans rien installer, `memoria
 * stop` annonçait à tort le service launchd, et bin.ts attendait un verrou au
 * lieu d'échouer proprement. Même chemin pour le redémarrage après mise à jour.
 *
 * Le seul process légitimement supervisé est celui que launchd lance lui-même :
 * tout ce que NOUS spawnons part sans ces variables.
 */

/** Variables posées par launchd sur ses agents — jamais à transmettre. */
const LAUNCHD_ENV_KEYS = ['XPC_SERVICE_NAME', 'XPC_FLAGS'] as const

/** Copie de `env` sans les marqueurs launchd (l'original n'est pas modifié). */
export function stripLaunchdEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env }
  for (const key of LAUNCHD_ENV_KEYS) delete out[key]
  return out
}
