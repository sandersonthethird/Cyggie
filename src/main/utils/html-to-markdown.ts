import TurndownService from 'turndown'

export interface ExtractedImage {
  mimeType: string  // 'png' | 'jpeg' | 'jpg' | 'gif' | 'webp'
  data: string      // raw base64 string (no data URI prefix)
}

export interface HtmlToMarkdownResult {
  markdown: string       // with __IMG_{n}__ placeholders where images were
  images: ExtractedImage[]
}

const ALLOWED_MIME_RE = /^image\/(png|jpe?g|gif|webp)$/i
const DATA_IMG_RE = /<img[^>]+src="(data:image\/(png|jpe?g|gif|webp);base64,([^"]+))"[^>]*>/gi

/**
 * Single-pass HTML → Markdown conversion.
 * Extracts base64-embedded images first (replacing with __IMG_{n}__ tokens),
 * then runs Turndown. Returns both the converted Markdown and the extracted
 * images in placeholder order, ready for disk write.
 *
 * On any conversion error, returns { markdown: '', images: [] } — caller treats as skip.
 */
export function convertHtmlToMarkdown(html: string): HtmlToMarkdownResult {
  try {
    const images: ExtractedImage[] = []

    // Single-pass: replace whitelisted base64 <img> tags with __IMG_{n}__ placeholders
    const substituted = html.replace(DATA_IMG_RE, (_match, _dataUri, rawMime, base64) => {
      const mime = rawMime.toLowerCase().replace('jpg', 'jpeg')
      if (!ALLOWED_MIME_RE.test(`image/${mime}`)) return _match  // leave non-whitelisted as-is
      const idx = images.length
      images.push({ mimeType: mime, data: base64 })
      return `__IMG_${idx}__`
    })

    const td = new TurndownService({
      headingStyle: 'atx',
      bulletListMarker: '-',
      codeBlockStyle: 'fenced',
    })

    const markdown = td.turndown(substituted)
    return { markdown, images }
  } catch {
    return { markdown: '', images: [] }
  }
}
