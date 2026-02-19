import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { useRecordingStore } from '../stores/recording.store'
import { useSharedAudioCapture, useSharedVideoCapture } from '../contexts/AudioCaptureContext'
import { useFindInPage } from '../hooks/useFindInPage'
import FindBar from '../components/common/FindBar'
import ChatInterface from '../components/chat/ChatInterface'
import { useChatStore } from '../stores/chat.store'
import type { Meeting, CompanySuggestion } from '../../shared/types/meeting'
import type { MeetingTemplate } from '../../shared/types/template'
import type { DriveShareResponse } from '../../shared/types/drive'
import type { WebShareResponse } from '../../shared/types/web-share'
import ReactMarkdown from 'react-markdown'
import styles from './MeetingDetail.module.css'

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

interface MeetingData {
  meeting: Meeting
  transcript: string | null
  summary: string | null
}

export default function MeetingDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
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
  const [isSavingSpeakers, setIsSavingSpeakers] = useState(false)
  const speakerInputRef = useRef<HTMLInputElement>(null)
  const [notesDraft, setNotesDraft] = useState('')
  const notesSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const notesDraftRef = useRef('')
  const [summaryDraft, setSummaryDraft] = useState('')
  const [editingSummary, setEditingSummary] = useState(false)
  const summarySaveRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const summaryDraftRef = useRef('')
  const summaryTextareaRef = useRef<HTMLTextAreaElement>(null)
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
  const audioCapture = useSharedAudioCapture()
  const videoCapture = useSharedVideoCapture()
  const prevRecordingRef = useRef(false)
  const [videoPath, setVideoPath] = useState<string | null>(null)
  const transcriptEndRef = useRef<HTMLDivElement>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [shareMenuOpen, setShareMenuOpen] = useState(false)
  const shareRef = useRef<HTMLDivElement>(null)
  const [showNotes, setShowNotes] = useState(true)
  const [companySuggestions, setCompanySuggestions] = useState<CompanySuggestion[]>([])

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

  const loadMeeting = useCallback(async () => {
    if (!id) return
    const result = await window.api.invoke<MeetingData | null>(IPC_CHANNELS.MEETING_GET, id)
    if (!result) {
      navigate('/')
      return
    }
    setData(result)
    setLocalSpeakerMap(result.meeting.speakerMap)
    setNotesDraft(result.meeting.notes || '')
    notesDraftRef.current = result.meeting.notes || ''
    setSummaryDraft(result.summary || '')
    summaryDraftRef.current = result.summary || ''
    if (result.summary) setShowNotes(false)

    // Load video path if recording exists
    if (result.meeting.recordingPath) {
      window.api.invoke<string | null>(IPC_CHANNELS.VIDEO_GET_PATH, id).then(setVideoPath).catch(() => {})
    } else {
      setVideoPath(null)
    }

    // Fetch company suggestions (with logos)
    window.api.invoke<CompanySuggestion[]>(IPC_CHANNELS.COMPANY_GET_SUGGESTIONS, id).then(setCompanySuggestions).catch(() => {})

    // Hydrate chat store from persisted messages (only if store is empty for this meeting)
    if (result.meeting.chatMessages && result.meeting.chatMessages.length > 0) {
      const existing = useChatStore.getState().conversations[id]
      if (!existing || existing.messages.length === 0) {
        for (const msg of result.meeting.chatMessages) {
          useChatStore.getState().addMessage(id, msg)
        }
      }
    }
  }, [id, navigate])

  useEffect(() => {
    loadMeeting()
  }, [loadMeeting])

  useEffect(() => {
    window.api.invoke<MeetingTemplate[]>(IPC_CHANNELS.TEMPLATE_LIST).then((result) => {
      setTemplates(result)
      if (result.length > 0) setSelectedTemplateId(result[0].id)
    })
  }, [])

  // Listen for streaming summary progress
  useEffect(() => {
    if (!isGenerating) return
    const unsub = window.api.on(IPC_CHANNELS.SUMMARY_PROGRESS, (chunk: unknown) => {
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
    const unsub = window.api.on(IPC_CHANNELS.SUMMARY_PHASE, (phase: unknown) => {
      setSummaryPhase(String(phase))
    })
    return unsub
  }, [isGenerating])

  // Debounced notes auto-save
  const saveNotes = useCallback(async (text: string) => {
    if (!id) return
    try {
      await window.api.invoke(IPC_CHANNELS.MEETING_SAVE_NOTES, id, text)
    } catch (err) {
      console.error('Failed to save notes:', err)
    }
  }, [id])

  const handleNotesChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value
    setNotesDraft(text)
    notesDraftRef.current = text
    if (notesSaveRef.current) clearTimeout(notesSaveRef.current)
    notesSaveRef.current = setTimeout(() => {
      saveNotes(text)
      notesSaveRef.current = null
    }, 500)
  }, [saveNotes])

  // Debounced summary auto-save
  const saveSummary = useCallback(async (text: string) => {
    if (!id) return
    try {
      await window.api.invoke(IPC_CHANNELS.MEETING_SAVE_SUMMARY, id, text)
    } catch (err) {
      console.error('Failed to save summary:', err)
    }
  }, [id])

  const handleSummaryChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value
    setSummaryDraft(text)
    summaryDraftRef.current = text
    if (summarySaveRef.current) clearTimeout(summarySaveRef.current)
    summarySaveRef.current = setTimeout(() => {
      saveSummary(text)
      summarySaveRef.current = null
    }, 500)
  }, [saveSummary])

  // Flush any pending notes/summary saves on unmount
  useEffect(() => {
    return () => {
      if (notesSaveRef.current) {
        clearTimeout(notesSaveRef.current)
        window.api.invoke(IPC_CHANNELS.MEETING_SAVE_NOTES, id, notesDraftRef.current)
      }
      if (summarySaveRef.current) {
        clearTimeout(summarySaveRef.current)
        window.api.invoke(IPC_CHANNELS.MEETING_SAVE_SUMMARY, id, summaryDraftRef.current)
      }
    }
  }, [id])

  const handleStartRecording = useCallback(async () => {
    if (!data || isRecording) return
    // Save any pending notes first
    if (notesSaveRef.current) {
      clearTimeout(notesSaveRef.current)
      await saveNotes(notesDraft)
    }
    try {
      const result = await window.api.invoke<{ meetingId: string }>(
        IPC_CHANNELS.RECORDING_START,
        data.meeting.title,
        data.meeting.calendarEventId || undefined
      )
      startRecording(result.meetingId)
      // Navigate to the recording meeting if it's different from the current one
      if (result.meetingId !== id) {
        navigate(`/meeting/${result.meetingId}`)
      }
    } catch (err) {
      console.error('Failed to start recording:', err)
    }
  }, [data, isRecording, notesDraft, saveNotes, startRecording, id, navigate])

  const handleContinueRecording = useCallback(async () => {
    if (!data || isRecording) return
    // Save any pending notes first
    if (notesSaveRef.current) {
      clearTimeout(notesSaveRef.current)
      await saveNotes(notesDraft)
    }
    try {
      const result = await window.api.invoke<{ meetingId: string }>(
        IPC_CHANNELS.RECORDING_START,
        undefined,
        undefined,
        data.meeting.id
      )
      startRecording(result.meetingId)
    } catch (err) {
      console.error('Failed to continue recording:', err)
    }
  }, [data, isRecording, notesDraft, saveNotes, startRecording])

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

  const handleStop = useCallback(async () => {
    try {
      if (videoCapture.isVideoRecording) {
        await videoCapture.stop()
      }
      audioCapture.stop()
      await window.api.invoke(IPC_CHANNELS.RECORDING_STOP)
      stopRecording()
    } catch (err) {
      setRecordingError(String(err))
    }
  }, [stopRecording, setRecordingError, audioCapture, videoCapture])

  const handlePause = useCallback(async () => {
    try {
      audioCapture.pause()
      videoCapture.pause()
      await window.api.invoke(IPC_CHANNELS.RECORDING_PAUSE)
      pauseRecording()
    } catch (err) {
      setRecordingError(String(err))
    }
  }, [pauseRecording, setRecordingError, audioCapture, videoCapture])

  const handleResume = useCallback(async () => {
    try {
      audioCapture.resume()
      videoCapture.resume()
      await window.api.invoke(IPC_CHANNELS.RECORDING_RESUME)
      resumeRecording()
    } catch (err) {
      setRecordingError(String(err))
    }
  }, [resumeRecording, setRecordingError, audioCapture, videoCapture])

  const handleDelete = useCallback(async () => {
    if (!id) return
    const confirmed = window.confirm(
      `Delete "${data?.meeting.title}"? This will permanently remove the transcript and summary.`
    )
    if (!confirmed) return
    await window.api.invoke(IPC_CHANNELS.MEETING_DELETE, id)
    navigate('/')
  }, [id, data, navigate])

  const handleToggleVideo = useCallback(async () => {
    try {
      if (videoCapture.isVideoRecording) {
        await videoCapture.stop()
        // Reload meeting to pick up the new recordingPath
        loadMeeting()
      } else if (recordingMeetingId) {
        const displayStream = audioCapture.getDisplayStream()
        const mixedAudio = audioCapture.getMixedAudioStream()
        await videoCapture.start(recordingMeetingId, displayStream, mixedAudio)
      }
    } catch (err) {
      console.error('[MeetingDetail] Video toggle failed:', err)
    }
  }, [videoCapture, audioCapture, recordingMeetingId, loadMeeting])

  const handleStopEnhance = useCallback(() => {
    window.api.invoke(IPC_CHANNELS.SUMMARY_ABORT)
  }, [])

  const handleGenerateSummary = useCallback(async () => {
    if (!id || !selectedTemplateId || isGenerating) return
    // Save any pending notes first
    if (notesSaveRef.current) {
      clearTimeout(notesSaveRef.current)
      await saveNotes(notesDraft)
    }
    setIsGenerating(true)
    setStreamedSummary('')
    setActiveTab('notes')

    try {
      const summary = await window.api.invoke<string>(
        IPC_CHANNELS.SUMMARY_GENERATE,
        id,
        selectedTemplateId
      )
      setData((prev) =>
        prev ? { ...prev, summary, meeting: { ...prev.meeting, status: 'summarized' } } : prev
      )
      setSummaryDraft(summary)
      setStreamedSummary('')
      setShowNotes(false)
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
  }, [id, selectedTemplateId, isGenerating, notesDraft, saveNotes])

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
      await window.api.invoke(IPC_CHANNELS.MEETING_RENAME_TITLE, id, trimmed)
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
      await window.api.invoke(IPC_CHANNELS.MEETING_RENAME_SPEAKERS, id, updated)
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

  const handleCopyDriveLink = useCallback(async () => {
    if (!id) return
    setShareMenuOpen(false)
    try {
      const result = await window.api.invoke<DriveShareResponse>(
        IPC_CHANNELS.DRIVE_GET_SHARE_LINK,
        id
      )
      if (result.success) {
        await navigator.clipboard.writeText(result.url)
        alert('Drive link copied to clipboard.')
      } else {
        alert(result.message)
      }
    } catch (err) {
      console.error('Failed to get Drive link:', err)
      alert('Failed to get shareable link.')
    }
  }, [id])

  const handleCopyText = useCallback(async () => {
    setShareMenuOpen(false)
    const text = activeTab === 'transcript' ? data?.transcript : summaryDraft
    if (!text) {
      alert('No content to copy.')
      return
    }
    try {
      await navigator.clipboard.writeText(text)
      alert('Copied to clipboard.')
    } catch (err) {
      console.error('Failed to copy text:', err)
      alert('Failed to copy to clipboard.')
    }
  }, [activeTab, data, summaryDraft])

  const handleWebShare = useCallback(async () => {
    if (!id) return
    setShareMenuOpen(false)
    try {
      const result = await window.api.invoke<WebShareResponse>(
        IPC_CHANNELS.WEB_SHARE_CREATE,
        id
      )
      if (result.success) {
        await navigator.clipboard.writeText(result.url)
        alert(`Web share link copied to clipboard:\n${result.url}`)
      } else {
        alert(result.message)
      }
    } catch (err) {
      console.error('Failed to create web share:', err)
      alert('Failed to create web share.')
    }
  }, [id])

  // Only show recording UI if THIS meeting is the one being recorded
  const isThisMeetingRecording = isRecording && recordingMeetingId === id

  const displaySummary = isGenerating ? streamedSummary : summaryDraft
  const hasSummary = isGenerating ? !!streamedSummary : !!summaryDraft
  const searchableText = activeTab === 'notes'
    ? (displaySummary || '')
    : (data?.transcript || '')

  const {
    query: findQuery,
    setQuery: setFindQuery,
    matchCount,
    activeMatchIndex,
    goToNext,
    goToPrev,
    highlightedContent
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
        <button className={styles.back} onClick={() => navigate('/')}>
          &larr; Back to Meetings
        </button>

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
              {!isRecording && (meeting.status === 'transcribed' || meeting.status === 'summarized') && (
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
            <span>{new Date(meeting.date).toLocaleString()}</span>
            {meeting.durationSeconds && (
              <span>{Math.round(meeting.durationSeconds / 60)} min</span>
            )}
            {speakerEntries.length > 0 && (
              <div className={styles.speakers}>
                {speakerEntries.map(([idx, name]) => {
                  const index = Number(idx)
                  if (editingSpeaker === index) {
                    return (
                      <input
                        key={idx}
                        ref={speakerInputRef}
                        className={styles.speakerInput}
                        value={speakerDraft}
                        onChange={(e) => setSpeakerDraft(e.target.value)}
                        onBlur={handleSpeakerSave}
                        onKeyDown={handleSpeakerKeyDown}
                        disabled={isSavingSpeakers}
                      />
                    )
                  }
                  return (
                    <button
                      key={idx}
                      className={styles.speakerChip}
                      onClick={() => handleSpeakerClick(index)}
                      title="Click to rename"
                    >
                      {name}
                    </button>
                  )
                })}
              </div>
            )}
            {companySuggestions.length > 0 && (
              <div className={styles.companies}>
                {companySuggestions.map((c) => (
                  <span key={c.domain || c.name} className={styles.companyChip}>
                    {c.domain && (
                      <img
                        src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(c.domain)}&sz=32`}
                        alt=""
                        className={styles.companyChipLogo}
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                      />
                    )}
                    {c.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {isThisMeetingRecording && (
          <div className={styles.recordingBar}>
            <div className={styles.recordingStatus}>
              <span className={`${styles.recordingDot} ${isPaused ? styles.paused : ''}`} />
              <span className={styles.recordingTimer}>
                {formatTime(duration)}
                {isPaused && <span className={styles.pausedLabel}> (Paused)</span>}
              </span>
            </div>
            <div className={styles.recordingControls}>
              <button
                className={`${styles.videoToggle} ${videoCapture.isVideoRecording ? styles.videoActive : ''}`}
                onClick={handleToggleVideo}
                title={videoCapture.isVideoRecording ? 'Stop screen recording' : 'Record screen'}
              >
                {videoCapture.isVideoRecording ? '\u25A0' : 'Record Screen'}
              </button>
              {isPaused ? (
                <button className={styles.resumeBtn} onClick={handleResume}>
                  Resume
                </button>
              ) : (
                <button className={styles.pauseBtn} onClick={handlePause}>
                  Pause
                </button>
              )}
              <button className={styles.stopBtn} onClick={handleStop}>
                Stop
              </button>
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
            disabled={!meeting.recordingPath && !videoCapture.isVideoRecording}
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
              <textarea
                className={styles.notesTextarea}
                value={notesDraft}
                onChange={handleNotesChange}
                placeholder="Add your meeting notes here..."
                rows={6}
              />
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

            {hasSummary && (
              <>
                <div className={styles.summaryDivider}>
                  <span>Summary</span>
                </div>
                {isGenerating ? (
                  <>
                    {summaryPhase && (
                      <div className={styles.summaryPhase}>
                        {summaryPhase === 'generating' ? 'Generating draft...' : 'Refining...'}
                      </div>
                    )}
                    <div className={styles.markdown}>
                      <ReactMarkdown>{streamedSummary}</ReactMarkdown>
                    </div>
                  </>
                ) : findOpen && findQuery ? (
                  <div className={styles.markdown}>
                    {highlightedContent}
                  </div>
                ) : editingSummary ? (
                  <textarea
                    ref={summaryTextareaRef}
                    className={styles.summaryTextarea}
                    value={summaryDraft}
                    onChange={handleSummaryChange}
                    onBlur={() => setEditingSummary(false)}
                    placeholder="Summary content..."
                  />
                ) : (
                  <div
                    className={styles.markdown}
                    onClick={() => {
                      setEditingSummary(true)
                      setTimeout(() => summaryTextareaRef.current?.focus(), 0)
                    }}
                    title="Click to edit"
                  >
                    <ReactMarkdown>{summaryDraft}</ReactMarkdown>
                  </div>
                )}
              </>
            )}

            {!displaySummary && !hasTranscript && !notesDraft && (
              <div className={styles.noContent}>
                Jot down notes before or during your meeting. After recording, click "Enhance" to generate a summary.
              </div>
            )}

            {hasTranscript && (
              <>
                <div className={styles.summaryDivider}>
                  <span>Ask AI</span>
                </div>
                <ChatInterface meetingId={meeting.id} />
              </>
            )}
          </div>
        )}
        {activeTab === 'transcript' && (
          <div className={styles.transcriptTab}>
            {transcript && (
              <div className={styles.markdown}>
                {findOpen && findQuery ? highlightedContent : transcript}
              </div>
            )}
            {isThisMeetingRecording && (
              <div className={styles.liveTranscript}>
                {liveTranscript.length === 0 && !interimSegment && !transcript && (
                  <p className={styles.noContent}>Waiting for speech...</p>
                )}
                {liveTranscript.map((segment, i) => (
                  <div key={i} className={styles.liveSegment}>
                    <span className={styles.liveSpeaker}>Speaker {segment.speaker + 1}</span>
                    <span>{segment.text}</span>
                  </div>
                ))}
                {interimSegment && (
                  <div className={`${styles.liveSegment} ${styles.interim}`}>
                    <span className={styles.liveSpeaker}>Speaker {interimSegment.speaker + 1}</span>
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
            {videoPath ? (
              <video
                className={styles.videoPlayer}
                src={videoPath}
                controls
                preload="metadata"
              />
            ) : videoCapture.isVideoRecording ? (
              <div className={styles.noContent}>Screen recording in progress...</div>
            ) : (
              <div className={styles.noContent}>No screen recording available.</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
