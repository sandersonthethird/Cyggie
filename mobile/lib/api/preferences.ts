import { api } from './client'

// Synced user preferences (Part E). Mobile has no local DB, so it reads/writes
// the gateway's /user/preferences directly (Neon). Desktop writes via SQLite +
// sync; both surfaces converge on the same `user_preferences` rows.

/** Keep in sync with EMAIL_THREADS_PREF_KEY in @cyggie/services/llm/email-signal. */
export const EMAIL_THREADS_PREF_KEY = 'emailThreadsPerCompany'
export const EMAIL_THREADS_DEFAULT = 20
const EMAIL_THREADS_MIN = 1
const EMAIL_THREADS_MAX = 100

export function clampEmailThreads(n: number): number {
  if (!Number.isFinite(n)) return EMAIL_THREADS_DEFAULT
  return Math.max(EMAIL_THREADS_MIN, Math.min(EMAIL_THREADS_MAX, Math.trunc(n)))
}

export async function fetchPreferences(opts?: { signal?: AbortSignal }): Promise<Record<string, string>> {
  const res = await api.get<{ preferences: Record<string, string> }>('/user/preferences', opts)
  return res.preferences
}

export async function setPreference(key: string, value: string): Promise<void> {
  await api.patch<{ ok: true }, { key: string; value: string }>('/user/preferences', { key, value })
}
