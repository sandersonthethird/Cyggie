// =============================================================================
// Onboarding — first-run flow gate body. Local useReducer (no global store);
// hydrates from prefs + real signals, decides the smart-backfill entry, and
// mirrors step+values back to prefs so a reload resumes.
//
//   mount ─▶ gather signals (auth / calendar / keys / saved prefs)
//          ─▶ decideGate:  app  → mark onboardingComplete, unmount
//                          flow → start at first-incomplete, pre-check done tiles
//   render ─▶ step switch (SignIn → Workspace → Google → Keys → Team → Done)
//   change ─▶ setJSON('onboardingState', snapshot)        (resume)
//   Enter  ─▶ setJSON('onboardingComplete', true)         (→ app)
// =============================================================================

import { useEffect, useReducer, useState } from 'react'
import { usePreferencesStore } from '../../stores/preferences.store'
import { api } from '../../api'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import { decideGate, STEP } from './onboarding-logic'
import { FlatProgress } from './FlatProgress'
import { SignInStep } from './steps/SignInStep'
import { WorkspaceStep } from './steps/WorkspaceStep'
import { GoogleStep } from './steps/GoogleStep'
import { KeysStep } from './steps/KeysStep'
import { TeamStep } from './steps/TeamStep'
import { DoneStep } from './steps/DoneStep'
import styles from './Onboarding.module.css'

interface OBState {
  step: number
  firmName: string
  slug: string
  slugEdited: boolean
  googleConnected: boolean
  keysSaved: boolean
  invites: string[]
}

type Action =
  | { type: 'hydrate'; value: OBState }
  | { type: 'step'; value: number }
  | { type: 'firmName'; name: string; derivedSlug: string | null }
  | { type: 'slug'; value: string }
  | { type: 'googleConnected' }
  | { type: 'keysSaved' }
  | { type: 'addInvite'; email: string }
  | { type: 'removeInvite'; email: string }

const SETUP_LABELS = ['Workspace', 'Google', 'Keys', 'Team']

const EMPTY: OBState = {
  step: STEP.signin,
  firmName: '',
  slug: '',
  slugEdited: false,
  googleConnected: false,
  keysSaved: false,
  invites: [],
}

function reducer(state: OBState, action: Action): OBState {
  switch (action.type) {
    case 'hydrate':
      return action.value
    case 'step':
      return { ...state, step: Math.max(0, Math.min(STEP.done, action.value)) }
    case 'firmName':
      return {
        ...state,
        firmName: action.name,
        slug: action.derivedSlug != null ? action.derivedSlug : state.slug,
      }
    case 'slug':
      return { ...state, slug: action.value, slugEdited: true }
    case 'googleConnected':
      return { ...state, googleConnected: true }
    case 'keysSaved':
      return { ...state, keysSaved: true }
    case 'addInvite':
      return state.invites.includes(action.email)
        ? state
        : { ...state, invites: [...state.invites, action.email] }
    case 'removeInvite':
      return { ...state, invites: state.invites.filter((e) => e !== action.email) }
    default:
      return state
  }
}

