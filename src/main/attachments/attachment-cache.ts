// =============================================================================
// attachment-cache.ts — local disk cache for attachment bytes, backed by R2.
//
//   {storagePath}/attachment-cache/{id}        — raw bytes
//   {storagePath}/attachment-cache/{id}.json   — { mimeType, checksum, sizeBytes }
//
// Flow:
//   • Upload seeds the cache immediately (instant local render).
//   • The cyggie-attachment:// protocol handler reads the cache; on a MISS it
//     downloads from R2 by id (firm-scoped presigned GET), verifies checksum +
//     size, atomically writes (temp + rename), then serves. Concurrent misses
//     for the same id are coalesced. A simple size cap evicts oldest-first; the
//     miss path re-downloads, so eviction is always safe.
//
// No local `attachments` row is required to resolve — id → gateway download-url
// returns mime/checksum/size (the "push + download-by-id" model from PR2).
// =============================================================================

import {
  createHash,
} from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { getStoragePath } from '../storage/paths'
import { resolveUnder } from './path-guard'
import { requestDownloadUrl, getBytes } from './attachment-transport'

// cuid2 shape — must match the gateway's ATTACHMENT_ID_RE so a crafted id can't
// reach the filesystem.
const ATTACHMENT_ID_RE = /^[a-z0-9]{1,32}$/

// Soft cap on the on-disk cache. Oldest files are evicted past this; the miss
// path re-downloads, so this never loses data, only re-fetches.
const CACHE_MAX_BYTES = 500 * 1024 * 1024

export interface AttachmentMeta {
  mimeType: string
  checksum: string | null
  sizeBytes: number
}

export function getAttachmentCacheDir(): string {
  const dir = join(getStoragePath(), 'attachment-cache')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function bytesPath(id: string): string | null {
  return resolveUnder(getAttachmentCacheDir(), id)
}
function metaPath(id: string): string | null {
  return resolveUnder(getAttachmentCacheDir(), `${id}.json`)
}

export function isValidAttachmentId(id: string): boolean {
  return ATTACHMENT_ID_RE.test(id)
}

/** Read cached bytes + meta for a hit, or null on miss / invalid id. */
export function readCached(id: string): { bytes: Buffer; meta: AttachmentMeta } | null {
  if (!isValidAttachmentId(id)) return null
  const bp = bytesPath(id)
  const mp = metaPath(id)
  if (!bp || !mp || !existsSync(bp) || !existsSync(mp)) return null
  try {
    const bytes = readFileSync(bp)
    const meta = JSON.parse(readFileSync(mp, 'utf8')) as AttachmentMeta
    return { bytes, meta }
  } catch {
    return null
  }
}

/** Atomically write bytes + meta into the cache (temp file + rename). */
export function writeCached(id: string, bytes: Buffer, meta: AttachmentMeta): void {
  if (!isValidAttachmentId(id)) return
  const bp = bytesPath(id)
  const mp = metaPath(id)
  if (!bp || !mp) return
  const tmp = `${bp}.tmp-${process.pid}`
  writeFileSync(tmp, bytes)
  renameSync(tmp, bp)
  writeFileSync(mp, JSON.stringify(meta))
  enforceSizeCap()
}

export function evictCached(id: string): void {
  if (!isValidAttachmentId(id)) return
  for (const p of [bytesPath(id), metaPath(id)]) {
    if (p && existsSync(p)) {
      try {
        rmSync(p)
      } catch {
        /* best-effort */
      }
    }
  }
}

// Coalesce concurrent downloads of the same id so N images in one note don't
// trigger N racing fetches of the same shared asset.
const inFlight = new Map<string, Promise<{ bytes: Buffer; meta: AttachmentMeta } | null>>()

/**
 * Ensure bytes for `id` are cached, downloading from R2 on a miss. Returns the
 * bytes + meta, or null if the attachment can't be resolved (404 / deleted) or
 * the download fails. Verifies checksum + size before committing to the cache.
 */
export async function ensureCached(
  id: string,
): Promise<{ bytes: Buffer; meta: AttachmentMeta } | null> {
  if (!isValidAttachmentId(id)) return null
  const hit = readCached(id)
  if (hit) return hit

  const existing = inFlight.get(id)
  if (existing) return existing

  const job = (async (): Promise<{ bytes: Buffer; meta: AttachmentMeta } | null> => {
    const presigned = await requestDownloadUrl(id)
    if (!presigned) return null // 404 — deleted / not authorized
    const bytes = await getBytes(presigned.url)

    // Integrity: size + sha256 must match the row's recorded values.
    if (presigned.sizeBytes != null && bytes.length !== presigned.sizeBytes) {
      throw new Error(`size mismatch for ${id}: got ${bytes.length}, expected ${presigned.sizeBytes}`)
    }
    if (presigned.checksum) {
      const got = createHash('sha256').update(bytes).digest('hex')
      if (got !== presigned.checksum) {
        throw new Error(`checksum mismatch for ${id}`)
      }
    }
    const meta: AttachmentMeta = {
      mimeType: presigned.mimeType,
      checksum: presigned.checksum,
      sizeBytes: bytes.length,
    }
    writeCached(id, bytes, meta)
    return { bytes, meta }
  })()

  inFlight.set(id, job)
  try {
    return await job
  } finally {
    inFlight.delete(id)
  }
}

/** Evict oldest cache entries (by mtime) until total bytes ≤ CACHE_MAX_BYTES. */
function enforceSizeCap(): void {
  try {
    const dir = getAttachmentCacheDir()
    const entries = readdirSync(dir)
      .filter((f) => !f.endsWith('.json') && !f.includes('.tmp-'))
      .map((f) => {
        const full = join(dir, f)
        const st = statSync(full)
        return { id: f, full, size: st.size, mtime: st.mtimeMs }
      })
    let total = entries.reduce((n, e) => n + e.size, 0)
    if (total <= CACHE_MAX_BYTES) return
    entries.sort((a, b) => a.mtime - b.mtime) // oldest first
    for (const e of entries) {
      if (total <= CACHE_MAX_BYTES) break
      evictCached(e.id)
      total -= e.size
    }
  } catch {
    /* best-effort — cache hygiene must never break a render */
  }
}
