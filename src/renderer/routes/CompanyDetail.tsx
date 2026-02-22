import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { useFeatureFlags } from '../hooks/useFeatureFlags'
import type {
  CompanyDetail as CompanyDetailType,
  CompanyEmailIngestResult,
  CompanyEntityType,
  CompanyContactRef,
  CompanyEmailRef,
  CompanyDriveFileRef,
  CompanyMeetingRef,
  CompanyNote,
  InvestmentMemoVersion,
  InvestmentMemoWithLatest
} from '../../shared/types/company'
import styles from './CompanyDetail.module.css'

type CompanyTab = 'meetings' | 'contacts' | 'emails' | 'files' | 'notes' | 'memo'

const TAB_LABELS: Record<CompanyTab, string> = {
  meetings: 'Meetings',
  contacts: 'Contacts',
  emails: 'Emails',
  files: 'Files',
  notes: 'Notes',
  memo: 'Memo'
}

const COMPANY_TYPE_OPTIONS: CompanyEntityType[] = [
  'prospect',
  'portfolio',
  'vc_fund',
  'customer',
  'partner',
  'vendor',
  'other',
  'unknown'
]

const COMPANY_STAGE_OPTIONS = ['Pre-Seed', 'Seed', 'Series A', 'Series B', 'Series C', 'Series D'] as const

type CompanyStageOption = (typeof COMPANY_STAGE_OPTIONS)[number]

function formatDateTime(value: string | null): string {
  if (!value) return 'Unknown'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown'
  return date.toLocaleString()
}

function formatDateHeading(value: string | null): string {
  if (!value) return 'Unknown date'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown date'

  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)

  if (date.toDateString() === today.toDateString()) return 'Today'
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'

  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  })
}

function formatTime(value: string | null): string {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--'
  return date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  })
}

function groupEmailsByDate(emails: CompanyEmailRef[]): Array<[string, CompanyEmailRef[]]> {
  const groups = new Map<string, CompanyEmailRef[]>()
  for (const email of emails) {
    const at = email.receivedAt || email.sentAt
    const heading = formatDateHeading(at)
    const existing = groups.get(heading)
    if (existing) {
      existing.push(email)
    } else {
      groups.set(heading, [email])
    }
  }
  return Array.from(groups.entries())
}

function formatEmailParticipantLabel(participant: CompanyEmailRef['participants'][number]): string {
  const displayName = (participant.displayName || '').trim()
  return displayName || participant.email
}

function getEmailRecipientGroups(email: CompanyEmailRef): {
  to: CompanyEmailRef['participants']
  cc: CompanyEmailRef['participants']
  bcc: CompanyEmailRef['participants']
} {
  const senderEmail = (email.fromEmail || '').trim().toLowerCase()
  const to: CompanyEmailRef['participants'] = []
  const cc: CompanyEmailRef['participants'] = []
  const bcc: CompanyEmailRef['participants'] = []
  const seen = new Set<string>()

  for (const participant of email.participants || []) {
    const role = participant.role
    if (role !== 'to' && role !== 'cc' && role !== 'bcc') continue
    const normalizedEmail = participant.email.trim().toLowerCase()
    if (!normalizedEmail || normalizedEmail === senderEmail) continue
    const dedupeKey = `${role}:${normalizedEmail}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)

    if (role === 'to') to.push(participant)
    if (role === 'cc') cc.push(participant)
    if (role === 'bcc') bcc.push(participant)
  }

  return { to, cc, bcc }
}

function groupMeetingsByDate(meetings: CompanyMeetingRef[]): Array<[string, CompanyMeetingRef[]]> {
  const groups = new Map<string, CompanyMeetingRef[]>()
  for (const meeting of meetings) {
    const heading = formatDateHeading(meeting.date)
    const existing = groups.get(heading)
    if (existing) {
      existing.push(meeting)
    } else {
      groups.set(heading, [meeting])
    }
  }
  return Array.from(groups.entries())
}

function groupFilesByDate(files: CompanyDriveFileRef[]): Array<[string, CompanyDriveFileRef[]]> {
  const groups = new Map<string, CompanyDriveFileRef[]>()
  for (const file of files) {
    const heading = formatDateHeading(file.modifiedAt)
    const existing = groups.get(heading)
    if (existing) {
      existing.push(file)
    } else {
      groups.set(heading, [file])
    }
  }
  return Array.from(groups.entries())
}

function formatEntityType(entityType: CompanyEntityType): string {
  const labels: Record<CompanyEntityType, string> = {
    prospect: 'Prospect',
    portfolio: 'Portfolio',
    vc_fund: 'VC Fund',
    customer: 'Customer',
    partner: 'Partner',
    vendor: 'Vendor',
    other: 'Other',
    unknown: 'Unknown'
  }
  return labels[entityType]
}

function normalizeStageValue(stage: string | null): CompanyStageOption | '' {
  if (!stage) return ''
  const normalized = stage.trim()
  const matched = COMPANY_STAGE_OPTIONS.find((option) => option === normalized)
  return matched || ''
}

function formatDuration(seconds: number | null): string | null {
  if (!seconds || seconds <= 0) return null
  const minutes = Math.round(seconds / 60)
  return `${minutes} min`
}

function formatFileSize(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return null
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function formatDriveFileType(mimeType: string): string {
  const googleType = mimeType.match(/^application\/vnd\.google-apps\.(.+)$/)
  if (googleType?.[1]) {
    const raw = googleType[1]
    if (raw === 'document') return 'Google Doc'
    if (raw === 'spreadsheet') return 'Google Sheet'
    if (raw === 'presentation') return 'Google Slides'
    if (raw === 'drawing') return 'Google Drawing'
    if (raw === 'form') return 'Google Form'
    return `Google ${raw}`
  }

  const [top, sub] = mimeType.split('/')
  if (!sub) return mimeType
  if (top === 'application' && sub === 'pdf') return 'PDF'
  if (top === 'text') return sub.toUpperCase()
  return `${top}/${sub}`
}

function buildWebsiteHref(websiteUrl: string | null, primaryDomain: string | null): string | null {
  const candidate = (websiteUrl || '').trim() || (primaryDomain || '').trim()
  if (!candidate) return null
  if (/^https?:\/\//i.test(candidate)) return candidate
  return `https://${candidate}`
}

function toDisplayError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const withoutIpcPrefix = raw.replace(/^Error invoking remote method '.*?':\s*/, '')
  return withoutIpcPrefix.replace(/^Error:\s*/, '')
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  try {
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(message))
      }, timeoutMs)
    })
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}

