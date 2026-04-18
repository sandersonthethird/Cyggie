import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { EditorContent } from '@tiptap/react'
import { useTiptapMarkdown } from '../hooks/useTiptapMarkdown'
import { TiptapBubbleMenu } from '../components/common/TiptapBubbleMenu'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import remarkGfm from 'remark-gfm'
import { TABLE_EXTENSIONS } from '../lib/tiptap-extensions'
import { Clock } from 'lucide-react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { useRecordingStore } from '../stores/recording.store'
import { useSharedAudioCapture, useSharedVideoCapture } from '../contexts/AudioCaptureContext'
import { useFindInPage, injectFindMarks } from '../hooks/useFindInPage'
import FindBar from '../components/common/FindBar'
import ConfirmDialog from '../components/common/ConfirmDialog'
import { useNotice } from '../components/common/NoticeModal'
import { useChatStore } from '../stores/chat.store'
import type { ContextOption } from '../../shared/types/chat'
import type { Meeting, CompanySuggestion } from '../../shared/types/meeting'
import type { CompanyEntityType, CompanySummary } from '../../shared/types/company'
import type { ContactSummary } from '../../shared/types/contact'
import { usePicker } from '../hooks/usePicker'
import { EntityPicker } from '../components/common/EntityPicker'
import type { MeetingTemplate } from '../../shared/types/template'
import type { DriveShareResponse } from '../../shared/types/drive'
import type { WebShareResponse } from '../../shared/types/web-share'
import type {
  CompanySummaryUpdateChange,
  CompanySummaryUpdateProposal,
  CompanySummaryUpdatePayload,
  ContactSummaryUpdateProposal,
  ContactSummaryUpdatePayload,
  SummaryGenerateResult
} from '../../shared/types/summary'
import { contactEnrichedAtKey, companyEnrichedAtKey } from '../../shared/utils/enrichment-keys'
import { EnrichmentProposalDialog } from '../components/enrichment/EnrichmentProposalDialog'
import type { EnrichmentEntityProposal } from '../components/enrichment/EnrichmentProposalDialog'
import type { SetCustomFieldValueInput } from '../../shared/types/custom-fields'
import type { Task, ProposedTask, TaskCreateData } from '../../shared/types/task'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import styles from './MeetingDetail.module.css'
import { api } from '../api'
import { useNotesAutoSave } from '../hooks/useNotesAutoSave'

/**
 * Normalises AI-generated summary markdown so ReactMarkdown renders it correctly.
 *
 * Problems fixed:
 *  1. Unicode bullets (•) before **bold** text break CommonMark's emphasis parser
 *     (closing ** is not right-flanking when followed by punctuation like ':').
 *     Fix: replace "• " with "- " so standard list syntax is used.
 *  2. Empty headings ("## \n") from AI render as a bare crimson bar with no text.
 *     Fix: strip lines that are only a heading marker with no content.
 *  3. Multiple consecutive blank lines create stacked empty <p> elements with margin.
 *     Fix: collapse runs of 2+ blank lines to a single blank line.
 */
