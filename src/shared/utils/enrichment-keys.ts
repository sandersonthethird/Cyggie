export const contactEnrichedAtKey = (id: string): string =>
  `contact_enriched_at_${id}`

export const companyEnrichedAtKey = (id: string): string =>
  `company_enriched_at_${id}`

/** Stores the ISO timestamp of the last file-based enhancement (PDF/URL → note flow). */
export const companyEnhancedAtKey = (id: string): string =>
  `company_enhanced_at_${id}`
