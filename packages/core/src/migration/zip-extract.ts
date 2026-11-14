/**
 * Lecture d'archives ZIP SANS dépendance, pour l'export ChatGPT (reçu par mail
 * sous forme de .zip, parfois plusieurs Go à cause des images).
 *
 * Principes :
 *  - on lit le RÉPERTOIRE CENTRAL (fin du fichier), jamais les en-têtes locaux
 *    seuls : les tailles y sont justes même quand l'entrée utilise un
 *    descripteur de données ; ZIP64 pris en charge (archives > 4 Go) ;
 *  - accès aléatoire par descripteur de fichier : l'archive n'est jamais
 *    chargée en mémoire ;
 *  - on n'extrait QUE les entrées demandées (`select`), en flux
 *    (stored ou deflate), vers un nom PLAT choisi par nous dans le dossier
 *    cible : aucun nom venu de l'archive ne sert de chemin ;
 *  - ARCHIVE REFUSÉE en entier si une seule entrée est dangereuse : chemin
 *    absolu, lecteur Windows, segment « .. » (avec / ou \), caractère nul,
 *    lien symbolique. Une vraie archive d'export n'en contient jamais ;
 *  - entrée chiffrée ou méthode de compression inconnue : refus explicite ;
 *  - bombe de décompression : chaque entrée est coupée dès qu'elle dépasse la
 *    taille annoncée, et le total annoncé est plafonné ; CRC vérifié.
 */
import { createReadStream, createWriteStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { Readable, Transform, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import * as zlib from 'node:zlib'

export class ZipError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipError'
  }
}

export interface ZipEntry {
  name: string
  method: number
  flags: number
  crc32: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
  externalAttrs: number
  isDirectory: boolean
  isSymlink: boolean
  encrypted: boolean
}

export interface ExtractedEntry {
  /** Nom dans l'archive. */
  name: string
  /** Fichier écrit dans le dossier cible. */
  path: string
  size: number
}

/** Plafond par défaut du total décompressé extrait (somme des tailles annoncées). */
export const DEFAULT_MAX_EXTRACT_BYTES = 8 * 1024 ** 3

const SIG_EOCD = 0x06054b50
const SIG_ZIP64_LOCATOR = 0x07064b50
const SIG_ZIP64_EOCD = 0x06064b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50
/** Taille max du commentaire d'archive (u16) + EOCD. */
const EOCD_SEARCH = 0xffff + 22
/** Garde-fou : un répertoire central plus gros est suspect. */
const MAX_CENTRAL_DIR_BYTES = 512 * 1024 * 1024

async function readAt(fd: import('node:fs/promises').FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length)
  let done = 0
  while (done < length) {
    const { bytesRead } = await fd.read(buf, done, length - done, position + done)
    if (bytesRead === 0) throw new ZipError('archive tronquée (lecture au-delà de la fin)')
    done += bytesRead
  }
  return buf
}

function u64(buf: Buffer, offset: number): number {
  const v = buf.readBigUInt64LE(offset)
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError('archive ZIP64 hors limites')
  return Number(v)
}