export function Onboarding() {
  const setJSON = usePreferencesStore((s) => s.setJSON)
  const getJSON = usePreferencesStore((s) => s.getJSON)
  const [state, dispatch] = useReducer(reducer, EMPTY)
  const [ready, setReady] = useState(false)

  const complete = (): void => {
    // Clear the resume snapshot so a later reset (clearing onboardingComplete for
    // testing) restarts cleanly instead of resuming at the Done step.
    setJSON('onboardingState', null)
    setJSON('onboardingComplete', true)
  }

  // Mount: gather real signals + saved progress, decide the entry point.
  useEffect(() => {
    let alive = true
    void (async () => {
      const saved = getJSON<Partial<OBState> | null>('onboardingState', null)
      const [auth, calConnected, settings] = await Promise.all([
        api.invoke<{ signedIn: boolean }>(IPC_CHANNELS.CYGGIE_AUTH_STATUS).catch(() => ({ signedIn: false })),
        api.invoke<boolean>(IPC_CHANNELS.CALENDAR_IS_CONNECTED).catch(() => false),
        api.invoke<Record<string, string>>(IPC_CHANNELS.SETTINGS_GET_ALL).catch(() => ({})),
      ])
      if (!alive) return

      const hasDeepgram = Boolean(settings?.['deepgramApiKey'])
      const hasAnthropic = Boolean(settings?.['claudeApiKey'])
      const firmName = saved?.firmName ?? ''
      const gate = decideGate({
        onboardingComplete: false,
        signedIn: Boolean(auth?.signedIn),
        calendarConnected: Boolean(calConnected),
        hasDeepgram,
        hasAnthropic,
        hasFirmName: firmName.trim().length > 0,
      })

      if (gate.kind === 'app') {
        complete()
        return
      }

      dispatch({
        type: 'hydrate',
        value: {
          step: saved?.step ?? gate.startStep,
          firmName,
          slug: saved?.slug ?? '',
          slugEdited: saved?.slugEdited ?? false,
          googleConnected: Boolean(calConnected) || Boolean(saved?.googleConnected),
          keysSaved: (hasDeepgram && hasAnthropic) || Boolean(saved?.keysSaved),
          invites: saved?.invites ?? [],
        },
      })
      setReady(true)
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Mirror progress to prefs so a reload resumes where they were.
  useEffect(() => {
    if (ready) setJSON('onboardingState', state)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, state])

  if (!ready) return null

  const go = (step: number): void => dispatch({ type: 'step', value: step })

  // The flat progress bar shows for the four setup steps only (not Sign in / Done).
  // current = 0-based setup-step index. Percentage is over the full 6-screen flow
  // so Google reads ~33%, matching the design.
  const setupIndex = state.step >= STEP.workspace && state.step <= STEP.team ? state.step - 1 : -1
  const showBar = setupIndex >= 0
  const percent = Math.round((state.step / 6) * 100)

  return (
    <div className={styles.gate}>
      {showBar && (
        <FlatProgress steps={SETUP_LABELS} current={setupIndex} percent={percent} />
      )}
      <div className={styles.body}>
        {state.step === STEP.signin && (
          <SignInStep
            onSignedIn={() => go(STEP.workspace)}
            onUseLocal={() => go(STEP.workspace)}
          />
        )}
        {state.step === STEP.workspace && (
          <WorkspaceStep
            firmName={state.firmName}
            slug={state.slug}
            slugEdited={state.slugEdited}
            onFirmName={(name, derivedSlug) => dispatch({ type: 'firmName', name, derivedSlug })}
            onSlug={(value) => dispatch({ type: 'slug', value })}
            onBack={() => go(STEP.signin)}
            onNext={() => go(STEP.google)}
          />
        )}
        {state.step === STEP.google && (
          <GoogleStep
            connected={state.googleConnected}
            onConnected={() => {
              dispatch({ type: 'googleConnected' })
              go(STEP.keys)
            }}
            onBack={() => go(STEP.workspace)}
            onSkip={() => go(STEP.keys)}
          />
        )}
        {state.step === STEP.keys && (
          <KeysStep
            onSaved={() => {
              dispatch({ type: 'keysSaved' })
              go(STEP.team)
            }}
            onBack={() => go(STEP.google)}
            onSkip={() => go(STEP.team)}
          />
        )}
        {state.step === STEP.team && (
          <TeamStep
            invites={state.invites}
            onAdd={(email) => dispatch({ type: 'addInvite', email })}
            onRemove={(email) => dispatch({ type: 'removeInvite', email })}
            onBack={() => go(STEP.keys)}
            onContinue={() => go(STEP.done)}
          />
        )}
        {state.step === STEP.done && (
          <DoneStep
            summary={{
              workspace: state.firmName.trim() || null,
              googleConnected: state.googleConnected,
              keysConfigured: state.keysSaved,
              inviteCount: state.invites.length,
            }}
            onEnter={complete}
          />
        )}
      </div>
    </div>
  )
}
