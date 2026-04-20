import { useCallback, useEffect, useRef, useState } from 'react'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { api } from '../api'

type EntityType = 'company' | 'contact'

interface TakeawaysConfig {
  entityType: EntityType
  entityId: string
  /** Current saved takeaways from the entity record */
  savedText: string | null
  /** Callback to optimistically update the parent state */
  onUpdate: (updates: { keyTakeaways: string | null }) => void
  /** Whether there's new data since last generation (for staleness detection) */
  hasNewDataSince?: (generatedAt: string) => boolean
}

interface TakeawaysState {
  text: string
  editing: boolean
  generating: boolean
  streaming: string
  error: string | null
  hasNewData: boolean
  generatedAt: string | null
  /** Show "Generate" button (no saved text, not generating, not editing) */
  showGenerate: boolean
  /** Show "Update" button (has saved text, new data available) */
  showUpdate: boolean
  generate: () => void
  save: () => void
  startEditing: () => void
  cancelEditing: () => void
  setEditText: (text: string) => void
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
}

/**
 * Shared hook for Key Takeaways generation and management.
 * Works for both company and contact entities.
 *
 * Data flow:
 *   generate() → IPC invoke → LLM streaming → DB persist → state update
 *                    ↑
 *                    └── webContents.send(PROGRESS) chunks → streaming state
 *
 * Staleness:
 *   generatedAt stored in localStorage → compared against new data timestamps
 *
 * Error guards:
 *   - Empty LLM response → throws 'Generation produced no content'
 *   - localStorage quota → caught silently
 *   - Navigate away → stale ref check prevents state update
 */
export function useTakeaways(config: TakeawaysConfig): TakeawaysState {
  const { entityType, entityId, savedText, onUpdate, hasNewDataSince } = config

  const [text, setText] = useState<string>(savedText ?? '')
  const [editing, setEditing] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [streaming, setStreaming] = useState('')
  const [error, setError] = useState<string | null>(null)

  const generatedAtKey = `cyggie:kt-generated-at:${entityId}`
  const [generatedAt, setGeneratedAt] = useState<string | null>(
    () => localStorage.getItem(generatedAtKey)
  )

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const generatingForIdRef = useRef<string | null>(null)
  const startTimeRef = useRef<number>(0)

  // Determine channels based on entity type
  const generateChannel = entityType === 'company'
    ? IPC_CHANNELS.COMPANY_KEY_TAKEAWAYS_GENERATE
    : IPC_CHANNELS.CONTACT_KEY_TAKEAWAYS_GENERATE
  const progressChannel = entityType === 'company'
    ? IPC_CHANNELS.COMPANY_KEY_TAKEAWAYS_PROGRESS
    : IPC_CHANNELS.CONTACT_KEY_TAKEAWAYS_PROGRESS
  const updateChannel = entityType === 'company'
    ? IPC_CHANNELS.COMPANY_UPDATE
    : IPC_CHANNELS.CONTACT_UPDATE

  // Staleness detection
  const hasNewData = generatedAt != null && hasNewDataSince != null
    ? hasNewDataSince(generatedAt)
    : false

  const showGenerate = !text && !generating && !editing
  const showUpdate = !!text && !generating && !editing && hasNewData

  // Sync text when entity changes (e.g. navigating to different company/contact)
  useEffect(() => {
    setText(savedText ?? '')
    setEditing(false)
  }, [entityId, savedText])

  // Progress listener — receives streaming chunks from backend
  useEffect(() => {
    return api.on(progressChannel, (payload) => {
      if (payload === null) return // completion sentinel
      const data = payload as { contactId?: string; companyId?: string; chunk: string }
      const payloadId = data.contactId ?? data.companyId
      if (payloadId !== generatingForIdRef.current) return // stale
      setStreaming((prev) => prev + data.chunk)
    })
  }, [progressChannel])

  const generate = useCallback(async () => {
    const thisId = entityId
    generatingForIdRef.current = thisId
    startTimeRef.current = Date.now()
    setGenerating(true)
    setStreaming('')
    setError(null)

    try {
      const result = await api.invoke<{ success: boolean; keyTakeaways: string }>(
        generateChannel, thisId
      )
      if (generatingForIdRef.current !== thisId) return // stale

      // Guard: empty LLM response
      if (!result.keyTakeaways?.trim()) {
        throw new Error('Generation produced no content — try again')
      }

      const elapsed = Date.now() - startTimeRef.current
      console.log(`[KT] Generated ${result.keyTakeaways.length} chars in ${elapsed}ms for ${entityType} ${thisId}`)

      setText(result.keyTakeaways)
      onUpdate({ keyTakeaways: result.keyTakeaways })

      const now = new Date().toISOString()
      try {
        localStorage.setItem(generatedAtKey, now)
      } catch {
        // QuotaExceededError — silently continue
      }
      setGeneratedAt(now)
    } catch (err) {
      if (generatingForIdRef.current !== thisId) return // stale / aborted
      const msg = err instanceof Error ? err.message : String(err)
      if (/abort/i.test(msg)) return // silently ignore cancelled streams
      setError(msg || 'Generation failed — try again')
    } finally {
      if (generatingForIdRef.current === thisId) {
        setStreaming('')
        setGenerating(false)
        generatingForIdRef.current = null
      }
    }
  }, [entityId, entityType, generateChannel, generatedAtKey, onUpdate])

  const save = useCallback(async () => {
    const trimmed = (textareaRef.current?.value ?? text).trim()
    setEditing(false)
    setText(trimmed)
    onUpdate({ keyTakeaways: trimmed || null })
    try {
      await api.invoke(updateChannel, entityId, { keyTakeaways: trimmed || null })
    } catch (err) {
      console.error('[KT] Save failed:', err)
      setError('Save failed — please try again')
      setEditing(true) // re-open edit so user doesn't lose their text
    }
  }, [text, entityId, updateChannel, onUpdate])

  const startEditing = useCallback(() => setEditing(true), [])
  const cancelEditing = useCallback(() => setEditing(false), [])
  const setEditText = useCallback((t: string) => setText(t), [])

  return {
    text,
    editing,
    generating,
    streaming,
    error,
    hasNewData,
    generatedAt,
    showGenerate,
    showUpdate,
    generate,
    save,
    startEditing,
    cancelEditing,
    setEditText,
    textareaRef,
  }
}
