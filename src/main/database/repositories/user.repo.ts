import { randomUUID } from 'crypto'
import { getDatabase } from '../connection'

export interface UserRecord {
  id: string
  displayName: string
  email: string | null
  avatarUrl: string | null
  role: 'admin' | 'member'
  createdAt: string
}

interface UserRow {
  id: string
  display_name: string
  email: string | null
  avatar_url: string | null
  role: 'admin' | 'member'
  created_at: string
}

function mapUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    avatarUrl: row.avatar_url,
    role: row.role,
    createdAt: row.created_at
  }
}

function normalizeEmail(value: string | null | undefined): string | null {
  if (!value) return null
  const cleaned = value.trim().toLowerCase()
  if (!cleaned) return null
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) return null
  return cleaned
}

export function getUser(userId: string): UserRecord | null {
  const db = getDatabase()
  const row = db
    .prepare(`
      SELECT id, display_name, email, avatar_url, role, created_at
      FROM users
      WHERE id = ?
      LIMIT 1
    `)
    .get(userId) as UserRow | undefined
  return row ? mapUser(row) : null
}

export function listUsers(limit = 100): UserRecord[] {
  const db = getDatabase()
  const rows = db
    .prepare(`
      SELECT id, display_name, email, avatar_url, role, created_at
      FROM users
      ORDER BY datetime(created_at) ASC
      LIMIT ?
    `)
    .all(limit) as UserRow[]
  return rows.map(mapUser)
}

export function createUser(data: {
  displayName: string
  email?: string | null
  avatarUrl?: string | null
  role?: 'admin' | 'member'
}): UserRecord {
  const db = getDatabase()
  const displayName = data.displayName.trim()
  if (!displayName) throw new Error('displayName is required')
  const email = normalizeEmail(data.email ?? null)

  const byEmail = email
    ? (db.prepare(`
        SELECT id
        FROM users
        WHERE lower(email) = ?
        LIMIT 1
      `).get(email) as { id: string } | undefined)
    : undefined

  if (byEmail?.id) {
    const updated = updateUser(byEmail.id, {
      displayName,
      email,
      avatarUrl: data.avatarUrl ?? null,
      role: data.role ?? undefined
    })
    if (!updated) throw new Error('Failed to load updated user')
    return updated
  }

  const id = randomUUID()
  db.prepare(`
    INSERT INTO users (
      id, display_name, email, avatar_url, role, created_at
    ) VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(
    id,
    displayName,
    email,
    data.avatarUrl ?? null,
    data.role ?? 'member'
  )

  const created = getUser(id)
  if (!created) throw new Error('Failed to create user')
  return created
}

export function updateUser(
  userId: string,
  data: Partial<{
    displayName: string
    email: string | null
    avatarUrl: string | null
    role: 'admin' | 'member'
  }>
): UserRecord | null {
  const db = getDatabase()
  const sets: string[] = []
  const params: unknown[] = []

  if (data.displayName !== undefined) {
    const displayName = data.displayName.trim()
    if (!displayName) throw new Error('displayName cannot be empty')
    sets.push('display_name = ?')
    params.push(displayName)
  }
  if (data.email !== undefined) {
    sets.push('email = ?')
    params.push(normalizeEmail(data.email))
  }
  if (data.avatarUrl !== undefined) {
    sets.push('avatar_url = ?')
    params.push(data.avatarUrl?.trim() || null)
  }
  if (data.role !== undefined) {
    sets.push('role = ?')
    params.push(data.role)
  }

  if (sets.length === 0) return getUser(userId)

  params.push(userId)
  db.prepare(`
    UPDATE users
    SET ${sets.join(', ')}
    WHERE id = ?
  `).run(...params)

  return getUser(userId)
}

export function ensureDefaultTeam(): string {
  const db = getDatabase()
  const existing = db.prepare('SELECT id FROM teams LIMIT 1').get() as { id: string } | undefined
  if (existing?.id) return existing.id

  const id = randomUUID()
  db.prepare(`
    INSERT INTO teams (id, name, created_at)
    VALUES (?, 'Default Workspace', datetime('now'))
  `).run(id)
  return id
}

export function ensureTeamMembership(
  userId: string,
  role: 'admin' | 'member' = 'member'
): void {
  const db = getDatabase()
  const teamId = ensureDefaultTeam()
  db.prepare(`
    INSERT INTO team_members (team_id, user_id, role, joined_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(team_id, user_id) DO UPDATE SET
      role = excluded.role
  `).run(teamId, userId, role)
}
