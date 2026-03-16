import { useState, useEffect, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { IPC_CHANNELS } from '../../shared/constants/channels'

import { useCalendar } from '../hooks/useCalendar'
import type { LlmProvider } from '../../shared/types/settings'
import type {
  ContactEmailOnboardingOptions,
  ContactEmailOnboardingResult,
  ContactEmailOnboardingProgress
} from '../../shared/types/contact'
import type { UserProfile } from '../../shared/types/user'
import styles from './Settings.module.css'
import { CustomFieldsSettings } from '../components/settings/CustomFieldsSettings'
import { ImportModal } from '../components/settings/ImportModal'
import { api } from '../api'

function splitDriveRoots(raw: string): string[] {
  const values = raw
    .split(/[\n,;]+/)
    .map((value) => value.trim())
    .filter(Boolean)

  const unique: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    unique.push(value)
  }
  return unique
}

function formatOnboardingStage(stage: ContactEmailOnboardingProgress['stage']): string {
  if (stage === 'starting') return 'Starting'
  if (stage === 'checking') return 'Checking contact'
  if (stage === 'ingesting') return 'Ingesting emails'
  if (stage === 'enriching') return 'Enriching contact'
  if (stage === 'completed') return 'Completed'
  if (stage === 'failed') return 'Failed'
  return 'Running'
}

const CLAUDE_MODEL_LABELS: Record<string, string> = {
  'claude-opus-4-6': 'Claude Opus 4.6',
  'claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'claude-sonnet-4-5-20250929': 'Claude Sonnet 4.5',
  'claude-haiku-4-5-20251001': 'Claude Haiku 4.5',
}

