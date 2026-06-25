// =============================================================================
// attachment-protocol.ts — the cyggie-attachment:// custom protocol.
//
// A markdown reference `cyggie-attachment://{id}` (image src or PDF link href)
// resolves here: serve from the local cache, downloading from R2 by id on a
// miss (the cache layer handles coalescing + integrity). Device-independent —
// the same reference resolves on any device because the id is opaque and the
// bytes come from R2, not a device-local path (unlike asset://).
//
//   cache HIT  → 200 with Content-Type from the cached meta
//   miss→DL ok → 200 (downloaded, verified, cached)
//   not found  → 404 (deleted / not authorized / unknown id)
//   DL failure → 503 (renderer shows "unavailable, retry")
//
// Registered as a privileged scheme in index.ts BEFORE app-ready (same as
// asset://) so <img> treats it as a secure, streamable source.
// =============================================================================

import { protocol } from 'electron'
import { ensureCached, isValidAttachmentId } from './attachment-cache'

export function registerAttachmentProtocol(): void {
  protocol.handle('cyggie-attachment', async (request) => {
    const url = new URL(request.url)
    // Standard scheme → the id is the host (cyggie-attachment://{id}).
    const id = decodeURIComponent(url.host || url.pathname.replace(/^\/+/, ''))
    if (!isValidAttachmentId(id)) {
      return new Response('Bad Request', { status: 400 })
    }
    try {
      const result = await ensureCached(id)
      if (!result) return new Response('Not Found', { status: 404 })
      return new Response(result.bytes as unknown as BodyInit, {
        status: 200,
        headers: {
          'Content-Type': result.meta.mimeType,
          'Cache-Control': 'no-cache',
        },
      })
    } catch (err) {
      console.error(
        `[attachment-protocol] resolve failed id=${id} metric=attachment.resolve.failed`,
        err,
      )
      return new Response('Unavailable', { status: 503 })
    }
  })
}
