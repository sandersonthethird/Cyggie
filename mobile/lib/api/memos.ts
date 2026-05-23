import { api } from './client'

// Typed client for /memos/* gateway routes (read-only — desktop owns
// the write path; mobile only renders memos drafted on desktop).

export interface MemoListItem {
  id: string
  title: string
  status: string
  latestVersionNumber: number
  updatedAt: string
  /** First ~200 chars of the latest version's contentMarkdown, with
   *  markdown syntax stripped. Used as a list-row sub-line. */
  preview: string
}

export interface MemoDetail {
  id: string
  title: string
  status: string
  /** Latest version's markdown body. Null OR empty when no version row
   *  has content yet (memo is in 'still being drafted' state on desktop).
   *  Mobile renders a dedicated empty-state for that case. */
  contentMarkdown: string | null
  latestVersionNumber: number
  updatedAt: string
}

interface MemoListResponse {
  memos: MemoListItem[]
}

export async function fetchMemosForCompany(
  companyId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<MemoListItem[]> {
  const params = new URLSearchParams({ companyId })
  const result = await api.get<MemoListResponse>(`/memos?${params.toString()}`, {
    signal: opts.signal,
  })
  return result.memos
}

export async function fetchMemo(
  id: string,
  opts: { signal?: AbortSignal } = {},
): Promise<MemoDetail> {
  return api.get<MemoDetail>(`/memos/${encodeURIComponent(id)}`, {
    signal: opts.signal,
  })
}
