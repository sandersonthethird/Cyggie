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
  CompanyMeetingSummaryRef,
  CompanyNote,
  CompanyTimelineItem,
  InvestmentMemoVersion,
  InvestmentMemoWithLatest
} from '../../shared/types/company'
import type { CompanyPipelineStage, CompanyPriority, CompanyRound } from '../../shared/types/company'
import type { ContactSummary } from '../../shared/types/contact'
import type { UnifiedSearchAnswerResponse } from '../../shared/types/unified-search'
import styles from './CompanyDetail.module.css'

type CompanyTab = 'timeline' | 'notes' | 'memo' | 'contacts' | 'files'
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
  { value: 'vc_fund', label: 'investor' },
  { value: 'customer', label: 'customer' },
  { value: 'partner', label: 'partner' },
  { value: 'vendor', label: 'vendor' },
  { value: 'other', label: 'other' },
  { value: 'unknown', label: 'unknown' }
]

const PIPELINE_STAGE_OPTIONS: Array<{ value: CompanyPipelineStage | ''; label: string }> = [
  { value: '', label: 'None' },
  { value: 'screening', label: 'Screening' },
  { value: 'diligence', label: 'Diligence' },
  { value: 'decision', label: 'Decision' },
  { value: 'documentation', label: 'Documentation' },
  { value: 'pass', label: 'Pass' }
]

const PRIORITY_OPTIONS: Array<{ value: CompanyPriority | ''; label: string }> = [
  { value: '', label: 'None' },
  { value: 'high', label: 'High' },
  { value: 'further_work', label: 'Further Work' },
  { value: 'monitor', label: 'Monitor' }
]

