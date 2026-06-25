// Shared attachment constants + helpers (main + renderer). Inline images are
// RASTER ONLY — no SVG (inline SVG can execute <script> in the renderer;
// eng-review decision 3A). PDFs are attachments opened externally (PR4), not
// inline images, so they're not in the inline-image allowlist here.

export const ATTACHMENT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024 // mirror gateway default

export const RASTER_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const

export type RasterImageMime = (typeof RASTER_IMAGE_MIME_TYPES)[number]

const EXT_TO_MIME: Record<string, RasterImageMime> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
}

export function isRasterImageMime(mime: string): mime is RasterImageMime {
  return (RASTER_IMAGE_MIME_TYPES as readonly string[]).includes(mime)
}

/** Resolve a raster-image mime from a filename's extension, or null. */
export function imageMimeFromFilename(filename: string): RasterImageMime | null {
  const dot = filename.lastIndexOf('.')
  if (dot < 0) return null
  const ext = filename.slice(dot + 1).toLowerCase()
  return EXT_TO_MIME[ext] ?? null
}

/** File extension for a known mime (for naming externally-opened files). */
export function extensionForMime(mime: string): string {
  return MIME_TO_EXT[mime] ?? 'bin'
}
