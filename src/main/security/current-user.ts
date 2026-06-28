import os from 'os'
import * as settingsRepo from '@cyggie/db/sqlite/repositories/settings.repo'
import * as userRepo from '@cyggie/db/sqlite/repositories/user.repo'
import { getCyggieUserId } from '../auth/cyggie-auth-storage'

/** Setting that durably mirrors the current user's gateway id (JWT sub). Written
 *  on sign-in and survives sign-out, so note ownership still recognises the
 *  user's gateway-stamped rows as their own while signed out. */
export const GATEWAY_ID_SETTING = 'currentUserGatewayId'

let cachedUserId: string | null = null

function defaultDisplayName(): string {
  const configured = (settingsRepo.getSetting('currentUserDisplayName') || '').trim()
  if (configured) return configured

  const userInfo = os.userInfo()
  const username = (userInfo.username || '').trim()
  if (username) return username

  return 'Cyggie User'
}

function defaultEmail(): string | null {
  const configured = (settingsRepo.getSetting('currentUserEmail') || '').trim()
  return configured || null
}

function persistCurrentUser(userId: string, displayName: string, email: string | null): void {
  settingsRepo.setSetting('currentUserId', userId)
  settingsRepo.setSetting('currentUserDisplayName', displayName)
  settingsRepo.setSetting('currentUserEmail', email || '')
  cachedUserId = userId
}

export function getCurrentUserId(): string {
  if (cachedUserId) return cachedUserId

  const configuredUserId = (settingsRepo.getSetting('currentUserId') || '').trim()
  if (configuredUserId) {
    const existing = userRepo.getUser(configuredUserId)
    if (existing) {
      userRepo.ensureTeamMembership(existing.id, existing.role === 'admin' ? 'admin' : 'member')
      cachedUserId = existing.id
      return existing.id
    }
  }

  const user = userRepo.createUser({
    displayName: defaultDisplayName(),
    email: defaultEmail(),
    role: 'admin'
  })
  userRepo.ensureTeamMembership(user.id, 'admin')
  persistCurrentUser(user.id, user.displayName, user.email)
  return user.id
}

/**
 * Every id that belongs to the current user. A note is the user's own when its
 * `created_by_user_id` matches ANY of these — the desktop-local id, plus the
 * gateway id (cuid2 JWT sub) under which round-tripped rows come back. Without
 * this union, the user's own gateway-stamped notes look foreign and lock
 * read-only. A real teammate's note carries the teammate's gateway id, which is
 * never in this set, so it stays read-only.
 */
export function getMyUserIds(): string[] {
  const ids = new Set<string>([getCurrentUserId()])
  const persisted = (settingsRepo.getSetting(GATEWAY_ID_SETTING) || '').trim()
  if (persisted) ids.add(persisted) // durable alias, present even when signed out
  const live = getCyggieUserId()
  if (live) ids.add(live) // present while signed in
  return [...ids]
}

export function getCurrentUserProfile(): userRepo.UserRecord {
  const userId = getCurrentUserId()
  const user = userRepo.getUser(userId)
  if (!user) {
    throw new Error('Current user could not be loaded')
  }
  return user
}

export function updateCurrentUserProfile(data: {
  displayName: string
  firstName?: string | null
  lastName?: string | null
  email?: string | null
  title?: string | null
  jobFunction?: string | null
}): userRepo.UserRecord {
  const currentUserId = getCurrentUserId()
  const updated = userRepo.updateUser(currentUserId, {
    displayName: data.displayName,
    firstName: data.firstName,
    lastName: data.lastName,
    email: data.email ?? null,
    title: data.title,
    jobFunction: data.jobFunction
  })
  if (!updated) {
    throw new Error('Failed to update current user profile')
  }
  userRepo.ensureTeamMembership(updated.id, updated.role === 'admin' ? 'admin' : 'member')
  persistCurrentUser(updated.id, updated.displayName, updated.email)
  return updated
}