export default function CompanyDetail() {
  const { companyId = '' } = useParams()
  const navigate = useNavigate()
  const { values: flags, loading: flagsLoading } = useFeatureFlags([
    'ff_companies_ui_v1',
    'ff_company_notes_v1',
    'ff_investment_memo_v1'
  ])

  const [activeTab, setActiveTab] = useState<CompanyTab>('meetings')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [company, setCompany] = useState<CompanyDetailType | null>(null)
  const [meetings, setMeetings] = useState<CompanyMeetingRef[]>([])
  const [contacts, setContacts] = useState<CompanyContactRef[]>([])
  const [emails, setEmails] = useState<CompanyEmailRef[]>([])
  const [files, setFiles] = useState<CompanyDriveFileRef[]>([])
  const [filesLoading, setFilesLoading] = useState(false)
  const [filesLoadedForCompanyId, setFilesLoadedForCompanyId] = useState<string | null>(null)
  const [notes, setNotes] = useState<CompanyNote[]>([])
  const [noteTitle, setNoteTitle] = useState('')
  const [noteContent, setNoteContent] = useState('')
  const [memo, setMemo] = useState<InvestmentMemoWithLatest | null>(null)
  const [memoVersions, setMemoVersions] = useState<InvestmentMemoVersion[]>([])
  const [memoDraft, setMemoDraft] = useState('')
  const [memoChangeNote, setMemoChangeNote] = useState('')
  const [savingMemo, setSavingMemo] = useState(false)
  const [exportingMemo, setExportingMemo] = useState(false)
  const [ingestingEmails, setIngestingEmails] = useState(false)
  const [emailIngestSummary, setEmailIngestSummary] = useState<string | null>(null)
  const [expandedEmailId, setExpandedEmailId] = useState<string | null>(null)
  const [updatingType, setUpdatingType] = useState(false)
  const [updatingStage, setUpdatingStage] = useState(false)
  const [editingCompanyName, setEditingCompanyName] = useState(false)
  const [companyNameDraft, setCompanyNameDraft] = useState('')
  const [savingCompanyName, setSavingCompanyName] = useState(false)
  const companyNameInputRef = useRef<HTMLInputElement>(null)

  const tabs = useMemo(() => {
    const items: CompanyTab[] = ['meetings', 'contacts', 'emails', 'files']
    if (flags.ff_company_notes_v1) items.push('notes')
    if (flags.ff_investment_memo_v1) items.push('memo')
    return items
  }, [flags.ff_company_notes_v1, flags.ff_investment_memo_v1])

  const loadData = useCallback(async () => {
    if (!companyId || !flags.ff_companies_ui_v1) return

    setLoading(true)
    setError(null)
    try {
      const companyResult = await window.api.invoke<CompanyDetailType | null>(
        IPC_CHANNELS.COMPANY_GET,
        companyId
      )
      setCompany(companyResult)
      if (!companyResult) {
        setMeetings([])
        setContacts([])
        setEmails([])
        setFiles([])
        setFilesLoadedForCompanyId(null)
        setNotes([])
        setMemo(null)
        setMemoVersions([])
        setMemoDraft('')
        return
      }

      setFiles([])
      setFilesLoadedForCompanyId(null)

      const partialErrors: string[] = []

      const [
        meetingsSettled,
        contactsSettled,
        emailsSettled,
        notesSettled,
        memoSettled
      ] = await Promise.allSettled([
        window.api.invoke<CompanyMeetingRef[]>(IPC_CHANNELS.COMPANY_MEETINGS, companyId),
        window.api.invoke<CompanyContactRef[]>(IPC_CHANNELS.COMPANY_CONTACTS, companyId),
        window.api.invoke<CompanyEmailRef[]>(IPC_CHANNELS.COMPANY_EMAILS, companyId),
        flags.ff_company_notes_v1
          ? window.api.invoke<CompanyNote[]>(IPC_CHANNELS.COMPANY_NOTES_LIST, companyId)
          : Promise.resolve([]),
        flags.ff_investment_memo_v1
          ? window.api.invoke<InvestmentMemoWithLatest>(IPC_CHANNELS.INVESTMENT_MEMO_GET_OR_CREATE, companyId)
          : Promise.resolve(null)
      ])

      if (meetingsSettled.status === 'fulfilled') {
        setMeetings(meetingsSettled.value)
      } else {
        setMeetings([])
        partialErrors.push('Failed to load meetings')
      }

      if (contactsSettled.status === 'fulfilled') {
        setContacts(contactsSettled.value)
      } else {
        setContacts([])
        partialErrors.push('Failed to load contacts')
      }

      if (emailsSettled.status === 'fulfilled') {
        setEmails(emailsSettled.value)
      } else {
        setEmails([])
        partialErrors.push('Failed to load emails')
      }

      if (notesSettled.status === 'fulfilled') {
        setNotes(notesSettled.value)
      } else {
        setNotes([])
        partialErrors.push('Failed to load notes')
      }

      let memoResult: InvestmentMemoWithLatest | null = null
      if (memoSettled.status === 'fulfilled') {
        memoResult = memoSettled.value
      } else {
        partialErrors.push('Failed to load memo')
      }

      setMemo(memoResult)
      if (memoResult) {
        try {
          const versions = await window.api.invoke<InvestmentMemoVersion[]>(
            IPC_CHANNELS.INVESTMENT_MEMO_LIST_VERSIONS,
            memoResult.id
          )
          setMemoVersions(versions)
        } catch {
          setMemoVersions([])
          partialErrors.push('Failed to load memo versions')
        }
        setMemoDraft(memoResult.latestVersion?.contentMarkdown || '')
      } else {
        setMemoVersions([])
        setMemoDraft('')
      }

      if (partialErrors.length > 0) {
        setError(partialErrors.join(' | '))
      }
    } catch (err) {
      setCompany(null)
      setError(toDisplayError(err))
    } finally {
      setLoading(false)
    }
  }, [companyId, flags.ff_companies_ui_v1, flags.ff_company_notes_v1, flags.ff_investment_memo_v1])

  useEffect(() => {
    loadData()
  }, [loadData])

  useEffect(() => {
    if (!tabs.includes(activeTab)) {
      setActiveTab(tabs[0] || 'overview')
    }
  }, [activeTab, tabs])

  useEffect(() => {
    setEmailIngestSummary(null)
    setExpandedEmailId(null)
    setFiles([])
    setFilesLoadedForCompanyId(null)
    setFilesLoading(false)
    setEditingCompanyName(false)
    setCompanyNameDraft('')
    setSavingCompanyName(false)
  }, [companyId])

  useEffect(() => {
    if (!company || editingCompanyName) return
    setCompanyNameDraft(company.canonicalName)
  }, [company, editingCompanyName])

  useEffect(() => {
    if (emails.length === 0) {
      setExpandedEmailId(null)
      return
    }
    if (expandedEmailId && !emails.some((email) => email.id === expandedEmailId)) {
      setExpandedEmailId(null)
    }
  }, [emails, expandedEmailId])

  const loadFiles = useCallback(async () => {
    if (!companyId || !company) return
    if (filesLoadedForCompanyId === companyId) return

    setFilesLoading(true)
    try {
      const result = await withTimeout(
        window.api.invoke<CompanyDriveFileRef[]>(IPC_CHANNELS.COMPANY_FILES, companyId),
        12000,
        'Timed out while loading files from Google Drive.'
      )
      setFiles(result)
    } catch (err) {
      setFiles([])
      setError((prev) => {
        const next = toDisplayError(err)
        return prev ? `${prev} | ${next}` : next
      })
    } finally {
      setFilesLoadedForCompanyId(companyId)
      setFilesLoading(false)
    }
  }, [companyId, company, filesLoadedForCompanyId])

  useEffect(() => {
    if (activeTab === 'files' && company) {
      void loadFiles()
    }
  }, [activeTab, company, loadFiles])

  const handleAddNote = async () => {
    if (!companyId || !noteContent.trim()) return
    try {
      await window.api.invoke<CompanyNote>(IPC_CHANNELS.COMPANY_NOTES_CREATE, {
        companyId,
        title: noteTitle.trim() || null,
        content: noteContent.trim()
      })
      setNoteTitle('')
      setNoteContent('')
      const updated = await window.api.invoke<CompanyNote[]>(IPC_CHANNELS.COMPANY_NOTES_LIST, companyId)
      setNotes(updated)
    } catch (err) {
      setError(toDisplayError(err))
    }
  }

  const handleTogglePinNote = async (note: CompanyNote) => {
    try {
      await window.api.invoke<CompanyNote>(
        IPC_CHANNELS.COMPANY_NOTES_UPDATE,
        note.id,
        { isPinned: !note.isPinned }
      )
      const updated = await window.api.invoke<CompanyNote[]>(IPC_CHANNELS.COMPANY_NOTES_LIST, companyId)
      setNotes(updated)
    } catch (err) {
      setError(toDisplayError(err))
    }
  }

  const handleDeleteNote = async (noteId: string) => {
    try {
      await window.api.invoke<boolean>(IPC_CHANNELS.COMPANY_NOTES_DELETE, noteId)
      const updated = await window.api.invoke<CompanyNote[]>(IPC_CHANNELS.COMPANY_NOTES_LIST, companyId)
      setNotes(updated)
    } catch (err) {
      setError(toDisplayError(err))
    }
  }

  const handleSaveMemo = async () => {
    if (!memo || !memoDraft.trim()) return
    setSavingMemo(true)
    try {
      await window.api.invoke<InvestmentMemoVersion>(
        IPC_CHANNELS.INVESTMENT_MEMO_SAVE_VERSION,
        memo.id,
        {
          contentMarkdown: memoDraft,
          changeNote: memoChangeNote.trim() || null
        }
      )
      setMemoChangeNote('')
      const refreshedMemo = await window.api.invoke<InvestmentMemoWithLatest>(
        IPC_CHANNELS.INVESTMENT_MEMO_GET_OR_CREATE,
        companyId
      )
      setMemo(refreshedMemo)
      const refreshedVersions = await window.api.invoke<InvestmentMemoVersion[]>(
        IPC_CHANNELS.INVESTMENT_MEMO_LIST_VERSIONS,
        refreshedMemo.id
      )
      setMemoVersions(refreshedVersions)
    } catch (err) {
      setError(toDisplayError(err))
    } finally {
      setSavingMemo(false)
    }
  }

  const handleMemoStatusChange = async (status: 'draft' | 'review' | 'final' | 'archived') => {
    if (!memo) return
    try {
      const updated = await window.api.invoke<InvestmentMemoWithLatest>(
        IPC_CHANNELS.INVESTMENT_MEMO_SET_STATUS,
        memo.id,
        status
      )
      setMemo((prev) => (prev ? { ...updated, latestVersion: prev.latestVersion } : prev))
    } catch (err) {
      setError(toDisplayError(err))
    }
  }

  const handleExportMemo = async () => {
    if (!memo) return
    setExportingMemo(true)
    try {
      const result = await window.api.invoke<{ success: boolean; path?: string; error?: string }>(
        IPC_CHANNELS.INVESTMENT_MEMO_EXPORT_PDF,
        memo.id
      )
      if (!result.success) {
        throw new Error(result.error || 'Failed to export memo')
      }
    } catch (err) {
      setError(toDisplayError(err))
    } finally {
      setExportingMemo(false)
    }
  }

  const handleIngestCompanyEmails = async () => {
    if (!companyId) return
    setIngestingEmails(true)
    setError(null)
    try {
      const result = await window.api.invoke<CompanyEmailIngestResult>(
        IPC_CHANNELS.COMPANY_EMAIL_INGEST,
        companyId
      )
      setEmailIngestSummary(
        `${result.insertedMessageCount} new, ${result.updatedMessageCount} updated, ${result.linkedMessageCount} linked`
      )
      await loadData()
      setActiveTab('emails')
    } catch (err) {
      setError(toDisplayError(err))
    } finally {
      setIngestingEmails(false)
    }
  }

  const handleCompanyTypeChange = useCallback(async (nextType: CompanyEntityType) => {
    if (!companyId || !company || nextType === company.entityType) return
    setUpdatingType(true)
    setError(null)
    try {
      const updated = await window.api.invoke<CompanyDetailType | null>(
        IPC_CHANNELS.COMPANY_UPDATE,
        companyId,
        {
          entityType: nextType,
          classificationSource: 'manual',
          classificationConfidence: 1
        }
      )
      if (updated) {
        setCompany(updated)
      }
    } catch (err) {
      setError(toDisplayError(err))
    } finally {
      setUpdatingType(false)
    }
  }, [companyId, company])

  const handleCompanyStageChange = useCallback(async (nextStage: string) => {
    if (!companyId || !company) return
    const normalizedStage = nextStage.trim() || null
    if (normalizedStage === company.stage) return
    setUpdatingStage(true)
    setError(null)
    try {
      const updated = await window.api.invoke<CompanyDetailType | null>(
        IPC_CHANNELS.COMPANY_UPDATE,
        companyId,
        { stage: normalizedStage }
      )
      if (updated) {
        setCompany(updated)
      }
    } catch (err) {
      setError(toDisplayError(err))
    } finally {
      setUpdatingStage(false)
    }
  }, [companyId, company])

  const startCompanyNameEdit = useCallback(() => {
    if (!company || savingCompanyName) return
    setCompanyNameDraft(company.canonicalName)
    setEditingCompanyName(true)
    setTimeout(() => {
      const input = companyNameInputRef.current
      if (!input) return
      input.focus()
      input.select()
    }, 0)
  }, [company, savingCompanyName])

  const cancelCompanyNameEdit = useCallback(() => {
    setCompanyNameDraft(company?.canonicalName || '')
    setEditingCompanyName(false)
  }, [company])

  const handleCompanyNameSave = useCallback(async () => {
    if (!companyId || !company) return
    const trimmed = companyNameDraft.trim()
    if (!trimmed) {
      setError('Company name is required.')
      cancelCompanyNameEdit()
      return
    }
    if (trimmed === company.canonicalName) {
      setEditingCompanyName(false)
      return
    }

    setSavingCompanyName(true)
    setError(null)
    try {
      const updated = await window.api.invoke<CompanyDetailType | null>(
        IPC_CHANNELS.COMPANY_UPDATE,
        companyId,
        { canonicalName: trimmed }
      )
      if (!updated) {
        throw new Error('Failed to update company name')
      }
      setCompany(updated)
      setCompanyNameDraft(updated.canonicalName)
      setEditingCompanyName(false)
    } catch (err) {
      setError(toDisplayError(err))
    } finally {
      setSavingCompanyName(false)
    }
  }, [companyId, company, companyNameDraft, cancelCompanyNameEdit])

  const handleCompanyNameKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void handleCompanyNameSave()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      cancelCompanyNameEdit()
    }
  }, [handleCompanyNameSave, cancelCompanyNameEdit])

  const handleCompanyTitleKeyDown = useCallback((event: KeyboardEvent<HTMLHeadingElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    startCompanyNameEdit()
  }, [startCompanyNameEdit])

  const handleOpenWebsite = useCallback(async (url: string) => {
    try {
      await window.api.invoke<boolean>(IPC_CHANNELS.APP_OPEN_EXTERNAL_URL, url)
    } catch (err) {
      setError(toDisplayError(err))
    }
  }, [])

  const toggleExpandedEmail = useCallback((emailId: string) => {
    setExpandedEmailId((prev) => (prev === emailId ? null : emailId))
  }, [])

  if (!flagsLoading && !flags.ff_companies_ui_v1) {
    return (
      <div className={styles.page}>
        <div className={styles.empty}>Companies view is disabled by feature flag.</div>
      </div>
    )
  }

  if (!companyId) {
    return (
      <div className={styles.page}>
        <div className={styles.empty}>Missing company id.</div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className={styles.page}>
        <div className={styles.meta}>Loading company...</div>
      </div>
    )
  }

  if (!company) {
    return (
      <div className={styles.page}>
        <div className={styles.empty}>{error || 'Company not found.'}</div>
      </div>
    )
  }

  const tabCounts: Partial<Record<CompanyTab, number>> = {
    meetings: meetings.length,
    contacts: contacts.length,
    emails: emails.length,
    files: files.length,
    notes: notes.length,
    memo: memo?.latestVersionNumber ?? 0
  }
  const websiteHref = buildWebsiteHref(company.websiteUrl, company.primaryDomain)
  const websiteLabel = (company.websiteUrl || '').trim() || (company.primaryDomain || '').trim()
  const stageSelectValue = normalizeStageValue(company.stage)
  const metaUpdating = updatingType || updatingStage || savingCompanyName

  return (
    <div className={styles.page}>
      <button className={styles.backButton} onClick={() => navigate('/companies')}>
        {'< Back to Companies'}
      </button>

      <div className={styles.headerCard}>
        <div className={styles.titleRow}>
          {editingCompanyName ? (
            <input
              ref={companyNameInputRef}
              className={styles.titleInput}
              value={companyNameDraft}
              onChange={(event) => setCompanyNameDraft(event.target.value)}
              onBlur={() => {
                void handleCompanyNameSave()
              }}
              onKeyDown={handleCompanyNameKeyDown}
              disabled={savingCompanyName}
              aria-label="Company name"
            />
          ) : (
            <h2
              className={`${styles.title} ${styles.editableTitle}`}
              role="button"
              tabIndex={0}
              onClick={startCompanyNameEdit}
              onKeyDown={handleCompanyTitleKeyDown}
            >
              {company.canonicalName}
            </h2>
          )}
          {savingCompanyName && <span className={styles.titleSaving}>Saving...</span>}
        </div>
        <div className={styles.headerMeta}>
          {websiteHref ? (
            <a
              className={styles.websiteLink}
              href={websiteHref}
              rel="noreferrer"
              onClick={(event) => {
                event.preventDefault()
                void handleOpenWebsite(websiteHref)
              }}
              onAuxClick={(event) => {
                event.preventDefault()
                void handleOpenWebsite(websiteHref)
              }}
            >
              {websiteLabel}
            </a>
          ) : (
            <span className={styles.noWebsite}>No website on file.</span>
          )}
          <label className={styles.typeControl}>
            <span>Type:</span>
            <select
              className={styles.typeSelect}
              value={company.entityType}
              onChange={(e) => handleCompanyTypeChange(e.target.value as CompanyEntityType)}
              disabled={metaUpdating}
            >
              {COMPANY_TYPE_OPTIONS.map((type) => (
                <option key={type} value={type}>
                  {formatEntityType(type)}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.typeControl}>
            <span>Stage:</span>
            <select
              className={styles.typeSelect}
              value={stageSelectValue}
              onChange={(e) => handleCompanyStageChange(e.target.value)}
              disabled={metaUpdating}
            >
              <option value="" disabled>Unspecified</option>
              {COMPANY_STAGE_OPTIONS.map((stage) => (
                <option key={stage} value={stage}>
                  {stage}
                </option>
              ))}
            </select>
          </label>
          <span>Status: {company.status}</span>
          <span>Last touch: {formatDateTime(company.lastTouchpoint)}</span>
        </div>
        <div className={styles.businessBlock}>
          <div className={styles.businessLabel}>Business Description</div>
          <p className={styles.businessText}>
            {(company.description || '').trim() || 'No business description added yet.'}
          </p>
        </div>
        <div className={styles.tagsRow}>
          {company.industries.length > 0 && (
            <div className={styles.tagGroup}>
              <strong>Industry</strong>
              {company.industries.map((item) => (
                <span key={item} className={styles.tag}>{item}</span>
              ))}
            </div>
          )}
          {company.themes.length > 0 && (
            <div className={styles.tagGroup}>
              <strong>Themes</strong>
              {company.themes.map((item) => (
                <span key={item} className={styles.tag}>{item}</span>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className={styles.tabRow}>
        {tabs.map((tab) => (
          <button
            key={tab}
            className={`${styles.tab} ${activeTab === tab ? styles.activeTab : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            <span className={styles.tabLabel}>{TAB_LABELS[tab]}</span>
            {tabCounts[tab] !== undefined && (
              <span className={styles.tabCount}>{tabCounts[tab]}</span>
            )}
          </button>
        ))}
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {activeTab === 'meetings' && (
        <div className={styles.section}>
          {meetings.length === 0 && (
            <div className={styles.empty}>No meetings linked to this company yet.</div>
          )}
          {meetings.length > 0 && (
            <div className={styles.meetingListView}>
              {groupMeetingsByDate(meetings).map(([dateHeading, groupedMeetings]) => (
                <div key={dateHeading} className={styles.meetingDateGroup}>
                  <div className={styles.meetingDateHeader}>
                    <span>{dateHeading}</span>
                  </div>
                  <div className={styles.meetingRows}>
                    {groupedMeetings.map((meeting) => (
                      <button
                        key={meeting.id}
                        className={styles.meetingRow}
                        onClick={() => navigate(`/meeting/${meeting.id}`, {
                          state: { fromCompanyId: companyId }
                        })}
                      >
                        <div className={styles.meetingRowTop}>
                          <span className={styles.meetingRowTitle}>{meeting.title}</span>
                          <span className={styles.meetingRowTime}>{formatTime(meeting.date)}</span>
                        </div>
                        <div className={styles.meetingRowMeta}>
                          {[meeting.status, formatDuration(meeting.durationSeconds)].filter(Boolean).join(' | ')}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'contacts' && (
        <div className={styles.section}>
          {contacts.length === 0 && (
            <div className={styles.empty}>No contacts linked to this company yet.</div>
          )}
          {contacts.length > 0 && (
            <div className={styles.contactListView}>
              <div className={styles.contactRows}>
                {contacts.map((contact) => (
                  <button
                    key={contact.id}
                    className={styles.contactRow}
                    onClick={() => navigate(`/contact/${contact.id}`)}
                  >
                    <div className={styles.contactRowTop}>
                      <span className={styles.contactRowName}>{contact.fullName}</span>
                      <span className={styles.contactRowTime}>{formatTime(contact.lastInteractedAt)}</span>
                    </div>
                    <div className={styles.contactRowMeta}>
                      {[
                        contact.email,
                        contact.title,
                        contact.meetingCount > 0
                          ? `${contact.meetingCount} meeting${contact.meetingCount === 1 ? '' : 's'}`
                          : null,
                        `Last touch ${formatDateTime(contact.lastInteractedAt || contact.updatedAt)}`
                      ].filter(Boolean).join(' | ')}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'emails' && (
        <div className={styles.section}>
          <div className={styles.emailActions}>
            <button
              className={styles.secondaryButton}
              onClick={handleIngestCompanyEmails}
              disabled={ingestingEmails}
            >
              {ingestingEmails ? 'Ingesting from Gmail...' : 'Ingest from Gmail'}
            </button>
            {emailIngestSummary && (
              <span className={styles.emailIngestMeta}>{emailIngestSummary}</span>
            )}
          </div>
          {emails.length === 0 && (
            <div className={styles.empty}>No emails linked to this company yet.</div>
          )}
          {emails.length > 0 && (
            <div className={styles.emailListView}>
              {groupEmailsByDate(emails).map(([dateHeading, groupedEmails]) => (
                <div key={dateHeading} className={styles.emailDateGroup}>
                  <div className={styles.emailDateHeader}>
                    <span>{dateHeading}</span>
                  </div>
                  <div className={styles.emailRows}>
                    {groupedEmails.map((email) => {
                      const expanded = expandedEmailId === email.id
                      const recipients = getEmailRecipientGroups(email)
                      return (
                        <div
                          key={email.id}
                          className={`${styles.emailRow} ${expanded ? styles.emailRowExpanded : ''}`}
                          role="button"
                          tabIndex={0}
                          onClick={() => toggleExpandedEmail(email.id)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              toggleExpandedEmail(email.id)
                            }
                          }}
                        >
                          <div className={styles.emailRowTop}>
                            <span className={styles.emailRowSubject}>{email.subject?.trim() || '(no subject)'}</span>
                            <span className={styles.emailRowTime}>{formatTime(email.receivedAt || email.sentAt)}</span>
                          </div>
                          <div className={styles.emailRowMeta}>
                            {[
                              email.fromName ? `${email.fromName} <${email.fromEmail}>` : email.fromEmail,
                              email.threadMessageCount > 1 ? `${email.threadMessageCount} messages in thread` : null
                            ].filter(Boolean).join(' | ')}
                          </div>
                          {(recipients.to.length > 0 || recipients.cc.length > 0 || recipients.bcc.length > 0) && (
                            <div className={styles.emailRecipients}>
                              {([
                                ['To', recipients.to],
                                ['Cc', recipients.cc],
                                ['Bcc', recipients.bcc]
                              ] as const).map(([label, participants]) => (
                                participants.length > 0 ? (
                                  <div key={label} className={styles.emailRecipientRow}>
                                    <span className={styles.emailRecipientRole}>{label}:</span>
                                    <span className={styles.emailRecipientList}>
                                      {participants.map((participant, index) => (
                                        <span key={`${participant.role}:${participant.email}`} className={styles.emailRecipientToken}>
                                          {participant.contactId ? (
                                            <button
                                              type="button"
                                              className={styles.emailRecipientLink}
                                              onClick={(event) => {
                                                event.stopPropagation()
                                                navigate(`/contact/${participant.contactId}`)
                                              }}
                                              onKeyDown={(event) => {
                                                event.stopPropagation()
                                              }}
                                            >
                                              {formatEmailParticipantLabel(participant)}
                                            </button>
                                          ) : (
                                            <span className={styles.emailRecipientText}>
                                              {formatEmailParticipantLabel(participant)}
                                            </span>
                                          )}
                                          {index < participants.length - 1 && (
                                            <span className={styles.emailRecipientDelimiter}>, </span>
                                          )}
                                        </span>
                                      ))}
                                    </span>
                                  </div>
                                ) : null
                              ))}
                            </div>
                          )}
                          {expanded ? (
                            <div className={styles.emailRowBody}>
                              {email.bodyText?.trim()
                                || email.snippet?.trim()
                                || 'No email body available for this message.'}
                            </div>
                          ) : (
                            email.snippet && <div className={styles.emailRowSnippet}>{email.snippet}</div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
              <div className={styles.meta}>
                Click an email row to {expandedEmailId ? 'collapse/expand details' : 'expand details'}.
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'files' && (
        <div className={styles.section}>
          {filesLoading && (
            <div className={styles.meta}>Loading files...</div>
          )}
          {!filesLoading && files.length === 0 && (
            <div className={styles.empty}>
              No Google Drive files found for this company. Configure the company files root folder in Settings and grant Drive Files access.
            </div>
          )}
          {files.length > 0 && (
            <div className={styles.fileListView}>
              {groupFilesByDate(files).map(([dateHeading, groupedFiles]) => (
                <div key={dateHeading} className={styles.fileDateGroup}>
                  <div className={styles.fileDateHeader}>
                    <span>{dateHeading}</span>
                  </div>
                  <div className={styles.fileRows}>
                    {groupedFiles.map((file) => (
                      <button
                        key={file.id}
                        className={styles.fileRow}
                        onClick={() => {
                          if (file.webViewLink) {
                            void handleOpenWebsite(file.webViewLink)
                          }
                        }}
                        disabled={!file.webViewLink}
                      >
                        <div className={styles.fileRowTop}>
                          <span className={styles.fileRowTitle}>{file.name}</span>
                          <span className={styles.fileRowTime}>{formatTime(file.modifiedAt)}</span>
                        </div>
                        <div className={styles.fileRowMeta}>
                          {[
                            file.parentFolderName ? `Folder: ${file.parentFolderName}` : null,
                            formatDriveFileType(file.mimeType),
                            formatFileSize(file.sizeBytes)
                          ].filter(Boolean).join(' | ')}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'notes' && (
        <div className={styles.section}>
          <div className={styles.editor}>
            <input
              className={styles.input}
              placeholder="Optional note title"
              value={noteTitle}
              onChange={(e) => setNoteTitle(e.target.value)}
            />
            <textarea
              className={styles.textarea}
              placeholder="Add company-specific notes, risks, and follow-ups"
              value={noteContent}
              onChange={(e) => setNoteContent(e.target.value)}
            />
            <button className={styles.primaryButton} onClick={handleAddNote}>
              Add Note
            </button>
          </div>

          <div className={styles.stack}>
            {notes.length === 0 && (
              <div className={styles.empty}>No notes yet for this company.</div>
            )}
            {notes.map((note) => (
              <div key={note.id} className={styles.noteCard}>
                <div className={styles.noteHeader}>
                  <strong>{note.title || 'Untitled note'}</strong>
                  <div className={styles.noteActions}>
                    <button className={styles.actionBtn} onClick={() => handleTogglePinNote(note)}>
                      {note.isPinned ? 'Unpin' : 'Pin'}
                    </button>
                    <button className={styles.actionBtn} onClick={() => handleDeleteNote(note.id)}>
                      Delete
                    </button>
                  </div>
                </div>
                <div className={styles.noteBody}>{note.content}</div>
                <div className={styles.noteMeta}>
                  Updated: {formatDateTime(note.updatedAt)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab === 'memo' && (
        <div className={styles.section}>
          {!memo && (
            <div className={styles.meta}>Loading memo...</div>
          )}
          {memo && (
            <>
              <div className={styles.memoToolbar}>
                <div>
                  <strong>{memo.title}</strong>
                  <div className={styles.noteMeta}>
                    Status: {memo.status} | Latest version: {memo.latestVersionNumber}
                  </div>
                </div>
                <div className={styles.memoActions}>
                  <select
                    className={styles.select}
                    value={memo.status}
                    onChange={(e) =>
                      handleMemoStatusChange(e.target.value as 'draft' | 'review' | 'final' | 'archived')
                    }
                  >
                    <option value="draft">Draft</option>
                    <option value="review">Review</option>
                    <option value="final">Final</option>
                    <option value="archived">Archived</option>
                  </select>
                  <button
                    className={styles.secondaryButton}
                    onClick={handleExportMemo}
                    disabled={exportingMemo}
                  >
                    {exportingMemo ? 'Exporting...' : 'Export PDF'}
                  </button>
                </div>
              </div>

              <textarea
                className={styles.memoEditor}
                value={memoDraft}
                onChange={(e) => setMemoDraft(e.target.value)}
                placeholder="Write investment memo in markdown"
              />
              <input
                className={styles.input}
                placeholder="Version note (optional)"
                value={memoChangeNote}
                onChange={(e) => setMemoChangeNote(e.target.value)}
              />
              <button
                className={styles.primaryButton}
                onClick={handleSaveMemo}
                disabled={savingMemo}
              >
                {savingMemo ? 'Saving...' : 'Save New Version'}
              </button>

              <div className={styles.stack}>
                {memoVersions.map((version) => (
                  <button
                    key={version.id}
                    className={styles.versionCard}
                    onClick={() => setMemoDraft(version.contentMarkdown)}
                  >
                    <div className={styles.timelineTop}>
                      <strong>Version {version.versionNumber}</strong>
                      <span className={styles.timelineWhen}>{formatDateTime(version.createdAt)}</span>
                    </div>
                    {version.changeNote && (
                      <div className={styles.timelineSubtitle}>{version.changeNote}</div>
                    )}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
