import { randomUUID } from 'crypto'
import { getDatabase } from '../connection'

export interface ArtifactRecord {
  id: string
  companyId: string | null
  themeId: string | null
  meetingId: string | null
  artifactType: string
  title: string
  mimeType: string | null
  storageUri: string | null
  sourceProvider: string | null
  sourceExternalId: string | null
  contentText: string | null
  capturedAt: string | null
  createdAt: string
  updatedAt: string
}

export function createArtifact(data: {
  companyId?: string | null
  themeId?: string | null
  meetingId?: string | null
  artifactType: string
  title: string
  mimeType?: string | null
  storageUri?: string | null
  sourceProvider?: string | null
  sourceExternalId?: string | null
  contentText?: string | null
  capturedAt?: string | null
}): ArtifactRecord {
  const db = getDatabase()
  const id = randomUUID()
  db.prepare(`
    INSERT INTO artifacts (
      id, company_id, theme_id, meeting_id, artifact_type, title, mime_type, storage_uri,
      source_provider, source_external_id, content_text, captured_at, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    id,
    data.companyId ?? null,
    data.themeId ?? null,
    data.meetingId ?? null,
    data.artifactType,
    data.title,
    data.mimeType ?? null,
    data.storageUri ?? null,
    data.sourceProvider ?? null,
    data.sourceExternalId ?? null,
    data.contentText ?? null,
    data.capturedAt ?? null
  )

  db.prepare(
    'INSERT INTO artifacts_fts (artifact_id, title, content_text) VALUES (?, ?, ?)'
  ).run(id, data.title, data.contentText ?? '')

  const row = db.prepare(`
    SELECT
      id, company_id, theme_id, meeting_id, artifact_type, title, mime_type, storage_uri,
      source_provider, source_external_id, content_text, captured_at, created_at, updated_at
    FROM artifacts
    WHERE id = ?
  `).get(id) as {
    id: string
    company_id: string | null
    theme_id: string | null
    meeting_id: string | null
    artifact_type: string
    title: string
    mime_type: string | null
    storage_uri: string | null
    source_provider: string | null
    source_external_id: string | null
    content_text: string | null
    captured_at: string | null
    created_at: string
    updated_at: string
  }

  return {
    id: row.id,
    companyId: row.company_id,
    themeId: row.theme_id,
    meetingId: row.meeting_id,
    artifactType: row.artifact_type,
    title: row.title,
    mimeType: row.mime_type,
    storageUri: row.storage_uri,
    sourceProvider: row.source_provider,
    sourceExternalId: row.source_external_id,
    contentText: row.content_text,
    capturedAt: row.captured_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}
