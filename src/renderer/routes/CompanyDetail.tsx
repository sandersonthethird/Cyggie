import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { useFeatureFlags } from '../hooks/useFeatureFlags'
import type {
  CompanyEntityType,
  CompanyDetail as CompanyDetailType,
  CompanyContactRef,
  CompanyDriveFileRef,
  CompanyEmailIngestResult,
  CompanyEmailRef,
  CompanyMeetingRef,
  CompanyNote,
  CompanyTimelineItem,
  InvestmentMemoVersion,
  InvestmentMemoWithLatest
} from '../../shared/types/company'
import type { CompanyActiveDeal } from '../../shared/types/pipeline'
import type { UnifiedSearchAnswerResponse } from '../../shared/types/unified-search'
import styles from './CompanyDetail.module.css'

type CompanyTab = 'overview' | 'timeline' | 'notes' | 'memo' | 'contacts' | 'files' | 'chat'
type TimelineFilter = 'all' | 'meeting' | 'email' | 'note' | 'deal_event'

interface CompanyConversation {
  id: string
  companyId: string
  themeId: string | null
  title: string
  modelProvider: string | null
  modelName: string | null
  isPinned: boolean
  isArchived: boolean
  lastMessageAt: string | null
  createdAt: string
  updatedAt: string
}

interface CompanyConversationMessage {
  id: string
  conversationId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  citationsJson: string | null
  tokenCount: number | null
  createdAt: string
}

const COMPANY_ENTITY_TYPE_OPTIONS: Array<{ value: CompanyEntityType; label: string }> = [
  { value: 'prospect', label: 'prospect' },
  { value: 'portfolio', label: 'portfolio' },
  { value: 'vc_fund', label: 'vc fund' },
  { value: 'customer', label: 'customer' },
  { value: 'partner', label: 'partner' },
  { value: 'vendor', label: 'vendor' },
  { value: 'other', label: 'other' },
  { value: 'unknown', label: 'unknown' }
]

function formatDateTime(value: string | null): string {
  if (!value) return 'Unknown'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown'
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

function daysSince(value: string | null): number | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24))
}

function formatDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return '-'
  return `${Math.round(seconds / 60)} min`
}

function formatTimelineType(type: CompanyTimelineItem['type']): string {
  if (type === 'meeting') return 'Meeting'
  if (type === 'email') return 'Email'
  if (type === 'note') return 'Note'
  return 'Deal Event'
}

function formatFileSize(bytes: number | null): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function displayError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw
    .replace(/^Error invoking remote method '.*?':\s*/, '')
    .replace(/^Error:\s*/, '')
}

function isMissingHandlerError(message: string, channel: string): boolean {
  return message.toLowerCase().includes('no handler registered') && message.includes(channel)
}

