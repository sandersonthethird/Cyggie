import { randomUUID } from 'crypto'
import { getDatabase } from '../connection'

export interface CompanyConversation {
  id: string
  companyId: string
  themeId: string | null
  title: string
  modelProvider: string | null
  modelName: string | null
  isPinned: boolean
  isArchived: boolean
  lastMessageAt: string | null
  createdAt: string
  updatedAt: string
}

export interface CompanyConversationMessage {
  id: string
  conversationId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  citationsJson: string | null
  tokenCount: number | null
  createdAt: string
}

interface ConversationRow {
  id: string
  company_id: string
  theme_id: string | null
  title: string
  model_provider: string | null
  model_name: string | null
  is_pinned: number
  is_archived: number
  last_message_at: string | null
  created_at: string
  updated_at: string
}

interface MessageRow {
  id: string
  conversation_id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  citations_json: string | null
  token_count: number | null
  created_at: string
}

function mapConversation(row: ConversationRow): CompanyConversation {
  return {
    id: row.id,
    companyId: row.company_id,
    themeId: row.theme_id,
    title: row.title,
    modelProvider: row.model_provider,
    modelName: row.model_name,
    isPinned: row.is_pinned === 1,
    isArchived: row.is_archived === 1,
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapMessage(row: MessageRow): CompanyConversationMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    citationsJson: row.citations_json,
    tokenCount: row.token_count,
    createdAt: row.created_at
  }
}

export function listConversations(companyId: string): CompanyConversation[] {
  const db = getDatabase()
  const rows = db.prepare(`
    SELECT
      id, company_id, theme_id, title, model_provider, model_name,
      is_pinned, is_archived, last_message_at, created_at, updated_at
    FROM company_conversations
    WHERE company_id = ? AND is_archived = 0
    ORDER BY is_pinned DESC, datetime(COALESCE(last_message_at, updated_at)) DESC
  `).all(companyId) as ConversationRow[]

  return rows.map(mapConversation)
}

export function createConversation(data: {
  companyId: string
  title: string
  themeId?: string | null
  modelProvider?: string | null
  modelName?: string | null
}, userId: string | null = null): CompanyConversation {
  const db = getDatabase()
  const id = randomUUID()
  db.prepare(`
    INSERT INTO company_conversations (
      id, company_id, theme_id, title, model_provider, model_name,
      is_pinned, is_archived, last_message_at,
      created_by_user_id, updated_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, NULL, ?, ?, datetime('now'), datetime('now'))
  `).run(
    id,
    data.companyId,
    data.themeId ?? null,
    data.title,
    data.modelProvider ?? null,
    data.modelName ?? null,
    userId,
    userId
  )

  const row = db.prepare(`
    SELECT
      id, company_id, theme_id, title, model_provider, model_name,
      is_pinned, is_archived, last_message_at, created_at, updated_at
    FROM company_conversations
    WHERE id = ?
  `).get(id) as ConversationRow

  return mapConversation(row)
}

export function listMessages(conversationId: string): CompanyConversationMessage[] {
  const db = getDatabase()
  const rows = db.prepare(`
    SELECT id, conversation_id, role, content, citations_json, token_count, created_at
    FROM company_conversation_messages
    WHERE conversation_id = ?
    ORDER BY datetime(created_at) ASC
  `).all(conversationId) as MessageRow[]
  return rows.map(mapMessage)
}

export function appendMessage(data: {
  conversationId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  citationsJson?: string | null
  tokenCount?: number | null
}, userId: string | null = null): CompanyConversationMessage {
  const db = getDatabase()
  const id = randomUUID()
  db.prepare(`
    INSERT INTO company_conversation_messages (
      id, conversation_id, role, content, citations_json, token_count,
      created_by_user_id, updated_by_user_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    id,
    data.conversationId,
    data.role,
    data.content,
    data.citationsJson ?? null,
    data.tokenCount ?? null,
    userId,
    userId
  )

  db.prepare(`
    UPDATE company_conversations
    SET last_message_at = datetime('now'), updated_by_user_id = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(userId, data.conversationId)

  const row = db.prepare(`
    SELECT id, conversation_id, role, content, citations_json, token_count, created_at
    FROM company_conversation_messages
    WHERE id = ?
  `).get(id) as MessageRow

  return mapMessage(row)
}