const ROUND_OPTIONS: Array<{ value: CompanyRound | ''; label: string }> = [
  { value: '', label: 'No Round' },
  { value: 'pre_seed', label: 'Pre-Seed' },
  { value: 'seed', label: 'Seed' },
  { value: 'seed_extension', label: 'Seed Extension' },
  { value: 'series_a', label: 'Series A' },
  { value: 'series_b', label: 'Series B' }
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
  const cleaned = raw
    .replace(/^Error invoking remote method '.*?':\s*/, '')
    .replace(/^Error:\s*/, '')
  if (cleaned.toLowerCase().includes('unique constraint failed') && cleaned.includes('normalized_name')) {
    return 'A company with this name already exists. Please use a different name.'
  }
  return cleaned
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
  const [activeTab, setActiveTab] = useState<CompanyTab>('timeline')
  const [timelineFilter, setTimelineFilter] = useState<TimelineFilter>('all')
  const [editingEntityType, setEditingEntityType] = useState(false)
  const [updatingEntityType, setUpdatingEntityType] = useState(false)
  const [editingStage, setEditingStage] = useState(false)
  const [updatingStage, setUpdatingStage] = useState(false)
  const [editingPriority, setEditingPriority] = useState(false)
  const [updatingPriority, setUpdatingPriority] = useState(false)
  const [editingRound, setEditingRound] = useState(false)
  const [updatingRound, setUpdatingRound] = useState(false)

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
  const [addingNote, setAddingNote] = useState(false)
  const [meetingSummaries, setMeetingSummaries] = useState<CompanyMeetingSummaryRef[]>([])
  const [expandedSummaryId, setExpandedSummaryId] = useState<string | null>(null)

  const [memo, setMemo] = useState<InvestmentMemoWithLatest | null>(null)
  const [memoVersions, setMemoVersions] = useState<InvestmentMemoVersion[]>([])
  const [memoDraft, setMemoDraft] = useState('')
  const [memoChangeNote, setMemoChangeNote] = useState('')
  const [savingMemo, setSavingMemo] = useState(false)
  const [exportingMemo, setExportingMemo] = useState(false)
  const [memoMode, setMemoMode] = useState<'view' | 'edit'>('view')
  const [generatingMemo, setGeneratingMemo] = useState(false)
  const [memoGenerateProgress, setMemoGenerateProgress] = useState('')
  const [showMemoFileSelect, setShowMemoFileSelect] = useState(false)
  const [memoSelectableFiles, setMemoSelectableFiles] = useState<CompanyDriveFileRef[]>([])
  const [memoSelectedFileIds, setMemoSelectedFileIds] = useState<Set<string>>(new Set())
  const [memoIncludeEmails, setMemoIncludeEmails] = useState(true)
  const [loadingMemoFiles, setLoadingMemoFiles] = useState(false)
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

  const [contactSearchQuery, setContactSearchQuery] = useState('')
  const [contactSearchResults, setContactSearchResults] = useState<ContactSummary[]>([])
  const [contactEmail, setContactEmail] = useState('')
  const [showContactDropdown, setShowContactDropdown] = useState(false)
  const [contactDropdownIndex, setContactDropdownIndex] = useState(-1)
  const contactSearchRef = useRef<HTMLDivElement>(null)
  const contactSearchDebounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  const [conversations, setConversations] = useState<CompanyConversation[]>([])
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<CompanyConversationMessage[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatAsking, setChatAsking] = useState(false)
  const [chatStreaming, setChatStreaming] = useState('')

  useEffect(() => {
    latestCompanyIdRef.current = companyId
  }, [companyId])

  const visibleTabs = useMemo(() => {
    const tabs: CompanyTab[] = ['timeline', 'contacts']
    if (flags.ff_company_notes_v1) tabs.push('notes')
    if (flags.ff_investment_memo_v1) tabs.push('memo')
    if (company) tabs.push('files')
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
        memoResult,
        meetingSummaryResult
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
          : Promise.resolve(null),
        flags.ff_company_notes_v1
          ? window.api.invoke<CompanyMeetingSummaryRef[]>(IPC_CHANNELS.COMPANY_MEETING_SUMMARIES, companyId)
          : Promise.resolve([])
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
      const meetingSummaryData = resolveOrFallback(meetingSummaryResult, [] as CompanyMeetingSummaryRef[], IPC_CHANNELS.COMPANY_MEETING_SUMMARIES)

      setTimeline(timelineData)
      setMeetings(meetingData)
      setEmails(emailData)
      setContacts(contactData)
      setNotes(noteData)
      setMemo(memoData)
      setMeetingSummaries(meetingSummaryData)

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
      setActiveTab('timeline')
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
    setEditingRound(false)
    setUpdatingRound(false)
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

  const primaryContact = useMemo(() => {
    if (contacts.length === 0) return null
    return (
      contacts.find((c) => c.isPrimary) ||
      contacts.find((c) => c.contactType === 'founder') ||
      contacts[0]
    )
  }, [contacts])

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

  const handleSetPrimaryContact = useCallback(async (contactId: string) => {
    if (!companyId) return
    try {
      await window.api.invoke(IPC_CHANNELS.COMPANY_SET_PRIMARY_CONTACT, companyId, contactId)
      const updated = await window.api.invoke<CompanyContactRef[]>(IPC_CHANNELS.COMPANY_CONTACTS, companyId)
      setContacts(updated)
    } catch (err) {
      setError(displayError(err))
    }
  }, [companyId])

  // Contact search: debounced query
  useEffect(() => {
    if (contactSearchDebounceRef.current) clearTimeout(contactSearchDebounceRef.current)
    const q = contactSearchQuery.trim()
    if (q.length < 2) {
      setContactSearchResults([])
      setShowContactDropdown(false)
      return
    }
    contactSearchDebounceRef.current = setTimeout(async () => {
      try {
        const results = await window.api.invoke<ContactSummary[]>(
          IPC_CHANNELS.CONTACT_LIST,
          { query: q, limit: 8 }
        )
        setContactSearchResults(results)
        setShowContactDropdown(results.length > 0)
        setContactDropdownIndex(-1)
      } catch {
        setContactSearchResults([])
        setShowContactDropdown(false)
      }
    }, 150)
    return () => {
      if (contactSearchDebounceRef.current) clearTimeout(contactSearchDebounceRef.current)
    }
  }, [contactSearchQuery])

  // Contact search: click-outside to close dropdown
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (contactSearchRef.current && !contactSearchRef.current.contains(e.target as Node)) {
        setShowContactDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleSelectExistingContact = useCallback(async (contact: ContactSummary) => {
    if (!companyId) return
    try {
      await window.api.invoke(IPC_CHANNELS.COMPANY_SET_PRIMARY_CONTACT, companyId, contact.id)
      const updated = await window.api.invoke<CompanyContactRef[]>(IPC_CHANNELS.COMPANY_CONTACTS, companyId)
      setContacts(updated)
      setContactSearchQuery(contact.fullName)
      setContactEmail('')
      setContactSearchResults([])
      setShowContactDropdown(false)
    } catch (err) {
      setError(displayError(err))
    }
  }, [companyId])

  const handleCreateAndLinkContact = useCallback(async () => {
    if (!companyId || !contactSearchQuery.trim() || !contactEmail.trim()) return
    try {
      const created = await window.api.invoke<ContactSummary>(
        IPC_CHANNELS.CONTACT_CREATE,
        { fullName: contactSearchQuery.trim(), email: contactEmail.trim() }
      )
      await window.api.invoke(IPC_CHANNELS.COMPANY_SET_PRIMARY_CONTACT, companyId, created.id)
      const updated = await window.api.invoke<CompanyContactRef[]>(IPC_CHANNELS.COMPANY_CONTACTS, companyId)
      setContacts(updated)
      setContactSearchQuery(created.fullName)
      setContactEmail('')
      setContactSearchResults([])
      setShowContactDropdown(false)
    } catch (err) {
      setError(displayError(err))
    }
  }, [companyId, contactSearchQuery, contactEmail])

  const handleContactSearchKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (!showContactDropdown || contactSearchResults.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setContactDropdownIndex((prev) => Math.min(prev + 1, contactSearchResults.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setContactDropdownIndex((prev) => Math.max(prev - 1, -1))
    } else if (e.key === 'Enter' && contactDropdownIndex >= 0) {
      e.preventDefault()
      void handleSelectExistingContact(contactSearchResults[contactDropdownIndex])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setShowContactDropdown(false)
    }
  }, [showContactDropdown, contactSearchResults, contactDropdownIndex, handleSelectExistingContact])

  const handleCreateNote = useCallback(async () => {
    if (!companyId || !noteContent.trim()) return
    try {
      await window.api.invoke(IPC_CHANNELS.COMPANY_NOTES_CREATE, {
        companyId,
        content: noteContent.trim()
      })
      setNoteContent('')
      setAddingNote(false)
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

  const handleGenerateMemo = useCallback(async (selectedFileIds: string[], includeEmails: boolean) => {
    if (!companyId) return
    setGeneratingMemo(true)
    setMemoGenerateProgress('')
    try {
      await window.api.invoke(IPC_CHANNELS.INVESTMENT_MEMO_GENERATE, { companyId, selectedFileIds, includeEmails })
      // Refresh memo data after generation
      const refreshedMemo = await window.api.invoke<InvestmentMemoWithLatest>(
        IPC_CHANNELS.INVESTMENT_MEMO_GET_OR_CREATE,
        companyId
      )
      setMemo(refreshedMemo)
      setMemoDraft(refreshedMemo.latestVersion?.contentMarkdown || '')
      const refreshedVersions = await window.api.invoke<InvestmentMemoVersion[]>(
        IPC_CHANNELS.INVESTMENT_MEMO_LIST_VERSIONS,
        refreshedMemo.id
      )
      setMemoVersions(refreshedVersions)
      setMemoMode('view')
    } catch (err) {
      setError(displayError(err))
    } finally {
      setGeneratingMemo(false)
      setMemoGenerateProgress('')
    }
  }, [companyId])

  const handleOpenMemoFileSelect = useCallback(async () => {
    if (!companyId) return
    setLoadingMemoFiles(true)
    try {
      const readableFiles = await window.api.invoke<CompanyDriveFileRef[]>(
        IPC_CHANNELS.COMPANY_FILES_READABLE,
        companyId
      )
      if (readableFiles.length === 0) {
        // No files — go straight to generation with emails only
        void handleGenerateMemo([], true)
        return
      }
      setMemoSelectableFiles(readableFiles)
      setMemoSelectedFileIds(new Set(readableFiles.map((f) => f.id)))
      setMemoIncludeEmails(true)
      setShowMemoFileSelect(true)
    } catch {
      // On error, proceed without files
      void handleGenerateMemo([], true)
    } finally {
      setLoadingMemoFiles(false)
    }
  }, [companyId, handleGenerateMemo])

  // Listen for memo generation progress
  useEffect(() => {
    const cleanup = window.api.on(IPC_CHANNELS.INVESTMENT_MEMO_GENERATE_PROGRESS, (text: unknown) => {
      if (text === null) {
        setMemoGenerateProgress('')
      } else if (typeof text === 'string') {
        setMemoGenerateProgress((prev) => prev + text)
      }
    })
    return cleanup
  }, [])

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

  const handleStageChange = useCallback(async (nextStage: CompanyPipelineStage | '') => {
    if (!company || updatingStage) return
    if (nextStage === (company.pipelineStage || '')) {
      setEditingStage(false)
      return
    }

    setUpdatingStage(true)
    setError(null)
    try {
      const updated = await window.api.invoke<CompanyDetailType | null>(
        IPC_CHANNELS.COMPANY_UPDATE,
        company.id,
        { pipelineStage: nextStage || null }
      )
      if (!updated) {
        throw new Error('Failed to update pipeline stage.')
      }
      setCompany(updated)
      setEditingStage(false)
    } catch (err) {
      setError(displayError(err))
    } finally {
      setUpdatingStage(false)
    }
  }, [company, updatingStage])

  const handlePriorityChange = useCallback(async (nextPriority: CompanyPriority | '') => {
    if (!company || updatingPriority) return
    if (nextPriority === (company.priority || '')) {
      setEditingPriority(false)
      return
    }

    setUpdatingPriority(true)
    setError(null)
    try {
      const updated = await window.api.invoke<CompanyDetailType | null>(
        IPC_CHANNELS.COMPANY_UPDATE,
        company.id,
        { priority: nextPriority || null }
      )
      if (!updated) {
        throw new Error('Failed to update priority.')
      }
      setCompany(updated)
      setEditingPriority(false)
    } catch (err) {
      setError(displayError(err))
    } finally {
      setUpdatingPriority(false)
    }
  }, [company, updatingPriority])

  const handleRoundChange = useCallback(async (nextRound: CompanyRound | '') => {
    if (!company || updatingRound) return
    if (nextRound === (company.round || '')) {
      setEditingRound(false)
      return
    }

    setUpdatingRound(true)
    setError(null)
    try {
      const updated = await window.api.invoke<CompanyDetailType | null>(
        IPC_CHANNELS.COMPANY_UPDATE,
        company.id,
        { round: nextRound || null }
      )
      if (!updated) {
        throw new Error('Failed to update round.')
      }
      setCompany(updated)
      setEditingRound(false)
    } catch (err) {
      setError(displayError(err))
    } finally {
      setUpdatingRound(false)
    }
  }, [company, updatingRound])

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
    setContactSearchQuery(primaryContact?.fullName || '')
    setContactEmail('')
    setContactSearchResults([])
    setShowContactDropdown(false)
    setEditingHeader(true)
    setTimeout(() => {
      nameInputRef.current?.focus()
      nameInputRef.current?.select()
    }, 0)
  }, [company, savingHeader])

  const cancelHeaderEdit = useCallback(() => {
    setEditingHeader(false)
  }, [])

  const handleDeleteCompany = useCallback(async () => {
    if (!company) return
    const confirmed = window.confirm(`Delete "${company.canonicalName}" and all associated data? This cannot be undone.`)
    if (!confirmed) return
    try {
      await window.api.invoke(IPC_CHANNELS.COMPANY_DELETE, company.id)
      navigate('/companies')
    } catch (err) {
      setError(displayError(err))
    }
  }, [company, navigate])

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
      <button className={styles.backButton} onClick={() => {
        if (editingHeader) {
          cancelHeaderEdit()
        } else {
          navigate(-1)
        }
      }}>
        {'< Back'}
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
            <div className={styles.editRow}>
              <label className={styles.editLabel}>Contact</label>
              <div className={styles.contactSearchWrapper} ref={contactSearchRef}>
                <input
                  className={styles.editInput}
                  value={contactSearchQuery}
                  onChange={(e) => setContactSearchQuery(e.target.value)}
                  onKeyDown={handleContactSearchKeyDown}
                  onFocus={() => {
                    if (contactSearchResults.length > 0) setShowContactDropdown(true)
                  }}
                  disabled={savingHeader}
                  placeholder="Search contacts"
                  aria-label="Contact name"
                />
                {showContactDropdown && contactSearchResults.length > 0 && (
                  <div className={styles.contactDropdown}>
                    {contactSearchResults.map((c, i) => (
                      <div
                        key={c.id}
                        className={`${styles.contactDropdownItem} ${i === contactDropdownIndex ? styles.contactDropdownActive : ''}`}
                        onMouseDown={() => void handleSelectExistingContact(c)}
                        onMouseEnter={() => setContactDropdownIndex(i)}
                      >
                        <span className={styles.contactDropdownName}>{c.fullName}</span>
                        {c.email && <span className={styles.contactDropdownEmail}>{c.email}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            {error && <div className={styles.error}>{error}</div>}
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
              <button
                type="button"
                className={styles.editDeleteButton}
                onClick={() => void handleDeleteCompany()}
                disabled={savingHeader}
              >
                Delete Company
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
              {editingStage ? (
                <select
                  className={styles.typeSelect}
                  value={company.pipelineStage || ''}
                  onChange={(event) => void handleStageChange(event.target.value as CompanyPipelineStage | '')}
                  onBlur={() => setEditingStage(false)}
                  disabled={updatingStage}
                  autoFocus
                  aria-label="Pipeline stage"
                >
                  {PIPELINE_STAGE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <button
                  type="button"
                  className={styles.stageBadgeButton}
                  onClick={() => setEditingStage(true)}
                  disabled={updatingStage}
                  title="Click to change pipeline stage"
                >
                  {company.pipelineStage
                    ? PIPELINE_STAGE_OPTIONS.find((o) => o.value === company.pipelineStage)?.label || company.pipelineStage
                    : 'No Stage'}
                </button>
              )}
              {editingPriority ? (
                <select
                  className={styles.typeSelect}
                  value={company.priority || ''}
                  onChange={(event) => void handlePriorityChange(event.target.value as CompanyPriority | '')}
                  onBlur={() => setEditingPriority(false)}
                  disabled={updatingPriority}
                  autoFocus
                  aria-label="Priority"
                >
                  {PRIORITY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <button
                  type="button"
                  className={styles.priorityBadgeButton}
                  onClick={() => setEditingPriority(true)}
                  disabled={updatingPriority}
                  title="Click to change priority"
                >
                  {company.priority
                    ? PRIORITY_OPTIONS.find((o) => o.value === company.priority)?.label || company.priority
                    : 'No Priority'}
                </button>
              )}
              {editingRound ? (
                <select
                  className={styles.typeSelect}
                  value={company.round || ''}
                  onChange={(event) => void handleRoundChange(event.target.value as CompanyRound | '')}
                  onBlur={() => setEditingRound(false)}
                  disabled={updatingRound}
                  autoFocus
                  aria-label="Round"
                >
                  {ROUND_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <button
                  type="button"
                  className={styles.roundBadgeButton}
                  onClick={() => setEditingRound(true)}
                  disabled={updatingRound}
                  title="Click to change round"
                >
                  {company.round
                    ? ROUND_OPTIONS.find((o) => o.value === company.round)?.label || company.round
                    : 'No Round'}
                </button>
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
              <div className={styles.metaLeft}>
                {company.primaryDomain ? (
                  <a
                    href={`https://${company.primaryDomain}`}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {company.primaryDomain}
                  </a>
                ) : (
                  <span>No domain</span>
                )}
                {(company.city || company.state) && (
                  <span>{[company.city, company.state].filter(Boolean).join(', ')}</span>
                )}
                {(company.postMoneyValuation != null || company.raiseSize != null) && (
                  <span>
                    {company.postMoneyValuation != null && `Val: $${company.postMoneyValuation}M`}
                    {company.postMoneyValuation != null && company.raiseSize != null && ' · '}
                    {company.raiseSize != null && `Raise: $${company.raiseSize}M`}
                  </span>
                )}
              </div>
              <div className={styles.metaRight}>
                <span>{touchDays == null ? 'No touchpoint' : `Last touch ${touchDays}d ago`}</span>
                <span>{company.status}</span>
              </div>
            </div>
            <p className={styles.description}>
              {(company.description || '').trim() || 'No business description added yet.'}
            </p>
            <div className={styles.founderRow}>
              <span className={styles.founderLabel}>Primary Contact</span>
              {primaryContact ? (
                <>
                  <button
                    type="button"
                    className={styles.founderLink}
                    onClick={() => navigate(`/contact/${primaryContact.id}`)}
                  >
                    {primaryContact.fullName}
                  </button>
                  {primaryContact.linkedinUrl && (
                    <button
                      type="button"
                      className={styles.linkedinLink}
                      onClick={() => void handleOpenExternal(primaryContact.linkedinUrl!)}
                    >
                      LinkedIn
                    </button>
                  )}
                </>
              ) : (
                <button
                  type="button"
                  className={styles.editPrimaryBtn}
                  onClick={startHeaderEdit}
                >
                  + Add Contact
                </button>
              )}
            </div>
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
            </div>
            {(company.industries.length > 0 || company.themes.length > 0) && (
              <div className={styles.tagGroup}>
                {company.industries.map((industry) => (
                  <span key={industry} className={styles.tag}>{industry}</span>
                ))}
                {company.themes.map((theme) => (
                  <span key={theme} className={styles.tag}>{theme}</span>
                ))}
              </div>
            )}
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
                  onClick={() => navigate(`/meeting/${meeting.id}`, { state: { fromCompanyId: companyId } })}
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
                      navigate(`/meeting/${item.referenceId}`, { state: { fromCompanyId: companyId } })
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
          <div className={styles.notesHeader}>
            <h3 className={styles.sectionTitle}>Notes</h3>
            <button
              type="button"
              className={styles.addNoteButton}
              onClick={() => setAddingNote(!addingNote)}
            >
              {addingNote ? 'Cancel' : '+ Note'}
            </button>
          </div>
          {addingNote && (
            <div className={styles.noteEditor}>
              <textarea
                className={styles.textarea}
                value={noteContent}
                onChange={(event) => setNoteContent(event.target.value)}
                placeholder="Write a company note..."
                autoFocus
              />
              <button className={styles.primaryButton} onClick={() => void handleCreateNote()} disabled={!noteContent.trim()}>
                Save
              </button>
            </div>
          )}
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
            {notes.length === 0 && meetingSummaries.length === 0 && <div className={styles.empty}>No notes yet.</div>}
          </div>
          {meetingSummaries.length > 0 && (
            <>
              <div className={styles.notesHeader}>
                <h3 className={styles.sectionTitle}>Meeting Notes</h3>
              </div>
              <div className={styles.list}>
                {meetingSummaries.map((ms) => (
                  <div key={ms.meetingId} className={styles.noteCard}>
                    <button
                      type="button"
                      className={styles.meetingSummaryToggle}
                      onClick={() => setExpandedSummaryId((prev) => (prev === ms.meetingId ? null : ms.meetingId))}
                    >
                      <span className={styles.meetingSummaryTitle}>{ms.title}</span>
                      <span className={styles.rowMeta}>{formatDateTime(ms.date)}</span>
                      <span className={styles.expandArrow}>{expandedSummaryId === ms.meetingId ? '\u25B4' : '\u25BE'}</span>
                    </button>
                    {expandedSummaryId === ms.meetingId && (
                      <div className={styles.meetingSummaryBody}>
                        <div className={styles.noteContent}>
                          <ReactMarkdown>{ms.summary}</ReactMarkdown>
                        </div>
                        <button
                          type="button"
                          className={styles.linkButton}
                          onClick={() => navigate(`/meeting/${ms.meetingId}`, { state: { fromCompanyId: companyId } })}
                        >
                          Open meeting
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {activeTab === 'memo' && flags.ff_investment_memo_v1 && (
        <section className={styles.section}>
          <div className={styles.memoTab}>
            <div className={styles.memoActions}>
              <div className={styles.memoViewToggle}>
                <button
                  className={memoMode === 'view' ? styles.activeToggle : undefined}
                  onClick={() => setMemoMode('view')}
                >
                  View
                </button>
                <button
                  className={memoMode === 'edit' ? styles.activeToggle : undefined}
                  onClick={() => setMemoMode('edit')}
                >
                  Edit
                </button>
              </div>
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
              <button
                className={styles.primaryButton}
                onClick={() => void handleOpenMemoFileSelect()}
                disabled={generatingMemo || loadingMemoFiles || !companyId}
              >
                {generatingMemo ? 'Generating...' : loadingMemoFiles ? 'Loading...' : 'Generate Memo'}
              </button>
              <button className={styles.secondaryButton} onClick={() => void handleExportMemo()} disabled={exportingMemo || !memo}>
                {exportingMemo ? 'Exporting...' : 'Export PDF'}
              </button>
            </div>

            {generatingMemo && memoGenerateProgress && (
              <div className={styles.memoRendered}>
                <ReactMarkdown>{memoGenerateProgress}</ReactMarkdown>
              </div>
            )}

            {!generatingMemo && (
              <div className={styles.memoBody}>
                {memoMode === 'view' ? (
                  <div className={styles.memoRendered}>
                    {memoDraft.trim() ? (
                      <ReactMarkdown>{memoDraft}</ReactMarkdown>
                    ) : (
                      <span className={styles.empty}>No memo content yet. Click "Generate Memo" to create one from meeting data, or switch to Edit mode.</span>
                    )}
                  </div>
                ) : (
                  <>
                    <textarea
                      className={styles.memoEditor}
                      value={memoDraft}
                      onChange={(event) => setMemoDraft(event.target.value)}
                      placeholder="Write your investment memo in markdown..."
                    />
                    <div className={styles.memoSaveRow}>
                      <input
                        className={styles.input}
                        value={memoChangeNote}
                        onChange={(event) => setMemoChangeNote(event.target.value)}
                        placeholder="Change note (optional)"
                      />
                      <button className={styles.primaryButton} onClick={() => void handleSaveMemo()} disabled={savingMemo || !memoDraft.trim()}>
                        {savingMemo ? 'Saving...' : 'Save'}
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            {memoVersions.length > 0 && (
              <details className={styles.versionsCollapsible}>
                <summary>Version History ({memoVersions.length})</summary>
                <div className={styles.list}>
                  {memoVersions.map((version) => (
                    <div
                      key={version.id}
                      className={styles.versionCard}
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        setMemoDraft(version.contentMarkdown)
                        setMemoMode('view')
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          setMemoDraft(version.contentMarkdown)
                          setMemoMode('view')
                        }
                      }}
                      style={{ cursor: 'pointer' }}
                    >
                      <strong>v{version.versionNumber}</strong>
                      <span>{version.changeNote || 'No change note'}</span>
                      <span className={styles.rowMeta}>{formatDateTime(version.createdAt)}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}
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
            {!filesLoaded && <div className={`${styles.empty} ${styles.pulse}`}>Loading files...</div>}
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

      {showMemoFileSelect && (
        <div className={styles.memoFileSelectOverlay} onClick={() => setShowMemoFileSelect(false)}>
          <div className={styles.memoFileSelectDialog} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.memoFileSelectTitle}>Select sources for memo generation</h3>

            <div className={styles.memoFileSelectSection}>
              <label className={styles.memoFileSelectCheckRow}>
                <input
                  type="checkbox"
                  checked={memoIncludeEmails}
                  onChange={(e) => setMemoIncludeEmails(e.target.checked)}
                />
                <span>Include linked emails</span>
              </label>
            </div>

            {memoSelectableFiles.length > 0 && (
              <div className={styles.memoFileSelectSection}>
                <div className={styles.memoFileSelectHeader}>
                  <span className={styles.memoFileSelectSectionLabel}>Company files</span>
                  <button
                    className={styles.memoFileSelectToggle}
                    onClick={() => {
                      if (memoSelectedFileIds.size === memoSelectableFiles.length) {
                        setMemoSelectedFileIds(new Set())
                      } else {
                        setMemoSelectedFileIds(new Set(memoSelectableFiles.map((f) => f.id)))
                      }
                    }}
                  >
                    {memoSelectedFileIds.size === memoSelectableFiles.length ? 'Deselect all' : 'Select all'}
                  </button>
                </div>
                <div className={styles.memoFileList}>
                  {memoSelectableFiles.map((file) => (
                    <label key={file.id} className={styles.memoFileSelectCheckRow}>
                      <input
                        type="checkbox"
                        checked={memoSelectedFileIds.has(file.id)}
                        onChange={(e) => {
                          setMemoSelectedFileIds((prev) => {
                            const next = new Set(prev)
                            if (e.target.checked) next.add(file.id)
                            else next.delete(file.id)
                            return next
                          })
                        }}
                      />
                      <span className={styles.memoFileName}>{file.name}</span>
                      {file.sizeBytes != null && (
                        <span className={styles.memoFileSize}>
                          {file.sizeBytes < 1024 * 1024
                            ? `${Math.round(file.sizeBytes / 1024)}KB`
                            : `${(file.sizeBytes / (1024 * 1024)).toFixed(1)}MB`}
                        </span>
                      )}
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className={styles.memoFileSelectActions}>
              <button className={styles.secondaryButton} onClick={() => setShowMemoFileSelect(false)}>
                Cancel
              </button>
              <button
                className={styles.primaryButton}
                onClick={() => {
                  setShowMemoFileSelect(false)
                  void handleGenerateMemo([...memoSelectedFileIds], memoIncludeEmails)
                }}
              >
                Generate
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
