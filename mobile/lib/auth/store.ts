import { create } from 'zustand'
import {
  clearAllAuthStorage,
  getAccessToken,
  getLastAction,
  getUserId,
  setAccessToken,
  setLastAction as persistLastAction,
  setRefreshToken,
  setUserId,
  type LastAction,
} from './storage'

// In-memory mirror of the auth artifacts. SecureStore is the source of truth
// at rest; this store is the source of truth at runtime so route guards and
// the api client don't have to await Keychain reads on every render.
//
// Notably we don't keep the refresh token in this store — it stays in Keychain
// (biometric-gated) and only the api client reads it (and only on 401).

export type AuthStatus = 'idle' | 'loading' | 'signed_in' | 'signed_out'

interface AuthState {
  status: AuthStatus
  userId: string | null
  accessToken: string | null
  lastAction: LastAction | null
  // Re-hydrate from SecureStore on app launch. Called once from _layout.
  hydrate: () => Promise<void>
  // Called after a successful OAuth round-trip. Persists everything.
  signIn: (opts: {
    accessToken: string
    refreshToken: string
    userId: string
    action: LastAction
  }) => Promise<void>
  // Called when /auth/refresh succeeds. Rotates access + refresh.
  updateTokens: (opts: { accessToken: string; refreshToken: string }) => Promise<void>
  // Called after /auth/firms/claim or /auth/firms/join — gateway mints a
  // fresh access token (firm_id baked in) but does NOT rotate the refresh
  // token. Touching the refresh would trigger an unnecessary FaceID prompt.
  updateAccessToken: (opts: { accessToken: string }) => Promise<void>
  // Mutates lastAction in BOTH SecureStore and the in-memory store so the
  // route dispatcher re-renders against the new value. The bare
  // storage/setLastAction would only touch SecureStore — that's the bug
  // we hit during M1a Step 8 (Flow A landed back at create-workspace
  // because Zustand still had the stale 'create_workspace' value).
  setLastAction: (action: LastAction) => Promise<void>
  // Wipe. Used by sign-out and unrecoverable 401.
  signOut: () => Promise<void>
}

export const useAuthStore = create<AuthState>((set) => ({
  status: 'idle',
  userId: null,
  accessToken: null,
  lastAction: null,

  hydrate: async () => {
    set({ status: 'loading' })
    const [accessToken, userId, lastAction] = await Promise.all([
      getAccessToken(),
      getUserId(),
      getLastAction(),
    ])
    if (accessToken && userId) {
      set({ status: 'signed_in', accessToken, userId, lastAction })
    } else {
      set({ status: 'signed_out', accessToken: null, userId: null, lastAction: null })
    }
  },

  signIn: async ({ accessToken, refreshToken, userId, action }) => {
    await Promise.all([
      setAccessToken(accessToken),
      setRefreshToken(refreshToken),
      setUserId(userId),
      persistLastAction(action),
    ])
    set({ status: 'signed_in', accessToken, userId, lastAction: action })
  },

  updateTokens: async ({ accessToken, refreshToken }) => {
    await Promise.all([setAccessToken(accessToken), setRefreshToken(refreshToken)])
    set({ accessToken })
  },

  updateAccessToken: async ({ accessToken }) => {
    await setAccessToken(accessToken)
    set({ accessToken })
  },

  setLastAction: async (action) => {
    await persistLastAction(action)
    set({ lastAction: action })
  },

  signOut: async () => {
    await clearAllAuthStorage()
    set({ status: 'signed_out', accessToken: null, userId: null, lastAction: null })
  },
}))
