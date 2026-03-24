const SQLITE_DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/

export function parseTimestamp(value: string | null | undefined): number {
  if (!value) return Number.NaN
  const trimmed = value.trim()
  if (!trimmed) return Number.NaN
  const normalized = SQLITE_DATETIME_RE.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}Z`
    : trimmed
  return Date.parse(normalized)
}

export function formatLastTouch(value: string | null | undefined): string {
  if (!value) return ''
  const timestamp = parseTimestamp(value)
  if (Number.isNaN(timestamp)) return ''
  const diffDays = Math.max(0, Math.floor((Date.now() - timestamp) / 86400000))
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return `${diffDays}d ago`
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function formatCurrency(n: number | null | undefined): string {
  if (n == null) return '—'
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`
  return `${sign}$${abs.toLocaleString()}`
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
}

export function daysSince(value: string | null | undefined): number | null {
  if (!value) return null
  const ts = parseTimestamp(value)
  if (Number.isNaN(ts)) return null
  return Math.max(0, Math.floor((Date.now() - ts) / 86400000))
}

/** Strip markdown syntax from text for use in plain-text previews (e.g. note list snippets).
 *  Not a full markdown parser — covers the common cases from Apple Notes / Notion exports.
 *  Known limitation: nested markers like ***bold-italic*** are only partially stripped.
 */
export function stripMarkdownPreview(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '')              // # headings
    .replace(/\*\*([^*]+)\*\*/g, '$1')         // **bold**
    .replace(/\*([^*]+)\*/g, '$1')             // *italic*
    .replace(/__([^_]+)__/g, '$1')             // __bold__
    .replace(/_([^_]+)_/g, '$1')               // _italic_
    .replace(/`([^`]+)`/g, '$1')               // `code`
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')   // [text](url)
    .replace(/^>\s+/gm, '')                    // > blockquote
    .replace(/\n+/g, ' ')                      // collapse newlines
    .trim()
}
