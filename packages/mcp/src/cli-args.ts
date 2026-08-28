/**
 * Analyse des arguments de `memoria-mcp` — SANS stack brute. C'est la commande
 * que `memoria pair` demande de coller dans le chat d'un agent : une option
 * mal tapée doit donner un message d'usage (exit 2), pas
 * ERR_PARSE_ARGS_UNKNOWN_OPTION avec la pile Node. `--no-register` est
 * déclaré explicitement (pas d'`allowNegative`, absent des Node 20 anciens).
 */
import { parseArgs } from 'node:util'

export type ParsedCli =
  | { kind: 'connect'; code: string; register: boolean; storageRoot: string | undefined }
  | { kind: 'disconnect'; instanceId: string | undefined; storageRoot: string | undefined }
  | { kind: 'serve'; instanceId: string | undefined; storageRoot: string | undefined }
  | { kind: 'help' }
  | { kind: 'error'; message: string; exitCode: 2 }

const HELP_HINT = '`memoria-mcp --help` pour l’usage.'

function usageError(message: string): ParsedCli {
  return { kind: 'error', message: `memoria-mcp : ${message}\n${HELP_HINT}`, exitCode: 2 }
}

/** Nom d'option lisible depuis l'erreur de parseArgs (« Unknown option '--bogus' » → « --bogus »). */
function optionName(err: unknown): string {
  const m = /'(--?[^']+)'/.exec((err as Error)?.message ?? '')
  return m?.[1] ?? '?'
}

export function parseCliArgs(argv: readonly string[]): ParsedCli {
  const [command, ...rest] = argv
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') return { kind: 'help' }
  if (command !== 'connect' && command !== 'disconnect' && command !== 'serve') {
    return usageError(`commande inconnue « ${command} » (attendu : connect | disconnect | serve)`)
  }

  let values: Record<string, string | boolean | undefined>
  try {
    values = parseArgs({
      args: rest,
      options: {
        code: { type: 'string' },
        'no-register': { type: 'boolean' },
        instance: { type: 'string' },
        'storage-root': { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }).values
  } catch (err) {
    const code = (err as { code?: string }).code ?? ''
    if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') return usageError(`option inconnue « ${optionName(err)} » pour « ${command} »`)
    if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') return usageError(`valeur invalide : ${(err as Error).message}`)
    if (code === 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL') return usageError(`argument inattendu : ${(err as Error).message}`)
    return usageError((err as Error)?.message ?? String(err))
  }

  const storageRoot = values['storage-root'] as string | undefined
  switch (command) {
    case 'connect': {
      const code = values['code'] as string | undefined
      if (!code) return usageError('connect : --code XXXX-XXXX requis (affiché par l’UI Memoria ou « memoria pair »)')
      return { kind: 'connect', code, register: values['no-register'] !== true, storageRoot }
    }
    case 'disconnect':
      return { kind: 'disconnect', instanceId: values['instance'] as string | undefined, storageRoot }
    case 'serve': {
      const instanceId = values['instance'] as string | undefined
      if (!instanceId) return usageError('serve : --instance <id> requis (voir memoria-mcp connect)')
      return { kind: 'serve', instanceId, storageRoot }
    }
  }
}
