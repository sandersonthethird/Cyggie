export type UnifiedSearchEntityType = 'meeting' | 'email' | 'note' | 'memo'

export interface UnifiedSearchCitation {
  id: string
  entityType: UnifiedSearchEntityType
  entityId: string
  title: string
  occurredAt: string
  companyId: string | null
  companyName: string | null
  route: string
  citationLabel: string
}

export interface UnifiedSearchResult extends UnifiedSearchCitation {
  snippet: string
  rank: number
}

export interface UnifiedSearchResultsGrouped {
  meeting: UnifiedSearchResult[]
  email: UnifiedSearchResult[]
  note: UnifiedSearchResult[]
  memo: UnifiedSearchResult[]
}

export interface UnifiedSearchResponse {
  query: string
  totalCount: number
  grouped: UnifiedSearchResultsGrouped
  flat: UnifiedSearchResult[]
}

export interface UnifiedSearchAnswerResponse {
  query: string
  answer: string
  citations: UnifiedSearchCitation[]
}
