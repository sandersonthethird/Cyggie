import type { CompanyRound, CompanyEntityType } from './company'

export interface PitchDeckExtractionResult {
  companyName: string | null
  description: string | null
  domain: string | null
  websiteUrl: string | null
  city: string | null
  state: string | null
  sector: string | null
  businessModel: string | null
  targetCustomer: string | null
  productStage: string | null
  round: CompanyRound | null
  raiseSize: number | null           // millions USD
  postMoneyValuation: number | null  // millions USD
  entityType: CompanyEntityType | null
  industries: string[]
  // Founders and C-suite officers ONLY — no advisors, board members, or investors
  founders: Array<{
    name: string
    email: string | null
    title: string | null
    isCeo: boolean
  }>
  sourceLabel: string       // e.g. "Acme.pdf" or "acme.docsend.com"
  rawText?: string          // raw deck text for downstream LLM use (e.g. partner sync brief generation)
  sourceFilePath?: string   // local file path for PDF sources; used by partner sync brief generation for vision PDFs
}

export type PitchDeckSource =
  | { type: 'pdf'; path: string }
  | { type: 'url'; url: string; email?: string; password?: string }

export type PitchDeckIngestPayload = {
  source: PitchDeckSource
  companyId?: string  // present when enriching an existing company
}

export type PitchDeckIngestResult =
  | { result: PitchDeckExtractionResult; existingMatch?: { companyId: string; companyName: string } }
  | { error: string }

export type KnownDeckPlatform = {
  pattern: RegExp
  name: string
  requiresEmail: boolean
}

export const KNOWN_DECK_PLATFORMS: KnownDeckPlatform[] = [
  { pattern: /docsend\.com/i, name: 'DocSend', requiresEmail: true },
  { pattern: /pitch\.com/i, name: 'Pitch', requiresEmail: false },
  { pattern: /notion\.so/i, name: 'Notion', requiresEmail: false },
  { pattern: /slides\.google\.com/i, name: 'Google Slides', requiresEmail: false },
]

export function detectDeckPlatform(url: string): KnownDeckPlatform | null {
  for (const platform of KNOWN_DECK_PLATFORMS) {
    if (platform.pattern.test(url)) return platform
  }
  return null
}
