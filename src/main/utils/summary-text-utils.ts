/**
 * Shared text utilities for summary-based auto-fill services.
 * Used by both company-summary-sync.service.ts and contact-summary-sync.service.ts.
 */

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function isDifferentText(next: string | null | undefined, current: string | null | undefined): boolean {
  if (!next) return false
  const normalizedNext = normalizeWhitespace(next).toLowerCase()
  const normalizedCurrent = normalizeWhitespace(current || '').toLowerCase()
  return normalizedNext !== normalizedCurrent
}

export function stripMarkdown(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^[-*]\s+/, '')
    .replace(/^\d+[\).]\s+/, '')
    .trim()
}
