/**
 * Adresse du hub sur le réseau local du bureau.
 *
 * Écoute par défaut : `lan:47600`. Le mot `lan` est résolu À CHAQUE démarrage
 * en l'adresse IPv4 privée de l'interface du réseau local (Wi-Fi ou Ethernet).
 * C'est plus sûr que `0.0.0.0` (toutes les interfaces, VPN compris) et plus
 * solide qu'une IP écrite en dur, que le DHCP finit par changer.
 *
 * Invitation : jamais `0.0.0.0` (inutilisable depuis un autre Mac). On donne
 * l'IP du réseau local, et le nom `.local` en second choix (il suit l'IP).
 */
import { hostname, networkInterfaces, type NetworkInterfaceInfo } from 'node:os'

export const LAN_AUTO_HOST = 'lan'
export const DEFAULT_SYNC_PORT = 47600
export const DEFAULT_LISTEN_LAN = `${LAN_AUTO_HOST}:${DEFAULT_SYNC_PORT}`

/** Interfaces à ne jamais prendre pour « le réseau du bureau » (VPN, tunnels, ponts, AirDrop). */
const SKIP_IFACE = /^(lo|utun|ipsec|ppp|tun|tap|gif|stf|awdl|llw|bridge|vmnet|vboxnet|docker|anpi)/i

/** IPv4 privée (RFC 1918) : le seul genre d'adresse sur lequel le hub accepte d'écouter en automatique. */
export function isPrivateIPv4(ip: string): boolean {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b] = p as [number, number, number, number]
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

type Ifaces = NodeJS.Dict<NetworkInterfaceInfo[]>

/** IPv4 privée de l'interface du réseau local (en0, puis en1…, puis la première autre), ou null. */
export function lanIPv4(ifaces: Ifaces = networkInterfaces()): string | null {
  const names = Object.keys(ifaces)
    .filter(n => !SKIP_IFACE.test(n))
    .sort((x, y) => rank(x) - rank(y) || x.localeCompare(y))
  for (const name of names) {
    for (const a of ifaces[name] ?? []) {
      if (a.family === 'IPv4' && !a.internal && isPrivateIPv4(a.address)) return a.address
    }
  }
  return null
}

function rank(name: string): number {
  const m = /^en(\d+)$/.exec(name)
  return m ? Number(m[1]) : 100
}

/** Nom Bonjour de ce Mac (`<nom>.local`), qui reste juste quand l'IP change. */
export function localHostName(host: string = hostname()): string | null {
  const h = host.trim()
  if (!h) return null
  return h.endsWith('.local') ? h : `${h.split('.')[0]}.local`
}

/** « hôte:port » → [hôte, port] (hôte vide → mot automatique `lan`). */
export function splitHostPort(addr: string): [string, number] {
  const i = addr.lastIndexOf(':')
  if (i < 0) return [LAN_AUTO_HOST, Number.parseInt(addr, 10) || DEFAULT_SYNC_PORT]
  const host = addr.slice(0, i).replace(/^\[|\]$/g, '') || LAN_AUTO_HOST
  const port = Number.parseInt(addr.slice(i + 1), 10) || DEFAULT_SYNC_PORT
  return [host, port]
}

/**
 * Hôte d'écoute réel d'une adresse configurée : `lan` → IP du réseau local
 * (null si aucune pour l'instant : pas de Wi-Fi au démarrage, par exemple) ;
 * toute autre valeur est prise telle quelle.
 */
export function resolveListenHost(listen: string, ifaces?: Ifaces): { host: string | null; port: number } {
  const [host, port] = splitHostPort(listen)
  if (host === LAN_AUTO_HOST) return { host: lanIPv4(ifaces), port }
  return { host, port }
}

/** L'adresse d'écoute couvre-t-elle toutes les interfaces (0.0.0.0, ::) ? */
export function isWildcardHost(host: string): boolean {
  return host === '0.0.0.0' || host === '::' || host === ''
}

/**
 * Adresses à donner à un autre Mac pour joindre ce hub : l'IP du réseau local
 * d'abord, puis le nom `.local`. Jamais 0.0.0.0 ni le mot `lan`.
 */
export function hubAddressesFor(listen: string | null | undefined, ifaces?: Ifaces, host?: string): { primary: string | null; alternatives: string[] } {
  const [h, port] = splitHostPort(listen ?? DEFAULT_LISTEN_LAN)
  const local = localHostName(host)
  const alternatives = local ? [`${local}:${port}`] : []
  if (h === LAN_AUTO_HOST || isWildcardHost(h)) {
    const ip = lanIPv4(ifaces)
    return { primary: ip ? `${ip}:${port}` : (alternatives[0] ?? null), alternatives: ip ? alternatives : [] }
  }
  return { primary: `${h.includes(':') ? `[${h}]` : h}:${port}`, alternatives: h === '127.0.0.1' ? [] : alternatives }
}
