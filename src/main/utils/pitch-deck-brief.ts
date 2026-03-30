/**
 * Extracts the "Partner Sync Summary" block from a pitch deck analysis note.
 *
 * The analysis note is structured as:
 *   ## Partner Sync Summary
 *   Company: ...
 *   Founder: ...
 *   ...
 *   ---
 *   ## Full Analysis
 *   ...
 *
 * Returns the content of the Partner Sync Summary section, or null if the section
 * is absent or contains fewer than 10 characters.
 */
export function extractPartnerSyncBrief(noteContent: string): string | null {
  const normalized = noteContent.replace(/\r\n/g, '\n')
  const match = /#{1,3}\s+Partner Sync Summary\s*:?\s*\n([\s\S]*?)(?=\n\s*---|\n#{1,3}\s|$)/i.exec(normalized)
  if (!match) return null
  const content = match[1].trim()
  return content.length > 10 ? content : null
}
