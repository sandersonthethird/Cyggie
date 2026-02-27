import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
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
import type { CompanyPipelineStage, CompanyPriority, CompanyRound } from '../../shared/types/company'
import type { UnifiedSearchAnswerResponse } from '../../shared/types/unified-search'
import styles from './CompanyDetail.module.css'

type CompanyTab = 'overview' | 'timeline' | 'notes' | 'memo' | 'contacts' | 'files'
type TimelineFilter = 'all' | 'meeting' | 'email' | 'note'

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

interface CompanyFilesLookupResult {
  companyRoot: string | null
  files: CompanyDriveFileRef[]
}

interface CompanyFilesCacheEntry extends CompanyFilesLookupResult {
  resolvedAt: number
}

const COMPANY_ENTITY_TYPE_OPTIONS: Array<{ value: CompanyEntityType; label: string }> = [
  { value: 'prospect', label: 'prospect' },
  { value: 'portfolio', label: 'portfolio' },
  { value: 'pass', label: 'pass' },
  { value: 'vc_fund', label: 'vc fund' },
  { value: 'customer', label: 'customer' },
  { value: 'partner', label: 'partner' },
  { value: 'vendor', label: 'vendor' },
  { value: 'other', label: 'other' },
  { value: 'unknown', label: 'unknown' }
]

const COMPANY_FILES_CACHE_TTL_MS = 15 * 60 * 1000
const companyFilesCache = new Map<string, CompanyFilesCacheEntry>()
const companyFilesInFlight = new Map<string, Promise<CompanyFilesLookupResult>>()

