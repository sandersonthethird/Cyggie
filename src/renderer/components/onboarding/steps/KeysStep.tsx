import { useEffect, useState } from 'react'
import { api } from '../../../api'
import { IPC_CHANNELS } from '../../../../shared/constants/channels'
import { StepLinks } from '../StepLinks'
import { useVoiceLine } from '../../../hooks/useVoice'
import styles from '../Onboarding.module.css'

/**
 * Step 3 — provider keys. Persists Deepgram + Anthropic keys via the SAME setting
 * keys Settings reads (`deepgramApiKey` / `claudeApiKey`), so what's entered here
 * shows up there. Already-configured keys render as a checked row, not an input.
 * Skippable.
 */
export function KeysStep({
  onSaved,
  onBack,
  onSkip,
}: {
  onSaved: () => void
  onBack: () => void
  onSkip: () => void
}) {
  const [hasDeepgram, setHasDeepgram] = useState(false)
  const [hasAnthropic, setHasAnthropic] = useState(false)
  const [deepgram, setDeepgram] = useState('')
  const [anthropic, setAnthropic] = useState('')
  const [busy, setBusy] = useState(false)
  const sub = useVoiceLine('onboarding', 'keys')

  useEffect(() => {
    void api.invoke<Record<string, string>>(IPC_CHANNELS.SETTINGS_GET_ALL).then((all) => {
      setHasDeepgram(Boolean(all?.['deepgramApiKey']))
      setHasAnthropic(Boolean(all?.['claudeApiKey']))
    })
  }, [])

  const save = async (): Promise<void> => {
    setBusy(true)
    const dg = deepgram.trim()
    const an = anthropic.trim()
    if (dg) await api.invoke(IPC_CHANNELS.SETTINGS_SET, 'deepgramApiKey', dg)
    if (an) await api.invoke(IPC_CHANNELS.SETTINGS_SET, 'claudeApiKey', an)
    if (dg) setHasDeepgram(true)
    if (an) setHasAnthropic(true)
    setDeepgram('')
    setAnthropic('')
    setBusy(false)
    onSaved()
  }

  const bothConfigured = hasDeepgram && hasAnthropic
  const canSave = deepgram.trim().length > 0 || anthropic.trim().length > 0

  return (
    <div className={styles.card}>
      <div className={styles.headBlock}>
        <h1 className={styles.heading}>Add your API keys</h1>
        <p className={styles.sub}>{sub}</p>
      </div>

      <div className={styles.stack}>
        {hasDeepgram ? (
          <p className={styles.pendingNote}>✓ Deepgram key configured.</p>
        ) : (
          <div className={styles.field}>
            <label className={styles.label} htmlFor="ob-dg">Deepgram API key (recording)</label>
            <input
              id="ob-dg"
              type="password"
              className={`${styles.input} ${styles.inputMono}`}
              placeholder="Paste Deepgram API key…"
              value={deepgram}
              onChange={(e) => setDeepgram(e.target.value)}
            />
          </div>
        )}
        {hasAnthropic ? (
          <p className={styles.pendingNote}>✓ Anthropic key configured.</p>
        ) : (
          <div className={styles.field}>
            <label className={styles.label} htmlFor="ob-an">Anthropic API key (AI)</label>
            <input
              id="ob-an"
              type="password"
              className={`${styles.input} ${styles.inputMono}`}
              placeholder="sk-ant-api03-…"
              value={anthropic}
              onChange={(e) => setAnthropic(e.target.value)}
            />
          </div>
        )}
      </div>

      {bothConfigured ? (
        <button type="button" className={styles.primaryBtn} onClick={onSkip}>Continue</button>
      ) : (
        <button
          type="button"
          className={styles.primaryBtn}
          onClick={() => void save()}
          disabled={busy || !canSave}
        >
          {busy ? 'Saving…' : 'Save keys'}
        </button>
      )}
      <StepLinks onBack={onBack} onSkip={bothConfigured ? undefined : onSkip} />
    </div>
  )
}
