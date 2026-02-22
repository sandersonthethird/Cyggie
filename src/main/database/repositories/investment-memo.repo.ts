import { randomUUID } from 'crypto'
import { getDatabase } from '../connection'
import type {
  InvestmentMemo,
  InvestmentMemoVersion,
  InvestmentMemoWithLatest
} from '../../../shared/types/company'

interface MemoRow {
  id: string
  company_id: string
  theme_id: string | null
  deal_id: string | null
  title: string
  status: string
  latest_version_number: number
  created_by: string | null
  created_at: string
  updated_at: string
}

interface MemoVersionRow {
  id: string
  memo_id: string
  version_number: number
  content_markdown: string
  structured_json: string | null
  change_note: string | null
  created_by: string | null
  created_at: string
}

function rowToMemo(row: MemoRow): InvestmentMemo {
  return {
    id: row.id,
    companyId: row.company_id,
    themeId: row.theme_id,
    dealId: row.deal_id,
    title: row.title,
    status: row.status as InvestmentMemo['status'],
    latestVersionNumber: row.latest_version_number,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function rowToMemoVersion(row: MemoVersionRow): InvestmentMemoVersion {
  return {
    id: row.id,
    memoId: row.memo_id,
    versionNumber: row.version_number,
    contentMarkdown: row.content_markdown,
    structuredJson: row.structured_json,
    changeNote: row.change_note,
    createdBy: row.created_by,
    createdAt: row.created_at
  }
}

export function createMemo(data: {
  companyId: string
  title: string
  themeId?: string | null
  dealId?: string | null
  createdBy?: string | null
}, userId: string | null = null): InvestmentMemo {
  const db = getDatabase()
  const id = randomUUID()
  db.prepare(`
    INSERT INTO investment_memos (
      id, company_id, theme_id, deal_id, title, status, latest_version_number,
      created_by, created_by_user_id, updated_by_user_id, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, 'draft', 0, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    id,
    data.companyId,
    data.themeId ?? null,
    data.dealId ?? null,
    data.title,
    data.createdBy ?? userId ?? null,
    userId,
    userId
  )

  return getMemo(id)!
}

export function getMemo(memoId: string): InvestmentMemo | null {
  const db = getDatabase()
  const row = db
    .prepare(`
      SELECT
        id, company_id, theme_id, deal_id, title, status, latest_version_number, created_by, created_at, updated_at
      FROM investment_memos
      WHERE id = ?
    `)
    .get(memoId) as MemoRow | undefined
  return row ? rowToMemo(row) : null
}

export function getLatestMemoForCompany(companyId: string): InvestmentMemoWithLatest | null {
  const db = getDatabase()
  const row = db
    .prepare(`
      SELECT
        id, company_id, theme_id, deal_id, title, status, latest_version_number, created_by, created_at, updated_at
      FROM investment_memos
      WHERE company_id = ?
      ORDER BY datetime(updated_at) DESC
      LIMIT 1
    `)
    .get(companyId) as MemoRow | undefined

  if (!row) return null
  const memo = rowToMemo(row)
  const latestVersion = getMemoLatestVersion(memo.id)
  return { ...memo, latestVersion }
}

export function getOrCreateMemoForCompany(
  companyId: string,
  companyName: string,
  userId: string | null = null
): InvestmentMemoWithLatest {
  const existing = getLatestMemoForCompany(companyId)
  if (existing) return existing

  const memo = createMemo({
    companyId,
    title: `${companyName} Investment Memo`
  }, userId)

  const initialContent = [
    `# ${companyName} Investment Memo`,
    '',
    '## Thesis',
    '- ',
    '',
    '## Why Now',
    '- ',
    '',
    '## Risks / Open Questions',
    '- ',
    '',
    '## Next Steps',
    '- '
  ].join('\n')

  const version = saveMemoVersion(memo.id, {
    contentMarkdown: initialContent,
    changeNote: 'Initial draft'
  }, userId)

  return { ...memo, latestVersion: version, latestVersionNumber: version.versionNumber }
}

export function listMemoVersions(memoId: string): InvestmentMemoVersion[] {
  const db = getDatabase()
  const rows = db
    .prepare(`
      SELECT
        id, memo_id, version_number, content_markdown, structured_json, change_note, created_by, created_at
      FROM investment_memo_versions
      WHERE memo_id = ?
      ORDER BY version_number DESC
    `)
    .all(memoId) as MemoVersionRow[]
  return rows.map(rowToMemoVersion)
}

export function getMemoLatestVersion(memoId: string): InvestmentMemoVersion | null {
  const db = getDatabase()
  const row = db
    .prepare(`
      SELECT
        id, memo_id, version_number, content_markdown, structured_json, change_note, created_by, created_at
      FROM investment_memo_versions
      WHERE memo_id = ?
      ORDER BY version_number DESC
      LIMIT 1
    `)
    .get(memoId) as MemoVersionRow | undefined
  return row ? rowToMemoVersion(row) : null
}

export function getMemoVersion(versionId: string): InvestmentMemoVersion | null {
  const db = getDatabase()
  const row = db
    .prepare(`
      SELECT
        id, memo_id, version_number, content_markdown, structured_json, change_note, created_by, created_at
      FROM investment_memo_versions
      WHERE id = ?
      LIMIT 1
    `)
    .get(versionId) as MemoVersionRow | undefined
  return row ? rowToMemoVersion(row) : null
}

export function saveMemoVersion(
  memoId: string,
  data: {
    contentMarkdown: string
    structuredJson?: string | null
    changeNote?: string | null
    createdBy?: string | null
  },
  userId: string | null = null
): InvestmentMemoVersion {
  const db = getDatabase()
  const memo = getMemo(memoId)
  if (!memo) {
    throw new Error('Memo not found')
  }

  const versionNumber = memo.latestVersionNumber + 1
  const versionId = randomUUID()
  db.prepare(`
    INSERT INTO investment_memo_versions (
      id, memo_id, version_number, content_markdown, structured_json, change_note,
      created_by, created_by_user_id, updated_by_user_id, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    versionId,
    memoId,
    versionNumber,
    data.contentMarkdown,
    data.structuredJson ?? null,
    data.changeNote ?? null,
    data.createdBy ?? userId ?? null,
    userId,
    userId
  )

  if (userId) {
    db.prepare(`
      UPDATE investment_memos
      SET latest_version_number = ?, updated_by_user_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(versionNumber, userId, memoId)
  } else {
    db.prepare(`
      UPDATE investment_memos
      SET latest_version_number = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(versionNumber, memoId)
  }

  const saved = db
    .prepare(`
      SELECT
        id, memo_id, version_number, content_markdown, structured_json, change_note, created_by, created_at
      FROM investment_memo_versions
      WHERE id = ?
    `)
    .get(versionId) as MemoVersionRow | undefined

  if (!saved) {
    throw new Error('Failed to save memo version')
  }
  return rowToMemoVersion(saved)
}

export function updateMemoStatus(
  memoId: string,
  status: InvestmentMemo['status'],
  userId: string | null = null
): InvestmentMemo | null {
  const db = getDatabase()
  if (userId) {
    db.prepare(`
      UPDATE investment_memos
      SET status = ?, updated_by_user_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(status, userId, memoId)
  } else {
    db.prepare(`
      UPDATE investment_memos
      SET status = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(status, memoId)
  }
  return getMemo(memoId)
}

export function recordMemoExport(data: {
  memoVersionId: string
  artifactId?: string | null
  exportFormat?: string
  storageUri?: string | null
}): string {
  const db = getDatabase()
  const id = randomUUID()
  db.prepare(`
    INSERT INTO investment_memo_exports (
      id, memo_version_id, artifact_id, export_format, storage_uri, created_at
    )
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(
    id,
    data.memoVersionId,
    data.artifactId ?? null,
    data.exportFormat ?? 'pdf',
    data.storageUri ?? null
  )
  return id
}