const CLAUDE_MODEL_OPTIONS = [
  { value: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { value: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5' },
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
]

type SettingsTab = 'profile' | 'ai' | 'integrations' | 'import' | 'custom-fields'

const TAB_LABELS: Record<SettingsTab, string> = {
  profile: 'Profile',
  ai: 'AI & Transcription',
  integrations: 'Integrations',
  import: 'Import',
  'custom-fields': 'Custom Fields'
}

interface SettingsState {
  deepgramApiKey: string
  llmProvider: LlmProvider
  claudeApiKey: string
  claudeSummaryModel: string
  claudeEnrichmentModel: string
  ollamaHost: string
  ollamaModel: string
  showLiveTranscript: boolean
  defaultMaxSpeakers: string
  companyDriveRootFolder: string
  companyLocalFilesRoot: string
  autoSyncEmails: boolean
}

export default function Settings() {

  const [searchParams] = useSearchParams()
  const [activeTab, setActiveTab] = useState<SettingsTab>(() => {
    const tab = searchParams.get('tab')
    if (tab === 'ai' || tab === 'integrations' || tab === 'import' || tab === 'profile') return tab
    return 'profile'
  })
  const [initialLoad, setInitialLoad] = useState(true)
  const [settings, setSettings] = useState<SettingsState>({
    deepgramApiKey: '',
    llmProvider: 'claude',
    claudeApiKey: '',
    claudeSummaryModel: 'claude-sonnet-4-5-20250929',
    claudeEnrichmentModel: 'claude-haiku-4-5-20251001',
    ollamaHost: 'http://127.0.0.1:11434',
    ollamaModel: 'llama3.1',
    showLiveTranscript: true,
    defaultMaxSpeakers: '',
    companyDriveRootFolder: '',
    companyLocalFilesRoot: '',
    autoSyncEmails: true
  })
  const [saved, setSaved] = useState(false)
  const [showImportModal, setShowImportModal] = useState(false)
  const [storagePath, setStoragePath] = useState('')
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null)
  const [userDisplayName, setUserDisplayName] = useState('')
  const [userFirstName, setUserFirstName] = useState('')
  const [userLastName, setUserLastName] = useState('')
  const [userEmail, setUserEmail] = useState('')
  const [userTitle, setUserTitle] = useState('')
  const [userJobFunction, setUserJobFunction] = useState('')
  const [editingProfile, setEditingProfile] = useState(false)
  const [profileError, setProfileError] = useState('')
  const [brandingLogoDataUrl, setBrandingLogoDataUrl] = useState('')
  const [staleRelationshipDays, setStaleRelationshipDays] = useState('21')
  const [stalledPipelineDays, setStalledPipelineDays] = useState('21')
  const [passExpiryDays, setPassExpiryDays] = useState('30')
  const [contactOnboardingRunning, setContactOnboardingRunning] = useState(false)
  const [contactOnboardingUseWebLookup, setContactOnboardingUseWebLookup] = useState(false)
  const [contactOnboardingError, setContactOnboardingError] = useState('')
  const [contactOnboardingResult, setContactOnboardingResult] =
    useState<ContactEmailOnboardingResult | null>(null)
  const [contactOnboardingProgress, setContactOnboardingProgress] =
    useState<ContactEmailOnboardingProgress | null>(null)
  const [backfillRunning, setBackfillRunning] = useState(false)
  const [backfillResult, setBackfillResult] = useState<{ meetings: number; created: number; skipped: number } | null>(null)
  const [backfillError, setBackfillError] = useState('')

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
  const [driveFilesExpanded, setDriveFilesExpanded] = useState(false)
  const [editingThresholds, setEditingThresholds] = useState(false)
  const [editingTranscription, setEditingTranscription] = useState(false)
  const [editingSummarization, setEditingSummarization] = useState(false)

  const refreshGoogleScopes = useCallback(async () => {
    const [driveScopeResult, driveFilesScopeResult, gmailConnectedResult] = await Promise.allSettled([
      api.invoke<boolean>(IPC_CHANNELS.DRIVE_HAS_SCOPE),
      api.invoke<boolean>(IPC_CHANNELS.DRIVE_HAS_FILES_SCOPE),
      api.invoke<boolean>(IPC_CHANNELS.GMAIL_IS_CONNECTED)
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
        const [allResult, currentPathResult, userResult] = await Promise.allSettled([
          api.invoke<Record<string, string>>(IPC_CHANNELS.SETTINGS_GET_ALL),
          api.invoke<string>(IPC_CHANNELS.APP_GET_STORAGE_PATH),
          api.invoke<UserProfile>(IPC_CHANNELS.USER_GET_CURRENT)
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
            companyDriveRootFolder: all.companyDriveRootFolder || '',
            companyLocalFilesRoot: all.companyLocalFilesRoot || '',
            autoSyncEmails: all.autoSyncEmails !== 'false'
          })
          setStaleRelationshipDays(all.dashboardStaleRelationshipDays || '21')
          setStalledPipelineDays(all.dashboardStalledPipelineDays || '21')
          setPassExpiryDays(all.pipelinePassExpiryDays || '30')
          setBrandingLogoDataUrl(all.brandingLogoDataUrl || '')
        }

        if (currentPathResult.status === 'fulfilled') {
          setStoragePath(currentPathResult.value)
        }

        if (userResult.status === 'fulfilled') {
          setUserProfile(userResult.value)
          setUserDisplayName(userResult.value.displayName || '')
          setUserFirstName(userResult.value.firstName || '')
          setUserLastName(userResult.value.lastName || '')
          setUserEmail(userResult.value.email || '')
          setUserTitle(userResult.value.title || '')
          setUserJobFunction(userResult.value.jobFunction || '')
          const hasProfileValues = Boolean(
            userResult.value.displayName
            || userResult.value.firstName
            || userResult.value.lastName
            || userResult.value.email
            || userResult.value.title
            || userResult.value.jobFunction
          )
          setEditingProfile(!hasProfileValues)
        }
      } finally {
        await refreshGoogleScopes()
        setInitialLoad(false)
      }
    }
    load()
  }, [refreshGoogleScopes])

  // Auto-navigate new users to the AI tab when setup is needed, and open relevant edit sections
  useEffect(() => {
    if (initialLoad) return
    const deepgramMissing = !settings.deepgramApiKey
    const claudeMissing = settings.llmProvider === 'claude' && !settings.claudeApiKey
    if (deepgramMissing) setEditingTranscription(true)
    if (claudeMissing) setEditingSummarization(true)
    if ((deepgramMissing || claudeMissing) && !searchParams.get('tab')) {
      setActiveTab('ai')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialLoad])

  useEffect(() => {
    const unsubscribe = api.on(
      IPC_CHANNELS.CONTACT_ONBOARD_PROGRESS,
      (payload: unknown) => {
        if (!payload || typeof payload !== 'object') return
        setContactOnboardingProgress(payload as ContactEmailOnboardingProgress)
      }
    )
    return unsubscribe
  }, [])

  const saveUserProfile = useCallback(async (): Promise<boolean> => {
    setProfileError('')
    const nextFirstName = userFirstName.trim()
    const nextLastName = userLastName.trim()
    const fallbackDisplayName = [nextFirstName, nextLastName].filter(Boolean).join(' ').trim()
    const nextDisplayName = fallbackDisplayName || userDisplayName.trim()
    if (!nextDisplayName) {
      setProfileError('Display name is required.')
      setActiveTab('profile')
      return false
    }

    const updatedProfile = await api.invoke<UserProfile>(
      IPC_CHANNELS.USER_UPDATE_CURRENT,
      {
        displayName: nextDisplayName,
        firstName: nextFirstName || null,
        lastName: nextLastName || null,
        email: userEmail.trim() || null,
        title: userTitle.trim() || null,
        jobFunction: userJobFunction.trim() || null
      }
    )
    setUserProfile(updatedProfile)
    setUserDisplayName(updatedProfile.displayName)
    setUserFirstName(updatedProfile.firstName || '')
    setUserLastName(updatedProfile.lastName || '')
    setUserEmail(updatedProfile.email || '')
    setUserTitle(updatedProfile.title || '')
    setUserJobFunction(updatedProfile.jobFunction || '')
    return true
  }, [userDisplayName, userFirstName, userLastName, userEmail, userTitle, userJobFunction])

  const handleSaveProfile = useCallback(async () => {
    const savedProfile = await saveUserProfile()
    if (!savedProfile) return
    setEditingProfile(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }, [saveUserProfile])

  const handleCancelProfileEdit = useCallback(() => {
    setProfileError('')
    if (userProfile) {
      setUserDisplayName(userProfile.displayName || '')
      setUserFirstName(userProfile.firstName || '')
      setUserLastName(userProfile.lastName || '')
      setUserEmail(userProfile.email || '')
      setUserTitle(userProfile.title || '')
      setUserJobFunction(userProfile.jobFunction || '')
    }
    setEditingProfile(false)
  }, [userProfile])

  const handleSave = useCallback(async () => {
    const savedProfile = await saveUserProfile()
    if (!savedProfile) return

    const entries = Object.entries(settings) as [string, string | boolean][]
    for (const [key, value] of entries) {
      await api.invoke(IPC_CHANNELS.SETTINGS_SET, key, String(value))
    }
    await api.invoke(
      IPC_CHANNELS.SETTINGS_SET,
      'dashboardStaleRelationshipDays',
      staleRelationshipDays.trim() || '21'
    )
    await api.invoke(
      IPC_CHANNELS.SETTINGS_SET,
      'dashboardStalledPipelineDays',
      stalledPipelineDays.trim() || '21'
    )
    await api.invoke(
      IPC_CHANNELS.SETTINGS_SET,
      'pipelinePassExpiryDays',
      passExpiryDays.trim() || '30'
    )
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }, [settings, saveUserProfile, staleRelationshipDays, stalledPipelineDays, passExpiryDays])

  const handleOpenStorage = useCallback(async () => {
    await api.invoke(IPC_CHANNELS.APP_OPEN_STORAGE_DIR)
  }, [])

  const handleChangeStorage = useCallback(async () => {
    const newPath = await api.invoke<string | null>(IPC_CHANNELS.APP_CHANGE_STORAGE_DIR)
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
      await api.invoke(IPC_CHANNELS.CALENDAR_REAUTHORIZE)
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
      await api.invoke(IPC_CHANNELS.CALENDAR_REAUTHORIZE, 'drive-files')
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
      await api.invoke(
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
    await api.invoke(IPC_CHANNELS.GMAIL_DISCONNECT)
    await refreshGoogleScopes()
  }, [refreshGoogleScopes])

  const handleRunContactOnboarding = useCallback(async () => {
    setContactOnboardingRunning(true)
    setContactOnboardingError('')
    setContactOnboardingResult(null)
    setContactOnboardingProgress(null)
    try {
      const options: ContactEmailOnboardingOptions = {
        ingestOnlyMissingEmailHistory: true,
        webLookup: contactOnboardingUseWebLookup,
        webLookupLimit: contactOnboardingUseWebLookup ? 500 : undefined
      }
      const result = await api.invoke<ContactEmailOnboardingResult>(
        IPC_CHANNELS.CONTACT_ONBOARD_FROM_EMAIL,
        options
      )
      setContactOnboardingResult(result)
    } catch (err) {
      setContactOnboardingError(String(err))
    } finally {
      setContactOnboardingRunning(false)
    }
  }, [contactOnboardingUseWebLookup])

  const needsDeepgram = !settings.deepgramApiKey
  const needsClaude = settings.llmProvider === 'claude' && !settings.claudeApiKey
  const needsSetup = needsDeepgram || needsClaude
  const profileName = userDisplayName.trim()
    || [userFirstName.trim(), userLastName.trim()].filter(Boolean).join(' ')
    || 'No name set'
  const profileTitle = userTitle.trim() || 'No title'
  const profileJobFunction = userJobFunction.trim() || 'No job function'
  const profileEmail = userEmail.trim() || 'No email'

  return (
    <div className={styles.container}>
      <div className={styles.tabRow}>
        {(['profile', 'ai', 'integrations', 'import', 'custom-fields'] as SettingsTab[]).map((tab) => (
          <button
            key={tab}
            className={`${styles.tab} ${activeTab === tab ? styles.activeTab : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {TAB_LABELS[tab]}
            {tab === 'ai' && needsSetup && (
              <span className={styles.tabBadge}>Setup needed</span>
            )}
          </button>
        ))}
      </div>

      {activeTab === 'profile' && (
        <>
      <section className={styles.section}>
        <div className={styles.sectionTitleRow}>
          <h3 className={styles.sectionTitle}>User Profile</h3>
          {!editingProfile && (
            <button
              className={styles.linkBtn}
              onClick={() => setEditingProfile(true)}
            >
              Edit
            </button>
          )}
        </div>
        {!editingProfile ? (
          <>
            <div className={styles.profileIdentity}>
              <p className={styles.profileName}>{profileName}</p>
              <p className={styles.profileEmail}>{profileEmail}</p>
            </div>
            <p className={styles.profileMeta}>Title: {profileTitle}</p>
            <p className={styles.profileMeta}>Job function: {profileJobFunction}</p>
            <p className={styles.hint}>
              Your profile is used to personalize meeting summaries and task extraction.
            </p>
          </>
        ) : (
          <>
            <div className={styles.fieldRow}>
              <div className={styles.field}>
                <label className={styles.label}>First Name</label>
                <input
                  className={styles.input}
                  value={userFirstName}
                  onChange={(e) => setUserFirstName(e.target.value)}
                  placeholder="Your first name"
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label}>Last Name</label>
                <input
                  className={styles.input}
                  value={userLastName}
                  onChange={(e) => setUserLastName(e.target.value)}
                  placeholder="Your last name"
                />
              </div>
            </div>
            <div className={styles.field}>
              <label className={styles.label}>Display Name</label>
              <input
                className={styles.input}
                value={userDisplayName}
                onChange={(e) => setUserDisplayName(e.target.value)}
                placeholder="Your name"
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label}>Email</label>
              <input
                className={styles.input}
                value={userEmail}
                onChange={(e) => setUserEmail(e.target.value)}
                placeholder="you@firm.com"
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label}>Title</label>
              <input
                className={styles.input}
                value={userTitle}
                onChange={(e) => setUserTitle(e.target.value)}
                placeholder="e.g. Partner, Principal, Associate"
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label}>Job Function</label>
              <input
                className={styles.input}
                value={userJobFunction}
                onChange={(e) => setUserJobFunction(e.target.value)}
                placeholder="e.g. Venture Capital, Private Equity"
              />
              <p className={styles.hint}>
                Your profile is used to personalize meeting summaries and task extraction.
              </p>
            </div>
            <div className={styles.profileEditActions}>
              <button className={styles.connectBtn} onClick={handleSaveProfile}>
                Save Profile
              </button>
              <button className={styles.linkBtn} onClick={handleCancelProfileEdit}>
                Cancel
              </button>
            </div>
          </>
        )}
        {profileError && <p className={styles.error}>{profileError}</p>}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionTitleRow}>
          <h3 className={styles.sectionTitle}>Relationship Thresholds</h3>
          {!editingThresholds && (
            <button className={styles.linkBtn} onClick={() => setEditingThresholds(true)}>
              Edit
            </button>
          )}
        </div>
        {editingThresholds ? (
          <>
            <div className={styles.field}>
              <label className={styles.label}>Stale relationship after (days)</label>
              <input
                type="number"
                className={styles.input}
                value={staleRelationshipDays}
                onChange={(event) => setStaleRelationshipDays(event.target.value)}
                min="1"
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label}>Stalled pipeline after (days)</label>
              <input
                type="number"
                className={styles.input}
                value={stalledPipelineDays}
                onChange={(event) => setStalledPipelineDays(event.target.value)}
                min="1"
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label}>Remove Pass items from pipeline after (days)</label>
              <input
                type="number"
                className={styles.input}
                value={passExpiryDays}
                onChange={(event) => setPassExpiryDays(event.target.value)}
                min="1"
              />
            </div>
            <div className={styles.profileEditActions}>
              <button className={styles.connectBtn} onClick={() => setEditingThresholds(false)}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <p className={styles.profileMeta}>Stale relationship after: {staleRelationshipDays} days</p>
            <p className={styles.profileMeta}>Stalled pipeline after: {stalledPipelineDays} days</p>
            <p className={styles.profileMeta}>Pass items expire after: {passExpiryDays} days</p>
          </>
        )}
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Branding</h3>
        <p className={styles.hint}>
          Upload your firm logo. It will appear in the sidebar and at the top of exported memos.
        </p>
        <div className={styles.brandingLogoRow}>
          {brandingLogoDataUrl ? (
            <img src={brandingLogoDataUrl} alt="Firm logo" className={styles.brandingLogoPreview} />
          ) : (
            <div className={styles.brandingLogoPlaceholder}>No logo set</div>
          )}
          <div className={styles.brandingLogoActions}>
            <button
              className={styles.connectBtn}
              onClick={async () => {
                const dataUrl = await api.invoke<string | null>(IPC_CHANNELS.APP_PICK_LOGO_FILE)
                if (dataUrl) {
                  setBrandingLogoDataUrl(dataUrl)
                  await api.invoke(IPC_CHANNELS.SETTINGS_SET, 'brandingLogoDataUrl', dataUrl)
                }
              }}
            >
              {brandingLogoDataUrl ? 'Replace Logo' : 'Upload Logo'}
            </button>
            {brandingLogoDataUrl && (
              <button
                className={styles.linkBtn}
                onClick={async () => {
                  setBrandingLogoDataUrl('')
                  await api.invoke(IPC_CHANNELS.SETTINGS_SET, 'brandingLogoDataUrl', '')
                }}
              >
                Remove
              </button>
            )}
          </div>
        </div>
      </section>

        </>
      )}

      {activeTab === 'ai' && (
        <>
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
        <div className={styles.sectionTitleRow}>
          <h3 className={styles.sectionTitle}>Transcription</h3>
          {!editingTranscription && (
            <button className={styles.linkBtn} onClick={() => setEditingTranscription(true)}>
              Edit
            </button>
          )}
        </div>
        <p className={styles.hint} style={{ marginBottom: 12 }}>
          Powered by Deepgram. Converts meeting audio into a real-time transcript during recording.
        </p>
        {editingTranscription ? (
          <>
            <div className={styles.field}>
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
            <div className={styles.inlineFieldRow}>
              <span className={styles.inlineFieldLabel}>Live transcript</span>
              <select
                className={styles.inlineSelect}
                value={settings.showLiveTranscript ? 'on' : 'off'}
                onChange={(e) => setSettings({ ...settings, showLiveTranscript: e.target.value === 'on' })}
              >
                <option value="on">On</option>
                <option value="off">Off</option>
              </select>
            </div>
            <div className={styles.inlineFieldRow}>
              <span className={styles.inlineFieldLabel}>Default speaker count</span>
              <select
                className={styles.inlineSelect}
                value={settings.defaultMaxSpeakers || ''}
                onChange={(e) => setSettings({ ...settings, defaultMaxSpeakers: e.target.value })}
              >
                <option value="">Auto-detect</option>
                {Array.from({ length: 20 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={String(n)}>{n}</option>
                ))}
              </select>
            </div>
            <div className={styles.profileEditActions}>
              <button className={styles.connectBtn} onClick={() => setEditingTranscription(false)}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <p className={styles.profileMeta}>
              API key: {settings.deepgramApiKey ? '••••••••' : <span style={{ color: 'var(--color-danger, #ef4444)' }}>Not configured</span>}
            </p>
            <div className={styles.inlineFieldRow}>
              <span className={styles.inlineFieldLabel}>Live transcript</span>
              <select
                className={styles.inlineSelect}
                value={settings.showLiveTranscript ? 'on' : 'off'}
                onChange={(e) => setSettings({ ...settings, showLiveTranscript: e.target.value === 'on' })}
              >
                <option value="on">On</option>
                <option value="off">Off</option>
              </select>
            </div>
            <div className={styles.inlineFieldRow}>
              <span className={styles.inlineFieldLabel}>Default speaker count</span>
              <select
                className={styles.inlineSelect}
                value={settings.defaultMaxSpeakers || ''}
                onChange={(e) => setSettings({ ...settings, defaultMaxSpeakers: e.target.value })}
              >
                <option value="">Auto-detect</option>
                {Array.from({ length: 20 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={String(n)}>{n}</option>
                ))}
              </select>
            </div>
          </>
        )}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionTitleRow}>
          <h3 className={styles.sectionTitle}>Summarization</h3>
          {!editingSummarization && (
            <button className={styles.linkBtn} onClick={() => setEditingSummarization(true)}>
              Edit
            </button>
          )}
        </div>
        <p className={styles.hint} style={{ marginBottom: 12 }}>
          Generates meeting summaries, extracts action items, and powers AI chat. Also used for contact web enrichment (title and LinkedIn inference). Uses Claude (Anthropic API) or a local Ollama model.
        </p>
        {editingSummarization ? (
          <>
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
              <>
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
                <div className={styles.inlineFieldRow}>
                  <span className={styles.inlineFieldLabel}>Summary model</span>
                  <select
                    className={styles.inlineSelect}
                    value={settings.claudeSummaryModel}
                    onChange={(e) => setSettings({ ...settings, claudeSummaryModel: e.target.value })}
                  >
                    {CLAUDE_MODEL_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
                <div className={styles.inlineFieldRow}>
                  <span className={styles.inlineFieldLabel}>Enrichment model</span>
                  <select
                    className={styles.inlineSelect}
                    value={settings.claudeEnrichmentModel}
                    onChange={(e) => setSettings({ ...settings, claudeEnrichmentModel: e.target.value })}
                  >
                    {CLAUDE_MODEL_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
              </>
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
            <div className={styles.profileEditActions}>
              <button className={styles.connectBtn} onClick={() => setEditingSummarization(false)}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <p className={styles.profileMeta}>
              Provider: {settings.llmProvider === 'claude' ? 'Claude (Anthropic API)' : 'Ollama (Local)'}
            </p>
            {settings.llmProvider === 'claude' && (
              <>
                <p className={styles.profileMeta}>
                  API key: {settings.claudeApiKey ? '••••••••' : <span style={{ color: 'var(--color-danger, #ef4444)' }}>Not configured</span>}
                </p>
                <p className={styles.profileMeta}>
                  Summary model: {CLAUDE_MODEL_LABELS[settings.claudeSummaryModel] ?? settings.claudeSummaryModel}
                </p>
                <p className={styles.profileMeta}>
                  Enrichment model: {CLAUDE_MODEL_LABELS[settings.claudeEnrichmentModel] ?? settings.claudeEnrichmentModel}
                </p>
              </>
            )}
            {settings.llmProvider === 'ollama' && (
              <>
                <p className={styles.profileMeta}>Host: {settings.ollamaHost}</p>
                <p className={styles.profileMeta}>Model: {settings.ollamaModel || 'Not set'}</p>
              </>
            )}
          </>
        )}
      </section>
        </>
      )}

      {activeTab === 'integrations' && (
        <>
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
        {gmailConnected && (
          <div className={styles.inlineFieldRow} style={{ marginTop: 12 }}>
            <span className={styles.inlineFieldLabel}>Auto-sync emails on open</span>
            <select
              className={styles.inlineSelect}
              value={settings.autoSyncEmails ? 'on' : 'off'}
              onChange={(e) => setSettings({ ...settings, autoSyncEmails: e.target.value === 'on' })}
            >
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
          </div>
        )}
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Google Drive</h3>
        <p className={styles.hint} style={{ marginBottom: 12 }}>
          Drive Uploads lets Cyggie save meeting files to your Drive. Drive Files allows browsing
          company folders in Company Detail &gt; Files. Both permissions use the Google OAuth
          credentials configured in Google Calendar above.
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
      </section>

      {/* Transcripts & Summaries */}
      <section className={styles.section}>
        <div className={styles.sectionTitleRow}>
          <h3 className={styles.sectionTitle}>Transcripts &amp; Summaries</h3>
          <div className={styles.storageCardActions}>
            <button className={styles.linkBtn} onClick={handleChangeStorage}>Edit</button>
            <button className={styles.linkBtn} onClick={handleOpenStorage}>Open in Finder</button>
          </div>
        </div>
        <p className={styles.hint}>Meeting transcripts and AI summaries stored as Markdown files.</p>
        {!storagePath && <p className={styles.storageCardStatusWarn} style={{ marginTop: 8 }}>Not configured</p>}
      </section>

      {/* Company Files */}
      <section className={styles.section}>
        <div className={styles.sectionTitleRow}>
          <h3 className={styles.sectionTitle}>Company Files</h3>
          <div className={styles.storageCardActions}>
            <button
              className={styles.linkBtn}
              onClick={async () => {
                const chosen = await api.invoke<string | null>(
                  IPC_CHANNELS.APP_PICK_FOLDER
                )
                if (chosen) {
                  setSettings((prev) => ({ ...prev, companyLocalFilesRoot: chosen }))
                }
              }}
            >
              {settings.companyLocalFilesRoot ? 'Edit' : 'Select Folder'}
            </button>
            {settings.companyLocalFilesRoot && (
              <button
                className={styles.linkBtn}
                onClick={() => api.invoke(IPC_CHANNELS.APP_OPEN_PATH, settings.companyLocalFilesRoot)}
              >
                Open in Finder
              </button>
            )}
          </div>
        </div>
        <p className={styles.hint}>
          Root folder containing per-company sub-folders. The app matches folders by company name.
          Works with local folders and Google Drive folders synced via Drive for Desktop.
        </p>
        {!settings.companyLocalFilesRoot && <p className={styles.storageCardStatusWarn} style={{ marginTop: 8 }}>Not configured</p>}
        {/* Advanced: Drive URL fallback */}
        <button
          className={styles.storageCardToggle}
          onClick={() => setDriveFilesExpanded((v) => !v)}
          style={{ marginTop: 10 }}
        >
          {driveFilesExpanded ? 'Hide advanced' : 'Advanced'}
        </button>
        {driveFilesExpanded && (
          <div style={{ marginTop: 10 }}>
            <p className={styles.hint} style={{ marginBottom: 8 }}>
              If you can&apos;t select the folder locally, paste Google Drive folder URLs here instead.
              The app will use the Drive API to find company files. One URL or folder ID per line.
            </p>
            <textarea
              className={styles.input}
              value={settings.companyDriveRootFolder}
              onChange={(e) =>
                setSettings({ ...settings, companyDriveRootFolder: e.target.value })
              }
              rows={3}
              placeholder="https://drive.google.com/drive/folders/..."
            />
            {(!hasDriveScope || !hasDriveFilesScope) && (
              <div style={{ marginTop: 12 }}>
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
                      Grant Drive Files access to query company files via the Drive API (read-only).
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
          </div>
        )}
      </section>
        </>
      )}

      {activeTab === 'import' && (
        <>
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Contact Onboarding</h3>
        <div className={styles.field}>
          <p className={styles.hint}>
            One-time pass: ingest Gmail threads for all contacts, enrich name/company details, and
            backfill Contact &gt; Emails for contacts missing email history.
          </p>
          <label className={styles.checkboxLabel} style={{ marginTop: 8 }}>
            <input
              type="checkbox"
              checked={contactOnboardingUseWebLookup}
              onChange={(event) => setContactOnboardingUseWebLookup(event.target.checked)}
            />
            Use web lookup for missing title/company/LinkedIn
          </label>
          <div className={styles.onboardingActionRow}>
            <button
              className={styles.connectBtn}
              onClick={handleRunContactOnboarding}
              disabled={contactOnboardingRunning}
            >
              {contactOnboardingRunning
                ? 'Running contact onboarding...'
                : 'Ingest + Enrich Contacts from Gmail'}
            </button>
          </div>
          {contactOnboardingRunning && (
            <div className={styles.onboardingProgress}>
              {contactOnboardingProgress ? (
                <>
                  <p className={styles.hint}>
                    {formatOnboardingStage(contactOnboardingProgress.stage)}: {' '}
                    {contactOnboardingProgress.completedContacts}/
                    {contactOnboardingProgress.totalContacts}
                    {contactOnboardingProgress.currentContactName
                      ? ` (${contactOnboardingProgress.currentContactName})`
                      : ''}
                  </p>
                  <p className={styles.hint}>
                    Ingested {contactOnboardingProgress.ingestedContacts}, skipped already ingested{' '}
                    {contactOnboardingProgress.skippedAlreadyIngested}, ingest failures{' '}
                    {contactOnboardingProgress.ingestFailures}, enrichment failures{' '}
                    {contactOnboardingProgress.enrichmentFailures}.
                  </p>
                </>
              ) : (
                <p className={styles.hint}>Starting contact onboarding...</p>
              )}
            </div>
          )}
          {contactOnboardingError && (
            <p className={styles.error}>{contactOnboardingError}</p>
          )}
          {contactOnboardingResult && (
            <div className={styles.onboardingResult}>
              <p className={styles.hint}>
                Scanned {contactOnboardingResult.scannedContacts} contacts. Ingested{' '}
                {contactOnboardingResult.ingestedContacts}, skipped as already ingested{' '}
                {contactOnboardingResult.skippedAlreadyIngested}, enriched{' '}
                {contactOnboardingResult.enrichedContacts}.
              </p>
              <p className={styles.hint}>
                Messages inserted/updated: {contactOnboardingResult.insertedMessageCount}/
                {contactOnboardingResult.updatedMessageCount}, linked messages:{' '}
                {contactOnboardingResult.linkedMessageCount}, linked contacts:{' '}
                {contactOnboardingResult.linkedContactCount}.
              </p>
              <p className={styles.hint}>
                Updates: names {contactOnboardingResult.updatedNames}, companies{' '}
                {contactOnboardingResult.linkedCompanies}, titles{' '}
                {contactOnboardingResult.updatedTitles}, LinkedIn{' '}
                {contactOnboardingResult.updatedLinkedinUrls}.
              </p>
              {(contactOnboardingResult.ingestFailures > 0
                || contactOnboardingResult.enrichmentFailures > 0) && (
                <p className={styles.hint} style={{ color: 'var(--color-warning)' }}>
                  Failures: ingest {contactOnboardingResult.ingestFailures}, enrich{' '}
                  {contactOnboardingResult.enrichmentFailures}.
                </p>
              )}
            </div>
          )}
        </div>
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Import Data</h3>
        <p className={styles.hint} style={{ marginBottom: 12 }}>
          Import contacts and companies from a CSV file. Cyggie will suggest field mappings automatically.
        </p>
        <button className={styles.connectBtn} onClick={() => setShowImportModal(true)}>
          Import CSV
        </button>
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Meeting Notes Backfill</h3>
        <div className={styles.field}>
          <p className={styles.hint}>
            Populates Contact and Company notes from historical meeting summaries.
            Safe to run multiple times — already-backfilled notes are skipped.
          </p>
          <div className={styles.onboardingActionRow}>
            <button
              className={styles.connectBtn}
              onClick={async () => {
                setBackfillRunning(true)
                setBackfillResult(null)
                setBackfillError('')
                try {
                  const result = await api.invoke<{ meetings: number; created: number; skipped: number }>(
                    IPC_CHANNELS.MEETING_NOTES_BACKFILL
                  )
                  setBackfillResult(result)
                } catch (err) {
                  setBackfillError(String(err))
                } finally {
                  setBackfillRunning(false)
                }
              }}
              disabled={backfillRunning}
            >
              {backfillRunning ? 'Running…' : 'Backfill Meeting Notes'}
            </button>
          </div>
          {backfillResult && (
            <p className={styles.hint}>
              Done — {backfillResult.meetings} meetings scanned, {backfillResult.created} notes created,{' '}
              {backfillResult.skipped} skipped (already present).
            </p>
          )}
          {backfillError && <p className={styles.error}>{backfillError}</p>}
        </div>
      </section>
        </>
      )}

      <div className={styles.actions}>
        <button className={styles.saveBtn} onClick={handleSave}>
          {saved ? 'Saved' : 'Save Settings'}
        </button>
      </div>

      {activeTab === 'custom-fields' && (
        <CustomFieldsSettings />
      )}

      {showImportModal && (
        <ImportModal onClose={() => setShowImportModal(false)} />
      )}
    </div>
  )
}
