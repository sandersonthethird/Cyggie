import os from 'os'
import * as settingsRepo from '../database/repositories/settings.repo'
import * as userRepo from '../database/repositories/user.repo'

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
  email?: string | null
}): userRepo.UserRecord {
  const currentUserId = getCurrentUserId()
  const updated = userRepo.updateUser(currentUserId, {
    displayName: data.displayName,
    email: data.email ?? null
  })
  if (!updated) {
    throw new Error('Failed to update current user profile')
  }
  userRepo.ensureTeamMembership(updated.id, updated.role === 'admin' ? 'admin' : 'member')
  persistCurrentUser(updated.id, updated.displayName, updated.email)
  return updated
}
