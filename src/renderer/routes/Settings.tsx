import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { IPC_CHANNELS } from '../../shared/constants/channels'

import { useCalendar } from '../hooks/useCalendar'
import type { LlmProvider } from '../../shared/types/settings'
import type {
  ContactEmailOnboardingOptions,
  ContactEmailOnboardingResult,
  ContactEmailOnboardingProgress
} from '../../shared/types/contact'
import type { UserProfile } from '../../shared/types/user'
import type { ImportFormat } from '../../shared/types/note'
import styles from './Settings.module.css'
import { CustomFieldsSettings } from '../components/settings/CustomFieldsSettings'
import { IntegrationsPanel } from '../components/settings/IntegrationsPanel'
import TemplatesPanel from './Templates'
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

const OPENAI_MODEL_OPTIONS = [
  { value: 'gpt-4o', label: 'GPT-4o' },
  { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
  { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
  { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo' },
]

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

type SettingsTab = 'profile' | 'ai' | 'integrations' | 'import' | 'custom-fields' | 'templates'

const TAB_LABELS: Record<SettingsTab, string> = {
  profile: 'Profile',
  ai: 'AI & Transcription',
  integrations: 'Integrations',
  import: 'Import',
  'custom-fields': 'Custom Fields',
  templates: 'Templates',
}

interface SettingsState {
  deepgramApiKey: string
  llmProvider: LlmProvider
  claudeApiKey: string
  claudeSummaryModel: string
  claudeEnrichmentModel: string
  ollamaHost: string
  ollamaModel: string
  openAiApiKey: string
  openAiSummaryModel: string
  openAiEnrichmentModel: string
  showLiveTranscript: boolean
  defaultMaxSpeakers: string
  companyDriveRootFolder: string
  companyLocalFilesRoot: string
  autoSyncEmails: boolean
  exaApiKey: string
}

export default function Settings() {

  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const [activeTab, setActiveTab] = useState<SettingsTab>(() => {
    const tab = searchParams.get('tab')
    if (tab === 'ai' || tab === 'integrations' || tab === 'import' || tab === 'profile' || tab === 'templates') return tab
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
    openAiApiKey: '',
    openAiSummaryModel: 'gpt-4o',
    openAiEnrichmentModel: 'gpt-4o-mini',
    showLiveTranscript: true,
    defaultMaxSpeakers: '',
    companyDriveRootFolder: '',
    companyLocalFilesRoot: '',
    autoSyncEmails: true,
    exaApiKey: ''
  })
  const [apiKeyModalOpen, setApiKeyModalOpen] = useState(false)
  const [apiKeyModalProvider, setApiKeyModalProvider] = useState<'claude' | 'openai' | 'exa'>('claude')
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const [showApiKeyDraft, setShowApiKeyDraft] = useState(false)
  const [isSavingKey, setIsSavingKey] = useState(false)
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
  const [brandingFirmName, setBrandingFirmName] = useState('')
  const [brandingPrimaryColor, setBrandingPrimaryColor] = useState('#374151')
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
  const [fixNamesRunning, setFixNamesRunning] = useState(false)
  const [fixNamesResult, setFixNamesResult] = useState<{ fixed: number; merged: number; changes: Array<{ id: string; before: string; after: string; action: 'renamed' | 'merged' }> } | null>(null)
  const [fixNamesError, setFixNamesError] = useState('')
  const [fixNamesExpanded, setFixNamesExpanded] = useState(false)
  const [notesImportFormat, setNotesImportFormat] = useState<ImportFormat>('apple-notes')
  const [notesImportRunning, setNotesImportRunning] = useState(false)
  const [notesImportProgress, setNotesImportProgress] = useState<{ created: number; skipped: number; total: number } | null>(null)
  const [notesImportResult, setNotesImportResult] = useState<{ created: number; skipped: number; errors: string[]; imagesExtracted?: number; foldersFound?: number } | null>(null)
  const [notesImportError, setNotesImportError] = useState('')
  const [notesImportScan, setNotesImportScan] = useState<{ total: number; alreadyExist: number; folders: number; folderPath: string } | null>(null)
  const [showImportErrors, setShowImportErrors] = useState(false)
  const [testKeyStatus, setTestKeyStatus] = useState<{ ok: boolean; message: string } | null>(null)
  const [isTesting, setIsTesting] = useState(false)

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
  const [calendarAccountEmail, setCalendarAccountEmail] = useState<string | null>(null)
  const [gmailAccountEmail, setGmailAccountEmail] = useState<string | null>(null)
  const [editingThresholds, setEditingThresholds] = useState(false)
  const [editingTranscription, setEditingTranscription] = useState(false)

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

  const refreshAccountEmails = useCallback(async () => {
    try {
      const result = await api.invoke<{ calendarEmail: string | null; gmailEmail: string | null }>(
        IPC_CHANNELS.GOOGLE_ACCOUNT_EMAILS
      )
      setCalendarAccountEmail(result?.calendarEmail ?? null)
      setGmailAccountEmail(result?.gmailEmail ?? null)
    } catch {
      // Non-fatal — email badges will be absent
    }
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
            claudeSummaryModel: all.claudeSummaryModel || 'claude-sonnet-4-5-20250929',
            claudeEnrichmentModel: all.claudeEnrichmentModel || 'claude-haiku-4-5-20251001',
            ollamaHost: all.ollamaHost || 'http://127.0.0.1:11434',
            ollamaModel: all.ollamaModel || 'llama3.1',
            openAiApiKey: all.openAiApiKey || '',
            openAiSummaryModel: all.openAiSummaryModel || 'gpt-4o',
            openAiEnrichmentModel: all.openAiEnrichmentModel || 'gpt-4o-mini',
            showLiveTranscript: all.showLiveTranscript !== 'false',
            defaultMaxSpeakers: all.defaultMaxSpeakers || '',
            companyDriveRootFolder: all.companyDriveRootFolder || '',
            companyLocalFilesRoot: all.companyLocalFilesRoot || '',
            autoSyncEmails: all.autoSyncEmails !== 'false',
            exaApiKey: all.exaApiKey || ''
          })
          setStaleRelationshipDays(all.dashboardStaleRelationshipDays || '21')
          setStalledPipelineDays(all.dashboardStalledPipelineDays || '21')
          setPassExpiryDays(all.pipelinePassExpiryDays || '30')
          setBrandingLogoDataUrl(all.brandingLogoDataUrl || '')
          setBrandingFirmName(all.brandingFirmName || '')
          setBrandingPrimaryColor(all.brandingPrimaryColor || '#374151')
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
        await refreshAccountEmails()
        setInitialLoad(false)
      }
    }
    load()
  }, [refreshGoogleScopes, refreshAccountEmails])

  // Auto-navigate new users to the AI tab when setup is needed, and open relevant edit sections
  useEffect(() => {
    if (initialLoad) return
    const deepgramMissing = !settings.deepgramApiKey
    const claudeMissing = settings.llmProvider === 'claude' && !settings.claudeApiKey
    const openAiMissing = settings.llmProvider === 'openai' && !settings.openAiApiKey
    if (deepgramMissing) setEditingTranscription(true)
    if ((deepgramMissing || claudeMissing || openAiMissing) && !searchParams.get('tab')) {
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

  useEffect(() => {
    if (!apiKeyModalOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setApiKeyModalOpen(false)
        setTestKeyStatus(null)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [apiKeyModalOpen])

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

  // Listen for import progress events from main process
  useEffect(() => {
    const unsub = api.on(IPC_CHANNELS.NOTES_IMPORT_PROGRESS, (progress: { created: number; skipped: number; total: number }) => {
      setNotesImportProgress(progress)
    })
    return unsub
  }, [])

  const handleScanNotes = useCallback(async () => {
    setNotesImportScan(null)
    setNotesImportResult(null)
    setNotesImportError('')
    setShowImportErrors(false)
    try {
      const result = await api.invoke<{ total: number; alreadyExist: number; folders: number; folderPath: string }>(
        IPC_CHANNELS.NOTES_IMPORT_SCAN,
        notesImportFormat
      )
      if (result) setNotesImportScan(result)
    } catch (err) {
      setNotesImportError(String(err))
    }
  }, [notesImportFormat])

  const handleImportNotes = useCallback(async () => {
    if (!notesImportScan) return
    setNotesImportRunning(true)
    setNotesImportProgress(null)
    setNotesImportResult(null)
    setShowImportErrors(false)
    try {
      const result = await api.invoke<{ created: number; skipped: number; errors: string[]; imagesExtracted: number; foldersFound: number }>(
        IPC_CHANNELS.NOTES_IMPORT_FOLDER,
        notesImportScan.folderPath,
        notesImportFormat
      )
      if (result) setNotesImportResult(result)
    } catch (err) {
      setNotesImportError(String(err))
    } finally {
      setNotesImportRunning(false)
      setNotesImportScan(null)
    }
  }, [notesImportScan, notesImportFormat])

  const handleCancelImport = useCallback(async () => {
    await api.invoke(IPC_CHANNELS.NOTES_IMPORT_CANCEL)
  }, [])

  const handleSave = useCallback(async () => {
    const savedProfile = await saveUserProfile()
    if (!savedProfile) return

    const entries = Object.entries(settings) as [string, string | boolean][]
    for (const [key, value] of entries) {
      const stored = key === 'claudeApiKey' ? String(value).trim() : String(value)
      await api.invoke(IPC_CHANNELS.SETTINGS_SET, key, stored)
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

  const handleTestKey = useCallback(async (provider: 'claude' | 'openai', apiKey: string): Promise<{ ok: boolean; message: string }> => {
    setIsTesting(true)
    setTestKeyStatus(null)
    try {
      const result = await api.invoke<{ ok: boolean; message: string }>(
        IPC_CHANNELS.SETTINGS_TEST_LLM_KEY,
        { provider, apiKey }
      )
      setTestKeyStatus(result)
      return result
    } catch (err) {
      const r = { ok: false, message: String(err) }
      setTestKeyStatus(r)
      return r
    } finally {
      setIsTesting(false)
    }
  }, [])

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
      await refreshAccountEmails()
    } catch (err) {
      setCalendarError(String(err))
    } finally {
      setCalendarConnecting(false)
    }
  }, [googleClientId, googleClientSecret, connect, refreshGoogleScopes, refreshAccountEmails])

  const handleDisconnectCalendar = useCallback(async () => {
    await disconnect()
    await refreshGoogleScopes()
    await refreshAccountEmails()
  }, [disconnect, refreshGoogleScopes, refreshAccountEmails])

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
      await refreshAccountEmails()
    } catch (err) {
      setGmailError(String(err))
    } finally {
      setGmailConnecting(false)
    }
  }, [googleClientId, googleClientSecret, refreshGoogleScopes, refreshAccountEmails])

  const handleDisconnectGmail = useCallback(async () => {
    await api.invoke(IPC_CHANNELS.GMAIL_DISCONNECT)
    await refreshGoogleScopes()
    await refreshAccountEmails()
  }, [refreshGoogleScopes, refreshAccountEmails])

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
  const needsOpenAi = settings.llmProvider === 'openai' && !settings.openAiApiKey
  const needsSetup = needsDeepgram || needsClaude || needsOpenAi
  const profileName = userDisplayName.trim()
    || [userFirstName.trim(), userLastName.trim()].filter(Boolean).join(' ')
    || 'No name set'
  const profileTitle = userTitle.trim() || 'No title'
  const profileJobFunction = userJobFunction.trim() || 'No job function'
  const profileEmail = userEmail.trim() || 'No email'

  return (
    <div className={styles.container}>
      <div className={styles.tabRow}>
        {(['profile', 'ai', 'integrations', 'import', 'custom-fields', 'templates'] as SettingsTab[]).map((tab) => (
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
          Firm name, brand color, and logo appear in the header of all shared pages.
        </p>

        <div className={styles.field}>
          <label className={styles.label}>Firm Name</label>
          <input
            className={styles.input}
            type="text"
            placeholder="e.g. Red Swan Ventures"
            value={brandingFirmName}
            onChange={(e) => setBrandingFirmName(e.target.value)}
            onBlur={async () => {
              await api.invoke(IPC_CHANNELS.SETTINGS_SET, 'brandingFirmName', brandingFirmName)
            }}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Brand Color</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="color"
              value={brandingPrimaryColor}
              onChange={async (e) => {
                setBrandingPrimaryColor(e.target.value)
                await api.invoke(IPC_CHANNELS.SETTINGS_SET, 'brandingPrimaryColor', e.target.value)
              }}
              style={{ width: 40, height: 32, padding: 2, border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer' }}
            />
            <span style={{ fontSize: 12, color: '#6b7280', fontFamily: 'monospace' }}>{brandingPrimaryColor}</span>
          </div>
        </div>

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
                , go to Settings &gt; API Keys, and create a new key. Click <strong>Add key</strong> in the Summarization section below.
              </li>
            )}
            {needsOpenAi && (
              <li>
                <strong>OpenAI</strong> (AI summaries &amp; chat) — Sign up at{' '}
                <a href="https://platform.openai.com/" target="_blank" rel="noreferrer">
                  platform.openai.com
                </a>
                , go to API Keys, and create a new key. Click <strong>Add key</strong> in the Summarization section below.
              </li>
            )}
          </ol>
          {(needsClaude || needsOpenAi) && (
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
        <h3 className={styles.sectionTitle}>Summarization</h3>
        <p className={styles.hint} style={{ marginBottom: 12 }}>
          Generates meeting summaries, extracts action items, and powers AI chat. Also used for contact web enrichment (title and LinkedIn inference).
        </p>
        <div className={styles.inlineFieldRow}>
          <span className={styles.inlineFieldLabel}>LLM Provider</span>
          <select
            className={styles.inlineSelect}
            value={settings.llmProvider}
            onChange={async (e) => {
              const v = e.target.value as LlmProvider
              setSettings((prev) => ({ ...prev, llmProvider: v }))
              await api.invoke(IPC_CHANNELS.SETTINGS_SET, 'llmProvider', v)
            }}
          >
            <option value="claude">Claude (Anthropic)</option>
            <option value="openai">OpenAI</option>
            <option value="ollama">Ollama (Local)</option>
          </select>
        </div>

        {settings.llmProvider === 'claude' && (
          <>
            <div className={styles.field} style={{ marginTop: 12 }}>
              <label className={styles.label}>Claude API Key</label>
              <div className={styles.apiKeyRow}>
                <span className={styles.apiKeyMask}>
                  {settings.claudeApiKey ? '••••••••' : <span style={{ color: 'var(--color-danger, #ef4444)' }}>Not configured</span>}
                </span>
                <button
                  className={styles.connectBtn}
                  onClick={() => { setApiKeyDraft(''); setTestKeyStatus(null); setShowApiKeyDraft(false); setApiKeyModalProvider('claude'); setApiKeyModalOpen(true) }}
                >
                  {settings.claudeApiKey ? 'Change key' : 'Add key'}
                </button>
                {settings.claudeApiKey && (
                  <button
                    className={styles.connectBtn}
                    onClick={() => handleTestKey('claude', settings.claudeApiKey)}
                    disabled={isTesting}
                  >
                    {isTesting ? 'Testing…' : 'Test key'}
                  </button>
                )}
              </div>
              {testKeyStatus && apiKeyModalProvider === 'claude' && !apiKeyModalOpen && (
                <div style={{ marginTop: 6, fontSize: 13, color: testKeyStatus.ok ? 'var(--color-success, #16a34a)' : 'var(--color-danger, #ef4444)' }}>
                  {testKeyStatus.ok ? `✓ ${testKeyStatus.message}` : `✗ ${testKeyStatus.message}`}
                </div>
              )}
            </div>
            <div className={styles.inlineFieldRow}>
              <span className={styles.inlineFieldLabel}>Summary model</span>
              <select
                className={styles.inlineSelect}
                value={settings.claudeSummaryModel}
                onChange={async (e) => {
                  const v = e.target.value
                  setSettings((prev) => ({ ...prev, claudeSummaryModel: v }))
                  await api.invoke(IPC_CHANNELS.SETTINGS_SET, 'claudeSummaryModel', v)
                }}
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
                onChange={async (e) => {
                  const v = e.target.value
                  setSettings((prev) => ({ ...prev, claudeEnrichmentModel: v }))
                  await api.invoke(IPC_CHANNELS.SETTINGS_SET, 'claudeEnrichmentModel', v)
                }}
              >
                {CLAUDE_MODEL_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </>
        )}

        {settings.llmProvider === 'openai' && (
          <>
            <div className={styles.field} style={{ marginTop: 12 }}>
              <label className={styles.label}>OpenAI API Key</label>
              <div className={styles.apiKeyRow}>
                <span className={styles.apiKeyMask}>
                  {settings.openAiApiKey ? '••••••••' : <span style={{ color: 'var(--color-danger, #ef4444)' }}>Not configured</span>}
                </span>
                <button
                  className={styles.connectBtn}
                  onClick={() => { setApiKeyDraft(''); setTestKeyStatus(null); setShowApiKeyDraft(false); setApiKeyModalProvider('openai'); setApiKeyModalOpen(true) }}
                >
                  {settings.openAiApiKey ? 'Change key' : 'Add key'}
                </button>
                {settings.openAiApiKey && (
                  <button
                    className={styles.connectBtn}
                    onClick={() => handleTestKey('openai', settings.openAiApiKey)}
                    disabled={isTesting}
                  >
                    {isTesting ? 'Testing…' : 'Test key'}
                  </button>
                )}
              </div>
              {testKeyStatus && apiKeyModalProvider === 'openai' && !apiKeyModalOpen && (
                <div style={{ marginTop: 6, fontSize: 13, color: testKeyStatus.ok ? 'var(--color-success, #16a34a)' : 'var(--color-danger, #ef4444)' }}>
                  {testKeyStatus.ok ? `✓ ${testKeyStatus.message}` : `✗ ${testKeyStatus.message}`}
                </div>
              )}
            </div>
            <div className={styles.inlineFieldRow}>
              <span className={styles.inlineFieldLabel}>Summary model</span>
              <select
                className={styles.inlineSelect}
                value={settings.openAiSummaryModel}
                onChange={async (e) => {
                  const v = e.target.value
                  setSettings((prev) => ({ ...prev, openAiSummaryModel: v }))
                  await api.invoke(IPC_CHANNELS.SETTINGS_SET, 'openAiSummaryModel', v)
                }}
              >
                {OPENAI_MODEL_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div className={styles.inlineFieldRow}>
              <span className={styles.inlineFieldLabel}>Enrichment model</span>
              <select
                className={styles.inlineSelect}
                value={settings.openAiEnrichmentModel}
                onChange={async (e) => {
                  const v = e.target.value
                  setSettings((prev) => ({ ...prev, openAiEnrichmentModel: v }))
                  await api.invoke(IPC_CHANNELS.SETTINGS_SET, 'openAiEnrichmentModel', v)
                }}
              >
                {OPENAI_MODEL_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </>
        )}

        {settings.llmProvider === 'ollama' && (
          <>
            <div className={styles.field} style={{ marginTop: 12 }}>
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

        <div className={styles.field} style={{ marginTop: 24 }}>
          <label className={styles.label}>Exa API Key</label>
          <p className={styles.profileMeta} style={{ marginBottom: 8 }}>
            Used to discover LinkedIn URLs for contacts. Optional — only needed for LinkedIn backfill.
          </p>
          <div className={styles.apiKeyRow}>
            <span className={styles.apiKeyMask}>
              {settings.exaApiKey ? '••••••••' : <span style={{ color: 'var(--color-text-secondary)' }}>Not configured</span>}
            </span>
            <button
              className={styles.connectBtn}
              onClick={() => {
                setApiKeyModalProvider('exa')
                setApiKeyDraft('')
                setApiKeyModalOpen(true)
              }}
            >
              {settings.exaApiKey ? 'Change key' : 'Add key'}
            </button>
            {settings.exaApiKey && (
              <button
                className={styles.connectBtn}
                onClick={async () => {
                  await api.invoke(IPC_CHANNELS.SETTINGS_SET, 'exaApiKey', '')
                  setSettings((prev) => ({ ...prev, exaApiKey: '' }))
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

      {activeTab === 'integrations' && (
        <>
          <IntegrationsPanel
            calendarConnected={calendarConnected}
            calendarConnecting={calendarConnecting}
            calendarError={calendarError}
            googleClientId={googleClientId}
            googleClientSecret={googleClientSecret}
            onGoogleClientIdChange={setGoogleClientId}
            onGoogleClientSecretChange={setGoogleClientSecret}
            onConnectCalendar={handleConnectCalendar}
            onDisconnectCalendar={handleDisconnectCalendar}
            gmailConnected={gmailConnected}
            gmailConnecting={gmailConnecting}
            gmailError={gmailError}
            onConnectGmail={handleConnectGmail}
            onDisconnectGmail={handleDisconnectGmail}
            autoSyncEmails={settings.autoSyncEmails}
            onAutoSyncChange={(v) => setSettings({ ...settings, autoSyncEmails: v })}
            hasDriveScope={hasDriveScope}
            hasDriveFilesScope={hasDriveFilesScope}
            driveGranting={driveGranting}
            driveFilesGranting={driveFilesGranting}
            driveError={driveError}
            onGrantDriveUploads={handleReauthorizeGoogleScopes}
            onGrantDriveFiles={handleGrantDriveFilesAccess}
            calendarAccountEmail={calendarAccountEmail}
            gmailAccountEmail={gmailAccountEmail}
          />

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
        <h3 className={styles.sectionTitle}>Import Notes</h3>
        <div className={styles.field}>
          <p className={styles.hint}>
            Import notes from Apple Notes, Notion, or any folder of .txt / .md files.
            Subfolders are walked recursively; duplicate notes are skipped automatically.
          </p>
          <div className={styles.onboardingActionRow} style={{ alignItems: 'center', gap: 8 }}>
            <select
              className={styles.select}
              value={notesImportFormat}
              onChange={e => {
                setNotesImportFormat(e.target.value as ImportFormat)
                setNotesImportScan(null)
                setNotesImportResult(null)
                setNotesImportError('')
              }}
              disabled={notesImportRunning}
            >
              <option value="apple-notes">Apple Notes</option>
              <option value="notion">Notion</option>
              <option value="generic">Generic (.txt / .md)</option>
            </select>
            <button
              className={styles.connectBtn}
              onClick={handleScanNotes}
              disabled={notesImportRunning}
            >
              Scan Folder
            </button>
          </div>

          {/* Scan preview */}
          {notesImportScan && !notesImportRunning && !notesImportResult && (
            <div style={{ marginTop: 10 }}>
              <p className={styles.hint}>
                Found {notesImportScan.total} note{notesImportScan.total !== 1 ? 's' : ''} in{' '}
                {notesImportScan.folders} folder{notesImportScan.folders !== 1 ? 's' : ''}.
                {notesImportScan.alreadyExist > 0
                  ? ` ${notesImportScan.alreadyExist} already exist and will be skipped.`
                  : ' None exist yet.'}
              </p>
              <button
                className={styles.connectBtn}
                onClick={handleImportNotes}
                disabled={notesImportScan.total === 0}
              >
                Import {notesImportScan.total - notesImportScan.alreadyExist} note{notesImportScan.total - notesImportScan.alreadyExist !== 1 ? 's' : ''}
              </button>
            </div>
          )}

          {/* Live progress */}
          {notesImportRunning && notesImportProgress && (
            <div className={styles.onboardingActionRow} style={{ marginTop: 10, alignItems: 'center', gap: 12 }}>
              <p className={styles.hint} style={{ margin: 0 }}>
                Importing {notesImportProgress.created + notesImportProgress.skipped} of {notesImportProgress.total}…
              </p>
              <button className={styles.disconnectBtn} onClick={handleCancelImport}>
                Cancel
              </button>
            </div>
          )}
          {notesImportRunning && !notesImportProgress && (
            <p className={styles.hint} style={{ marginTop: 10 }}>Starting import…</p>
          )}

          {/* Result */}
          {notesImportResult && (
            <div style={{ marginTop: 10 }}>
              <p className={styles.hint}>
                Done — {notesImportResult.created} note{notesImportResult.created !== 1 ? 's' : ''} imported,{' '}
                {notesImportResult.skipped} skipped.
                {(notesImportResult.foldersFound ?? 0) > 0 && (
                  <> · {notesImportResult.foldersFound} folder{notesImportResult.foldersFound !== 1 ? 's' : ''}</>
                )}
                {(notesImportResult.imagesExtracted ?? 0) > 0 && (
                  <> · {notesImportResult.imagesExtracted} image{notesImportResult.imagesExtracted !== 1 ? 's' : ''} extracted</>
                )}
              </p>
              {notesImportResult.errors.length > 0 && (
                <div>
                  <button
                    className={styles.disconnectBtn}
                    onClick={() => setShowImportErrors(v => !v)}
                    style={{ fontSize: 12 }}
                  >
                    {notesImportResult.errors.length} error{notesImportResult.errors.length !== 1 ? 's' : ''}{' '}
                    {showImportErrors ? '▲' : '▼'}
                  </button>
                  {showImportErrors && (
                    <ul className={styles.hint} style={{ marginTop: 6, paddingLeft: 16 }}>
                      {notesImportResult.errors.map((e, i) => (
                        <li key={i}>{e}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              <button
                className={styles.connectBtn}
                onClick={() => navigate('/notes')}
                style={{ marginTop: 8 }}
              >
                View imported notes →
              </button>
            </div>
          )}

          {notesImportError && <p className={styles.error} style={{ marginTop: 10 }}>{notesImportError}</p>}
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

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Fix Company Names</h3>
        <div className={styles.field}>
          <p className={styles.hint}>
            Scans for company names that look like concatenated words (e.g. &ldquo;AcmeCorp&rdquo;, &ldquo;bowleycapital&rdquo;)
            and corrects them. If a corrected name already exists, the duplicate is merged automatically.
            Safe to run multiple times.
          </p>
          <div className={styles.onboardingActionRow}>
            <button
              className={styles.connectBtn}
              onClick={async () => {
                setFixNamesRunning(true)
                setFixNamesResult(null)
                setFixNamesError('')
                setFixNamesExpanded(false)
                try {
                  const result = await api.invoke<{ fixed: number; merged: number; changes: Array<{ id: string; before: string; after: string; action: 'renamed' | 'merged' }> }>(
                    IPC_CHANNELS.COMPANY_FIX_CONCATENATED_NAMES
                  )
                  setFixNamesResult(result)
                } catch (err) {
                  setFixNamesError(String(err))
                } finally {
                  setFixNamesRunning(false)
                }
              }}
              disabled={fixNamesRunning}
            >
              {fixNamesRunning ? 'Running…' : 'Fix Company Names'}
            </button>
          </div>
          {fixNamesResult && (
            <div>
              <p className={styles.hint}>
                {fixNamesResult.fixed === 0 && fixNamesResult.merged === 0
                  ? 'No concatenated names found — all company names look correct.'
                  : `Fixed ${fixNamesResult.fixed} name${fixNamesResult.fixed !== 1 ? 's' : ''}${fixNamesResult.merged > 0 ? `, merged ${fixNamesResult.merged} duplicate${fixNamesResult.merged !== 1 ? 's' : ''}` : ''}.`}
                {fixNamesResult.changes.length > 0 && (
                  <>
                    {' '}
                    <button
                      className={styles.linkBtn}
                      onClick={() => setFixNamesExpanded((v) => !v)}
                    >
                      {fixNamesExpanded ? 'Hide what changed' : 'Show what changed'}
                    </button>
                  </>
                )}
              </p>
              {fixNamesExpanded && fixNamesResult.changes.length > 0 && (
                <ul className={styles.fixNamesList}>
                  {fixNamesResult.changes.map((c) => (
                    <li key={c.id}>
                      <span className={styles.fixNameBefore}>{c.before}</span>
                      {' → '}
                      <span className={styles.fixNameAfter}>{c.after}</span>
                      {c.action === 'merged' && <span className={styles.fixNameMergedBadge}> [merged]</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {fixNamesError && <p className={styles.error}>{fixNamesError}</p>}
        </div>
      </section>
        </>
      )}

      {activeTab !== 'templates' && (
        <div className={styles.actions}>
          <button className={styles.saveBtn} onClick={handleSave}>
            {saved ? 'Saved' : 'Save Settings'}
          </button>
        </div>
      )}

      {activeTab === 'custom-fields' && (
        <CustomFieldsSettings />
      )}

      {activeTab === 'templates' && (
        <TemplatesPanel />
      )}

      {showImportModal && (
        <ImportModal onClose={() => setShowImportModal(false)} />
      )}

      {apiKeyModalOpen && createPortal(
        <div
          className={styles.apiKeyOverlay}
          onClick={() => { setApiKeyModalOpen(false); setTestKeyStatus(null) }}
        >
          <div className={styles.apiKeyDialog} onClick={(e) => e.stopPropagation()}>
            <h2 className={styles.apiKeyDialogTitle}>
              {apiKeyModalProvider === 'openai' ? 'Update OpenAI API Key' : apiKeyModalProvider === 'exa' ? 'Update Exa API Key' : 'Update Claude API Key'}
            </h2>
            <div className={styles.apiKeyInputRow}>
              <input
                className={styles.input}
                type={showApiKeyDraft ? 'text' : 'password'}
                autoFocus
                value={apiKeyDraft}
                onChange={(e) => { setApiKeyDraft(e.target.value); setTestKeyStatus(null) }}
                placeholder={apiKeyModalProvider === 'openai' ? 'sk-...' : apiKeyModalProvider === 'exa' ? 'Paste Exa API key…' : 'sk-ant-api03-…'}
              />
              <button
                className={styles.apiKeyToggle}
                onClick={() => setShowApiKeyDraft((v) => !v)}
              >
                {showApiKeyDraft ? '🙈' : '👁'}
              </button>
            </div>
            {testKeyStatus && (
              <div style={{ marginTop: 6, fontSize: 13, color: testKeyStatus.ok ? 'var(--color-success, #16a34a)' : 'var(--color-danger, #ef4444)' }}>
                {testKeyStatus.ok ? `✓ ${testKeyStatus.message}` : `✗ ${testKeyStatus.message}`}
              </div>
            )}
            <div className={styles.apiKeyDialogActions}>
              {apiKeyModalProvider !== 'exa' && (
                <button
                  className={styles.connectBtn}
                  onClick={() => handleTestKey(apiKeyModalProvider as 'claude' | 'openai', apiKeyDraft)}
                  disabled={isTesting || !apiKeyDraft}
                >
                  {isTesting ? 'Testing…' : 'Test key'}
                </button>
              )}
              <button
                className={styles.connectBtn}
                onClick={() => { setApiKeyModalOpen(false); setTestKeyStatus(null) }}
              >
                Cancel
              </button>
              <button
                className={styles.saveBtn}
                disabled={isSavingKey || !apiKeyDraft}
                onClick={async () => {
                  setIsSavingKey(true)
                  const trimmed = apiKeyDraft.trim()
                  if (apiKeyModalProvider === 'exa') {
                    await api.invoke(IPC_CHANNELS.SETTINGS_SET, 'exaApiKey', trimmed)
                    setSettings((prev) => ({ ...prev, exaApiKey: trimmed }))
                    setApiKeyModalOpen(false)
                  } else {
                    const result = await handleTestKey(apiKeyModalProvider, apiKeyDraft)
                    if (result.ok) {
                      const settingKey = apiKeyModalProvider === 'openai' ? 'openAiApiKey' : 'claudeApiKey'
                      await api.invoke(IPC_CHANNELS.SETTINGS_SET, settingKey, trimmed)
                      setSettings((prev) => ({ ...prev, [settingKey]: trimmed }))
                      setApiKeyModalOpen(false)
                      setTestKeyStatus(null)
                    }
                  }
                  setIsSavingKey(false)
                }}
              >
                {isSavingKey ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
