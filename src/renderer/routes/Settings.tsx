import { useState, useEffect, useCallback } from 'react'
import { IPC_CHANNELS } from '../../shared/constants/channels'

import { useCalendar } from '../hooks/useCalendar'
import type { LlmProvider } from '../../shared/types/settings'
import styles from './Settings.module.css'

interface SettingsState {
  deepgramApiKey: string
  llmProvider: LlmProvider
  claudeApiKey: string
  ollamaHost: string
  ollamaModel: string
  showLiveTranscript: boolean
  defaultMaxSpeakers: string
}

export default function Settings() {
  const [settings, setSettings] = useState<SettingsState>({
    deepgramApiKey: '',
    llmProvider: 'claude',
    claudeApiKey: '',
    ollamaHost: 'http://127.0.0.1:11434',
    ollamaModel: 'llama3.1',
    showLiveTranscript: true,
    defaultMaxSpeakers: ''
  })
  const [saved, setSaved] = useState(false)
  const [storagePath, setStoragePath] = useState('')

  // Calendar state
  const { calendarConnected, connect, disconnect } = useCalendar()
  const [googleClientId, setGoogleClientId] = useState('')
  const [googleClientSecret, setGoogleClientSecret] = useState('')
  const [calendarConnecting, setCalendarConnecting] = useState(false)
  const [calendarError, setCalendarError] = useState('')
  const [hasDriveScope, setHasDriveScope] = useState(false)
  const [driveGranting, setDriveGranting] = useState(false)
  const [driveError, setDriveError] = useState('')

  useEffect(() => {
    async function load() {
      const [all, currentPath, driveScope] = await Promise.all([
        window.api.invoke<Record<string, string>>(IPC_CHANNELS.SETTINGS_GET_ALL),
        window.api.invoke<string>(IPC_CHANNELS.APP_GET_STORAGE_PATH),
        window.api.invoke<boolean>(IPC_CHANNELS.DRIVE_HAS_SCOPE)
      ])
      setHasDriveScope(driveScope)
      setSettings({
        deepgramApiKey: all.deepgramApiKey || '',
        llmProvider: (all.llmProvider as LlmProvider) || 'claude',
        claudeApiKey: all.claudeApiKey || '',
        ollamaHost: all.ollamaHost || 'http://127.0.0.1:11434',
        ollamaModel: all.ollamaModel || 'llama3.1',
        showLiveTranscript: all.showLiveTranscript !== 'false',
        defaultMaxSpeakers: all.defaultMaxSpeakers || ''
      })
      setStoragePath(currentPath)
    }
    load()
  }, [])

  const handleSave = useCallback(async () => {
    const entries = Object.entries(settings) as [string, string | boolean][]
    for (const [key, value] of entries) {
      await window.api.invoke(IPC_CHANNELS.SETTINGS_SET, key, String(value))
    }
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }, [settings])

  const handleOpenStorage = useCallback(async () => {
    await window.api.invoke(IPC_CHANNELS.APP_OPEN_STORAGE_DIR)
  }, [])

  const handleChangeStorage = useCallback(async () => {
    const newPath = await window.api.invoke<string | null>(IPC_CHANNELS.APP_CHANGE_STORAGE_DIR)
    if (newPath) {
      setStoragePath(newPath)
    }
  }, [])

  const handleConnectCalendar = useCallback(async () => {
    if (!googleClientId.trim()) {
      setCalendarError('Client ID is required')
      return
    }
    setCalendarConnecting(true)
    setCalendarError('')
    try {
      await connect(googleClientId.trim(), googleClientSecret.trim())
    } catch (err) {
      setCalendarError(String(err))
    } finally {
      setCalendarConnecting(false)
    }
  }, [googleClientId, googleClientSecret, connect])

  const handleDisconnectCalendar = useCallback(async () => {
    await disconnect()
  }, [disconnect])

  const handleGrantDriveAccess = useCallback(async () => {
    setDriveGranting(true)
    setDriveError('')
    try {
      await window.api.invoke(IPC_CHANNELS.CALENDAR_REAUTHORIZE)
      setHasDriveScope(true)
    } catch (err) {
      setDriveError(String(err))
    } finally {
      setDriveGranting(false)
    }
  }, [])

  const needsDeepgram = !settings.deepgramApiKey
  const needsClaude = settings.llmProvider === 'claude' && !settings.claudeApiKey

  return (
    <div className={styles.container}>
      {(needsDeepgram || needsClaude) && (
        <div className={styles.setupBanner}>
          <h3>Welcome to Cyggie</h3>
          <p>To get started, you'll need to provide your own API keys. They are stored locally on your machine and encrypted.</p>
          <ol>
            {needsDeepgram && (
              <li>
                <strong>Deepgram</strong> (transcription) — Create a free account at{' '}
                <a href="https://console.deepgram.com/signup" target="_blank" rel="noreferrer">
                  console.deepgram.com
                </a>
                , go to API Keys, and create a new key. Paste it into the Transcription section below.
              </li>
            )}
            {needsClaude && (
              <li>
                <strong>Anthropic</strong> (AI summaries &amp; chat) — Sign up at{' '}
                <a href="https://console.anthropic.com/" target="_blank" rel="noreferrer">
                  console.anthropic.com
                </a>
                , go to Settings &gt; API Keys, and create a new key. Paste it into the Summarization section below.
              </li>
            )}
          </ol>
          {needsClaude && (
            <p style={{ marginTop: 8, marginBottom: 0 }}>
              Prefer a free option? Select <strong>Ollama</strong> as your LLM provider below and run models locally.
            </p>
          )}
        </div>
      )}

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Transcription</h3>
        <div className={styles.field}>
          <label className={styles.label}>Deepgram API Key</label>
          <input
            type="password"
            className={styles.input}
            value={settings.deepgramApiKey}
            onChange={(e) => setSettings({ ...settings, deepgramApiKey: e.target.value })}
            placeholder="Enter your Deepgram API key"
          />
          <p className={styles.hint}>
            Get your API key at{' '}
            <a href="https://console.deepgram.com" target="_blank" rel="noreferrer">
              console.deepgram.com
            </a>
          </p>
        </div>
        <div className={styles.field}>
          <label className={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={settings.showLiveTranscript}
              onChange={(e) =>
                setSettings({ ...settings, showLiveTranscript: e.target.checked })
              }
            />
            Show live transcript during recording
          </label>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Default Speaker Count</label>
          <input
            type="number"
            className={styles.input}
            value={settings.defaultMaxSpeakers}
            onChange={(e) => setSettings({ ...settings, defaultMaxSpeakers: e.target.value })}
            placeholder="Auto-detect"
            min="1"
            max="20"
            style={{ width: 120 }}
          />
          <p className={styles.hint}>
            Limits how many speakers Deepgram identifies. When recording from a calendar event, this is set automatically from the attendee list. Leave blank for auto-detection.
          </p>
        </div>
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Summarization</h3>
        <div className={styles.field}>
          <label className={styles.label}>LLM Provider</label>
          <select
            className={styles.select}
            value={settings.llmProvider}
            onChange={(e) =>
              setSettings({ ...settings, llmProvider: e.target.value as LlmProvider })
            }
          >
            <option value="claude">Claude (Anthropic API)</option>
            <option value="ollama">Ollama (Local)</option>
          </select>
        </div>

        {settings.llmProvider === 'claude' && (
          <div className={styles.field}>
            <label className={styles.label}>Claude API Key</label>
            <input
              type="password"
              className={styles.input}
              value={settings.claudeApiKey}
              onChange={(e) => setSettings({ ...settings, claudeApiKey: e.target.value })}
              placeholder="Enter your Anthropic API key"
            />
          </div>
        )}

        {settings.llmProvider === 'ollama' && (
          <>
            <div className={styles.field}>
              <label className={styles.label}>Ollama Host</label>
              <input
                className={styles.input}
                value={settings.ollamaHost}
                onChange={(e) => setSettings({ ...settings, ollamaHost: e.target.value })}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label}>Model</label>
              <input
                className={styles.input}
                value={settings.ollamaModel}
                onChange={(e) => setSettings({ ...settings, ollamaModel: e.target.value })}
                placeholder="e.g., llama3.1"
              />
            </div>
          </>
        )}
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Google Calendar</h3>
        {calendarConnected ? (
          <div className={styles.field}>
            <div className={styles.connectedRow}>
              <span className={styles.connectedBadge}>Connected</span>
              <button className={styles.disconnectBtn} onClick={handleDisconnectCalendar}>
                Disconnect
              </button>
            </div>
            <p className={styles.hint}>
              Upcoming meetings with video links will appear in the sidebar.
            </p>
          </div>
        ) : (
          <>
            <p className={styles.hint} style={{ marginBottom: 12 }}>
              Create OAuth credentials in the{' '}
              <a
                href="https://console.cloud.google.com/apis/credentials"
                target="_blank"
                rel="noreferrer"
              >
                Google Cloud Console
              </a>
              . Enable the <strong>Calendar API</strong> and <strong>Drive API</strong>, then create a
              Desktop OAuth client.
            </p>
            <div className={styles.field}>
              <label className={styles.label}>Client ID</label>
              <input
                className={styles.input}
                value={googleClientId}
                onChange={(e) => setGoogleClientId(e.target.value)}
                placeholder="your-app.apps.googleusercontent.com"
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label}>Client Secret (optional for PKCE)</label>
              <input
                type="password"
                className={styles.input}
                value={googleClientSecret}
                onChange={(e) => setGoogleClientSecret(e.target.value)}
                placeholder="Optional"
              />
            </div>
            {calendarError && <p className={styles.error}>{calendarError}</p>}
            <button
              className={styles.connectBtn}
              onClick={handleConnectCalendar}
              disabled={calendarConnecting}
            >
              {calendarConnecting ? 'Connecting...' : 'Connect Google Calendar'}
            </button>
          </>
        )}
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Storage</h3>
        <div className={styles.field}>
          <label className={styles.label}>Storage Directory</label>
          <div className={styles.storagePathRow}>
            <span className={styles.storagePath}>{storagePath}</span>
            <button className={styles.linkBtn} onClick={handleChangeStorage}>
              Change
            </button>
          </div>
          <p className={styles.hint}>
            Transcripts and summaries are stored as Markdown files in this directory.
          </p>
          <button className={styles.linkBtn} onClick={handleOpenStorage}>
            Open in Finder
          </button>
        </div>
        {calendarConnected && !hasDriveScope && (
          <div className={styles.field}>
            <p className={styles.hint} style={{ color: 'var(--color-warning)' }}>
              To share meeting files via Google Drive link, grant Drive access.
            </p>
            {driveError && <p className={styles.error}>{driveError}</p>}
            <button
              className={styles.connectBtn}
              onClick={handleGrantDriveAccess}
              disabled={driveGranting}
              style={{ marginTop: 8 }}
            >
              {driveGranting ? 'Connecting...' : 'Grant Drive Access'}
            </button>
          </div>
        )}
      </section>

      <div className={styles.actions}>
        <button className={styles.saveBtn} onClick={handleSave}>
          {saved ? 'Saved' : 'Save Settings'}
        </button>
      </div>
    </div>
  )
}
