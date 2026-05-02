export const CANONICAL_INDUSTRIES = [
  'AdTech',
  'AI',
  'Consumer (CPG)',
  'Consumer Social',
  'Creator Economy',
  'Developer Tools',
  'Ecommerce',
  'FinTech',
  'Gaming',
  'HealthTech',
  'HR Tech',
  'InsurTech',
  'LegalTech',
  'Logistics',
  'Marketplace',
  'PropTech',
  'Retail Tech',
  'SaaS',
  'Travel',
  'Web3',
  'Workforce',
] as const

export type CanonicalIndustry = (typeof CANONICAL_INDUSTRIES)[number]

const CANONICAL_SET = new Set<string>(CANONICAL_INDUSTRIES)

export function isCanonicalIndustry(value: string | null | undefined): value is CanonicalIndustry {
  return value != null && CANONICAL_SET.has(value)
}

export function normalizeIndustryOrNull(value: string | null | undefined): CanonicalIndustry | null {
  if (!value) return null
  const trimmed = value.trim()
  return CANONICAL_SET.has(trimmed) ? (trimmed as CanonicalIndustry) : null
}

export const INDUSTRY_PROMPT_LIST = CANONICAL_INDUSTRIES.join(' | ')
