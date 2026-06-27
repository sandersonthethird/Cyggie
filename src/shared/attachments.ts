// Shared attachment constants + helpers (main + renderer). Inline images are
// RASTER ONLY — no SVG (inline SVG can execute <script> in the renderer;
// eng-review decision 3A). PDFs are also droppable now and render inline via the
// Chromium PDF viewer (a sandboxed iframe); they keep their own mime helpers so
// the raster-image allowlist stays image-only.

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

export const PDF_MIME = 'application/pdf'

export function isRasterImageMime(mime: string): mime is RasterImageMime {
  return (RASTER_IMAGE_MIME_TYPES as readonly string[]).includes(mime)
}

export function isPdfMime(mime: string): boolean {
  return mime === PDF_MIME
}

/** Resolve a raster-image mime from a filename's extension, or null. */
export function imageMimeFromFilename(filename: string): RasterImageMime | null {
  const dot = filename.lastIndexOf('.')
  if (dot < 0) return null
  const ext = filename.slice(dot + 1).toLowerCase()
  return EXT_TO_MIME[ext] ?? null
}

/** application/pdf if the filename ends in .pdf, else null. */
export function pdfMimeFromFilename(filename: string): typeof PDF_MIME | null {
  return filename.toLowerCase().endsWith('.pdf') ? PDF_MIME : null
}

/** File extension for a known mime (for naming externally-opened files). */
export function extensionForMime(mime: string): string {
  return MIME_TO_EXT[mime] ?? 'bin'
}
