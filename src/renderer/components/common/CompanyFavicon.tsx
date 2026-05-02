/**
 * CompanyFavicon — renders the Google s2 favicon for a company domain.
 * Hides itself on load error. Fully shared across table cell, name cell,
 * meeting row, calendar badge, etc.
 *
 * Phase 1: extracted from CompanyTable.tsx:651 et al; existing call sites can
 * migrate opportunistically (not required for the chip feature).
 */
import type { CSSProperties } from 'react'

interface CompanyFaviconProps {
  domain: string | null | undefined
  size?: number
  className?: string
  style?: CSSProperties
  alt?: string
}

export function CompanyFavicon({ domain, size = 14, className, style, alt = '' }: CompanyFaviconProps) {
  if (!domain) return null
  const sz = size <= 16 ? 16 : 32 // Google s2 supports 16 and 32
  return (
    <img
      src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=${sz}`}
      alt={alt}
      width={size}
      height={size}
      className={className}
      style={{ objectFit: 'contain', borderRadius: 2, flexShrink: 0, ...style }}
      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
    />
  )
}
