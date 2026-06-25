// =============================================================================
// OnboardingGate — first-run gate that takes over the window until the user has
// a firm. Flag-gated (ff_onboarding_v1); when off OR the user chose "use
// locally", it renders the app unchanged. Routing is the pure routeOnboarding()
// over CYGGIE_AUTH_STATUS (signedIn + firmId + action).
//
//   loading           → splash
//   welcome           → sign in with Google / use locally
//   create_workspace  → name the firm (claim)
//   join_firm         → "Join <firm>?" (email-matched invite)
//   app               → children (the real app)
// =============================================================================

import { useEffect, useState, type ReactNode } from 'react'
import { api } from '../../api'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import { useFeatureFlag } from '../../hooks/useFeatureFlags'
import { routeOnboarding, type OnboardingAction } from '../../lib/onboarding-route'
import { Welcome } from './Welcome'
import { CreateWorkspace } from './CreateWorkspace'
import { JoinFirm } from './JoinFirm'
import styles from './onboarding.module.css'

export interface CyggieAuthStatus {
  signedIn: boolean
  email: string | null
  userId: string | null
  firmId: string | null
  action: OnboardingAction | null
}

const USE_LOCAL_KEY = 'cyggie_use_local_v1'

export function OnboardingGate({ children }: { children: ReactNode }) {
  const { enabled: gateEnabled, loading: flagLoading } = useFeatureFlag('ff_onboarding_v1')
  const [status, setStatus] = useState<CyggieAuthStatus | null>(null)
  const [useLocal, setUseLocal] = useState(() => localStorage.getItem(USE_LOCAL_KEY) === '1')

  useEffect(() => {
    let alive = true
    void api.invoke<CyggieAuthStatus>(IPC_CHANNELS.CYGGIE_AUTH_STATUS).then((s) => {
      if (alive) setStatus(s)
    })
    const off = api.on(IPC_CHANNELS.CYGGIE_AUTH_STATUS_CHANGED, (...args: unknown[]) => {
      setStatus(args[0] as CyggieAuthStatus)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  // Gate disabled, or user escaped to local-only → render the app untouched.
  if (flagLoading) return null
  if (!gateEnabled || useLocal) return <>{children}</>

  const screen = routeOnboarding({
    authStatus: status == null ? 'unknown' : status.signedIn ? 'signed_in' : 'signed_out',
    action: status?.action ?? null,
    hasFirm: status?.firmId != null,
  })

  if (screen === 'app') return <>{children}</>
  if (screen === 'loading') {
    return <div className={styles.splash}>Loading…</div>
  }

  const onUseLocal = (): void => {
    localStorage.setItem(USE_LOCAL_KEY, '1')
    setUseLocal(true)
  }

  return (
    <div className={styles.gate}>
      {screen === 'welcome' && <Welcome onUseLocal={onUseLocal} />}
      {screen === 'create_workspace' && <CreateWorkspace email={status?.email ?? null} />}
      {screen === 'join_firm' && <JoinFirm email={status?.email ?? null} />}
    </div>
  )
}