export default function CompanyDetail() {
  const { companyId = '' } = useParams()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { values: flags, loading: flagsLoading } = useFeatureFlags([
    'ff_companies_ui_v1',
    'ff_company_notes_v1',
    'ff_investment_memo_v1',
    'ff_company_chat_v1'
  ])

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<CompanyTab>('overview')
  const [timelineFilter, setTimelineFilter] = useState<TimelineFilter>('all')
  const [editingEntityType, setEditingEntityType] = useState(false)
  const [updatingEntityType, setUpdatingEntityType] = useState(false)

  const [company, setCompany] = useState<CompanyDetailType | null>(null)
  const [timeline, setTimeline] = useState<CompanyTimelineItem[]>([])
  const [meetings, setMeetings] = useState<CompanyMeetingRef[]>([])
  const [emails, setEmails] = useState<CompanyEmailRef[]>([])
  const [contacts, setContacts] = useState<CompanyContactRef[]>([])
  const [files, setFiles] = useState<CompanyDriveFileRef[]>([])
  const [filesLoaded, setFilesLoaded] = useState(false)
  const [activeDeal, setActiveDeal] = useState<CompanyActiveDeal | null>(null)

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

  const [conversations, setConversations] = useState<CompanyConversation[]>([])
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<CompanyConversationMessage[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatAsking, setChatAsking] = useState(false)
  const [chatStreaming, setChatStreaming] = useState('')

  const visibleTabs = useMemo(() => {
    const tabs: CompanyTab[] = ['overview', 'timeline', 'contacts']
    if (flags.ff_company_notes_v1) tabs.push('notes')
    if (flags.ff_investment_memo_v1) tabs.push('memo')
    tabs.push('files')
    if (flags.ff_company_chat_v1) tabs.push('chat')
    return tabs
  }, [flags.ff_company_chat_v1, flags.ff_company_notes_v1, flags.ff_investment_memo_v1])

  const loadChatConversations = useCallback(async () => {
    if (!companyId || !flags.ff_company_chat_v1) {
      setConversations([])
      setSelectedConversationId(null)
      setMessages([])
      return
    }
    const list = await window.api.invoke<CompanyConversation[]>(
      IPC_CHANNELS.COMPANY_CHAT_LIST,
      companyId
    )
    setConversations(list)
    const selected = list[0]?.id || null
    setSelectedConversationId(selected)
    if (selected) {
      const msgs = await window.api.invoke<CompanyConversationMessage[]>(
        IPC_CHANNELS.COMPANY_CHAT_MESSAGES,
        selected
      )
      setMessages(msgs)
    } else {
      setMessages([])
    }
  }, [companyId, flags.ff_company_chat_v1])

  const loadCore = useCallback(async () => {
    if (!companyId || !flags.ff_companies_ui_v1) return
    setLoading(true)
    setError(null)
    try {
      const companyData = await window.api.invoke<CompanyDetailType | null>(
        IPC_CHANNELS.COMPANY_GET,
        companyId
      )
      setCompany(companyData)
      if (!companyData) {
        setTimeline([])
        setMeetings([])
        setEmails([])
        setContacts([])
        setActiveDeal(null)
        setNotes([])
        setMemo(null)
        setMemoVersions([])
        setMemoDraft('')
        return
      }

      const [
        timelineResult,
        meetingResult,
        emailResult,
        contactResult,
        dealResult,
        noteResult,
        memoResult
      ] = await Promise.allSettled([
        window.api.invoke<CompanyTimelineItem[]>(IPC_CHANNELS.COMPANY_TIMELINE, companyId),
        window.api.invoke<CompanyMeetingRef[]>(IPC_CHANNELS.COMPANY_MEETINGS, companyId),
        window.api.invoke<CompanyEmailRef[]>(IPC_CHANNELS.COMPANY_EMAILS, companyId),
        window.api.invoke<CompanyContactRef[]>(IPC_CHANNELS.COMPANY_CONTACTS, companyId),
        window.api.invoke<CompanyActiveDeal | null>(IPC_CHANNELS.PIPELINE_GET_COMPANY_ACTIVE_DEAL, companyId),
        flags.ff_company_notes_v1
          ? window.api.invoke<CompanyNote[]>(IPC_CHANNELS.COMPANY_NOTES_LIST, companyId)
          : Promise.resolve([]),
        flags.ff_investment_memo_v1
          ? window.api.invoke<InvestmentMemoWithLatest>(IPC_CHANNELS.INVESTMENT_MEMO_GET_OR_CREATE, companyId)
          : Promise.resolve(null)
      ])

      const partialErrors: string[] = []
      const resolveOrFallback = <T,>(
        result: PromiseSettledResult<T>,
        fallback: T,
        channel?: string
      ): T => {
        if (result.status === 'fulfilled') return result.value
        const message = displayError(result.reason)
        if (!channel || !isMissingHandlerError(message, channel)) {
          partialErrors.push(message)
        }
        return fallback
      }

      const timelineData = resolveOrFallback(timelineResult, [] as CompanyTimelineItem[])
      const meetingData = resolveOrFallback(meetingResult, [] as CompanyMeetingRef[])
      const emailData = resolveOrFallback(emailResult, [] as CompanyEmailRef[])
      const contactData = resolveOrFallback(contactResult, [] as CompanyContactRef[])
      const dealData = resolveOrFallback(
        dealResult,
        null as CompanyActiveDeal | null,
        IPC_CHANNELS.PIPELINE_GET_COMPANY_ACTIVE_DEAL
      )
      const noteData = resolveOrFallback(noteResult, [] as CompanyNote[])
      const memoData = resolveOrFallback(memoResult, null as InvestmentMemoWithLatest | null)

      setTimeline(timelineData)
      setMeetings(meetingData)
      setEmails(emailData)
      setContacts(contactData)
      setActiveDeal(dealData)
      setNotes(noteData)
      setMemo(memoData)

      if (memoData) {
        try {
          const versions = await window.api.invoke<InvestmentMemoVersion[]>(
            IPC_CHANNELS.INVESTMENT_MEMO_LIST_VERSIONS,
            memoData.id
          )
          setMemoVersions(versions)
          setMemoDraft(memoData.latestVersion?.contentMarkdown || '')
        } catch (err) {
          partialErrors.push(displayError(err))
          setMemoVersions([])
          setMemoDraft(memoData.latestVersion?.contentMarkdown || '')
        }
      } else {
        setMemoVersions([])
        setMemoDraft('')
      }

      try {
        await loadChatConversations()
      } catch (err) {
        partialErrors.push(displayError(err))
      }

      setError(partialErrors.length > 0 ? partialErrors[0] : null)
    } catch (err) {
      setError(displayError(err))
    } finally {
      setLoading(false)
    }
  }, [
    companyId,
    flags.ff_companies_ui_v1,
    flags.ff_company_notes_v1,
    flags.ff_investment_memo_v1,
    loadChatConversations
  ])

  const loadFiles = useCallback(async () => {
    if (!companyId || filesLoaded) return
    try {
      const fileRows = await window.api.invoke<CompanyDriveFileRef[]>(
        IPC_CHANNELS.COMPANY_FILES,
        companyId
      )
      setFiles(fileRows)
      setFilesLoaded(true)
    } catch (err) {
      setError(displayError(err))
    }
  }, [companyId, filesLoaded])

  useEffect(() => {
    void loadCore()
  }, [loadCore])

  useEffect(() => {
    if (!visibleTabs.includes(activeTab)) {
      setActiveTab('overview')
    }
  }, [activeTab, visibleTabs])

  useEffect(() => {
    const requestedTab = (searchParams.get('tab') || '').toLowerCase()
    const requestedFilter = (searchParams.get('filter') || '').toLowerCase()

    if (requestedTab === 'timeline') {
      setActiveTab('timeline')
    } else if (requestedTab === 'memo') {
      setActiveTab('memo')
    }

    if (
      requestedFilter === 'meetings'
      || requestedFilter === 'emails'
      || requestedFilter === 'notes'
      || requestedFilter === 'deal-events'
    ) {
      const mappedFilter: TimelineFilter =
        requestedFilter === 'meetings'
          ? 'meeting'
          : requestedFilter === 'emails'
              ? 'email'
              : requestedFilter === 'notes'
                  ? 'note'
                  : 'deal_event'
      setTimelineFilter(mappedFilter)
    }
  }, [searchParams])

  useEffect(() => {
    setEditingEntityType(false)
    setUpdatingEntityType(false)
    setEmailIngestSummary(null)
  }, [companyId])

  useEffect(() => {
    if (activeTab === 'files') {
      void loadFiles()
    }
  }, [activeTab, loadFiles])

  useEffect(() => {
    if (!chatAsking) return
    const unsubscribe = window.api.on(IPC_CHANNELS.CHAT_PROGRESS, (chunk: unknown) => {
      if (chunk == null) {
        setChatStreaming('')
        return
      }
      setChatStreaming((prev) => prev + String(chunk))
    })
    return unsubscribe
  }, [chatAsking])

  const filteredTimeline = useMemo(() => {
    if (timelineFilter === 'all') return timeline
    return timeline.filter((item) => item.type === timelineFilter)
  }, [timeline, timelineFilter])

  const handleOpenExternal = useCallback(async (url: string) => {
    try {
      await window.api.invoke(IPC_CHANNELS.APP_OPEN_EXTERNAL_URL, url)
    } catch (err) {
      setError(displayError(err))
    }
  }, [])

  const handleCreateNote = useCallback(async () => {
    if (!companyId || !noteContent.trim()) return
    try {
      await window.api.invoke(IPC_CHANNELS.COMPANY_NOTES_CREATE, {
        companyId,
        title: noteTitle.trim() || null,
        content: noteContent.trim()
      })
      setNoteTitle('')
      setNoteContent('')
      const refreshed = await window.api.invoke<CompanyNote[]>(
        IPC_CHANNELS.COMPANY_NOTES_LIST,
        companyId
      )
      setNotes(refreshed)
      const refreshedTimeline = await window.api.invoke<CompanyTimelineItem[]>(
        IPC_CHANNELS.COMPANY_TIMELINE,
        companyId
      )
      setTimeline(refreshedTimeline)
    } catch (err) {
      setError(displayError(err))
    }
  }, [companyId, noteContent, noteTitle])

  const handleTogglePinNote = useCallback(async (note: CompanyNote) => {
    try {
      await window.api.invoke(IPC_CHANNELS.COMPANY_NOTES_UPDATE, note.id, { isPinned: !note.isPinned })
      const refreshed = await window.api.invoke<CompanyNote[]>(
        IPC_CHANNELS.COMPANY_NOTES_LIST,
        companyId
      )
      setNotes(refreshed)
    } catch (err) {
      setError(displayError(err))
    }
  }, [companyId])

  const handleDeleteNote = useCallback(async (noteId: string) => {
    try {
      await window.api.invoke(IPC_CHANNELS.COMPANY_NOTES_DELETE, noteId)
      const refreshed = await window.api.invoke<CompanyNote[]>(
        IPC_CHANNELS.COMPANY_NOTES_LIST,
        companyId
      )
      setNotes(refreshed)
      const refreshedTimeline = await window.api.invoke<CompanyTimelineItem[]>(
        IPC_CHANNELS.COMPANY_TIMELINE,
        companyId
      )
      setTimeline(refreshedTimeline)
    } catch (err) {
      setError(displayError(err))
    }
  }, [companyId])

  const handleSaveMemo = useCallback(async () => {
    if (!memo || !memoDraft.trim()) return
    setSavingMemo(true)
    try {
      await window.api.invoke(
        IPC_CHANNELS.INVESTMENT_MEMO_SAVE_VERSION,
        memo.id,
        {
          contentMarkdown: memoDraft,
          changeNote: memoChangeNote.trim() || null
        }
      )
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
      setMemoChangeNote('')
    } catch (err) {
      setError(displayError(err))
    } finally {
      setSavingMemo(false)
    }
  }, [companyId, memo, memoChangeNote, memoDraft])

  const handleMemoStatus = useCallback(async (status: 'draft' | 'review' | 'final' | 'archived') => {
    if (!memo) return
    try {
      const updated = await window.api.invoke<InvestmentMemoWithLatest>(
        IPC_CHANNELS.INVESTMENT_MEMO_SET_STATUS,
        memo.id,
        status
      )
      setMemo((prev) => (prev ? { ...updated, latestVersion: prev.latestVersion } : prev))
    } catch (err) {
      setError(displayError(err))
    }
  }, [memo])

  const handleExportMemo = useCallback(async () => {
    if (!memo) return
    setExportingMemo(true)
    try {
      await window.api.invoke(IPC_CHANNELS.INVESTMENT_MEMO_EXPORT_PDF, memo.id)
    } catch (err) {
      setError(displayError(err))
    } finally {
      setExportingMemo(false)
    }
  }, [memo])

  const handleIngestEmails = useCallback(async () => {
    if (!companyId) return
    setIngestingEmails(true)
    setError(null)
    setEmailIngestSummary(null)
    try {
      const result = await window.api.invoke<CompanyEmailIngestResult>(
        IPC_CHANNELS.COMPANY_EMAIL_INGEST,
        companyId
      )
      setEmailIngestSummary(
        `${result.insertedMessageCount} new, ${result.updatedMessageCount} updated, ${result.linkedMessageCount} linked`
      )
      await loadCore()
      setTimelineFilter('email')
      setActiveTab('timeline')
    } catch (err) {
      setError(displayError(err))
    } finally {
      setIngestingEmails(false)
    }
  }, [companyId, loadCore])

  const handleEntityTypeChange = useCallback(async (nextEntityType: CompanyEntityType) => {
    if (!company || updatingEntityType) return
    if (nextEntityType === company.entityType) {
      setEditingEntityType(false)
      return
    }

    setUpdatingEntityType(true)
    setError(null)
    try {
      const updated = await window.api.invoke<CompanyDetailType | null>(
        IPC_CHANNELS.COMPANY_UPDATE,
        company.id,
        {
          entityType: nextEntityType,
          classificationSource: 'manual',
          classificationConfidence: 1
        }
      )
      if (!updated) {
        throw new Error('Failed to update company type.')
      }
      setCompany(updated)
      setEditingEntityType(false)
    } catch (err) {
      setError(displayError(err))
    } finally {
      setUpdatingEntityType(false)
    }
  }, [company, updatingEntityType])

  const loadConversationMessages = useCallback(async (conversationId: string) => {
    const rows = await window.api.invoke<CompanyConversationMessage[]>(
      IPC_CHANNELS.COMPANY_CHAT_MESSAGES,
      conversationId
    )
    setMessages(rows)
  }, [])

  const ensureConversation = useCallback(async (): Promise<string | null> => {
    if (!companyId || !flags.ff_company_chat_v1) return null
    if (selectedConversationId) return selectedConversationId
    const created = await window.api.invoke<CompanyConversation>(
      IPC_CHANNELS.COMPANY_CHAT_CREATE,
      {
        companyId,
        title: `${company?.canonicalName || 'Company'} Chat`
      }
    )
    const refreshed = await window.api.invoke<CompanyConversation[]>(
      IPC_CHANNELS.COMPANY_CHAT_LIST,
      companyId
    )
    setConversations(refreshed)
    setSelectedConversationId(created.id)
    return created.id
  }, [company?.canonicalName, companyId, flags.ff_company_chat_v1, selectedConversationId])

  const handleSendChat = useCallback(async () => {
    const prompt = chatInput.trim()
    if (!prompt || chatAsking || !companyId) return
    setChatAsking(true)
    setChatStreaming('')
    setError(null)
    try {
      const conversationId = await ensureConversation()
      if (!conversationId) return

      await window.api.invoke(
        IPC_CHANNELS.COMPANY_CHAT_APPEND,
        {
          conversationId,
          role: 'user',
          content: prompt
        }
      )
      setChatInput('')
      await loadConversationMessages(conversationId)

      const answer = await window.api.invoke<UnifiedSearchAnswerResponse>(
        IPC_CHANNELS.UNIFIED_SEARCH_ANSWER,
        `${company?.canonicalName || ''} ${prompt}`.trim(),
        40
      )
      await window.api.invoke(
        IPC_CHANNELS.COMPANY_CHAT_APPEND,
        {
          conversationId,
          role: 'assistant',
          content: answer.answer,
          citationsJson: JSON.stringify(answer.citations)
        }
      )
      await loadConversationMessages(conversationId)
      const refreshed = await window.api.invoke<CompanyConversation[]>(
        IPC_CHANNELS.COMPANY_CHAT_LIST,
        companyId
      )
      setConversations(refreshed)
    } catch (err) {
      setError(displayError(err))
    } finally {
      setChatAsking(false)
      setChatStreaming('')
    }
  }, [
    chatAsking,
    chatInput,
    company?.canonicalName,
    companyId,
    ensureConversation,
    loadConversationMessages
  ])

  if (!flagsLoading && !flags.ff_companies_ui_v1) {
    return <div className={styles.page}>Companies view is disabled by feature flag.</div>
  }

  if (!companyId) {
    return <div className={styles.page}>Missing company id.</div>
  }

  if (loading && !company) {
    return <div className={styles.page}>Loading company...</div>
  }

  if (!company) {
    return <div className={styles.page}>{error || 'Company not found.'}</div>
  }

  const touchDays = daysSince(company.lastTouchpoint)

  return (
    <div className={styles.page}>
      <button className={styles.backButton} onClick={() => navigate('/companies')}>
        {'< Back to Companies'}
      </button>

      <section className={styles.header}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>{company.canonicalName}</h1>
          {editingEntityType ? (
            <select
              className={styles.typeSelect}
              value={company.entityType}
              onChange={(event) => void handleEntityTypeChange(event.target.value as CompanyEntityType)}
              onBlur={() => setEditingEntityType(false)}
              disabled={updatingEntityType}
              autoFocus
              aria-label="Company type"
            >
              {COMPANY_ENTITY_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : (
            <button
              type="button"
              className={styles.typeBadgeButton}
              onClick={() => setEditingEntityType(true)}
              disabled={updatingEntityType}
              title="Click to change company type"
            >
              {company.entityType.replace('_', ' ')}
            </button>
          )}
          {company.stage && <span className={styles.stageBadge}>{company.stage}</span>}
        </div>
        <div className={styles.metaRow}>
          <span>{company.primaryDomain || 'No domain'}</span>
          <span>{company.status}</span>
          <span>{touchDays == null ? 'No touchpoint' : `Last touch ${touchDays}d ago`}</span>
        </div>
        <p className={styles.description}>
          {(company.description || '').trim() || 'No business description added yet.'}
        </p>
      </section>

      <div className={styles.tabRow}>
        {visibleTabs.map((tab) => (
          <button
            key={tab}
            className={`${styles.tab} ${activeTab === tab ? styles.activeTab : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {activeTab === 'overview' && (
        <section className={styles.section}>
          <div className={styles.metricGrid}>
            <div className={styles.metricCard}>
              <span className={styles.metricLabel}>Meetings</span>
              <strong>{company.meetingCount}</strong>
            </div>
            <div className={styles.metricCard}>
              <span className={styles.metricLabel}>Emails</span>
              <strong>{company.emailCount}</strong>
            </div>
            <div className={styles.metricCard}>
              <span className={styles.metricLabel}>Contacts</span>
              <strong>{contacts.length}</strong>
            </div>
            <div className={styles.metricCard}>
              <span className={styles.metricLabel}>Days Since Touch</span>
              <strong>{touchDays == null ? '-' : touchDays}</strong>
            </div>
          </div>

          {activeDeal ? (
            <div className={styles.dealCard}>
              <div className={styles.dealHeader}>
                <h3>Active Deal</h3>
                <span>{activeDeal.stageLabel}</span>
              </div>
              <p>In stage for {activeDeal.stageDurationDays} days.</p>
              <div className={styles.dealHistory}>
                {activeDeal.history.slice(0, 5).map((event) => (
                  <div key={event.id} className={styles.dealHistoryRow}>
                    <span>{event.fromStage ? `${event.fromStage} -> ${event.toStage}` : `Moved to ${event.toStage}`}</span>
                    <span>{formatDateTime(event.eventTime)}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className={styles.empty}>No active deal yet.</p>
          )}

          <div className={styles.tagGroup}>
            {company.industries.map((industry) => (
              <span key={industry} className={styles.tag}>{industry}</span>
            ))}
            {company.themes.map((theme) => (
              <span key={theme} className={styles.tag}>{theme}</span>
            ))}
          </div>
        </section>
      )}

      {activeTab === 'timeline' && (
        <section className={styles.section}>
          <div className={styles.filterRow}>
            {(['all', 'meeting', 'email', 'note', 'deal_event'] as TimelineFilter[]).map((filter) => (
              <button
                key={filter}
                className={`${styles.filterChip} ${timelineFilter === filter ? styles.activeFilter : ''}`}
                onClick={() => setTimelineFilter(filter)}
                disabled={ingestingEmails}
              >
                {filter === 'all' ? 'All' : formatTimelineType(filter)}
              </button>
            ))}
            <button
              className={styles.secondaryButton}
              onClick={() => void handleIngestEmails()}
              disabled={ingestingEmails}
            >
              {ingestingEmails ? 'Ingesting...' : 'Sync Emails'}
            </button>
          </div>
          {ingestingEmails && (
            <div className={styles.ingestStatus} role="status" aria-live="polite">
              <span className={styles.loadingDot} aria-hidden="true" />
              <span>Syncing emails for this company. This can take up to a minute.</span>
            </div>
          )}
          {emailIngestSummary && !ingestingEmails && (
            <div className={styles.ingestMeta}>{emailIngestSummary}</div>
          )}

          {timelineFilter === 'meeting' && (
            <div className={styles.list}>
              {meetings.map((meeting) => (
                <button
                  key={meeting.id}
                  className={styles.rowButton}
                  onClick={() => navigate(`/meeting/${meeting.id}`)}
                >
                  <div className={styles.rowTitle}>{meeting.title}</div>
                  <div className={styles.rowMeta}>
                    {formatDateTime(meeting.date)} · {meeting.status} · {formatDuration(meeting.durationSeconds)}
                  </div>
                </button>
              ))}
              {meetings.length === 0 && <div className={styles.empty}>No meetings yet.</div>}
            </div>
          )}

          {timelineFilter === 'email' && (
            <div className={styles.list}>
              {emails.map((email) => (
                <div key={email.id} className={styles.emailCard}>
                  <button
                    className={styles.rowButton}
                    onClick={() => setExpandedEmailId((prev) => (prev === email.id ? null : email.id))}
                  >
                    <div className={styles.rowTitle}>{email.subject || '(no subject)'}</div>
                    <div className={styles.rowMeta}>
                      {email.fromName || email.fromEmail} · {formatDateTime(email.receivedAt || email.sentAt)}
                    </div>
                  </button>
                  {expandedEmailId === email.id && (
                    <div className={styles.emailBody}>{email.bodyText || email.snippet || '-'}</div>
                  )}
                </div>
              ))}
              {emails.length === 0 && <div className={styles.empty}>No emails linked yet.</div>}
            </div>
          )}

          {timelineFilter !== 'meeting' && timelineFilter !== 'email' && (
            <div className={styles.list}>
              {filteredTimeline.map((item) => (
                <button
                  key={item.id}
                  className={styles.rowButton}
                  onClick={() => {
                    if (item.referenceType === 'meeting') {
                      navigate(`/meeting/${item.referenceId}`)
                    }
                  }}
                >
                  <div className={styles.rowTitle}>
                    <span className={styles.typePill}>{formatTimelineType(item.type)}</span>
                    {item.title}
                  </div>
                  <div className={styles.rowMeta}>
                    {formatDateTime(item.occurredAt)}{item.subtitle ? ` · ${item.subtitle}` : ''}
                  </div>
                </button>
              ))}
              {filteredTimeline.length === 0 && <div className={styles.empty}>No timeline events.</div>}
            </div>
          )}
        </section>
      )}

      {activeTab === 'notes' && flags.ff_company_notes_v1 && (
        <section className={styles.section}>
          <div className={styles.noteEditor}>
            <input
              className={styles.input}
              value={noteTitle}
              onChange={(event) => setNoteTitle(event.target.value)}
              placeholder="Optional title"
            />
            <textarea
              className={styles.textarea}
              value={noteContent}
              onChange={(event) => setNoteContent(event.target.value)}
              placeholder="Write a company note..."
            />
            <button className={styles.primaryButton} onClick={() => void handleCreateNote()}>
              Add note
            </button>
          </div>
          <div className={styles.list}>
            {notes.map((note) => (
              <div key={note.id} className={styles.noteCard}>
                <div className={styles.noteHeader}>
                  <strong>{note.title || 'Note'}</strong>
                  <div className={styles.noteActions}>
                    <button className={styles.linkButton} onClick={() => void handleTogglePinNote(note)}>
                      {note.isPinned ? 'Unpin' : 'Pin'}
                    </button>
                    <button className={styles.linkButton} onClick={() => void handleDeleteNote(note.id)}>
                      Delete
                    </button>
                  </div>
                </div>
                <p>{note.content}</p>
                <span className={styles.rowMeta}>{formatDateTime(note.updatedAt)}</span>
              </div>
            ))}
            {notes.length === 0 && <div className={styles.empty}>No notes yet.</div>}
          </div>
        </section>
      )}

      {activeTab === 'memo' && flags.ff_investment_memo_v1 && (
        <section className={styles.section}>
          <div className={styles.memoActions}>
            <select
              className={styles.select}
              value={memo?.status || 'draft'}
              onChange={(event) => void handleMemoStatus(event.target.value as InvestmentMemoWithLatest['status'])}
              disabled={!memo}
            >
              <option value="draft">Draft</option>
              <option value="review">Review</option>
              <option value="final">Final</option>
              <option value="archived">Archived</option>
            </select>
            <button className={styles.secondaryButton} onClick={() => void handleExportMemo()} disabled={exportingMemo || !memo}>
              {exportingMemo ? 'Exporting...' : 'Export PDF'}
            </button>
          </div>
          <textarea
            className={styles.memoEditor}
            value={memoDraft}
            onChange={(event) => setMemoDraft(event.target.value)}
            placeholder="Investment memo markdown..."
          />
          <input
            className={styles.input}
            value={memoChangeNote}
            onChange={(event) => setMemoChangeNote(event.target.value)}
            placeholder="Change note (optional)"
          />
          <button className={styles.primaryButton} onClick={() => void handleSaveMemo()} disabled={savingMemo || !memoDraft.trim()}>
            {savingMemo ? 'Saving...' : 'Save Memo Version'}
          </button>
          <div className={styles.list}>
            {memoVersions.map((version) => (
              <div key={version.id} className={styles.versionCard}>
                <strong>v{version.versionNumber}</strong>
                <span>{version.changeNote || 'No change note'}</span>
                <span className={styles.rowMeta}>{formatDateTime(version.createdAt)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {activeTab === 'contacts' && (
        <section className={styles.section}>
          <div className={styles.list}>
            {contacts.map((contact) => (
              <button
                key={contact.id}
                className={styles.rowButton}
                onClick={() => navigate(`/contact/${contact.id}`)}
              >
                <div className={styles.rowTitle}>{contact.fullName}</div>
                <div className={styles.rowMeta}>
                  {[
                    contact.title,
                    contact.email,
                    `${contact.meetingCount} meetings`,
                    formatDateTime(contact.lastInteractedAt)
                  ].filter(Boolean).join(' · ')}
                </div>
              </button>
            ))}
            {contacts.length === 0 && <div className={styles.empty}>No contacts linked yet.</div>}
          </div>
        </section>
      )}

      {activeTab === 'files' && (
        <section className={styles.section}>
          <div className={styles.list}>
            {files.map((file) => (
              <button
                key={file.id}
                className={styles.rowButton}
                onClick={() => {
                  if (file.webViewLink) {
                    void handleOpenExternal(file.webViewLink)
                  }
                }}
              >
                <div className={styles.rowTitle}>{file.name}</div>
                <div className={styles.rowMeta}>
                  {[file.mimeType, formatFileSize(file.sizeBytes), formatDateTime(file.modifiedAt)].join(' · ')}
                </div>
              </button>
            ))}
            {filesLoaded && files.length === 0 && <div className={styles.empty}>No linked files yet.</div>}
            {!filesLoaded && <div className={styles.empty}>Loading files...</div>}
          </div>
        </section>
      )}

      {activeTab === 'chat' && flags.ff_company_chat_v1 && (
        <section className={styles.section}>
          <div className={styles.chatLayout}>
            <div className={styles.chatSidebar}>
              <button
                className={styles.secondaryButton}
                onClick={async () => {
                  try {
                    const created = await window.api.invoke<CompanyConversation>(
                      IPC_CHANNELS.COMPANY_CHAT_CREATE,
                      {
                        companyId,
                        title: `${company.canonicalName} Chat`
                      }
                    )
                    setSelectedConversationId(created.id)
                    await loadChatConversations()
                  } catch (err) {
                    setError(displayError(err))
                  }
                }}
              >
                + Conversation
              </button>
              <div className={styles.list}>
                {conversations.map((conversation) => (
                  <button
                    key={conversation.id}
                    className={`${styles.rowButton} ${
                      conversation.id === selectedConversationId ? styles.selectedConversation : ''
                    }`}
                    onClick={async () => {
                      setSelectedConversationId(conversation.id)
                      try {
                        await loadConversationMessages(conversation.id)
                      } catch (err) {
                        setError(displayError(err))
                      }
                    }}
                  >
                    <div className={styles.rowTitle}>{conversation.title}</div>
                    <div className={styles.rowMeta}>{formatDateTime(conversation.lastMessageAt || conversation.updatedAt)}</div>
                  </button>
                ))}
              </div>
            </div>

            <div className={styles.chatMain}>
              <div className={styles.chatMessages}>
                {messages.map((message) => (
                  <div key={message.id} className={styles.chatMessage}>
                    <span className={styles.chatRole}>{message.role === 'assistant' ? 'AI' : 'You'}</span>
                    <pre>{message.content}</pre>
                  </div>
                ))}
                {chatAsking && chatStreaming && (
                  <div className={styles.chatMessage}>
                    <span className={styles.chatRole}>AI</span>
                    <pre>{chatStreaming}</pre>
                  </div>
                )}
                {!chatAsking && messages.length === 0 && (
                  <div className={styles.empty}>Start a company-scoped conversation.</div>
                )}
              </div>
              <div className={styles.chatInputRow}>
                <textarea
                  className={styles.textarea}
                  value={chatInput}
                  onChange={(event) => setChatInput(event.target.value)}
                  placeholder="Ask anything about this company..."
                />
                <button className={styles.primaryButton} onClick={() => void handleSendChat()} disabled={!chatInput.trim() || chatAsking}>
                  {chatAsking ? 'Asking...' : 'Send'}
                </button>
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  )
}