/** Lit le répertoire central : liste des entrées, sans rien décompresser. */
export async function readZipEntries(zipPath: string): Promise<ZipEntry[]> {
  const size = (await stat(zipPath)).size
  if (size < 22) throw new ZipError('fichier trop petit pour être une archive ZIP')
  const fd = await open(zipPath, 'r')
  try {
    const tailLen = Math.min(size, EOCD_SEARCH)
    const tailStart = size - tailLen
    const tail = await readAt(fd, tailStart, tailLen)
    let eocd = -1
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD && i + 22 + tail.readUInt16LE(i + 20) <= tail.length) {
        eocd = i
        break
      }
    }
    if (eocd < 0) throw new ZipError('fin de répertoire central introuvable (pas une archive ZIP, ou archive tronquée)')
    let disk = tail.readUInt16LE(eocd + 4)
    let cdDisk = tail.readUInt16LE(eocd + 6)
    let total = tail.readUInt16LE(eocd + 10)
    let cdSize = tail.readUInt32LE(eocd + 12)
    let cdOffset = tail.readUInt32LE(eocd + 16)

    if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      // ZIP64 : le localisateur précède immédiatement l'EOCD classique.
      const locPos = tailStart + eocd - 20
      if (locPos < 0) throw new ZipError('archive ZIP64 incomplète (localisateur absent)')
      const loc = await readAt(fd, locPos, 20)
      if (loc.readUInt32LE(0) !== SIG_ZIP64_LOCATOR) throw new ZipError('archive ZIP64 incomplète (localisateur absent)')
      const recPos = u64(loc, 8)
      if (recPos + 56 > size) throw new ZipError('archive ZIP64 incohérente')
      const rec = await readAt(fd, recPos, 56)
      if (rec.readUInt32LE(0) !== SIG_ZIP64_EOCD) throw new ZipError('archive ZIP64 incohérente (fin de répertoire)')
      disk = rec.readUInt32LE(16)
      cdDisk = rec.readUInt32LE(20)
      total = u64(rec, 32)
      cdSize = u64(rec, 40)
      cdOffset = u64(rec, 48)
    }
    if (disk !== 0 || cdDisk !== 0) throw new ZipError('archive en plusieurs volumes : non prise en charge')
    if (cdOffset + cdSize > size) throw new ZipError('répertoire central hors du fichier (archive tronquée ?)')
    if (cdSize > MAX_CENTRAL_DIR_BYTES) throw new ZipError('répertoire central démesuré')

    const cd = await readAt(fd, cdOffset, cdSize)
    const entries: ZipEntry[] = []
    let p = 0
    for (let n = 0; n < total; n++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) {
        throw new ZipError(`répertoire central illisible (entrée ${n + 1}/${total})`)
      }
      const flags = cd.readUInt16LE(p + 8)
      const method = cd.readUInt16LE(p + 10)
      const crc = cd.readUInt32LE(p + 16)
      let compressedSize = cd.readUInt32LE(p + 20)
      let uncompressedSize = cd.readUInt32LE(p + 24)
      const nameLen = cd.readUInt16LE(p + 28)
      const extraLen = cd.readUInt16LE(p + 30)
      const commentLen = cd.readUInt16LE(p + 32)
      const externalAttrs = cd.readUInt32LE(p + 38)
      let localHeaderOffset = cd.readUInt32LE(p + 42)
      const end = p + 46 + nameLen + extraLen + commentLen
      if (end > cd.length) throw new ZipError(`répertoire central illisible (entrée ${n + 1}/${total})`)
      const rawName = cd.subarray(p + 46, p + 46 + nameLen)
      // Bit 11 : nom en UTF-8 ; sinon CP437, lu en latin1 (identique pour l'ASCII).
      const name = rawName.toString(flags & 0x800 ? 'utf8' : 'latin1')
      // Champ étendu ZIP64 (0x0001) : valeurs 64 bits pour les champs à 0xFFFFFFFF.
      let x = p + 46 + nameLen
      const extraEnd = x + extraLen
      while (x + 4 <= extraEnd) {
        const id = cd.readUInt16LE(x)
        const len = cd.readUInt16LE(x + 2)
        if (id === 0x0001) {
          let q = x + 4
          const qEnd = Math.min(q + len, extraEnd)
          if (uncompressedSize === 0xffffffff && q + 8 <= qEnd) {
            uncompressedSize = u64(cd, q)
            q += 8
          }
          if (compressedSize === 0xffffffff && q + 8 <= qEnd) {
            compressedSize = u64(cd, q)
            q += 8
          }
          if (localHeaderOffset === 0xffffffff && q + 8 <= qEnd) {
            localHeaderOffset = u64(cd, q)
          }
        }
        x += 4 + len
      }
      const mode = externalAttrs >>> 16
      entries.push({
        name,
        method,
        flags,
        crc32: crc,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
        externalAttrs,
        isDirectory: name.endsWith('/') || (mode & 0o170000) === 0o040000,
        isSymlink: (mode & 0o170000) === 0o120000,
        // Bit 0 : chiffrement ; bit 6 : chiffrement fort.
        encrypted: (flags & 0x41) !== 0,
      })
      p = end
    }
    return entries
  } finally {
    await fd.close()
  }
}

/** Raison pour laquelle une entrée est dangereuse, ou null si elle est saine. */
export function unsafeEntryReason(entry: Pick<ZipEntry, 'name' | 'isSymlink'>): string | null {
  const name = entry.name
  if (entry.isSymlink) return 'lien symbolique'
  if (name.includes('\0')) return 'caractère nul dans le nom'
  if (name.startsWith('/') || name.startsWith('\\')) return 'chemin absolu'
  if (/^[a-zA-Z]:/.test(name)) return 'lecteur Windows'
  if (name.split(/[\\/]/).includes('..')) return 'remonte hors du dossier (« .. »)'
  return null
}

/** Nom de fichier plat et sûr, dérivé du dernier segment du nom d'archive. */
function flatName(index: number, name: string): string {
  const last = name.split(/[\\/]/).filter(Boolean).at(-1) ?? 'entree'
  const clean = last.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 120) || 'entree'
  return `${String(index).padStart(4, '0')}-${clean}`
}

