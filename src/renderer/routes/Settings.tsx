import { useState, useEffect, useCallback } from 'react'
import { IPC_CHANNELS } from '../../shared/constants/channels'

import { useCalendar } from '../hooks/useCalendar'
import type { LlmProvider } from '../../shared/types/settings'
import type { DriveFolderRef } from '../../shared/types/drive'
import styles from './Settings.module.css'

interface SettingsState {
  deepgramApiKey: string
  llmProvider: LlmProvider
  claudeApiKey: string
  ollamaHost: string
  ollamaModel: string
  showLiveTranscript: boolean
  defaultMaxSpeakers: string
  companyDriveRootFolder: string
}

export default function Settings() {
  const [settings, setSettings] = useState<SettingsState>({
    deepgramApiKey: '',
    llmProvider: 'claude',
    claudeApiKey: '',
    ollamaHost: 'http://127.0.0.1:11434',
    ollamaModel: 'llama3.1',
    showLiveTranscript: true,
    defaultMaxSpeakers: '',
    companyDriveRootFolder: ''
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
  const [hasDriveFilesScope, setHasDriveFilesScope] = useState(false)
  const [gmailConnected, setGmailConnected] = useState(false)
  const [gmailConnecting, setGmailConnecting] = useState(false)
  const [gmailError, setGmailError] = useState('')
  const [driveGranting, setDriveGranting] = useState(false)
  const [driveFilesGranting, setDriveFilesGranting] = useState(false)
  const [driveError, setDriveError] = useState('')
  const [folderPickerOpen, setFolderPickerOpen] = useState(false)
  const [folderPickerLoading, setFolderPickerLoading] = useState(false)
  const [folderPickerError, setFolderPickerError] = useState('')
  const [folderPickerFolders, setFolderPickerFolders] = useState<DriveFolderRef[]>([])
  const [folderPickerPath, setFolderPickerPath] = useState<DriveFolderRef[]>([])

  const refreshGoogleScopes = useCallback(async () => {
    const [driveScopeResult, driveFilesScopeResult, gmailConnectedResult] = await Promise.allSettled([
      window.api.invoke<boolean>(IPC_CHANNELS.DRIVE_HAS_SCOPE),
      window.api.invoke<boolean>(IPC_CHANNELS.DRIVE_HAS_FILES_SCOPE),
      window.api.invoke<boolean>(IPC_CHANNELS.GMAIL_IS_CONNECTED)
    ])
    setHasDriveScope(driveScopeResult.status === 'fulfilled' ? driveScopeResult.value : false)
    setHasDriveFilesScope(
      driveFilesScopeResult.status === 'fulfilled' ? driveFilesScopeResult.value : false
    )
    setGmailConnected(
      gmailConnectedResult.status === 'fulfilled' ? gmailConnectedResult.value : false
    )
  }, [])

  useEffect(() => {
    async function load() {
      try {
        const [allResult, currentPathResult] = await Promise.allSettled([
          window.api.invoke<Record<string, string>>(IPC_CHANNELS.SETTINGS_GET_ALL),
          window.api.invoke<string>(IPC_CHANNELS.APP_GET_STORAGE_PATH)
        ])

        if (allResult.status === 'fulfilled') {
          const all = allResult.value
          setSettings({
            deepgramApiKey: all.deepgramApiKey || '',
            llmProvider: (all.llmProvider as LlmProvider) || 'claude',
            claudeApiKey: all.claudeApiKey || '',
            ollamaHost: all.ollamaHost || 'http://127.0.0.1:11434',
            ollamaModel: all.ollamaModel || 'llama3.1',
            showLiveTranscript: all.showLiveTranscript !== 'false',
            defaultMaxSpeakers: all.defaultMaxSpeakers || '',
            companyDriveRootFolder: all.companyDriveRootFolder || ''
          })
        }

        if (currentPathResult.status === 'fulfilled') {
          setStoragePath(currentPathResult.value)
        }
      } finally {
        await refreshGoogleScopes()
      }
    }
    load()
  }, [refreshGoogleScopes])

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
      await refreshGoogleScopes()
    } catch (err) {
      setCalendarError(String(err))
    } finally {
      setCalendarConnecting(false)
    }
  }, [googleClientId, googleClientSecret, connect, refreshGoogleScopes])

  const handleDisconnectCalendar = useCallback(async () => {
    await disconnect()
    await refreshGoogleScopes()
  }, [disconnect, refreshGoogleScopes])

  const handleReauthorizeGoogleScopes = useCallback(async () => {
    setDriveGranting(true)
    setDriveError('')
    try {
      await window.api.invoke(IPC_CHANNELS.CALENDAR_REAUTHORIZE)
      await refreshGoogleScopes()
    } catch (err) {
      setDriveError(String(err))
    } finally {
      setDriveGranting(false)
    }
  }, [refreshGoogleScopes])

  const handleGrantDriveFilesAccess = useCallback(async () => {
    setDriveFilesGranting(true)
    setDriveError('')
    try {
      await window.api.invoke(IPC_CHANNELS.CALENDAR_REAUTHORIZE, 'drive-files')
      await refreshGoogleScopes()
    } catch (err) {
      setDriveError(String(err))
    } finally {
      setDriveFilesGranting(false)
    }
  }, [refreshGoogleScopes])

  const handleConnectGmail = useCallback(async () => {
    setGmailConnecting(true)
    setGmailError('')
    try {
      await window.api.invoke(
        IPC_CHANNELS.GMAIL_CONNECT,
        googleClientId.trim(),
        googleClientSecret.trim()
      )
      await refreshGoogleScopes()
    } catch (err) {
      setGmailError(String(err))
    } finally {
      setGmailConnecting(false)
    }
  }, [googleClientId, googleClientSecret, refreshGoogleScopes])

  const handleDisconnectGmail = useCallback(async () => {
    await window.api.invoke(IPC_CHANNELS.GMAIL_DISCONNECT)
    await refreshGoogleScopes()
  }, [refreshGoogleScopes])

  const loadDriveFolders = useCallback(async (parentId: string) => {
    setFolderPickerLoading(true)
    setFolderPickerError('')
    try {
      const folders = await window.api.invoke<DriveFolderRef[]>(
        IPC_CHANNELS.DRIVE_LIST_FOLDERS,
        parentId
      )
      setFolderPickerFolders(folders)
    } catch (err) {
      setFolderPickerFolders([])
      setFolderPickerError(String(err))
    } finally {
      setFolderPickerLoading(false)
    }
  }, [])

  const handleOpenFolderPicker = useCallback(async () => {
    if (!hasDriveFilesScope) {
      setDriveError('Drive Files access is missing. Click "Grant Drive Files Access" below, then try again.')
      setFolderPickerOpen(false)
      return
    }

    setDriveError('')
    setFolderPickerOpen(true)
    setFolderPickerPath([])
    await loadDriveFolders('root')
  }, [hasDriveFilesScope, loadDriveFolders])

  const handleFolderOpen = useCallback(async (folder: DriveFolderRef) => {
    setFolderPickerPath((prev) => [...prev, folder])
    await loadDriveFolders(folder.id)
  }, [loadDriveFolders])

  const handleFolderBack = useCallback(async () => {
    if (folderPickerPath.length === 0) return
    const nextPath = folderPickerPath.slice(0, -1)
    setFolderPickerPath(nextPath)
    const nextParentId = nextPath.length > 0 ? nextPath[nextPath.length - 1].id : 'root'
    await loadDriveFolders(nextParentId)
  }, [folderPickerPath, loadDriveFolders])

  const handleUseCurrentFolder = useCallback(() => {
    const currentFolder = folderPickerPath[folderPickerPath.length - 1]
    if (!currentFolder) return
    setSettings((prev) => ({
      ...prev,
      companyDriveRootFolder: `https://drive.google.com/drive/folders/${currentFolder.id}`
    }))
    setFolderPickerOpen(false)
  }, [folderPickerPath])

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
              Calendar events power meeting prep and attendee context.
            </p>
            <div className={styles.scopeStatusRow}>
              <span
                className={`${styles.scopePill} ${hasDriveScope ? styles.scopeGranted : styles.scopeMissing}`}
              >
                Drive Uploads: {hasDriveScope ? 'Granted' : 'Missing'}
              </span>
              <span
                className={`${styles.scopePill} ${hasDriveFilesScope ? styles.scopeGranted : styles.scopeMissing}`}
              >
                Drive Files: {hasDriveFilesScope ? 'Granted' : 'Missing'}
              </span>
            </div>
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
              . Enable the <strong>Calendar API</strong> and <strong>Drive API</strong>,
              then create a Desktop OAuth client.
            </p>
            <p className={styles.hint} style={{ marginBottom: 12 }}>
              The Google permissions dialog branding comes from your Google Cloud OAuth consent screen. If it shows
              <strong> EchoVault</strong>, update the OAuth app name to <strong>Cyggie</strong> in Google Cloud or use a
              Client ID from the correct project.
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
        <h3 className={styles.sectionTitle}>Gmail</h3>
        {gmailConnected ? (
          <div className={styles.field}>
            <div className={styles.connectedRow}>
              <span className={styles.connectedBadge}>Connected</span>
              <button className={styles.disconnectBtn} onClick={handleDisconnectGmail}>
                Disconnect
              </button>
            </div>
            <p className={styles.hint}>
              Used for company email ingest. This connection requests only
              {' '}<strong>View your email messages and settings</strong>.
            </p>
          </div>
        ) : (
          <>
            <p className={styles.hint} style={{ marginBottom: 12 }}>
              Grant Gmail access for company-specific email ingest. This request only asks for
              {' '}<strong>View your email messages and settings</strong>.
            </p>
            <p className={styles.hint} style={{ marginBottom: 12 }}>
              Gmail uses the same Google OAuth credentials configured above.
            </p>
            {gmailError && <p className={styles.error}>{gmailError}</p>}
            <button
              className={styles.connectBtn}
              onClick={handleConnectGmail}
              disabled={gmailConnecting}
            >
              {gmailConnecting ? 'Connecting...' : 'Grant Gmail Access'}
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
        <div className={styles.field}>
          <label className={styles.label}>Company Files Root Folder (Drive)</label>
          <input
            className={styles.input}
            value={settings.companyDriveRootFolder}
            onChange={(e) =>
              setSettings({ ...settings, companyDriveRootFolder: e.target.value })
            }
            placeholder="Google Drive folder URL or folder ID"
          />
          <p className={styles.hint}>
            Used by Company Detail &gt; Files. Set this to the Drive folder that contains your per-company folders.
          </p>
          <div className={styles.folderPickerActions}>
            <button
              className={styles.linkBtn}
              onClick={handleOpenFolderPicker}
            >
              Browse Drive Folders
            </button>
            {folderPickerOpen && (
              <button
                className={styles.linkBtn}
                onClick={() => setFolderPickerOpen(false)}
              >
                Close Browser
              </button>
            )}
          </div>
          {folderPickerOpen && (
            <div className={styles.folderPickerPanel}>
              <div className={styles.folderPickerToolbar}>
                <button
                  className={styles.linkBtn}
                  onClick={() => void handleFolderBack()}
                  disabled={folderPickerLoading || folderPickerPath.length === 0}
                >
                  Back
                </button>
                <span className={styles.folderPickerPath}>
                  {folderPickerPath.length > 0
                    ? `My Drive / ${folderPickerPath.map((f) => f.name).join(' / ')}`
                    : 'My Drive'}
                </span>
              </div>
              {folderPickerError && <p className={styles.error}>{folderPickerError}</p>}
              {folderPickerLoading ? (
                <p className={styles.hint}>Loading folders...</p>
              ) : folderPickerFolders.length === 0 ? (
                <p className={styles.hint}>No subfolders found.</p>
              ) : (
                <div className={styles.folderList}>
                  {folderPickerFolders.map((folder) => (
                    <button
                      key={folder.id}
                      className={styles.folderListItem}
                      onClick={() => void handleFolderOpen(folder)}
                    >
                      {folder.name}
                    </button>
                  ))}
                </div>
              )}
              <div className={styles.folderPickerFooter}>
                <button
                  className={styles.connectBtn}
                  onClick={handleUseCurrentFolder}
                  disabled={folderPickerPath.length === 0}
                >
                  Use Current Folder
                </button>
              </div>
            </div>
          )}
        </div>
        {(!hasDriveScope || !hasDriveFilesScope) && (
          <div className={styles.field}>
            {driveError && <p className={styles.error}>{driveError}</p>}
            {!hasDriveScope && (
              <div className={styles.scopeGrantRow}>
                <p className={styles.hint} style={{ color: 'var(--color-warning)' }}>
                  Grant Drive Uploads access to save and manage app-generated meeting files.
                </p>
                <button
                  className={styles.connectBtn}
                  onClick={handleReauthorizeGoogleScopes}
                  disabled={driveGranting}
                  style={{ marginTop: 8 }}
                >
                  {driveGranting ? 'Connecting...' : 'Grant Drive Upload Access'}
                </button>
              </div>
            )}
            {!hasDriveFilesScope && (
              <div className={styles.scopeGrantRow}>
                <p className={styles.hint} style={{ color: 'var(--color-warning)' }}>
                  Grant Drive Files access to browse the Company Files root folder (read-only metadata scope).
                </p>
                <button
                  className={styles.connectBtn}
                  onClick={handleGrantDriveFilesAccess}
                  disabled={driveFilesGranting}
                  style={{ marginTop: 8 }}
                >
                  {driveFilesGranting ? 'Connecting...' : 'Grant Drive Files Access'}
                </button>
              </div>
            )}
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
