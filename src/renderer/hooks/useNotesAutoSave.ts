import { useState, useRef, useEffect, useCallback } from 'react'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { api } from '../api'

/**
 * Manages debounced auto-save for meeting notes and summary.
 * Extracted from MeetingDetail.tsx to keep the component focused on rendering.
 *
 * Usage:
 *   const { notesDraft, summaryDraft, handleNotesChange, handleSummaryChange, saveNotes, reset }
 *     = useNotesAutoSave(id)
 *   // After meeting loads: reset(meeting.notes, summary)
 *   // Before recording/generation: await saveNotes(notesDraft)
 */
export function useNotesAutoSave(meetingId: string | undefined) {
  const [notesDraft, setNotesDraft] = useState('')
  const [summaryDraft, setSummaryDraft] = useState('')
  const [lastEditedAt, setLastEditedAt] = useState<Date | null>(null)

  const notesDraftRef = useRef('')
  const summaryDraftRef = useRef('')
  const notesSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const summarySaveRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Track the last content that was successfully persisted to DB.
  // Used in the unmount cleanup to detect unsaved changes and flush them,
  // even when the debounce timer has already fired (notesSaveRef.current === null).
  const savedNotesRef = useRef('')
  const savedSummaryRef = useRef('')

  // Flush any unsaved changes on unmount / meetingId change
  useEffect(() => {
    return () => {
      if (notesSaveRef.current) clearTimeout(notesSaveRef.current)
      if (summarySaveRef.current) clearTimeout(summarySaveRef.current)

      if (notesDraftRef.current !== savedNotesRef.current) {
        api.invoke(IPC_CHANNELS.MEETING_SAVE_NOTES, meetingId, notesDraftRef.current)
      }
      if (summaryDraftRef.current !== savedSummaryRef.current) {
        api.invoke(IPC_CHANNELS.MEETING_SAVE_SUMMARY, meetingId, summaryDraftRef.current)
      }
    }
  }, [meetingId])

  const saveNotes = useCallback(async (text: string) => {
    if (!meetingId) return
    try {
      await api.invoke(IPC_CHANNELS.MEETING_SAVE_NOTES, meetingId, text)
      savedNotesRef.current = text
    } catch (err) {
      console.error('Failed to save notes:', err)
    }
  }, [meetingId])

  const saveSummary = useCallback(async (text: string) => {
    if (!meetingId) return
    try {
      await api.invoke(IPC_CHANNELS.MEETING_SAVE_SUMMARY, meetingId, text)
      savedSummaryRef.current = text
    } catch (err) {
      console.error('Failed to save summary:', err)
    }
  }, [meetingId])

  const handleNotesChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value
    setNotesDraft(text)
    notesDraftRef.current = text
    setLastEditedAt(new Date())
    if (notesSaveRef.current) clearTimeout(notesSaveRef.current)
    notesSaveRef.current = setTimeout(() => {
      saveNotes(text)
      notesSaveRef.current = null
    }, 500)
  }, [saveNotes])

  const handleNotesChangeText = useCallback((text: string) => {
    setNotesDraft(text)
    notesDraftRef.current = text
    setLastEditedAt(new Date())
    if (notesSaveRef.current) clearTimeout(notesSaveRef.current)
    notesSaveRef.current = setTimeout(() => {
      void saveNotes(text)
      notesSaveRef.current = null
    }, 1500)
  }, [saveNotes])

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

  /** Call after meeting data loads to seed initial draft state. */
  const reset = useCallback((notes: string | null, summary: string | null) => {
    const n = notes || ''
    const s = summary || ''
    setNotesDraft(n)
    notesDraftRef.current = n
    savedNotesRef.current = n   // mark as persisted — just loaded from DB
    setSummaryDraft(s)
    summaryDraftRef.current = s
    savedSummaryRef.current = s  // mark as persisted — just loaded from DB
    setLastEditedAt(null)
  }, [])

  /**
   * Cancel any pending debounce and immediately persist notes.
   * Call before recording start or summary generation.
   */
  const flushNotes = useCallback(async () => {
    if (notesSaveRef.current) {
      clearTimeout(notesSaveRef.current)
      notesSaveRef.current = null
    }
    await saveNotes(notesDraftRef.current)
  }, [saveNotes])

  return {
    notesDraft,
    summaryDraft,
    setSummaryDraft,
    handleNotesChange,
    handleNotesChangeText,
    handleSummaryChange,
    saveNotes,
    saveSummary,
    flushNotes,
    reset,
    lastEditedAt,
  }
}
