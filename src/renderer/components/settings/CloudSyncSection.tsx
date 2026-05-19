import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'
import { IPC_CHANNELS } from '../../../shared/constants/channels'

// =============================================================================
// CloudSyncSection — Settings → Cloud Sync panel.
//
// Surfaces the desktop SyncAgent state to the user:
//   • Sign in / Sign out button (triggers /auth/google/start in system browser)
//   • Email pill (signed-in / signed-out / re-sign-in required)
//   • Pending + failed + dead outbox depth
//   • Last successful flush relative time
//   • Retry dead-letters button (when dead > 0)
//
// State comes from a push subscription on SYNC_STATUS_CHANGED — the SyncAgent
// fires onStateChange on every transition; sync-bootstrap forwards via
// webContents.send. Initial state is one-shot via SYNC_STATUS on mount.
// CYGGIE_AUTH_STATUS_CHANGED feeds the email + signed-in pill.
// =============================================================================

interface AuthStatus {
  signedIn: boolean
  email: string | null
  userId: string | null
}

interface SyncSnapshot {
  state:
    | 'idle'
    | 'flushing'
    | 'ack_pending'
    | 'backing_off'
    | 'paused_no_auth'
    | 'paused_cap_reached'
  pendingCount: number
  failedCount: number
  deadCount: number
  lastFlushAt: number | null
  lastError: string | null
  nextRetryAt: number | null
}

