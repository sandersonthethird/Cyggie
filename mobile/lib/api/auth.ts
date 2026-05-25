import { api } from './client'

// Typed client for /auth/* gateway routes that the app calls outside the
// OAuth round-trip itself. The OAuth start/callback/refresh paths live in
// lib/auth/oauth.ts because they use a different transport (raw fetch +
// WebBrowser) — this file only covers authed JSON endpoints.

export interface AuthMe {
  id: string
  email: string
  displayName: string | null
  avatarUrl: string | null
  firmId: string | null
  role: 'admin' | 'member'
}

export async function fetchMe(opts?: { signal?: AbortSignal }): Promise<AuthMe> {
  return api.get<AuthMe>('/auth/me', { signal: opts?.signal })
}