function preprocessSummaryMarkdown(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      // Convert Unicode bullet → GFM list item
      if (/^[•·]\s/.test(line)) return '- ' + line.replace(/^[•·]\s+/, '')
      // Drop empty heading lines (e.g. "## " or "### " with nothing after)
      if (/^#{1,6}\s*$/.test(line)) return ''
      return line
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  const parts = []
  if (h > 0) parts.push(String(h).padStart(2, '0'))
  parts.push(String(m).padStart(2, '0'))
  parts.push(String(s).padStart(2, '0'))
  return parts.join(':')
}

function formatVideoTime(secs: number): string {
  if (!isFinite(secs)) return '0:00'
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = Math.floor(secs % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function getInitials(name: string): string {
  return name.split(' ').filter(Boolean).slice(0, 2).map(w => w[0] ?? '').join('').toUpperCase() || '?'
}

function relativeTime(date: Date | string): string {
  const diff = Math.round((Date.now() - new Date(date).getTime()) / 1000)
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)} hr ago`
  return `${Math.floor(diff / 86400)} d ago`
}

function meetingStatusLabel(status: string, s: typeof styles): { label: string; className: string } {
  if (status === 'summarized') return { label: 'SUMMARIZED', className: s.statusSummarized }
  if (status === 'transcribed') return { label: 'TRANSCRIBED', className: s.statusTranscribed }
  return { label: 'SCHEDULED', className: s.statusScheduled }
}

function waitForMediaReady(video: HTMLVideoElement, timeoutMs = 3000): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    let settled = false
    const finalize = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    const cleanup = () => {
      clearTimeout(timer)
      video.removeEventListener('canplay', finalize)
      video.removeEventListener('loadeddata', finalize)
      video.removeEventListener('error', finalize)
    }

    const timer = setTimeout(finalize, timeoutMs)
    video.addEventListener('canplay', finalize, { once: true })
    video.addEventListener('loadeddata', finalize, { once: true })
    video.addEventListener('error', finalize, { once: true })
  })
}

interface MeetingData {
  meeting: Meeting
  transcript: string | null
  summary: string | null
  linkedCompanies: { id: string; name: string }[]
}

const TAGGABLE_COMPANY_TYPES: CompanyEntityType[] = ['prospect', 'vc_fund', 'customer', 'portfolio', 'other']

const TAG_LABELS: Record<CompanyEntityType, string> = {
  prospect: 'Prospect',
  portfolio: 'Portfolio',
  pass: 'Pass',
  vc_fund: 'Investor',
  customer: 'Customer',
  partner: 'Partner',
  vendor: 'Vendor',
  other: 'Other',
  unknown: 'Unknown'
}

function companySuggestionKey(company: CompanySuggestion): string {
  return `${company.name.toLowerCase()}::${(company.domain || '').toLowerCase()}`
}

function toTitleCase(value: string): string {
  return value
    .split('_')
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ')
}

function fieldLabel(field: CompanySummaryUpdateChange['field']): string {
  if (field === 'description') return 'Description'
  if (field === 'round') return 'Round'
  if (field === 'raiseSize') return 'Raise Size'
  if (field === 'postMoneyValuation') return 'Post Money'
  if (field === 'city') return 'City'
  if (field === 'state') return 'State'
  return 'Pipeline Stage'
}

function formatFieldValue(field: CompanySummaryUpdateChange['field'], value: string | number | null): string {
  if (value == null || String(value).trim() === '') return 'empty'
  if (field === 'raiseSize' || field === 'postMoneyValuation') return `$${value}M`
  if (field === 'round' || field === 'pipelineStage') return toTitleCase(String(value))
  return String(value)
}

type UnifiedEnrichProposal =
  | { kind: 'company'; proposal: CompanySummaryUpdateProposal }
  | { kind: 'contact'; proposal: ContactSummaryUpdateProposal }

export default function MeetingDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const notice = useNotice()
  const backLabel = 'Back'
  const [data, setData] = useState<MeetingData | null>(null)
  const [activeTab, setActiveTab] = useState<'notes' | 'transcript' | 'recording'>('notes')
  const [templates, setTemplates] = useState<MeetingTemplate[]>([])
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('')
  const [isGenerating, setIsGenerating] = useState(false)
  const [streamedSummary, setStreamedSummary] = useState('')
  const [summaryPhase, setSummaryPhase] = useState('')
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [isSavingTitle, setIsSavingTitle] = useState(false)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const [editingSpeaker, setEditingSpeaker] = useState<number | null>(null)
  const [speakerDraft, setSpeakerDraft] = useState('')
  const [localSpeakerMap, setLocalSpeakerMap] = useState<Record<number, string>>({})
  const [speakerContactMap, setSpeakerContactMap] = useState<Record<number, string>>({})
  const [linkingPicker, setLinkingPicker] = useState<number | null>(null)
  const [showCompanyPicker, setShowCompanyPicker] = useState(false)
  const [isSavingSpeakers, setIsSavingSpeakers] = useState(false)
  const speakerInputRef = useRef<HTMLInputElement>(null)
  const speakerContactPicker = usePicker<ContactSummary>(IPC_CHANNELS.CONTACT_LIST)
  const companyLinkPicker = usePicker<CompanySummary>(IPC_CHANNELS.COMPANY_LIST, 20, { view: 'all' })
  const swapCompanyPicker = usePicker<CompanySummary>(IPC_CHANNELS.COMPANY_LIST, 20, { view: 'all' })
  const [editingCompanyKey, setEditingCompanyKey] = useState<string | null>(null)
  const [optimisticSwap, setOptimisticSwap] = useState<Record<string, string>>({})
  const {
    notesDraft,
    summaryDraft,
    setSummaryDraft,
    handleNotesChange,
    handleNotesChangeText,
    handleSummaryChangeText,
    saveNotes,
    flushNotes,
    reset: resetAutoSave,
    lastEditedAt,
  } = useNotesAutoSave(id)
  const [editingSummary, setEditingSummary] = useState(false)
  // Reset edit mode when switching meetings
  useEffect(() => { setEditingSummary(false) }, [id])

  // Tiptap notes editor — dep [id] ensures recreation on meeting switch
  const { editor: meetingNotesEditor, loadContent: loadNotesContent } = useTiptapMarkdown(
    {
      extensions: [
        StarterKit,
        Markdown,
        Link.configure({ openOnClick: true }),
        ...TABLE_EXTENSIONS,
        Placeholder.configure({ placeholder: 'Jot down your meeting notes...' }),
      ],
      editable: true,
      onUpdate: ({ editor: ed }) => {
        const mkd = ed.getMarkdown?.() ?? ed.getText()
        handleNotesChangeText(mkd)
      },
    },
    [id],
  )

  // Tiptap summary editor — dep [id] ensures recreation on meeting switch
  const { editor: summaryEditor, loadContent: loadSummaryContent } = useTiptapMarkdown(
    {
      extensions: [
        StarterKit,
        Markdown,
        Link.configure({ openOnClick: true }),
        ...TABLE_EXTENSIONS,
        Placeholder.configure({ placeholder: 'Summary content...' }),
      ],
      editable: editingSummary,
      onUpdate: ({ editor: ed }) => {
        handleSummaryChangeText(ed.getMarkdown?.() ?? ed.getText())
      },
      onBlur: () => setEditingSummary(false),
    },
    [id],
  )

  // Load content into Tiptap and focus when entering edit mode
  useEffect(() => {
    if (editingSummary) {
      loadSummaryContent(summaryDraft ?? '')
      setTimeout(() => summaryEditor?.commands.focus(), 0)
    }
  }, [editingSummary]) // eslint-disable-line react-hooks/exhaustive-deps

  const wordCount = useMemo(() => {
    const combined = `${notesDraft ?? ''} ${summaryDraft ?? ''}`.trim()
    if (!combined) return 0
    return combined.split(/\s+/).filter(Boolean).length
  }, [notesDraft, summaryDraft])
  const startRecording = useRecordingStore((s) => s.startRecording)
  const stopRecording = useRecordingStore((s) => s.stopRecording)
  const pauseRecording = useRecordingStore((s) => s.pauseRecording)
  const resumeRecording = useRecordingStore((s) => s.resumeRecording)
  const isRecording = useRecordingStore((s) => s.isRecording)
  const recordingMeetingId = useRecordingStore((s) => s.meetingId)
  const isPaused = useRecordingStore((s) => s.isPaused)
  const duration = useRecordingStore((s) => s.duration)
  const recordingError = useRecordingStore((s) => s.error)
  const setRecordingError = useRecordingStore((s) => s.setError)
  const liveTranscript = useRecordingStore((s) => s.liveTranscript)
  const interimSegment = useRecordingStore((s) => s.interimSegment)
  const channelMode = useRecordingStore((s) => s.channelMode)
  const autoStoppedMeetingIds = useRecordingStore((s) => s.autoStoppedMeetingIds)
  const audioCapture = useSharedAudioCapture()
  const videoCapture = useSharedVideoCapture()
  const prevRecordingRef = useRef(false)
  // Tracks the most-recently-requested meeting load; used to discard stale async
  // results when the user navigates away before a load completes.
  const loadIdRef = useRef<string | undefined>()
  const [videoPath, setVideoPath] = useState<string | null>(null)
  const [videoBlobUrl, setVideoBlobUrl] = useState<string | null>(null)
  const [isVideoLoading, setIsVideoLoading] = useState(false)
  const [videoBlobFailed, setVideoBlobFailed] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [enrichDialogOpen, setEnrichDialogOpen] = useState(false)
  const [enrichProposals, setEnrichProposals] = useState<UnifiedEnrichProposal[]>([])
  const videoRef = useRef<HTMLVideoElement>(null)
  const playRequestRef = useRef<Promise<void> | null>(null)
  const videoWrapperRef = useRef<HTMLDivElement>(null)
  const [playbackSpeed, setPlaybackSpeed] = useState(1)
  const [speedMenuOpen, setSpeedMenuOpen] = useState(false)
  const speedMenuRef = useRef<HTMLDivElement>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [videoDuration, setVideoDuration] = useState(0)
  const [volume, setVolume] = useState(1)
  const [isMuted, setIsMuted] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [controlsVisible, setControlsVisible] = useState(true)
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [volumeOpen, setVolumeOpen] = useState(false)
  const volumeRef = useRef<HTMLDivElement>(null)
  const transcriptEndRef = useRef<HTMLDivElement>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [shareMenuOpen, setShareMenuOpen] = useState(false)
  const shareRef = useRef<HTMLDivElement>(null)
  const [showNotes, setShowNotes] = useState(true)
  const [summaryExists, setSummaryExists] = useState(false)
  const [companySuggestions, setCompanySuggestions] = useState<CompanySuggestion[]>([])
  const [companyTagSelections, setCompanyTagSelections] = useState<Record<string, CompanyEntityType>>({})
  const [savingCompanyTagKey, setSavingCompanyTagKey] = useState<string | null>(null)
  const [attendeeContactMap, setAttendeeContactMap] = useState<Record<string, { id: string; fullName: string }>>({})
  const [meetingTasks, setMeetingTasks] = useState<Task[]>([])
  const [taskProposalDialogOpen, setTaskProposalDialogOpen] = useState(false)
  const [pendingProposedTasks, setPendingProposedTasks] = useState<ProposedTask[]>([])
  const [proposedTaskSelections, setProposedTaskSelections] = useState<Record<string, boolean>>({})
  const [editingTaskKey, setEditingTaskKey] = useState<string | null>(null)
  const [editingTaskDraft, setEditingTaskDraft] = useState('')
  const [fieldSelections, setFieldSelections] = useState<Record<string, boolean>>({})
  const [isApplyingContactUpdates, setIsApplyingContactUpdates] = useState(false)
  const [contactEnrichError, setContactEnrichError] = useState<string | null>(null)
  const [enrichSuccessMsg, setEnrichSuccessMsg] = useState<string | null>(null)

  // Close share menu on click outside
  useEffect(() => {
    if (!shareMenuOpen) return
    const handleClick = (e: MouseEvent) => {
      if (shareRef.current && !shareRef.current.contains(e.target as Node)) {
        setShareMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [shareMenuOpen])

  // Close speed menu on click outside
  useEffect(() => {
    if (!speedMenuOpen) return
    const handleClick = (e: MouseEvent) => {
      if (speedMenuRef.current && !speedMenuRef.current.contains(e.target as Node)) {
        setSpeedMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [speedMenuOpen])

  // Close volume popup on click outside
  useEffect(() => {
    if (!volumeOpen) return
    const handleClick = (e: MouseEvent) => {
      if (volumeRef.current && !volumeRef.current.contains(e.target as Node)) {
        setVolumeOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [volumeOpen])

  // Video control handlers
  const handlePlayPause = useCallback(() => {
    const video = videoRef.current
    if (!video) return

    const beginPlay = async () => {
      // If the element has latched an error, force a reload from the current source.
      if (video.error) {
        const src = video.currentSrc || videoBlobUrl || videoPath
        if (!src) return
        video.pause()
        video.removeAttribute('src')
        video.load()
        video.src = src
        await waitForMediaReady(video)
      } else if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        await waitForMediaReady(video)
      }

      await video.play()
    }

    if (video.paused) {
      // If playback is already at the end, restart from the beginning.
      if (isFinite(video.duration) && video.currentTime >= video.duration) {
        video.currentTime = 0
      }
      const playPromise = beginPlay()
      playRequestRef.current = playPromise
      playPromise.catch((err) => {
        console.error('[MeetingDetail] Video play failed:', {
          err,
          src: video.currentSrc,
          readyState: video.readyState,
          networkState: video.networkState,
          currentTime: video.currentTime,
          duration: video.duration,
          error: video.error
            ? { code: video.error.code, message: video.error.message }
            : null
        })
      }).finally(() => {
        playRequestRef.current = null
      })
    } else {
      video.pause()
    }
  }, [videoBlobUrl, videoPath])

  const syncVideoDuration = useCallback(() => {
    const video = videoRef.current
    if (!video) return

    let nextDuration = 0
    if (isFinite(video.duration) && video.duration > 0) {
      nextDuration = video.duration
    } else if (video.seekable && video.seekable.length > 0) {
      try {
        const seekableEnd = video.seekable.end(video.seekable.length - 1)
        if (isFinite(seekableEnd) && seekableEnd > 0) {
          nextDuration = seekableEnd
        }
      } catch {
        // Ignore transient seekable access failures.
      }
    }

    if (nextDuration > 0) {
      setVideoDuration(nextDuration)
    }
  }, [])

  const handleSeek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const video = videoRef.current
    if (!video) return

    const target = Number(e.target.value)
    if (!Number.isFinite(target)) return

    // Avoid seeking exactly to the media EOF, which can leave the player in a paused-ended state.
    const duration = video.duration
    let nextTime = Math.max(0, target)
    if (isFinite(duration) && duration > 0) {
      nextTime = Math.min(nextTime, Math.max(0, duration - 0.05))
    }

    video.currentTime = nextTime
    setCurrentTime(nextTime)
  }, [])

  const handleVolumeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const video = videoRef.current
    if (!video) return
    const v = Number(e.target.value)
    video.volume = v
    video.muted = v === 0
    setVolume(v)
    setIsMuted(v === 0)
  }, [])

  const handleMuteToggle = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    video.muted = !video.muted
    setIsMuted(video.muted)
  }, [])

  const handleFullscreenToggle = useCallback(() => {
    if (!videoWrapperRef.current) return
    if (document.fullscreenElement) {
      document.exitFullscreen()
    } else {
      videoWrapperRef.current.requestFullscreen()
    }
  }, [])

  // Sync fullscreen state
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [])

  // Auto-hide controls after 3s of inactivity
  const showControls = useCallback(() => {
    setControlsVisible(true)
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current)
    controlsTimerRef.current = setTimeout(() => {
      if (videoRef.current && !videoRef.current.paused) {
        setControlsVisible(false)
      }
    }, 3000)
  }, [])

  const handleVideoMouseMove = useCallback(() => {
    showControls()
  }, [showControls])

  const handleVideoMouseLeave = useCallback(() => {
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current)
    if (videoRef.current && !videoRef.current.paused) {
      controlsTimerRef.current = setTimeout(() => setControlsVisible(false), 1000)
    }
  }, [])

  // Resolve media:// to blob URL once so playback/seek doesn't depend on live range streaming.
  useEffect(() => {
    let cancelled = false
    let objectUrl: string | null = null

    setVideoBlobUrl(null)
    setIsVideoLoading(false)
    setVideoBlobFailed(false)

    if (!videoPath) return

    const controller = new AbortController()
    setIsVideoLoading(true)
    fetch(videoPath, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`Failed to load video (${res.status})`)
        }
        const blob = await res.blob()
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setVideoBlobUrl(objectUrl)
      })
      .catch((err) => {
        if (controller.signal.aborted) return
        console.error('[MeetingDetail] Failed to fetch video blob:', err)
        if (!cancelled) setVideoBlobFailed(true)
      })
      .finally(() => {
        if (!cancelled) setIsVideoLoading(false)
      })

    return () => {
      cancelled = true
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [videoPath])

  // Reset playback state when a new video source is loaded.
  useEffect(() => {
    setIsPlaying(false)
    setCurrentTime(0)
    setVideoDuration(0)
    playRequestRef.current = null
    const v = videoRef.current
    if (v) {
      v.pause()
      try {
        v.currentTime = 0
      } catch {
        // Ignore seek failures while source metadata is not ready.
      }
    }
  }, [videoPath, videoBlobUrl])

  const loadMeeting = useCallback(async () => {
    if (!id) return
    loadIdRef.current = id  // mark this as the active load

    const result = await api.invoke<MeetingData | null>(IPC_CHANNELS.MEETING_GET, id)

    // Bail if a newer load has started (user navigated away before this resolved)
    if (loadIdRef.current !== id) {
      console.log('[MeetingDetail] Discarding stale load result for:', id, '(current:', loadIdRef.current, ')')
      return
    }

    if (!result) {
      navigate('/meetings')
      return
    }
    setData(result)
    setLocalSpeakerMap(result.meeting.speakerMap)
    setSpeakerContactMap(result.meeting.speakerContactMap ?? {})
    resetAutoSave(result.meeting.notes, result.summary)
    loadNotesContent(result.meeting.notes ?? '')  // sets ref + triggers editor recreation → onCreate parses ✓
    setSummaryExists(!!result.summary)
    if (result.summary) setShowNotes(false)

    // Load tasks linked to this meeting
    api.invoke<Task[]>(IPC_CHANNELS.TASK_LIST_FOR_MEETING, id)
      .then((tasks) => { if (loadIdRef.current === id) setMeetingTasks(tasks) })
      .catch((err) => console.error('[MeetingDetail] Failed to load tasks:', err))

    // Ask main process for a playable recording path (includes legacy/fallback resolution).
    api.invoke<string | null>(IPC_CHANNELS.VIDEO_GET_PATH, id)
      .then((path) => { if (loadIdRef.current === id) setVideoPath(path) })
      .catch((err) => {
        console.error('[MeetingDetail] Failed to resolve recording path:', err)
        if (loadIdRef.current === id) setVideoPath(null)
      })

    // Fetch company suggestions (with logos)
    api.invoke<CompanySuggestion[]>(IPC_CHANNELS.COMPANY_GET_SUGGESTIONS, id)
      .then((suggestions) => {
        if (loadIdRef.current !== id) return
        const seen = new Set<string>()
        const deduped = suggestions.filter((s) => {
          const key = companySuggestionKey(s)
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        setCompanySuggestions(deduped)
        const persistedSelections = suggestions.reduce<Record<string, CompanyEntityType>>(
          (acc, suggestion) => {
            if (suggestion.entityType) {
              acc[companySuggestionKey(suggestion)] = suggestion.entityType
            }
            return acc
          },
          {}
        )
        setCompanyTagSelections(persistedSelections)
      })
      .catch(() => {})

    // Resolve attendee emails to contact IDs for clickable chips
    if (result.meeting.attendeeEmails && result.meeting.attendeeEmails.length > 0) {
      api.invoke<Record<string, { id: string; fullName: string }>>(
        IPC_CHANNELS.CONTACT_RESOLVE_EMAILS,
        result.meeting.attendeeEmails
      )
        .then((map) => { if (loadIdRef.current === id) setAttendeeContactMap(map) })
        .catch(() => {})
    }

    // Hydrate chat store from persisted messages (only if store is empty for this meeting)
    if (result.meeting.chatMessages && result.meeting.chatMessages.length > 0) {
      const existing = useChatStore.getState().conversations[id]
      if (!existing || existing.messages.length === 0) {
        for (const msg of result.meeting.chatMessages) {
          useChatStore.getState().addMessage(id, msg)
        }
      }
    }
  }, [id, navigate, loadNotesContent])

  // Immediately clear stale data when navigating to a different meeting,
  // so old content doesn't persist during the async load window.
  useEffect(() => {
    if (!id) return
    setData(null)
    setShowNotes(true)        // reset to default — loadMeeting sets false only if summary exists
    setMeetingTasks([])
    setVideoPath(null)
    setCompanySuggestions([])
    setCompanyTagSelections({})
    setAttendeeContactMap({})
    setSummaryExists(false)
  }, [id])

  useEffect(() => {
    loadMeeting()
  }, [loadMeeting])

  useEffect(() => {
    api.invoke<MeetingTemplate[]>(IPC_CHANNELS.TEMPLATE_LIST).then((result) => {
      setTemplates(result)
      if (result.length > 0) setSelectedTemplateId(result[0].id)
    })
  }, [])

  // Listen for streaming summary progress
  useEffect(() => {
    if (!isGenerating) return
    const unsub = api.on(IPC_CHANNELS.SUMMARY_PROGRESS, (chunk: unknown) => {
      if (chunk === null) {
        setStreamedSummary('')
        return
      }
      setStreamedSummary((prev) => prev + String(chunk))
    })
    return unsub
  }, [isGenerating])

  // Listen for summary phase changes
  useEffect(() => {
    if (!isGenerating) return
    const unsub = api.on(IPC_CHANNELS.SUMMARY_PHASE, (phase: unknown) => {
      setSummaryPhase(String(phase))
    })
    return unsub
  }, [isGenerating])

  const handleTagCompany = useCallback(async (company: CompanySuggestion, entityType: CompanyEntityType) => {
    if (!id) return
    const suggestionKey = companySuggestionKey(company)
    setSavingCompanyTagKey(suggestionKey)
    try {
      await api.invoke(
        IPC_CHANNELS.COMPANY_TAG_FROM_MEETING,
        id,
        {
          canonicalName: company.name,
          primaryDomain: company.domain || null,
          entityType
        }
      )
      setCompanyTagSelections((prev) => ({
        ...prev,
        [suggestionKey]: entityType
      }))
    } catch (err) {
      console.error('[MeetingDetail] Failed to tag company:', err)
    } finally {
      setSavingCompanyTagKey(null)
    }
  }, [id])

  const handleOpenCompanyDetail = useCallback(async (company: CompanySuggestion) => {
    if (!id) return
    try {
      const suggestionKey = companySuggestionKey(company)
      const currentEntityType = companyTagSelections[suggestionKey] ?? company.entityType ?? 'unknown'
      const resolved = await api.invoke<{ id: string }>(
        IPC_CHANNELS.COMPANY_TAG_FROM_MEETING,
        id,
        {
          canonicalName: company.name,
          primaryDomain: company.domain || null,
          entityType: currentEntityType
        }
      )
      navigate(`/company/${resolved.id}`, { state: { backLabel: data?.meeting.title ?? 'Meeting' } })
    } catch (err) {
      console.error('[MeetingDetail] Failed to open company detail:', err)
    }
  }, [id, navigate, data, companyTagSelections])


  const handleStartRecording = useCallback(async () => {
    if (!data || isRecording) return
    // Save any pending notes first
    await flushNotes()
    try {
      const result = await api.invoke<{ meetingId: string; meetingPlatform: string | null }>(
        IPC_CHANNELS.RECORDING_START,
        data.meeting.title,
        data.meeting.calendarEventId || undefined
      )
      startRecording(result.meetingId, result.meetingPlatform)
      // Navigate to the recording meeting if it's different from the current one
      if (result.meetingId !== id) {
        navigate(`/meeting/${result.meetingId}`, { state: location.state })
      }
    } catch (err) {
      console.error('Failed to start recording:', err)
    }
  }, [data, isRecording, flushNotes, startRecording, id, navigate, location.state])

  const handleContinueRecording = useCallback(async () => {
    if (!data || isRecording) return
    await flushNotes()
    try {
      const result = await api.invoke<{ meetingId: string; meetingPlatform: string | null }>(
        IPC_CHANNELS.RECORDING_START,
        undefined,
        undefined,
        data.meeting.id
      )
      startRecording(result.meetingId, result.meetingPlatform)
    } catch (err) {
      console.error('Failed to continue recording:', err)
    }
  }, [data, isRecording, flushNotes, startRecording])


  // Auto-scroll live transcript
  useEffect(() => {
    if (activeTab === 'transcript') {
      transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [liveTranscript, interimSegment, activeTab])

  // Reload meeting data when recording stops (e.g. new transcript available)
  useEffect(() => {
    if (prevRecordingRef.current && !isRecording) {
      loadMeeting()
    }
    prevRecordingRef.current = isRecording
  }, [isRecording, loadMeeting])

  const generateSummaryRef = useRef<() => void>(() => {})

  const handleStop = useCallback(async () => {
    try {
      if (videoCapture.isVideoRecording) {
        await videoCapture.stop()
      }
      audioCapture.stop()
      await api.invoke(IPC_CHANNELS.RECORDING_STOP)
      stopRecording()
      if (selectedTemplateId) {
        let auto: string | null = null
        try {
          auto = await api.invoke<string | null>(IPC_CHANNELS.SETTINGS_GET, 'autoEnhanceAfterMeeting')
        } catch (err) {
          console.warn('[MeetingDetail] auto-enhance setting read failed; defaulting OFF:', err)
        }
        if (auto === 'true') {
          generateSummaryRef.current()
        }
      }
    } catch (err) {
      setRecordingError(String(err))
    }
  }, [stopRecording, setRecordingError, audioCapture, videoCapture, selectedTemplateId])

  const handlePause = useCallback(async () => {
    try {
      audioCapture.pause()
      videoCapture.pause()
      await api.invoke(IPC_CHANNELS.RECORDING_PAUSE)
      pauseRecording()
    } catch (err) {
      setRecordingError(String(err))
    }
  }, [pauseRecording, setRecordingError, audioCapture, videoCapture])

  const handleResume = useCallback(async () => {
    try {
      audioCapture.resume()
      videoCapture.resume()
      await api.invoke(IPC_CHANNELS.RECORDING_RESUME)
      resumeRecording()
    } catch (err) {
      setRecordingError(String(err))
    }
  }, [resumeRecording, setRecordingError, audioCapture, videoCapture])

  const handleDelete = useCallback(() => {
    if (!id) return
    setDeleteDialogOpen(true)
  }, [id])

  const handleConfirmDelete = useCallback(async () => {
    if (!id) return
    setDeleteDialogOpen(false)
    await api.invoke(IPC_CHANNELS.MEETING_DELETE, id)
    navigate('/meetings')
  }, [id, navigate])

  const handleToggleVideo = useCallback(async () => {
    try {
      if (videoCapture.isVideoRecording) {
        await videoCapture.stop()
        // Reload meeting to pick up the new recordingPath
        loadMeeting()
      } else if (recordingMeetingId) {
        const displayStream = audioCapture.getDisplayStream()
        const mixedAudio = audioCapture.getMixedAudioStream()
        const platform = useRecordingStore.getState().meetingPlatform
        await videoCapture.start(recordingMeetingId, displayStream, mixedAudio, platform)
      }
    } catch (err) {
      console.error('[MeetingDetail] Video toggle failed:', err)
    }
  }, [videoCapture, audioCapture, recordingMeetingId, loadMeeting])

  const handleStopEnhance = useCallback(() => {
    api.invoke(IPC_CHANNELS.SUMMARY_ABORT)
  }, [])

  const handleApplyEnrich = useCallback(async () => {
    const proposals = [...enrichProposals]
    setEnrichDialogOpen(false)
    setEnrichProposals([])
    if (proposals.length === 0) {
      if (pendingProposedTasks.length > 0) setTaskProposalDialogOpen(true)
      return
    }
    setIsApplyingContactUpdates(true)
    try {
      const enrichedAt = new Date().toISOString()
      const names: string[] = []
      for (const item of proposals) {
        if (item.kind === 'company') {
          const p = item.proposal
          const selectedFields = new Set(
            p.changes
              .filter(c => fieldSelections[`${p.companyId}:${c.field}`] !== false)
              .map(c => c.field)
          )
          const companyBuiltinKeys = [
            'description', 'round', 'raiseSize', 'postMoneyValuation',
            'city', 'state', 'pipelineStage',
          ] as const
          const filteredUpdates: CompanySummaryUpdatePayload = {}
          for (const key of companyBuiltinKeys) {
            if (selectedFields.has(key) && (p.updates as Record<string, unknown>)[key] !== undefined) {
              (filteredUpdates as Record<string, unknown>)[key] = (p.updates as Record<string, unknown>)[key]
            }
          }
          if (Object.keys(filteredUpdates).length > 0) {
            await api.invoke(IPC_CHANNELS.COMPANY_UPDATE, p.companyId, filteredUpdates)
          }
          if (p.founderUpdate) {
            await api.invoke(
              IPC_CHANNELS.CONTACT_UPDATE,
              p.founderUpdate.contactId,
              { contactType: p.founderUpdate.toType }
            )
          }
          if (p.customFieldUpdates) {
            for (const cfu of p.customFieldUpdates) {
              if (fieldSelections[`${p.companyId}:${cfu.label}`] === false) continue
              const input: SetCustomFieldValueInput = {
                fieldDefinitionId: cfu.fieldDefinitionId,
                entityId: p.companyId,
                entityType: 'company',
              }
              const v = cfu.newValue
              switch (cfu.fieldType) {
                case 'number': case 'currency': input.valueNumber = Number(v); break
                case 'boolean': input.valueBoolean = Boolean(v); break
                case 'date': input.valueDate = String(v); break
                case 'multiselect': input.valueText = JSON.stringify(v); break
                default: input.valueText = String(v)
              }
              await api.invoke(IPC_CHANNELS.CUSTOM_FIELD_SET_VALUE, input)
            }
          }
          names.push(p.companyName)
          localStorage.setItem(companyEnrichedAtKey(p.companyId), enrichedAt)
        } else if (item.kind === 'contact') {
          const p = item.proposal
          const selectedFields = new Set(
            p.changes
              .filter(c => fieldSelections[`${p.contactId}:${c.field}`] !== false)
              .map(c => c.field)
          )
          const filteredUpdates: ContactSummaryUpdatePayload = {}
          const copyableKeys = [
            'title', 'phone', 'linkedinUrl',
            'fundSize', 'typicalCheckSizeMin', 'typicalCheckSizeMax',
            'investmentStageFocus', 'investmentSectorFocus',
          ] as const
          for (const key of copyableKeys) {
            if (selectedFields.has(key) && p.updates[key] !== undefined) {
              (filteredUpdates as Record<string, unknown>)[key] = p.updates[key]
            }
          }
          if (p.updates.fieldSources) {
            try {
              const sources: Record<string, string> = JSON.parse(p.updates.fieldSources)
              const filteredSources: Record<string, string> = {}
              for (const [k, v] of Object.entries(sources)) {
                if (selectedFields.has(k)) filteredSources[k] = v
              }
              if (Object.keys(filteredSources).length > 0) {
                filteredUpdates.fieldSources = JSON.stringify(filteredSources)
              }
            } catch { /* ignore */ }
          }
          if (Object.keys(filteredUpdates).length > 0) {
            await api.invoke(IPC_CHANNELS.CONTACT_UPDATE, p.contactId, filteredUpdates)
          }
          if (p.companyLink) {
            await api.invoke(IPC_CHANNELS.CONTACT_SET_COMPANY, p.contactId, p.companyLink.companyName)
          }
          if (p.customFieldUpdates) {
            for (const cfu of p.customFieldUpdates) {
              if (fieldSelections[`${p.contactId}:${cfu.label}`] === false) continue
              const input: SetCustomFieldValueInput = {
                fieldDefinitionId: cfu.fieldDefinitionId,
                entityId: p.contactId,
                entityType: 'contact',
              }
              const v = cfu.newValue
              switch (cfu.fieldType) {
                case 'number': case 'currency': input.valueNumber = Number(v); break
                case 'boolean': input.valueBoolean = Boolean(v); break
                case 'date': input.valueDate = String(v); break
                case 'multiselect': input.valueText = JSON.stringify(v); break
                default: input.valueText = String(v)
              }
              await api.invoke(IPC_CHANNELS.CUSTOM_FIELD_SET_VALUE, input)
            }
          }
          names.push(p.contactName)
          localStorage.setItem(contactEnrichedAtKey(p.contactId), enrichedAt)
        }
      }
      if (names.length > 0) {
        setEnrichSuccessMsg(`${names.join(', ')} updated`)
        setTimeout(() => setEnrichSuccessMsg(null), 3000)
      }
    } catch (err) {
      console.error('[MeetingDetail] Failed to apply enrichment:', err)
    } finally {
      setIsApplyingContactUpdates(false)
      if (pendingProposedTasks.length > 0) setTaskProposalDialogOpen(true)
    }
  }, [enrichProposals, fieldSelections, pendingProposedTasks])

  const handleEnrichFromMeeting = useCallback(async () => {
    if (!id) return
    setContactEnrichError(null)
    try {
      const proposals = await api.invoke<ContactSummaryUpdateProposal[]>(
        IPC_CHANNELS.CONTACT_ENRICH_FROM_MEETING, id
      )
      if (proposals.length > 0) {
        const newFieldSelections: Record<string, boolean> = {}
        for (const p of proposals) {
          for (const change of p.changes) {
            newFieldSelections[`${p.contactId}:${change.field}`] = true
          }
          for (const cfu of p.customFieldUpdates ?? []) {
            newFieldSelections[`${p.contactId}:${cfu.label}`] = true
          }
        }
        setFieldSelections(newFieldSelections)
        setEnrichProposals(proposals.map(p => ({ kind: 'contact' as const, proposal: p })))
        setEnrichDialogOpen(true)
      } else {
        setContactEnrichError('No new contact info found in this meeting.')
        setTimeout(() => setContactEnrichError(null), 3000)
      }
    } catch (err) {
      console.error('[MeetingDetail] Contact enrichment failed:', err)
      setContactEnrichError('Could not extract contact info — please try again.')
      setTimeout(() => setContactEnrichError(null), 4000)
    }
  }, [id])

  const handleGenerateSummary = useCallback(async () => {
    if (!id || !selectedTemplateId || isGenerating) return
    // Close summary editor if open, then save any pending notes
    setEditingSummary(false)
    await flushNotes()
    setIsGenerating(true)
    setStreamedSummary('')
    setActiveTab('notes')

    try {
      const result = await api.invoke<SummaryGenerateResult | string>(
        IPC_CHANNELS.SUMMARY_GENERATE,
        id,
        selectedTemplateId
      )
      const summary = typeof result === 'string' ? result : result.summary
      const companyUpdateProposals = typeof result === 'string'
        ? []
        : (result.companyUpdateProposals || [])
      const contactProposals = typeof result === 'string'
        ? []
        : (result.contactUpdateProposals || [])
      setData((prev) =>
        prev ? { ...prev, summary, meeting: { ...prev.meeting, status: 'summarized' } } : prev
      )
      setSummaryDraft(summary)
      setSummaryExists(true)
      setStreamedSummary('')
      setShowNotes(false)
      // Handle task proposals
      const taskResult = typeof result === 'string' ? undefined : result.taskExtractionResult
      const proposedTasks = taskResult?.proposed || []

      if (proposedTasks.length > 0) {
        setPendingProposedTasks(proposedTasks)
        const selections: Record<string, boolean> = {}
        for (const task of proposedTasks) {
          selections[task.key] = true
        }
        setProposedTaskSelections(selections)
      }

      const newFieldSelections: Record<string, boolean> = {}
      for (const p of companyUpdateProposals) {
        for (const change of p.changes) newFieldSelections[`${p.companyId}:${change.field}`] = true
        for (const cfu of p.customFieldUpdates ?? []) newFieldSelections[`${p.companyId}:${cfu.label}`] = true
      }
      for (const p of contactProposals) {
        for (const change of p.changes) newFieldSelections[`${p.contactId}:${change.field}`] = true
        for (const cfu of p.customFieldUpdates ?? []) newFieldSelections[`${p.contactId}:${cfu.label}`] = true
      }
      setFieldSelections(newFieldSelections)

      const unified: UnifiedEnrichProposal[] = [
        ...companyUpdateProposals.map(p => ({ kind: 'company' as const, proposal: p })),
        ...contactProposals.map(p => ({ kind: 'contact' as const, proposal: p })),
      ]
      if (unified.length > 0) {
        setEnrichProposals(unified)
        setEnrichDialogOpen(true)
      } else if (proposedTasks.length > 0) {
        setTaskProposalDialogOpen(true)
      }

      // macOS notification
      const totalFieldCount = companyUpdateProposals.reduce((n, p) => n + p.changes.length, 0)
                            + contactProposals.reduce((n, p) => n + p.changes.length, 0)
      if (totalFieldCount > 0 && 'Notification' in window && Notification.permission === 'granted') {
        const notif = new Notification('Meeting summarized', {
          body: `${totalFieldCount} field${totalFieldCount !== 1 ? 's' : ''} ready to review`
        })
        notif.onclick = () => window.focus()
      }

      // Refresh existing tasks
      if (id) {
        api.invoke<Task[]>(IPC_CHANNELS.TASK_LIST_FOR_MEETING, id)
          .then(setMeetingTasks)
          .catch((err2) => console.error('[MeetingDetail] Failed to refresh tasks:', err2))
      }

      // Re-sync all meeting state from DB now that summary is persisted
      await loadMeeting()
    } catch (err) {
      const errStr = String(err)
      if (!errStr.includes('abort') && !errStr.includes('Abort')) {
        console.error('Summary generation failed:', err)
      }
    } finally {
      setIsGenerating(false)
      setStreamedSummary('')
      setSummaryPhase('')
    }
  }, [id, selectedTemplateId, isGenerating, flushNotes, loadMeeting])

  useEffect(() => { generateSummaryRef.current = handleGenerateSummary }, [handleGenerateSummary])

  const handleAcceptProposedTasks = useCallback(async () => {
    const selected = pendingProposedTasks.filter((t) => proposedTaskSelections[t.key])
    setTaskProposalDialogOpen(false)
    setPendingProposedTasks([])
    setProposedTaskSelections({})

    if (selected.length === 0) return

    try {
      const createData: TaskCreateData[] = selected.map((t) => ({
        title: t.title,
        description: t.description,
        meetingId: t.meetingId,
        companyId: t.companyId,
        category: t.category,
        assignee: t.assignee,
        source: 'auto' as const,
        sourceSection: t.sourceSection,
        extractionHash: t.extractionHash
      }))
      await api.invoke(IPC_CHANNELS.TASK_BULK_CREATE, createData)
      if (id) {
        const tasks = await api.invoke<Task[]>(IPC_CHANNELS.TASK_LIST_FOR_MEETING, id)
        setMeetingTasks(tasks)
      }
    } catch (err) {
      console.error('[MeetingDetail] Failed to create tasks:', err)
    }
  }, [id, pendingProposedTasks, proposedTaskSelections])

  const handleDismissProposedTasks = useCallback(() => {
    setTaskProposalDialogOpen(false)
    setPendingProposedTasks([])
    setProposedTaskSelections({})
    setEditingTaskKey(null)
  }, [])

  const commitTaskEdit = useCallback(() => {
    if (!editingTaskKey) return
    setPendingProposedTasks((prev) =>
      prev.map((t) => t.key === editingTaskKey ? { ...t, title: editingTaskDraft } : t)
    )
    setEditingTaskKey(null)
  }, [editingTaskKey, editingTaskDraft])

  const selectedTaskCount = Object.values(proposedTaskSelections).filter(Boolean).length

  const dialogProposals = useMemo<EnrichmentEntityProposal[]>(() => {
    return enrichProposals.map(item => {
      if (item.kind === 'company') {
        const p = item.proposal
        return {
          entityId: p.companyId,
          entityName: p.companyName,
          changes: [
            ...p.changes.map(c => ({
              key: c.field,
              label: fieldLabel(c.field),
              from: formatFieldValue(c.field, c.from),
              to: formatFieldValue(c.field, c.to),
            })),
            ...(p.customFieldUpdates ?? []).map(cfu => ({
              key: cfu.label,
              label: cfu.label,
              from: cfu.fromDisplay,
              to: cfu.toDisplay,
            })),
            ...(p.founderUpdate ? [{
              key: 'founderUpdate',
              label: 'Founder tag',
              from: null,
              to: `Tag ${p.founderUpdate.contactName} as founder`,
            }] : []),
          ],
        }
      } else {
        const p = item.proposal
        return {
          entityId: p.contactId,
          entityName: p.contactName,
          changes: [
            ...p.changes.map(c => ({
              key: c.field,
              label: c.field,
              from: c.from || null,
              to: c.to,
            })),
            ...(p.customFieldUpdates ?? []).map(cfu => ({
              key: cfu.label,
              label: cfu.label,
              from: cfu.fromDisplay,
              to: cfu.toDisplay,
            })),
          ],
        }
      }
    })
  }, [enrichProposals])

  const handleSelectAll = useCallback(() => {
    setFieldSelections(prev => {
      const next = { ...prev }
      for (const ep of dialogProposals) {
        for (const c of ep.changes) next[`${ep.entityId}:${c.key}`] = true
      }
      return next
    })
  }, [dialogProposals])

  const handleDeselectAll = useCallback(() => {
    setFieldSelections(prev => {
      const next = { ...prev }
      for (const ep of dialogProposals) {
        for (const c of ep.changes) next[`${ep.entityId}:${c.key}`] = false
      }
      return next
    })
  }, [dialogProposals])

  const handleSkipEnrich = useCallback(() => {
    setEnrichDialogOpen(false)
    setEnrichProposals([])
    if (pendingProposedTasks.length > 0) setTaskProposalDialogOpen(true)
  }, [pendingProposedTasks])

  const handleTitleClick = useCallback(() => {
    if (!data) return
    setEditingTitle(true)
    setTitleDraft(data.meeting.title)
    setTimeout(() => titleInputRef.current?.focus(), 0)
  }, [data])

  const handleTitleSave = useCallback(async () => {
    if (!id || !data) return
    const trimmed = titleDraft.trim()
    if (!trimmed || trimmed === data.meeting.title) {
      setEditingTitle(false)
      return
    }

    setEditingTitle(false)
    setIsSavingTitle(true)

    try {
      await api.invoke(IPC_CHANNELS.MEETING_RENAME_TITLE, id, trimmed)
      await loadMeeting()
    } catch (err) {
      console.error('Failed to rename meeting:', err)
    } finally {
      setIsSavingTitle(false)
    }
  }, [id, data, titleDraft, loadMeeting])

  const handleTitleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleTitleSave()
    } else if (e.key === 'Escape') {
      setEditingTitle(false)
    }
  }, [handleTitleSave])

  const handleSpeakerClick = useCallback((index: number) => {
    setEditingSpeaker(index)
    setSpeakerDraft(localSpeakerMap[index] || '')
    setTimeout(() => speakerInputRef.current?.focus(), 0)
  }, [localSpeakerMap])

  const handleSpeakerSave = useCallback(async () => {
    if (editingSpeaker === null || !id) return
    const trimmed = speakerDraft.trim()
    if (!trimmed || trimmed === localSpeakerMap[editingSpeaker]) {
      setEditingSpeaker(null)
      return
    }

    const updated = { ...localSpeakerMap, [editingSpeaker]: trimmed }
    setLocalSpeakerMap(updated)
    setEditingSpeaker(null)
    setIsSavingSpeakers(true)

    try {
      await api.invoke(IPC_CHANNELS.MEETING_RENAME_SPEAKERS, id, updated)
      await loadMeeting()
    } catch (err) {
      console.error('Failed to rename speaker:', err)
      setLocalSpeakerMap(localSpeakerMap)
    } finally {
      setIsSavingSpeakers(false)
    }
  }, [editingSpeaker, speakerDraft, localSpeakerMap, id, loadMeeting])

  const handleSpeakerKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSpeakerSave()
    } else if (e.key === 'Escape') {
      setEditingSpeaker(null)
    }
  }, [handleSpeakerSave])

  const handleLinkSpeakerContact = useCallback(async (index: number, contact: ContactSummary) => {
    setLinkingPicker(null)
    const prevMap = localSpeakerMap
    const prevLinks = speakerContactMap
    setLocalSpeakerMap({ ...localSpeakerMap, [index]: contact.fullName })
    setSpeakerContactMap({ ...speakerContactMap, [index]: contact.id })
    try {
      await api.invoke(IPC_CHANNELS.MEETING_TAG_SPEAKER_CONTACT, id, index, contact.id, contact.fullName)
    } catch (err) {
      console.error('[MeetingDetail] Failed to tag speaker contact:', err)
      setLocalSpeakerMap(prevMap)
      setSpeakerContactMap(prevLinks)
    }
  }, [localSpeakerMap, speakerContactMap, id])

  const handleUnlinkSpeaker = useCallback(async (index: number) => {
    const prevMap = localSpeakerMap
    const prevLinks = speakerContactMap
    const updatedLinks = { ...speakerContactMap }
    delete updatedLinks[index]
    setLocalSpeakerMap({ ...localSpeakerMap, [index]: `Speaker ${index}` })
    setSpeakerContactMap(updatedLinks)
    try {
      await api.invoke(IPC_CHANNELS.MEETING_TAG_SPEAKER_CONTACT, id, index, null, null)
    } catch (err) {
      console.error('[MeetingDetail] Failed to unlink speaker contact:', err)
      setLocalSpeakerMap(prevMap)
      setSpeakerContactMap(prevLinks)
    }
  }, [localSpeakerMap, speakerContactMap, id])

  const handleLinkExistingCompany = useCallback(async (company: CompanySummary) => {
    setShowCompanyPicker(false)
    try {
      await api.invoke(IPC_CHANNELS.MEETING_LINK_EXISTING_COMPANY, id, company.id)
      await loadMeeting()
    } catch (err) {
      console.error('[MeetingDetail] Failed to link company:', err)
    }
  }, [id, loadMeeting])

  const handleUnlinkCompany = useCallback(async (e: React.MouseEvent, company: CompanySuggestion) => {
    e.stopPropagation()
    if (!company.id) return
    try {
      await api.invoke(IPC_CHANNELS.MEETING_UNLINK_COMPANY, id, company.id)
      await loadMeeting()
    } catch (err) {
      console.error('[MeetingDetail] Failed to unlink company:', err)
    }
  }, [id, loadMeeting])

  const handleSwapCompany = useCallback(async (oldCompany: CompanySuggestion, newName: string) => {
    if (!id || !newName.trim()) return
    const key = oldCompany.id ?? oldCompany.name
    setOptimisticSwap((prev) => ({ ...prev, [key]: newName.trim() }))
    setEditingCompanyKey(null)
    try {
      await api.invoke(IPC_CHANNELS.MEETING_SWAP_COMPANY, id, oldCompany.id ?? null, newName.trim())
      await loadMeeting()
    } catch (err) {
      console.error('[MeetingDetail] Failed to swap company:', err)
    } finally {
      setOptimisticSwap((prev) => { const n = { ...prev }; delete n[key]; return n })
    }
  }, [id, loadMeeting])

  const handleCopyDriveLink = useCallback(async () => {
    if (!id) return
    setShareMenuOpen(false)
    try {
      const result = await api.invoke<DriveShareResponse>(
        IPC_CHANNELS.DRIVE_GET_SHARE_LINK,
        id
      )
      if (result.success) {
        await navigator.clipboard.writeText(result.url)
        notice.show({ variant: 'success', title: 'Drive link copied to clipboard', url: result.url })
      } else {
        notice.show({ variant: 'error', title: 'Failed to get link', message: result.message })
      }
    } catch (err) {
      console.error('Failed to get Drive link:', err)
      notice.show({ variant: 'error', title: 'Failed to get shareable link' })
    }
  }, [id, notice])

  const handleCopyText = useCallback(async () => {
    setShareMenuOpen(false)
    const text = activeTab === 'transcript' ? data?.transcript : summaryDraft
    if (!text) {
      notice.show({ variant: 'error', title: 'No content to copy' })
      return
    }
    try {
      await navigator.clipboard.writeText(text)
      notice.show({ variant: 'success', title: 'Copied to clipboard' })
    } catch (err) {
      console.error('Failed to copy text:', err)
      notice.show({ variant: 'error', title: 'Failed to copy to clipboard' })
    }
  }, [activeTab, data, summaryDraft, notice])

  const isCreatingShareRef = useRef(false)
  const handleWebShare = useCallback(async () => {
    if (!id || isCreatingShareRef.current) return
    isCreatingShareRef.current = true
    setShareMenuOpen(false)
    try {
      await flushNotes()
      const result = await api.invoke<WebShareResponse>(
        IPC_CHANNELS.WEB_SHARE_CREATE,
        id
      )
      if (result.success) {
        await navigator.clipboard.writeText(result.url)
        notice.show({ variant: 'success', title: 'Web share link copied to clipboard', url: result.url })
      } else {
        notice.show({ variant: 'error', title: 'Failed to create web share', message: result.message })
      }
    } catch (err) {
      console.error('Failed to create web share:', err)
      notice.show({ variant: 'error', title: 'Failed to create web share' })
    } finally {
      isCreatingShareRef.current = false
    }
  }, [id, flushNotes, notice])

  // Register this meeting as the chat page context so the global floating chat
  // shows entity-scoped options (meeting + linked companies/contacts) while on this page.
  const setPageContext = useChatStore((s) => s.setPageContext)
  useEffect(() => {
    if (!data?.meeting) return
    const seenContactIds = new Set<string>()
    const contextOptions: ContextOption[] = [
      ...(data?.linkedCompanies ?? []).map(c => ({ type: 'company' as const, id: c.id, name: c.name })),
      ...Object.entries(speakerContactMap)
        .filter(([, contactId]) => {
          if (!contactId || seenContactIds.has(contactId)) return false
          seenContactIds.add(contactId)
          return true
        })
        .map(([idx, contactId]) => ({
          type: 'contact' as const,
          id: contactId as string,
          name: localSpeakerMap[Number(idx)] || 'Contact'
        }))
    ]
    setPageContext({
      meetingId: data.meeting.id,
      contextOptions: contextOptions.length > 0 ? contextOptions : undefined
    })
    return () => setPageContext(null)
  }, [data?.meeting?.id, data?.linkedCompanies, speakerContactMap, localSpeakerMap, setPageContext])

  // Only show recording UI if THIS meeting is the one being recorded
  const isThisMeetingRecording = isRecording && recordingMeetingId === id

  const displaySummary = isGenerating ? streamedSummary : summaryDraft
  const hasSummary = isGenerating ? !!streamedSummary : summaryExists
  const searchableText = activeTab === 'notes'
    ? preprocessSummaryMarkdown(displaySummary || '')
    : (data?.transcript || '')

  const {
    query: findQuery,
    setQuery: setFindQuery,
    matchCount,
    activeMatchIndex,
    matches: findMatches,
    goToNext,
    goToPrev,
  } = useFindInPage({
    text: searchableText,
    isOpen: findOpen,
    onOpen: () => setFindOpen(true),
    onClose: () => setFindOpen(false)
  })

  if (!data) {
    return <div className={styles.loading}>Loading...</div>
  }

  const { meeting, transcript, summary } = data
  // Prefer blob playback for stability, but fall back to direct media:// source if blob fetch fails.
  const playbackSrc = videoBlobUrl || (videoBlobFailed ? videoPath : null)
  const displayVideoDuration = videoDuration > 0 ? videoDuration : 0
  const seekMax = Math.max(displayVideoDuration, currentTime, 1)
  const speakerEntries = Object.entries(localSpeakerMap)
  const hasTranscript = !!transcript

  return (
    <div className={styles.container}>
      {findOpen && (
        <FindBar
          query={findQuery}
          onQueryChange={setFindQuery}
          matchCount={matchCount}
          activeMatchIndex={activeMatchIndex}
          onNext={goToNext}
          onPrev={goToPrev}
          onClose={() => setFindOpen(false)}
        />
      )}

      <div className={styles.stickyHeader}>
        <button className={styles.back} onClick={() => navigate(-1)}>
          &larr; {backLabel}
        </button>

        {isThisMeetingRecording && (
          <div className={styles.recordingBadge}>
            <span className={styles.recordingBadgeDot} />
            RECORDING ACTIVE
          </div>
        )}

        <div className={styles.header}>
          <div className={styles.titleRow}>
            {editingTitle ? (
              <input
                ref={titleInputRef}
                className={styles.titleInput}
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={handleTitleSave}
                onKeyDown={handleTitleKeyDown}
                disabled={isSavingTitle}
              />
            ) : (
              <h2
                className={styles.title}
                onClick={handleTitleClick}
                title="Click to rename"
              >
                {meeting.title}
              </h2>
            )}
            <div className={styles.titleActions}>
              {!isRecording && meeting.status === 'scheduled' && (
                <button className={styles.recordBtn} onClick={handleStartRecording}>
                  Record
                </button>
              )}
              {isThisMeetingRecording ? (
                <button
                  className={styles.stopMeetingBtn}
                  onClick={handleStop}
                  title="Stop meeting transcription (and any active screen recording)"
                >
                  Stop Meeting
                </button>
              ) : (!isRecording && (meeting.status === 'transcribed' || meeting.status === 'summarized')) && (
                <button className={styles.recordBtn} onClick={handleContinueRecording}>
                  Continue Recording
                </button>
              )}
              <div ref={shareRef} className={styles.shareWrapper}>
                <button
                  className={styles.shareBtn}
                  onClick={() => setShareMenuOpen(!shareMenuOpen)}
                >
                  Share
                </button>
                {shareMenuOpen && (
                  <div className={styles.shareMenu}>
                    <button className={styles.shareMenuItem} onClick={handleCopyDriveLink}>
                      Copy Drive link
                    </button>
                    <button className={styles.shareMenuItem} onClick={handleCopyText}>
                      Copy text
                    </button>
                    <button className={styles.shareMenuItem} onClick={handleWebShare}>
                      Share to web
                    </button>
                  </div>
                )}
              </div>
              <button className={styles.deleteBtn} onClick={handleDelete}>
                Delete
              </button>
            </div>
          </div>
          <div className={styles.meta}>
            <span>{new Date(meeting.date).toLocaleString(undefined, { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
            {meeting.durationSeconds && (
              <span>{Math.round(meeting.durationSeconds / 60)} min</span>
            )}
            {!isThisMeetingRecording && (() => {
              const { label, className } = meetingStatusLabel(meeting.status, styles)
              return (
                <span className={`${styles.meetingStatusBadge} ${className}`}>
                  {label}
                </span>
              )
            })()}
            <div className={styles.speakers}>
              <div className={styles.attendeeAvatars}>
                {(meeting.attendees ?? []).slice(0, 4).map((attendee, i) => {
                  const email = meeting.attendeeEmails?.[i]?.trim().toLowerCase() || ''
                  const resolved = attendeeContactMap[email]
                  const contactId = resolved?.id
                  const displayName = resolved?.fullName ?? attendee
                  const initials = getInitials(displayName)
                  return (
                    <button
                      key={`${attendee}-${i}`}
                      className={styles.attendeeAvatar}
                      title={displayName}
                      onClick={async () => {
                        if (contactId) {
                          navigate(`/contact/${contactId}`, { state: { backLabel: data?.meeting.title ?? 'Meeting' } })
                          return
                        }
                        if (!email) return
                        try {
                          const created = await api.invoke<{ id: string }>(
                            IPC_CHANNELS.CONTACT_CREATE,
                            { fullName: attendee, email }
                          )
                          setAttendeeContactMap((prev) => ({ ...prev, [email]: { id: created.id, fullName: attendee } }))
                          navigate(`/contact/${created.id}`, { state: { backLabel: data?.meeting.title ?? 'Meeting' } })
                        } catch (err) {
                          console.error('[MeetingDetail] Failed to create contact:', err)
                        }
                      }}
                    >
                      {initials}
                    </button>
                  )
                })}
                {(meeting.attendees?.length ?? 0) > 4 && (
                  <span className={styles.attendeeAvatarOverflow}>
                    +{(meeting.attendees?.length ?? 0) - 4}
                  </span>
                )}
              </div>
              {!showCompanyPicker ? (
                <button
                  className={styles.addCompanyBtn}
                  onClick={() => { setShowCompanyPicker(true); companyLinkPicker.search('', 0) }}
                >
                  + Add Company
                </button>
              ) : (
                <EntityPicker<CompanySummary>
                  picker={companyLinkPicker}
                  placeholder="Search company…"
                  renderItem={(c) => c.canonicalName}
                  onSelect={handleLinkExistingCompany}
                  onClose={() => setShowCompanyPicker(false)}
                />
              )}
            </div>

            {companySuggestions.length > 0 && (
              <div className={styles.companies}>
                {companySuggestions.map((c) => {
                  const suggestionKey = companySuggestionKey(c)
                  const selectedType = companyTagSelections[suggestionKey]
                  const chipKey = c.id ?? c.name
                  const isEditing = editingCompanyKey === chipKey
                  return (
                    <div key={c.domain || c.name} className={styles.companyChip}>
                      <div className={styles.companyChipRow}>
                        {isEditing ? (
                          <EntityPicker<CompanySummary>
                            picker={swapCompanyPicker}
                            placeholder="Search company…"
                            renderItem={(co) => (
                              <span className={styles.companyPickerItem}>
                                {co.primaryDomain && (
                                  <img
                                    src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(co.primaryDomain)}&sz=32`}
                                    width={14}
                                    height={14}
                                    alt=""
                                  />
                                )}
                                {co.canonicalName}
                              </span>
                            )}
                            onSelect={(selected) => void handleSwapCompany(c, selected.canonicalName)}
                            onClose={() => setEditingCompanyKey(null)}
                            onCreate={(query) => void handleSwapCompany(c, query)}
                          />
                        ) : (
                          <button
                            type="button"
                            className={styles.companyChipMain}
                            onClick={() => void handleOpenCompanyDetail(c)}
                          >
                            {c.domain && (
                              <img
                                src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(c.domain)}&sz=32`}
                                alt=""
                                className={styles.companyChipLogo}
                                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                              />
                            )}
                            {optimisticSwap[chipKey] ?? c.name}
                          </button>
                        )}
                        {!isEditing && (
                          <button
                            type="button"
                            className={styles.companyChipEdit}
                            onClick={(e) => {
                              e.stopPropagation()
                              setEditingCompanyKey(chipKey)
                              swapCompanyPicker.search(c.name, 0)
                            }}
                            title="Change company"
                          >
                            ✎
                          </button>
                        )}
                        {!isEditing && c.id && (
                          <button
                            type="button"
                            className={styles.companyChipRemove}
                            onClick={(e) => void handleUnlinkCompany(e, c)}
                            title="Remove company tag"
                          >
                            ×
                          </button>
                        )}
                      </div>
                      {!isEditing && !selectedType && (
                        <span className={styles.companyChipActions}>
                          {TAGGABLE_COMPANY_TYPES.map((entityType) => (
                            <button
                              key={entityType}
                              type="button"
                              disabled={savingCompanyTagKey === suggestionKey}
                              className={styles.companyTagBtn}
                              onClick={() => handleTagCompany(c, entityType)}
                            >
                              {TAG_LABELS[entityType]}
                            </button>
                          ))}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        {isThisMeetingRecording && (
          <div className={styles.recordingBar}>
            <div className={styles.recordingStatus}>
              <span className={`${styles.recordingDot} ${isPaused ? styles.paused : ''}`} />
              <div className={styles.recordingStatusText}>
                <span className={styles.recordingModeLabel}>
                  Meeting transcription
                  {channelMode && channelMode !== 'detecting' && (
                    <span className={styles.channelModeBadge}>
                      {channelMode === 'multichannel' ? 'Stereo' : 'Mic Only'}
                    </span>
                  )}
                </span>
                <span className={styles.recordingTimer}>
                  {formatTime(duration)}
                  {isPaused && <span className={styles.pausedLabel}> (Paused)</span>}
                </span>
              </div>
            </div>
            <div className={styles.recordingControls}>
              <div className={styles.controlGroup}>
                <span className={styles.controlLabel}>Screen Recording</span>
                <button
                  className={`${styles.videoToggle} ${videoCapture.isVideoRecording ? styles.videoActive : ''}`}
                  onClick={handleToggleVideo}
                  title={videoCapture.isVideoRecording ? 'Stop screen recording only' : 'Start screen recording'}
                >
                  <span
                    className={`${styles.videoToggleDot} ${videoCapture.isVideoRecording ? styles.videoToggleDotActive : ''}`}
                    aria-hidden="true"
                  />
                  {videoCapture.isVideoRecording ? 'Stop Screen' : 'Start Screen'}
                </button>
              </div>
              <div className={styles.controlGroup}>
                <span className={styles.controlLabel}>Meeting Transcription</span>
                {isPaused ? (
                  <button className={styles.resumeBtn} onClick={handleResume}>
                    Resume
                  </button>
                ) : (
                  <button className={styles.pauseBtn} onClick={handlePause}>
                    Pause
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {isThisMeetingRecording && recordingError && (
          <div className={styles.recordingError}>{recordingError}</div>
        )}

        {isThisMeetingRecording && videoCapture.videoError && (
          <div className={styles.recordingError}>{videoCapture.videoError}</div>
        )}

        {isThisMeetingRecording && audioCapture.hasSystemAudio === false && (
          <div className={styles.recordingWarning}>
            Mic only — system audio capture is not available. Grant Screen Recording
            permission in System Settings &gt; Privacy &amp; Security to capture meeting audio.
          </div>
        )}

        <div className={styles.tabs}>
          <button
            className={`${styles.tab} ${activeTab === 'notes' ? styles.activeTab : ''}`}
            onClick={() => setActiveTab('notes')}
          >
            Notes
          </button>
          <button
            className={`${styles.tab} ${activeTab === 'transcript' ? styles.activeTab : ''}`}
            onClick={() => setActiveTab('transcript')}
          >
            Transcript
          </button>
          <button
            className={`${styles.tab} ${activeTab === 'recording' ? styles.activeTab : ''}`}
            onClick={() => setActiveTab('recording')}
            disabled={!videoPath && !videoCapture.isVideoRecording}
          >
            Recording
          </button>
        </div>
      </div>

      <div className={styles.content}>
        {activeTab === 'notes' && (
          <div className={styles.notesTab}>
            {hasSummary ? (
              <button
                className={styles.notesToggle}
                onClick={() => setShowNotes((v) => !v)}
              >
                {showNotes ? 'Hide your notes' : 'Show your notes'}
              </button>
            ) : null}
            {(showNotes || !hasSummary) && (
              <div className={styles.meetingNotesEditor}>
                <EditorContent editor={meetingNotesEditor} />
                <TiptapBubbleMenu editor={meetingNotesEditor} />
              </div>
            )}

            {hasTranscript && (
              <div className={styles.enhanceBar}>
                <select
                  className={styles.templateSelect}
                  value={selectedTemplateId}
                  onChange={(e) => setSelectedTemplateId(e.target.value)}
                  disabled={isGenerating}
                >
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <button
                  className={`${styles.enhanceBtn} ${isGenerating ? styles.stopEnhanceBtn : ''}`}
                  onClick={isGenerating ? handleStopEnhance : handleGenerateSummary}
                >
                  {isGenerating ? '\u25A0 Stop' : summary ? 'Re-enhance' : 'Enhance'}
                </button>
              </div>
            )}

            {meeting.status === 'summarized' && (meeting.attendeeEmails?.length ?? 0) > 0 && (
              <div className={styles.enrichBar}>
                <button
                  className={styles.enrichBtn}
                  onClick={() => void handleEnrichFromMeeting()}
                >
                  Enrich contacts from meeting
                </button>
                {contactEnrichError && (
                  <span className={styles.enrichError}>{contactEnrichError}</span>
                )}
              </div>
            )}

            {enrichSuccessMsg && (
              <div className={styles.enrichSuccessBanner}>
                ✓ {enrichSuccessMsg}
                <button onClick={() => setEnrichSuccessMsg(null)}>×</button>
              </div>
            )}

            {hasSummary && (
              <div className={styles.summaryCard}>
                <div className={styles.summaryDivider}>
                  <span>✦ AI SUMMARY & ACTION ITEMS</span>
                </div>
                {isGenerating ? (
                  <>
                    {summaryPhase && (
                      <div className={styles.summaryPhase}>
                        {summaryPhase === 'generating' ? 'Generating draft...' : 'Refining...'}
                      </div>
                    )}
                    <div className={styles.markdown}>
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {injectFindMarks(preprocessSummaryMarkdown(streamedSummary), findMatches, activeMatchIndex)}
                      </ReactMarkdown>
                    </div>
                  </>
                ) : editingSummary ? (
                  <div className={styles.summaryEditor}>
                    <EditorContent editor={summaryEditor} />
                  </div>
                ) : (
                  <div
                    className={styles.markdown}
                    onClick={() => { if (!findOpen) setEditingSummary(true) }}
                    title={findOpen ? undefined : 'Click to edit'}
                  >
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {injectFindMarks(preprocessSummaryMarkdown(summaryDraft ?? ''), findMatches, activeMatchIndex)}
                    </ReactMarkdown>
                  </div>
                )}
              </div>
            )}

            {meetingTasks.length > 0 && (
              <div className={styles.taskCard}>
                <div className={styles.summaryDivider}>
                  <span>Tasks ({meetingTasks.length})</span>
                </div>
                {meetingTasks.map((task) => (
                  <div key={task.id} className={styles.meetingTaskRow}>
                    <input
                      type="checkbox"
                      checked={task.status === 'done'}
                      className={styles.meetingTaskCheckbox}
                      onChange={async () => {
                        const newStatus = task.status === 'done' ? 'open' : 'done'
                        try {
                          await api.invoke(IPC_CHANNELS.TASK_UPDATE, task.id, { status: newStatus })
                          setMeetingTasks((prev) =>
                            prev.map((t) => (t.id === task.id ? { ...t, status: newStatus } : t))
                          )
                        } catch (err) {
                          console.error('Failed to update task:', err)
                        }
                      }}
                    />
                    <span className={task.status === 'done' ? styles.meetingTaskDone : styles.meetingTaskTitle}>
                      {task.title}
                    </span>
                    <span className={styles.meetingTaskBadge}>
                      {task.category === 'action_item' ? 'Action' : task.category === 'decision' ? 'Decision' : 'Follow-up'}
                    </span>
                  </div>
                ))}
                <button
                  className={styles.meetingTasksViewAll}
                  onClick={() => navigate('/tasks')}
                >
                  View all tasks
                </button>
              </div>
            )}

            {(notesDraft || summaryDraft) && (
              <div className={styles.noteFooter}>
                <div className={styles.noteFooterMeta}>
                  <Clock size={12} strokeWidth={2} />
                  Last edited {relativeTime(lastEditedAt ?? meeting.updatedAt)} · {wordCount} words
                </div>
                <div className={styles.noteFooterActions}>
                  <button
                    className={styles.noteFooterBtn}
                    title="Share"
                    onClick={() => setShareMenuOpen(true)}
                  >
                    ···
                  </button>
                </div>
              </div>
            )}

          </div>
        )}
        {activeTab === 'transcript' && (
          <div className={styles.transcriptTab}>
            {transcript && (
              <div className={styles.markdown}>
                {injectFindMarks(transcript ?? '', findMatches, activeMatchIndex)}
              </div>
            )}
            {isThisMeetingRecording && (
              <div className={styles.liveTranscript}>
                {speakerEntries.length > 0 && (
                  <div className={styles.speakers}>
                    {speakerEntries.map(([idx, name]) => {
                      const index = Number(idx)
                      const linkedContactId = speakerContactMap[index]

                      if (editingSpeaker === index && !linkedContactId) {
                        return (
                          <div key={idx} className={styles.speakerChipGroup}>
                            <input
                              ref={speakerInputRef}
                              className={styles.speakerInput}
                              value={speakerDraft}
                              onChange={(e) => setSpeakerDraft(e.target.value)}
                              onBlur={handleSpeakerSave}
                              onKeyDown={handleSpeakerKeyDown}
                              disabled={isSavingSpeakers}
                            />
                            <button
                              className={styles.speakerLinkBtn}
                              onClick={() => { setEditingSpeaker(null); setLinkingPicker(index); speakerContactPicker.search('', 0) }}
                              title="Tag to contact"
                            >
                              🔗
                            </button>
                          </div>
                        )
                      }

                      return (
                        <div key={idx} className={styles.speakerChipGroup}>
                          {linkedContactId ? (
                            <button
                              className={`${styles.speakerChip} ${styles.speakerChipLinked}`}
                              onClick={() => navigate(`/contact/${linkedContactId}`, { state: { backLabel: data?.meeting.title ?? 'Meeting' } })}
                              title="View contact"
                            >
                              {name} →
                            </button>
                          ) : (
                            <button
                              className={styles.speakerChip}
                              onClick={() => handleSpeakerClick(index)}
                              title="Click to rename"
                            >
                              {name}
                            </button>
                          )}

                          {linkedContactId ? (
                            <button
                              className={styles.speakerUnlinkBtn}
                              onClick={() => handleUnlinkSpeaker(index)}
                              title="Unlink contact"
                            >
                              ×
                            </button>
                          ) : (
                            <button
                              className={styles.speakerLinkBtn}
                              onClick={() => { setLinkingPicker(index); speakerContactPicker.search('', 0) }}
                              title="Tag to contact"
                            >
                              🔗
                            </button>
                          )}

                          {linkingPicker === index && (
                            <EntityPicker<ContactSummary>
                              picker={speakerContactPicker}
                              placeholder="Search contact…"
                              renderItem={(c) => (
                                <>
                                  <span>{c.fullName}</span>
                                  {c.primaryCompanyName && (
                                    <span className={styles.speakerPickerSub}>{c.primaryCompanyName}</span>
                                  )}
                                </>
                              )}
                              onSelect={(c) => handleLinkSpeakerContact(index, c)}
                              onClose={() => setLinkingPicker(null)}
                            />
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
                {liveTranscript.length === 0 && !interimSegment && !transcript && (
                  <p className={styles.noContent}>Waiting for speech...</p>
                )}
                {liveTranscript.map((segment, i) => {
                  const speakerName = localSpeakerMap[segment.speaker] ?? `Speaker ${segment.speaker + 1}`
                  const contactId = speakerContactMap[segment.speaker]
                  return (
                    <div key={i} className={styles.liveSegment}>
                      {contactId ? (
                        <button
                          className={`${styles.liveSpeaker} ${styles.liveSpeakerLinked}`}
                          onClick={() => navigate(`/contact/${contactId}`, { state: { backLabel: data?.meeting.title ?? 'Meeting' } })}
                          title="View contact"
                        >
                          {speakerName}
                        </button>
                      ) : (
                        <span className={styles.liveSpeaker}>{speakerName}</span>
                      )}
                      <span>{segment.text}</span>
                    </div>
                  )
                })}
                {interimSegment && (
                  <div className={`${styles.liveSegment} ${styles.interim}`}>
                    {(() => {
                      const speakerName = localSpeakerMap[interimSegment.speaker] ?? `Speaker ${interimSegment.speaker + 1}`
                      const contactId = speakerContactMap[interimSegment.speaker]
                      return contactId ? (
                        <button
                          className={`${styles.liveSpeaker} ${styles.liveSpeakerLinked}`}
                          onClick={() => navigate(`/contact/${contactId}`, { state: { backLabel: data?.meeting.title ?? 'Meeting' } })}
                          title="View contact"
                        >
                          {speakerName}
                        </button>
                      ) : (
                        <span className={styles.liveSpeaker}>{speakerName}</span>
                      )
                    })()}
                    <span>{interimSegment.text}</span>
                  </div>
                )}
                <div ref={transcriptEndRef} />
              </div>
            )}
            {!isThisMeetingRecording && !transcript && (
              <div className={styles.noContent}>No transcript available yet.</div>
            )}
          </div>
        )}
        {activeTab === 'recording' && (
          <div className={styles.videoTab}>
            {videoPath && playbackSrc ? (
              <div
                ref={videoWrapperRef}
                className={styles.videoWrapper}
                onMouseMove={handleVideoMouseMove}
                onMouseLeave={handleVideoMouseLeave}
              >
                <video
                  ref={videoRef}
                  className={styles.videoPlayer}
                  src={playbackSrc}
                  preload="metadata"
                  onClick={showControls}
                  onLoadedMetadata={() => {
                    const v = videoRef.current
                    if (!v) return
                    v.playbackRate = playbackSpeed
                    syncVideoDuration()
                  }}
                  onDurationChange={() => {
                    syncVideoDuration()
                  }}
                  onProgress={syncVideoDuration}
                  onTimeUpdate={() => {
                    if (videoRef.current) {
                      setCurrentTime(videoRef.current.currentTime)
                      if (videoDuration === 0) syncVideoDuration()
                    }
                  }}
                  onPlay={() => { setIsPlaying(true); playRequestRef.current = null }}
                  onPause={() => { setIsPlaying(false); setControlsVisible(true); playRequestRef.current = null }}
                  onEnded={() => { setIsPlaying(false); setControlsVisible(true); playRequestRef.current = null }}
                  onError={() => {
                    const v = videoRef.current
                    if (!v) return
                    const err = v.error
                    console.error('[MeetingDetail] Video element error:', {
                      src: v.currentSrc,
                      code: err?.code ?? null,
                      message: err?.message ?? null,
                      readyState: v.readyState,
                      networkState: v.networkState,
                      currentTime: v.currentTime,
                      duration: v.duration
                    })
                  }}
                />
                <div
                  className={styles.controlsBar}
                  style={{ opacity: controlsVisible ? 1 : 0, pointerEvents: controlsVisible ? 'auto' : 'none' }}
                >
                  <button className={styles.controlsBtn} onClick={handlePlayPause} title={isPlaying ? 'Pause' : 'Play'}>
                    {isPlaying ? '\u23F8' : '\u25B6'}
                  </button>
                  <span className={styles.timeDisplay}>
                    {formatVideoTime(currentTime)} / {formatVideoTime(displayVideoDuration)}
                  </span>
                  <input
                    type="range"
                    className={styles.seekBar}
                    min={0}
                    max={seekMax}
                    value={currentTime}
                    step={0.1}
                    onChange={handleSeek}
                  />
                  <div ref={volumeRef} className={styles.volumeAnchor}>
                    <button
                      className={styles.controlsBtn}
                      onClick={() => setVolumeOpen((o) => !o)}
                      onContextMenu={(e) => { e.preventDefault(); handleMuteToggle() }}
                      title={isMuted ? 'Unmute' : 'Mute'}
                    >
                      {isMuted || volume === 0 ? '\uD83D\uDD07' : volume < 0.5 ? '\uD83D\uDD09' : '\uD83D\uDD0A'}
                    </button>
                    {volumeOpen && (
                      <div className={styles.volumePopup}>
                        <input
                          type="range"
                          className={styles.volumeSlider}
                          min={0}
                          max={1}
                          step={0.01}
                          value={isMuted ? 0 : volume}
                          onChange={handleVolumeChange}
                          orient="vertical"
                        />
                      </div>
                    )}
                  </div>
                  <div ref={speedMenuRef} className={styles.menuAnchor}>
                    <button
                      className={styles.controlsBtn}
                      onClick={() => setSpeedMenuOpen((o) => !o)}
                      title="More options"
                    >
                      &#8942;
                    </button>
                    {speedMenuOpen && (
                      <div className={styles.videoMenuDropdown}>
                        <div className={styles.videoMenuSection}>
                          <span className={styles.videoMenuLabel}>Speed</span>
                          <div className={styles.speedGrid}>
                            {[0.5, 1, 1.5, 2, 2.5, 3].map((speed) => (
                              <button
                                key={speed}
                                className={`${styles.speedChip} ${playbackSpeed === speed ? styles.speedChipActive : ''}`}
                                onClick={() => {
                                  setPlaybackSpeed(speed)
                                  if (videoRef.current) videoRef.current.playbackRate = speed
                                }}
                              >
                                {speed}x
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className={styles.videoMenuDivider} />
                        <button
                          className={styles.videoMenuItem}
                          onClick={() => {
                            videoRef.current?.requestPictureInPicture?.()
                            setSpeedMenuOpen(false)
                          }}
                        >
                          Picture in Picture
                        </button>
                      </div>
                    )}
                  </div>
                  <button className={styles.controlsBtn} onClick={handleFullscreenToggle} title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
                    {isFullscreen ? '\u2715' : '\u26F6'}
                  </button>
                </div>
              </div>
            ) : videoPath && isVideoLoading ? (
              <div className={styles.noContent}>Loading recording...</div>
            ) : videoCapture.isVideoRecording ? (
              <div className={styles.noContent}>Screen recording in progress...</div>
            ) : (
              <div className={styles.noContent}>No screen recording available.</div>
            )}
          </div>
        )}
      </div>


      <ConfirmDialog
        open={deleteDialogOpen}
        title="Delete meeting"
        message={`Delete "${data?.meeting.title}"? This will permanently remove the transcript and summary.`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => void handleConfirmDelete()}
        onCancel={() => setDeleteDialogOpen(false)}
      />
      <EnrichmentProposalDialog
        title="Update fields from this meeting"
        subtitle="New information was found in the meeting summary. Select which updates to apply."
        proposals={dialogProposals}
        fieldSelections={fieldSelections}
        onFieldToggle={(key, value) => setFieldSelections(prev => ({ ...prev, [key]: value }))}
        onSelectAll={handleSelectAll}
        onDeselectAll={handleDeselectAll}
        onApply={() => void handleApplyEnrich()}
        onSkip={handleSkipEnrich}
        isApplying={isApplyingContactUpdates}
        open={enrichDialogOpen}
      />
      {taskProposalDialogOpen && createPortal(
        <div className={styles.taskProposalOverlay}>
          <div className={styles.taskProposalDialog}>
            <h3 className={styles.taskProposalTitle}>
              Add {pendingProposedTasks.length} proposed task{pendingProposedTasks.length !== 1 ? 's' : ''}?
            </h3>
            <p className={styles.taskProposalSubtitle}>
              Select the tasks you'd like to keep from this meeting.
            </p>
            <div className={styles.taskProposalList}>
              {pendingProposedTasks.map((task) => (
                <div key={task.key} className={styles.taskProposalRow}>
                  <input
                    type="checkbox"
                    checked={proposedTaskSelections[task.key] ?? true}
                    onChange={() => {
                      setProposedTaskSelections((prev) => ({
                        ...prev,
                        [task.key]: !prev[task.key]
                      }))
                    }}
                    className={styles.taskProposalCheckbox}
                  />
                  {editingTaskKey === task.key ? (
                    <input
                      className={styles.taskProposalInput}
                      value={editingTaskDraft}
                      autoFocus
                      onChange={(e) => setEditingTaskDraft(e.target.value)}
                      onBlur={commitTaskEdit}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitTaskEdit()
                        if (e.key === 'Escape') setEditingTaskKey(null)
                      }}
                    />
                  ) : (
                    <span
                      className={styles.taskProposalText}
                      onClick={() => { setEditingTaskKey(task.key); setEditingTaskDraft(task.title) }}
                      title="Click to edit"
                    >
                      {task.title}
                    </span>
                  )}
                  <span className={styles.taskProposalBadge}>
                    {task.category === 'action_item' ? 'Action' : task.category === 'decision' ? 'Decision' : 'Follow-up'}
                  </span>
                </div>
              ))}
            </div>
            <div className={styles.taskProposalActions}>
              <button
                className={styles.taskProposalSkip}
                onClick={handleDismissProposedTasks}
              >
                Skip All
              </button>
              <button
                className={styles.taskProposalAccept}
                onClick={() => void handleAcceptProposedTasks()}
                disabled={selectedTaskCount === 0}
              >
                Add {selectedTaskCount} Task{selectedTaskCount !== 1 ? 's' : ''}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