function companyFilesLookupKey(companyId: string, browsePath?: string): string {
  const path = (browsePath || '').trim()
  return `${companyId}::${path}`
}

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
  const [fileCompanyRoot, setFileCompanyRoot] = useState<string | null>(null)
  const [fileBrowsePath, setFileBrowsePath] = useState<string | null>(null)
  const [pipelineStageDraft, setPipelineStageDraft] = useState<CompanyPipelineStage | ''>('')
  const [priorityDraft, setPriorityDraft] = useState<CompanyPriority | ''>('')
  const [roundDraft, setRoundDraft] = useState<CompanyRound | ''>('')
  const [postMoneyDraft, setPostMoneyDraft] = useState('')
  const [raiseSizeDraft, setRaiseSizeDraft] = useState('')

  const [notes, setNotes] = useState<CompanyNote[]>([])
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

  const [editingHeader, setEditingHeader] = useState(false)
  const [savingHeader, setSavingHeader] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [descriptionDraft, setDescriptionDraft] = useState('')
  const [domainDraft, setDomainDraft] = useState('')
  const [cityDraft, setCityDraft] = useState('')
  const [stateDraft, setStateDraft] = useState('')
  const nameInputRef = useRef<HTMLInputElement>(null)
  const latestCompanyIdRef = useRef(companyId)

  const [conversations, setConversations] = useState<CompanyConversation[]>([])
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<CompanyConversationMessage[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatAsking, setChatAsking] = useState(false)
  const [chatStreaming, setChatStreaming] = useState('')

  const FILES_ENTITY_TYPES: Set<CompanyEntityType> = new Set(['prospect', 'portfolio', 'pass'])

  useEffect(() => {
    latestCompanyIdRef.current = companyId
  }, [companyId])

  const visibleTabs = useMemo(() => {
    const tabs: CompanyTab[] = ['overview', 'timeline', 'contacts']
    if (flags.ff_company_notes_v1) tabs.push('notes')
    if (flags.ff_investment_memo_v1) tabs.push('memo')
    if (company && FILES_ENTITY_TYPES.has(company.entityType)) tabs.push('files')
    return tabs
  }, [company, flags.ff_company_notes_v1, flags.ff_investment_memo_v1])

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
        noteResult,
        memoResult
      ] = await Promise.allSettled([
        window.api.invoke<CompanyTimelineItem[]>(IPC_CHANNELS.COMPANY_TIMELINE, companyId),
        window.api.invoke<CompanyMeetingRef[]>(IPC_CHANNELS.COMPANY_MEETINGS, companyId),
        window.api.invoke<CompanyEmailRef[]>(IPC_CHANNELS.COMPANY_EMAILS, companyId),
        window.api.invoke<CompanyContactRef[]>(IPC_CHANNELS.COMPANY_CONTACTS, companyId),
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
      const noteData = resolveOrFallback(noteResult, [] as CompanyNote[])
      const memoData = resolveOrFallback(memoResult, null as InvestmentMemoWithLatest | null)

      setTimeline(timelineData)
      setMeetings(meetingData)
      setEmails(emailData)
      setContacts(contactData)
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

  const loadFiles = useCallback(async (browsePath?: string) => {
    if (!companyId) return
    const requestCompanyId = companyId
    const lookupKey = companyFilesLookupKey(requestCompanyId, browsePath)
    const cached = companyFilesCache.get(lookupKey)
    const isFreshCache = cached && (Date.now() - cached.resolvedAt) < COMPANY_FILES_CACHE_TTL_MS
    if (isFreshCache) {
      setFiles(cached.files)
      setFileCompanyRoot(cached.companyRoot)
      setFileBrowsePath(browsePath || cached.companyRoot)
      setFilesLoaded(true)
      return
    }

    try {
      let pending = companyFilesInFlight.get(lookupKey)
      if (!pending) {
        pending = window.api
          .invoke<unknown>(IPC_CHANNELS.COMPANY_FILES, requestCompanyId, browsePath)
          .then((raw): CompanyFilesLookupResult => {
            // Handle both { companyRoot, files } and legacy array formats
            const result = raw && typeof raw === 'object' && 'files' in raw
              ? (raw as CompanyFilesLookupResult)
              : { companyRoot: null, files: Array.isArray(raw) ? (raw as CompanyDriveFileRef[]) : [] }
            companyFilesCache.set(lookupKey, {
              ...result,
              resolvedAt: Date.now()
            })
            return result
          })
          .finally(() => {
            companyFilesInFlight.delete(lookupKey)
          })
        companyFilesInFlight.set(lookupKey, pending)
      }

      const result = await pending
      if (latestCompanyIdRef.current !== requestCompanyId) return
      setFiles(result.files)
      if (result.companyRoot) setFileCompanyRoot(result.companyRoot)
      setFileBrowsePath(browsePath || result.companyRoot)
    } catch (err) {
      if (latestCompanyIdRef.current !== requestCompanyId) return
      setError(displayError(err))
      setFiles([])
    } finally {
      if (latestCompanyIdRef.current !== requestCompanyId) return
      setFilesLoaded(true)
    }
  }, [companyId])

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
    ) {
      const mappedFilter: TimelineFilter =
        requestedFilter === 'meetings'
          ? 'meeting'
          : requestedFilter === 'emails'
              ? 'email'
              : 'note'
      setTimelineFilter(mappedFilter)
    }
  }, [searchParams])

  useEffect(() => {
    setEditingEntityType(false)
    setUpdatingEntityType(false)
    setEmailIngestSummary(null)
    setFilesLoaded(false)
    setFiles([])
    setFileCompanyRoot(null)
    setFileBrowsePath(null)
  }, [companyId])

  useEffect(() => {
    if (activeTab === 'files' && !filesLoaded) {
      void loadFiles()
    }
  }, [activeTab, filesLoaded, loadFiles])

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

  const latestAssistantReply = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i]
      if (message.role === 'assistant') return message.content
    }
    return ''
  }, [messages])

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
        content: noteContent.trim()
      })
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
  }, [companyId, noteContent])

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

  const startHeaderEdit = useCallback(() => {
    if (!company || savingHeader) return
    setNameDraft(company.canonicalName)
    setDescriptionDraft(company.description || '')
    setDomainDraft(company.primaryDomain || '')
    setCityDraft(company.city || '')
    setStateDraft(company.state || '')
    setPipelineStageDraft(company.pipelineStage || '')
    setPriorityDraft(company.priority || '')
    setRoundDraft(company.round || '')
    setPostMoneyDraft(company.postMoneyValuation != null ? String(company.postMoneyValuation) : '')
    setRaiseSizeDraft(company.raiseSize != null ? String(company.raiseSize) : '')
    setEditingHeader(true)
    setTimeout(() => {
      nameInputRef.current?.focus()
      nameInputRef.current?.select()
    }, 0)
  }, [company, savingHeader])

  const cancelHeaderEdit = useCallback(() => {
    setEditingHeader(false)
  }, [])

  const saveHeader = useCallback(async () => {
    if (!company || savingHeader) return
    const nextName = nameDraft.trim()
    if (!nextName) {
      setError('Company name is required')
      cancelHeaderEdit()
      return
    }

    setSavingHeader(true)
    setError(null)
    try {
      const updated = await window.api.invoke<CompanyDetailType | null>(
        IPC_CHANNELS.COMPANY_UPDATE,
        company.id,
        {
          canonicalName: nextName,
          description: descriptionDraft.trim() || null,
          primaryDomain: domainDraft.trim() || null,
          city: cityDraft.trim() || null,
          state: stateDraft.trim() || null,
          pipelineStage: (pipelineStageDraft || null) as CompanyPipelineStage | null,
          priority: (priorityDraft || null) as CompanyPriority | null,
          round: (roundDraft || null) as CompanyRound | null,
          postMoneyValuation: postMoneyDraft.trim() ? Number(postMoneyDraft) : null,
          raiseSize: raiseSizeDraft.trim() ? Number(raiseSizeDraft) : null
        }
      )
      if (!updated) throw new Error('Failed to update company.')
      setCompany(updated)
      setEditingHeader(false)
    } catch (err) {
      setError(displayError(err))
    } finally {
      setSavingHeader(false)
    }
  }, [company, savingHeader, nameDraft, descriptionDraft, domainDraft, cityDraft, stateDraft, pipelineStageDraft, priorityDraft, roundDraft, postMoneyDraft, raiseSizeDraft, cancelHeaderEdit])

  const handleHeaderInputKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void saveHeader()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      cancelHeaderEdit()
    }
  }, [saveHeader, cancelHeaderEdit])

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

  const handleChatDockKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    void handleSendChat()
  }, [handleSendChat])

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
        {editingHeader ? (
          <div className={styles.editForm}>
            <div className={styles.editRow}>
              <label className={styles.editLabel}>Name</label>
              <input
                ref={nameInputRef}
                className={styles.editInput}
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={handleHeaderInputKeyDown}
                disabled={savingHeader}
                placeholder="Company name"
                aria-label="Company name"
              />
            </div>
            <div className={styles.editRow}>
              <label className={styles.editLabel}>Website</label>
              <input
                className={styles.editInput}
                value={domainDraft}
                onChange={(e) => setDomainDraft(e.target.value)}
                onKeyDown={handleHeaderInputKeyDown}
                disabled={savingHeader}
                placeholder="e.g. acme.com"
                aria-label="Website domain"
              />
            </div>
            <div className={styles.editRow}>
              <label className={styles.editLabel}>City</label>
              <input
                className={styles.editInput}
                value={cityDraft}
                onChange={(e) => setCityDraft(e.target.value)}
                onKeyDown={handleHeaderInputKeyDown}
                disabled={savingHeader}
                placeholder="e.g. San Francisco"
                aria-label="City"
              />
            </div>
            <div className={styles.editRow}>
              <label className={styles.editLabel}>State</label>
              <input
                className={styles.editInput}
                value={stateDraft}
                onChange={(e) => setStateDraft(e.target.value)}
                onKeyDown={handleHeaderInputKeyDown}
                disabled={savingHeader}
                placeholder="e.g. CA"
                aria-label="State"
              />
            </div>
            <div className={styles.editRow}>
              <label className={styles.editLabel}>Pipeline Stage</label>
              <select
                className={styles.editSelect}
                value={pipelineStageDraft}
                onChange={(e) => setPipelineStageDraft(e.target.value as CompanyPipelineStage | '')}
                disabled={savingHeader}
                aria-label="Pipeline stage"
              >
                <option value="">None</option>
                <option value="screening">Screening</option>
                <option value="diligence">Diligence</option>
                <option value="decision">Decision</option>
                <option value="documentation">Documentation</option>
                <option value="pass">Pass</option>
              </select>
            </div>
            <div className={styles.editRow}>
              <label className={styles.editLabel}>Priority</label>
              <select
                className={styles.editSelect}
                value={priorityDraft}
                onChange={(e) => setPriorityDraft(e.target.value as CompanyPriority | '')}
                disabled={savingHeader}
                aria-label="Priority"
              >
                <option value="">None</option>
                <option value="high">High</option>
                <option value="further_work">Further Work</option>
                <option value="monitor">Monitor</option>
              </select>
            </div>
            <div className={styles.editRow}>
              <label className={styles.editLabel}>Round</label>
              <select
                className={styles.editSelect}
                value={roundDraft}
                onChange={(e) => setRoundDraft(e.target.value as CompanyRound | '')}
                disabled={savingHeader}
                aria-label="Round"
              >
                <option value="">None</option>
                <option value="pre_seed">Pre-Seed</option>
                <option value="seed">Seed</option>
                <option value="seed_extension">Seed Extension</option>
                <option value="series_a">Series A</option>
                <option value="series_b">Series B</option>
              </select>
            </div>
            <div className={styles.editRow}>
              <label className={styles.editLabel}>Post Money ($M)</label>
              <input
                className={styles.editInput}
                type="number"
                step="0.1"
                value={postMoneyDraft}
                onChange={(e) => setPostMoneyDraft(e.target.value)}
                disabled={savingHeader}
                placeholder="e.g. 25"
                aria-label="Post money valuation in millions"
              />
            </div>
            <div className={styles.editRow}>
              <label className={styles.editLabel}>Raise Size ($M)</label>
              <input
                className={styles.editInput}
                type="number"
                step="0.1"
                value={raiseSizeDraft}
                onChange={(e) => setRaiseSizeDraft(e.target.value)}
                disabled={savingHeader}
                placeholder="e.g. 5"
                aria-label="Raise size in millions"
              />
            </div>
            <div className={styles.editRow}>
              <label className={styles.editLabel}>Type</label>
              <select
                className={styles.editSelect}
                value={company.entityType}
                onChange={(event) => void handleEntityTypeChange(event.target.value as CompanyEntityType)}
                disabled={updatingEntityType || savingHeader}
                aria-label="Company type"
              >
                {COMPANY_ENTITY_TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.editRow}>
              <label className={styles.editLabel}>Description</label>
              <textarea
                className={styles.editTextarea}
                value={descriptionDraft}
                onChange={(e) => setDescriptionDraft(e.target.value)}
                disabled={savingHeader}
                placeholder="Brief description of the company"
                aria-label="Description"
                rows={3}
              />
            </div>
            <div className={styles.editActions}>
              <button
                type="button"
                className={styles.editSaveButton}
                onClick={() => void saveHeader()}
                disabled={savingHeader || !nameDraft.trim()}
              >
                {savingHeader ? 'Saving...' : 'Save'}
              </button>
              <button
                type="button"
                className={styles.editCancelButton}
                onClick={cancelHeaderEdit}
                disabled={savingHeader}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className={styles.titleRow}>
              <h1 className={styles.title}>
                {company.canonicalName}
                {company.primaryDomain && (
                  <img
                    src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(company.primaryDomain)}&sz=64`}
                    alt=""
                    className={styles.titleLogo}
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                  />
                )}
              </h1>
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
              {company.pipelineStage && (
                <span className={styles.pipelineStageBadge}>
                  {company.pipelineStage === 'screening' ? 'Screening'
                    : company.pipelineStage === 'diligence' ? 'Diligence'
                    : company.pipelineStage === 'decision' ? 'Decision'
                    : company.pipelineStage === 'documentation' ? 'Documentation'
                    : 'Pass'}
                </span>
              )}
              {company.priority && (
                <span className={`${styles.priorityBadge} ${
                  company.priority === 'high' ? styles.priorityHigh
                    : company.priority === 'further_work' ? styles.priorityFurtherWork
                    : styles.priorityMonitor
                }`}>
                  {company.priority === 'high' ? 'High'
                    : company.priority === 'further_work' ? 'Further Work'
                    : 'Monitor'}
                </span>
              )}
              {company.round && (
                <span className={styles.roundBadge}>
                  {company.round.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                </span>
              )}
              <button
                type="button"
                className={styles.editButton}
                onClick={startHeaderEdit}
              >
                Edit
              </button>
            </div>
            <div className={styles.metaRow}>
              <span>{company.primaryDomain || 'No domain'}</span>
              {(company.city || company.state) && (
                <span>{[company.city, company.state].filter(Boolean).join(', ')}</span>
              )}
              <span>{company.status}</span>
              <span>{touchDays == null ? 'No touchpoint' : `Last touch ${touchDays}d ago`}</span>
              {(company.postMoneyValuation != null || company.raiseSize != null) && (
                <span>
                  {company.postMoneyValuation != null && `Val: $${company.postMoneyValuation}M`}
                  {company.postMoneyValuation != null && company.raiseSize != null && ' · '}
                  {company.raiseSize != null && `Raise: $${company.raiseSize}M`}
                </span>
              )}
            </div>
            <p className={styles.description}>
              {(company.description || '').trim() || 'No business description added yet.'}
            </p>
          </>
        )}
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

          {company.pipelineStage ? (
            <div className={styles.pipelineCard}>
              <h3>Pipeline</h3>
              <div className={styles.pipelineCardGrid}>
                <div className={styles.pipelineCardField}>
                  <span className={styles.pipelineCardLabel}>Stage</span>
                  <span className={styles.pipelineStageBadge}>
                    {company.pipelineStage === 'screening' ? 'Screening'
                      : company.pipelineStage === 'diligence' ? 'Diligence'
                      : company.pipelineStage === 'decision' ? 'Decision'
                      : company.pipelineStage === 'documentation' ? 'Documentation'
                      : 'Pass'}
                  </span>
                </div>
                {company.priority && (
                  <div className={styles.pipelineCardField}>
                    <span className={styles.pipelineCardLabel}>Priority</span>
                    <span className={`${styles.priorityBadge} ${
                      company.priority === 'high' ? styles.priorityHigh
                        : company.priority === 'further_work' ? styles.priorityFurtherWork
                        : styles.priorityMonitor
                    }`}>
                      {company.priority === 'high' ? 'High'
                        : company.priority === 'further_work' ? 'Further Work'
                        : 'Monitor'}
                    </span>
                  </div>
                )}
                {company.round && (
                  <div className={styles.pipelineCardField}>
                    <span className={styles.pipelineCardLabel}>Round</span>
                    <span>{company.round.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}</span>
                  </div>
                )}
                {company.postMoneyValuation != null && (
                  <div className={styles.pipelineCardField}>
                    <span className={styles.pipelineCardLabel}>Post Money</span>
                    <span>${company.postMoneyValuation}M</span>
                  </div>
                )}
                {company.raiseSize != null && (
                  <div className={styles.pipelineCardField}>
                    <span className={styles.pipelineCardLabel}>Raise Size</span>
                    <span>${company.raiseSize}M</span>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <p className={styles.empty}>Not in pipeline.</p>
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
            {(['all', 'meeting', 'email', 'note'] as TimelineFilter[]).map((filter) => (
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
                  <div className={styles.noteActions}>
                    <button className={styles.linkButton} onClick={() => void handleTogglePinNote(note)}>
                      {note.isPinned ? 'Unpin' : 'Pin'}
                    </button>
                    <button className={styles.linkButton} onClick={() => void handleDeleteNote(note.id)}>
                      Delete
                    </button>
                  </div>
                </div>
                <div className={styles.noteContent}>
                  <ReactMarkdown>{note.content}</ReactMarkdown>
                </div>
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
          {fileBrowsePath && fileCompanyRoot && fileBrowsePath !== fileCompanyRoot && (
            <button
              className={styles.fileBackBtn}
              onClick={() => {
                const parent = fileBrowsePath.replace(/\/[^/]+\/?$/, '')
                const target = parent.length >= fileCompanyRoot.length ? parent : fileCompanyRoot
                setFilesLoaded(false)
                void loadFiles(target)
              }}
            >
              &larr; Back
            </button>
          )}
          <div className={styles.fileList}>
            {files.map((file) => {
              const isFolder = file.mimeType === 'folder'
              const isLocal = !file.webViewLink && file.id.startsWith('/')
              return (
                <div
                  key={file.id}
                  className={styles.fileRow}
                  onDoubleClick={() => {
                    if (isFolder && isLocal) {
                      setFilesLoaded(false)
                      void loadFiles(file.id)
                    }
                  }}
                  onClick={() => {
                    if (!isFolder && file.webViewLink) {
                      void handleOpenExternal(file.webViewLink)
                    } else if (!isFolder && isLocal) {
                      void window.api.invoke(IPC_CHANNELS.APP_OPEN_PATH, file.id)
                    }
                  }}
                >
                  <div className={styles.fileRowMain}>
                    <span className={styles.fileIcon}>{isFolder ? '\uD83D\uDCC1' : '\uD83D\uDCC4'}</span>
                    <span className={styles.fileName}>{file.name}</span>
                  </div>
                  <span className={styles.fileMeta}>
                    {isFolder
                      ? ''
                      : [formatFileSize(file.sizeBytes), formatDateTime(file.modifiedAt)].filter(Boolean).join(' · ')
                    }
                  </span>
                </div>
              )
            })}
            {filesLoaded && files.length === 0 && <div className={styles.empty}>No files found.</div>}
            {!filesLoaded && <div className={styles.empty}>Loading files...</div>}
          </div>
        </section>
      )}

      {flags.ff_company_chat_v1 && (
        <div className={styles.chatDockWrap}>
          <div className={styles.chatDock}>
            {chatAsking && chatStreaming && (
              <div className={styles.chatDockPreview}>
                <span className={styles.chatRole}>AI</span>
                <span className={styles.chatDockTyping}>{chatStreaming}</span>
              </div>
            )}
            {!chatAsking && latestAssistantReply && (
              <div className={styles.chatDockPreview}>
                <span className={styles.chatRole}>AI</span>
                <span>{latestAssistantReply}</span>
              </div>
            )}
            <div className={styles.chatDockRow}>
              <input
                className={styles.chatDockInput}
                data-chat-shortcut="true"
                value={chatInput}
                onChange={(event) => setChatInput(event.target.value)}
                onKeyDown={handleChatDockKeyDown}
                placeholder="Ask anything..."
              />
              <button
                className={styles.chatDockSend}
                onClick={() => void handleSendChat()}
                disabled={!chatInput.trim() || chatAsking}
              >
                {chatAsking ? 'Asking...' : 'Ask (Cmd+K)'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