/** Compte les octets décompressés, coupe au-delà de la taille annoncée, calcule le CRC. */
class GuardedCounter extends Transform {
  bytes = 0
  crc = 0
  constructor(
    private readonly limit: number,
    private readonly label: string,
  ) {
    super()
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.bytes += chunk.length
    if (this.bytes > this.limit) {
      cb(new ZipError(`entrée « ${this.label} » plus grosse que sa taille annoncée : extraction coupée (bombe de décompression ?)`))
      return
    }
    if (typeof zlib.crc32 === 'function') this.crc = zlib.crc32(chunk, this.crc)
    cb(null, chunk)
  }
}

export interface ExtractOptions {
  /** Plafond du total décompressé (somme des tailles annoncées des entrées choisies). */
  maxTotalBytes?: number
}

/**
 * Extrait les entrées choisies vers `destDir` (dossier déjà créé, vide,
 * à nous). Refuse l'archive entière au moindre nom dangereux.
 */
export async function extractZipEntries(
  zipPath: string,
  destDir: string,
  select: (name: string) => boolean,
  opts: ExtractOptions = {},
): Promise<ExtractedEntry[]> {
  const maxTotal = opts.maxTotalBytes ?? DEFAULT_MAX_EXTRACT_BYTES
  const entries = await readZipEntries(zipPath)

  const unsafe = entries
    .map(e => ({ e, reason: unsafeEntryReason(e) }))
    .filter((x): x is { e: ZipEntry; reason: string } => x.reason !== null)
  if (unsafe.length > 0) {
    const first = unsafe[0]!
    throw new ZipError(
      `archive refusée : ${unsafe.length} entrée(s) dangereuse(s), par exemple « ${first.e.name.slice(0, 120)} » (${first.reason}). Rien n'a été extrait.`,
    )
  }

  const chosen = entries.filter(e => !e.isDirectory && select(e.name))
  const declared = chosen.reduce((n, e) => n + e.uncompressedSize, 0)
  if (declared > maxTotal) {
    throw new ZipError(`archive refusée : ${declared} octets à extraire, au-delà du plafond de ${maxTotal}`)
  }
  for (const e of chosen) {
    if (e.encrypted) throw new ZipError(`entrée chiffrée, illisible : « ${e.name} »`)
    if (e.method !== 0 && e.method !== 8) {
      throw new ZipError(`méthode de compression ${e.method} non prise en charge : « ${e.name} »`)
    }
  }

  const zipSize = (await stat(zipPath)).size
  const root = resolve(destDir)
  const out: ExtractedEntry[] = []
  const fd = await open(zipPath, 'r')
  try {
    for (let i = 0; i < chosen.length; i++) {
      const e = chosen[i]!
      const header = await readAt(fd, e.localHeaderOffset, 30)
      if (header.readUInt32LE(0) !== SIG_LOCAL) throw new ZipError(`en-tête local illisible : « ${e.name} »`)
      const dataStart = e.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
      if (dataStart + e.compressedSize > zipSize) throw new ZipError(`entrée hors du fichier (archive tronquée ?) : « ${e.name} »`)

      const target = join(root, flatName(i, e.name))
      // Défense en profondeur : le nom est le nôtre, il ne peut pas sortir du dossier.
      if (!resolve(target).startsWith(root + sep)) throw new ZipError(`chemin de sortie refusé : « ${e.name} »`)

      const source: Readable =
        e.compressedSize === 0
          ? Readable.from([])
          : createReadStream(zipPath, { start: dataStart, end: dataStart + e.compressedSize - 1 })
      const counter = new GuardedCounter(e.uncompressedSize, e.name)
      // 'wx' : échoue si le fichier existe déjà, donc ne suit jamais un lien posé là.
      const sink = createWriteStream(target, { flags: 'wx', mode: 0o600 })
      if (e.method === 8) await pipeline(source, zlib.createInflateRaw(), counter, sink)
      else await pipeline(source, counter, sink)

      if (counter.bytes !== e.uncompressedSize) {
        throw new ZipError(`taille incohérente pour « ${e.name} » (${counter.bytes} octets lus, ${e.uncompressedSize} annoncés)`)
      }
      if (typeof zlib.crc32 === 'function' && counter.crc >>> 0 !== e.crc32 >>> 0) {
        throw new ZipError(`somme de contrôle fausse pour « ${e.name} » (archive abîmée ?)`)
      }
      out.push({ name: e.name, path: target, size: counter.bytes })
    }
  } finally {
    await fd.close()
  }
  return out
}

/** Le fichier commence-t-il par une signature ZIP ? */
export async function looksLikeZip(path: string): Promise<boolean> {
  const fd = await open(path, 'r')
  try {
    const buf = Buffer.alloc(4)
    const { bytesRead } = await fd.read(buf, 0, 4, 0)
    if (bytesRead < 4) return false
    const sig = buf.readUInt32LE(0)
    return sig === SIG_LOCAL || sig === SIG_EOCD
  } finally {
    await fd.close()
  }
}

