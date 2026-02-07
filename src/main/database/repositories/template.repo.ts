import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../connection'
import type { TemplateRow } from '../schema'
import type { MeetingTemplate, TemplateCategory, OutputFormat } from '../../../shared/types/template'
import { DEFAULT_TEMPLATES } from '../../../shared/constants/templates'

function rowToTemplate(row: TemplateRow): MeetingTemplate {
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    category: row.category as TemplateCategory,
    systemPrompt: row.system_prompt,
    userPromptTemplate: row.user_prompt_template,
    outputFormat: row.output_format as OutputFormat,
    isDefault: row.is_default === 1,
    isActive: row.is_active === 1,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function seedDefaultTemplates(): void {
  const db = getDatabase()
  const count = (db.prepare('SELECT COUNT(*) as count FROM templates WHERE is_default = 1').get() as { count: number }).count

  if (count > 0) return

  const stmt = db.prepare(
    `INSERT INTO templates (id, name, description, category, system_prompt, user_prompt_template, output_format, is_default, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
  )

  const insertAll = db.transaction(() => {
    for (const t of DEFAULT_TEMPLATES) {
      stmt.run(
        uuidv4(),
        t.name,
        t.description,
        t.category,
        t.systemPrompt,
        t.userPromptTemplate,
        t.outputFormat,
        t.sortOrder
      )
    }
  })

  insertAll()
}

export function listTemplates(activeOnly = true): MeetingTemplate[] {
  const db = getDatabase()
  const where = activeOnly ? 'WHERE is_active = 1' : ''
  const rows = db.prepare(`SELECT * FROM templates ${where} ORDER BY sort_order ASC`).all() as TemplateRow[]
  return rows.map(rowToTemplate)
}

export function getTemplate(id: string): MeetingTemplate | null {
  const db = getDatabase()
  const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow | undefined
  return row ? rowToTemplate(row) : null
}

export function createTemplate(data: {
  name: string
  description: string
  category: TemplateCategory
  systemPrompt: string
  userPromptTemplate: string
  outputFormat: OutputFormat
}): MeetingTemplate {
  const db = getDatabase()
  const id = uuidv4()

  db.prepare(
    `INSERT INTO templates (id, name, description, category, system_prompt, user_prompt_template, output_format, is_default, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM templates))`
  ).run(id, data.name, data.description, data.category, data.systemPrompt, data.userPromptTemplate, data.outputFormat)

  return getTemplate(id)!
}

export function updateTemplate(
  id: string,
  data: Partial<{
    name: string
    description: string
    systemPrompt: string
    userPromptTemplate: string
    outputFormat: OutputFormat
    isActive: boolean
  }>
): MeetingTemplate | null {
  const db = getDatabase()
  const sets: string[] = []
  const params: unknown[] = []

  if (data.name !== undefined) {
    sets.push('name = ?')
    params.push(data.name)
  }
  if (data.description !== undefined) {
    sets.push('description = ?')
    params.push(data.description)
  }
  if (data.systemPrompt !== undefined) {
    sets.push('system_prompt = ?')
    params.push(data.systemPrompt)
  }
  if (data.userPromptTemplate !== undefined) {
    sets.push('user_prompt_template = ?')
    params.push(data.userPromptTemplate)
  }
  if (data.outputFormat !== undefined) {
    sets.push('output_format = ?')
    params.push(data.outputFormat)
  }
  if (data.isActive !== undefined) {
    sets.push('is_active = ?')
    params.push(data.isActive ? 1 : 0)
  }

  if (sets.length === 0) return getTemplate(id)

  sets.push("updated_at = datetime('now')")
  params.push(id)

  db.prepare(`UPDATE templates SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  return getTemplate(id)
}

export function deleteTemplate(id: string): boolean {
  const db = getDatabase()
  // Don't delete default templates
  const template = getTemplate(id)
  if (!template || template.isDefault) return false

  const result = db.prepare('DELETE FROM templates WHERE id = ? AND is_default = 0').run(id)
  return result.changes > 0
}