export function CloudSyncSection(): JSX.Element {
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [sync, setSync] = useState<SyncSnapshot | null>(null)
  const [signInPending, setSignInPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Initial fetch + push subscriptions.
  useEffect(() => {
    let cancelled = false
    void api
      .invoke<AuthStatus>(IPC_CHANNELS.CYGGIE_AUTH_STATUS)
      .then((s) => {
        if (!cancelled) setAuth(s)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'auth status failed'))
    void api
      .invoke<SyncSnapshot>(IPC_CHANNELS.SYNC_STATUS)
      .then((s) => {
        if (!cancelled) setSync(s)
      })
      .catch(() => undefined)

    const offAuth = api.on(IPC_CHANNELS.CYGGIE_AUTH_STATUS_CHANGED, ((next) => {
      setAuth(next as AuthStatus)
    }) as (...args: unknown[]) => void)
    const offSync = api.on(IPC_CHANNELS.SYNC_STATUS_CHANGED, ((next) => {
      setSync(next as SyncSnapshot)
    }) as (...args: unknown[]) => void)

    return () => {
      cancelled = true
      offAuth()
      offSync()
    }
  }, [])

  const onSignIn = useCallback(async () => {
    setError(null)
    setSignInPending(true)
    try {
      const result = await api.invoke<{ ok: boolean; error?: string }>(
        IPC_CHANNELS.CYGGIE_AUTH_SIGN_IN,
      )
      if (!result.ok) {
        setError(result.error ?? 'Sign-in failed')
      }
      // Browser-completion is asynchronous; the status-changed push will land
      // when the cyggie-desktop:// callback fires. Keep the pending flag for
      // ~30s as a UX hint, then clear it.
      setTimeout(() => setSignInPending(false), 30_000)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed')
      setSignInPending(false)
    }
  }, [])

  const onSignOut = useCallback(async () => {
    setError(null)
    try {
      await api.invoke(IPC_CHANNELS.CYGGIE_AUTH_SIGN_OUT)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-out failed')
    }
  }, [])

  const onRetryDeadLetters = useCallback(async () => {
    try {
      await api.invoke<{ promoted: number; snapshot: SyncSnapshot }>(
        IPC_CHANNELS.SYNC_RETRY_DEAD_LETTERS,
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Retry failed')
    }
  }, [])

  const pill = computePill(auth, sync)
  const pendingDepth = (sync?.pendingCount ?? 0) + (sync?.failedCount ?? 0)
  const showFirstLaunchBanner = !auth?.signedIn && pendingDepth > 0

  return (
    <section style={{ marginTop: 24 }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Cloud Sync</h3>
        <span style={{ fontSize: 11, color: 'var(--color-text-secondary, #6b7280)' }}>Beta</span>
        <Pill {...pill} />
      </header>

      {showFirstLaunchBanner && (
        <div
          style={{
            padding: '8px 12px',
            background: '#FEF3C7',
            border: '1px solid #FCD34D',
            borderRadius: 6,
            fontSize: 13,
            marginBottom: 12,
          }}
        >
          You have {pendingDepth} unsynced change{pendingDepth === 1 ? '' : 's'}. Sign in to back them up to the cloud.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
        <Row label="Sync state" value={humanize(sync?.state) ?? '—'} />
        <Row
          label="Outbox depth"
          value={
            sync ? `${sync.pendingCount} pending · ${sync.failedCount} retrying · ${sync.deadCount} dead` : '—'
          }
        />
        <Row label="Last sync" value={formatRelativeTime(sync?.lastFlushAt ?? null)} />
        {sync?.lastError && <Row label="Last error" value={sync.lastError} muted />}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        {auth?.signedIn ? (
          <button onClick={onSignOut} type="button" style={buttonStyle('secondary')}>
            Sign out
          </button>
        ) : (
          <button
            onClick={onSignIn}
            disabled={signInPending}
            type="button"
            style={buttonStyle('primary')}
          >
            {signInPending ? 'Waiting for browser…' : 'Sign in with Google'}
          </button>
        )}
        {sync && sync.deadCount > 0 && (
          <button onClick={onRetryDeadLetters} type="button" style={buttonStyle('secondary')}>
            Retry {sync.deadCount} dead
          </button>
        )}
      </div>

      {error && (
        <p style={{ color: '#B91C1C', fontSize: 12, marginTop: 8 }}>{error}</p>
      )}
    </section>
  )
}

// ── helpers ────────────────────────────────────────────────────────────────

function Pill({
  label,
  color,
  bg,
  border,
}: {
  label: string
  color: string
  bg: string
  border: string
}): JSX.Element {
  return (
    <span
      style={{
        fontSize: 11,
        padding: '2px 8px',
        borderRadius: 999,
        background: bg,
        color,
        border: `1px solid ${border}`,
      }}
    >
      {label}
    </span>
  )
}

function Row({
  label,
  value,
  muted,
}: {
  label: string
  value: string
  muted?: boolean
}): JSX.Element {
  return (
    <div style={{ display: 'flex', gap: 12 }}>
      <span style={{ minWidth: 110, color: 'var(--color-text-secondary, #6b7280)' }}>{label}</span>
      <span style={{ color: muted ? 'var(--color-text-secondary, #6b7280)' : undefined }}>
        {value}
      </span>
    </div>
  )
}

function buttonStyle(variant: 'primary' | 'secondary'): React.CSSProperties {
  return {
    padding: '6px 12px',
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
    border: variant === 'primary' ? '1px solid #B91C1C' : '1px solid #D1D5DB',
    background: variant === 'primary' ? '#B91C1C' : 'transparent',
    color: variant === 'primary' ? '#fff' : 'var(--color-text, #0F172A)',
  }
}

function computePill(
  auth: AuthStatus | null,
  sync: SyncSnapshot | null,
): { label: string; color: string; bg: string; border: string } {
  if (sync?.state === 'paused_no_auth' && !auth?.signedIn) {
    return { label: 'Signed out', color: '#92400E', bg: '#FEF3C7', border: '#FCD34D' }
  }
  if (sync?.state === 'paused_no_auth' && auth?.signedIn) {
    // Auth state thinks we're signed in but the agent is paused — rare; treat
    // as transient. Hide.
    return { label: 'Reconnecting…', color: '#374151', bg: '#F3F4F6', border: '#D1D5DB' }
  }
  if (auth?.signedIn) {
    const email = auth.email && auth.email.length > 0 ? auth.email : 'Connected'
    return { label: email, color: '#047857', bg: '#D1FAE5', border: '#10B981' }
  }
  return { label: 'Signed out', color: '#92400E', bg: '#FEF3C7', border: '#FCD34D' }
}

function humanize(state: SyncSnapshot['state'] | undefined): string | null {
  if (!state) return null
  return state.replace(/_/g, ' ')
}

function formatRelativeTime(ts: number | null): string {
  if (!ts) return 'never'
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`
  return `${Math.floor(diff / 86400_000)}d ago`
}
