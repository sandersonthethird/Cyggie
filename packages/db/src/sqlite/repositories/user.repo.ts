import { randomUUID } from 'crypto'
import { getDatabase } from '../connection'

export interface UserRecord {
  id: string
  displayName: string
  firstName: string | null
  lastName: string | null
  email: string | null
  avatarUrl: string | null
  role: 'admin' | 'member'
  title: string | null
  jobFunction: string | null
  createdAt: string
}

interface UserRow {
  id: string
  display_name: string
  first_name: string | null
  last_name: string | null
  email: string | null
  avatar_url: string | null
  role: 'admin' | 'member'
  title: string | null
  job_function: string | null
  created_at: string
}

function mapUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    avatarUrl: row.avatar_url,
    role: row.role,
    title: row.title,
    jobFunction: row.job_function,
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

function splitDisplayName(displayName: string): { firstName: string | null; lastName: string | null } {
  const tokens = displayName
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
  if (tokens.length === 0) return { firstName: null, lastName: null }
  if (tokens.length === 1) return { firstName: tokens[0], lastName: null }
  return {
    firstName: tokens[0] || null,
    lastName: tokens.slice(1).join(' ') || null
  }
}

export function getUser(userId: string): UserRecord | null {
  const db = getDatabase()
  const row = db
    .prepare(`
      SELECT id, display_name, first_name, last_name, email, avatar_url, role, title, job_function, created_at
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
      SELECT id, display_name, first_name, last_name, email, avatar_url, role, title, job_function, created_at
      FROM users
      ORDER BY datetime(created_at) ASC
      LIMIT ?
    `)
    .all(limit) as UserRow[]
  return rows.map(mapUser)
}

export function createUser(data: {
  displayName: string
  firstName?: string | null
  lastName?: string | null
  email?: string | null
  avatarUrl?: string | null
  role?: 'admin' | 'member'
}): UserRecord {
  const db = getDatabase()
  const displayName = data.displayName.trim()
  if (!displayName) throw new Error('displayName is required')
  const email = normalizeEmail(data.email ?? null)
  const split = splitDisplayName(displayName)
  const firstName = data.firstName?.trim() || split.firstName
  const lastName = data.lastName?.trim() || split.lastName

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
      firstName,
      lastName,
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
      id, display_name, first_name, last_name, email, avatar_url, role, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    id,
    displayName,
    firstName,
    lastName,
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
    firstName: string | null
    lastName: string | null
    email: string | null
    avatarUrl: string | null
    role: 'admin' | 'member'
    title: string | null
    jobFunction: string | null
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
  if (data.firstName !== undefined) {
    sets.push('first_name = ?')
    params.push(data.firstName?.trim() || null)
  }
  if (data.lastName !== undefined) {
    sets.push('last_name = ?')
    params.push(data.lastName?.trim() || null)
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
  if (data.title !== undefined) {
    sets.push('title = ?')
    params.push(data.title?.trim() || null)
  }
  if (data.jobFunction !== undefined) {
    sets.push('job_function = ?')
    params.push(data.jobFunction?.trim() || null)
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

/**
 * Firm directory cache. Mirrors the gateway's GET /firms/me/members into the
 * local users table (keyed by the gateway user id) so multiplayer attribution
 * — "created by / last edited by / shared by" — resolves offline. Idempotent
 * upsert by id; never deletes (a member who left simply stops being refreshed).
 */
export function upsertFirmMembers(
  members: ReadonlyArray<{
    id: string
    email: string | null
    displayName: string | null
    avatarUrl: string | null
    role: string
  }>,
): number {
  const db = getDatabase()
  const stmt = db.prepare(`
    INSERT INTO users (id, display_name, first_name, last_name, email, avatar_url, role, created_at)
    VALUES (@id, @displayName, @firstName, @lastName, @email, @avatarUrl, @role, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      display_name = excluded.display_name,
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      email = excluded.email,
      avatar_url = excluded.avatar_url,
      role = excluded.role
  `)
  const apply = db.transaction((rows: typeof members) => {
    for (const m of rows) {
      const displayName = (m.displayName ?? m.email ?? m.id).trim()
      const split = splitDisplayName(displayName)
      stmt.run({
        id: m.id,
        displayName,
        firstName: split.firstName,
        lastName: split.lastName,
        email: normalizeEmail(m.email ?? null),
        avatarUrl: m.avatarUrl ?? null,
        role: m.role === 'admin' ? 'admin' : 'member',
      })
    }
    return rows.length
  })
  return apply(members)
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
