import { useCallback, useEffect, useRef, useState } from 'react'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { api } from '../api'

type EntityType = 'company' | 'contact'

const MAX_USER_NOTE_CHARS = 2000

interface UserNoteConfig {
  entityType: EntityType
  entityId: string
  /** Current saved user-note value from the entity record. */
  savedUserNote: string | null
  /** Optimistic-update callback so the parent panel can reflect the change immediately. */
  onUpdate: (updates: { keyTakeawaysUserNote: string | null }) => void
}

export interface UserNoteState {
  userNote: string
  editing: boolean
  error: string | null
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  startEditing: () => void
  cancelEditing: () => void
  save: () => Promise<void>
}

/**
 * Sibling of useTakeaways. Owns the user-authored note that pins to the top
 * of the Key Takeaways card. Independent of AI generation — Generate never
 * touches this field. Mirrors the save semantics of useTakeaways.save():
 * trim → cap at 2000 chars → optimistic state + onUpdate → IPC invoke;
 * on error, re-open the editor with the unsaved text retained.
 */
export function useUserNote(config: UserNoteConfig): UserNoteState {
  const { entityType, entityId, savedUserNote, onUpdate } = config

  const [userNote, setUserNote] = useState<string>(savedUserNote ?? '')
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const updateChannel = entityType === 'company'
    ? IPC_CHANNELS.COMPANY_UPDATE
    : IPC_CHANNELS.CONTACT_UPDATE

  // Sync local state when the underlying entity changes (panel navigation)
  // or when an optimistic update has been applied upstream.
  useEffect(() => {
    setUserNote(savedUserNote ?? '')
    setEditing(false)
    setError(null)
  }, [entityId, savedUserNote])

  const startEditing = useCallback(() => {
    setError(null)
    setEditing(true)
  }, [])

  const cancelEditing = useCallback(() => {
    setError(null)
    setEditing(false)
  }, [])

  const save = useCallback(async () => {
    const raw = (textareaRef.current?.value ?? userNote).trim()
    const capped = raw.length > MAX_USER_NOTE_CHARS ? raw.slice(0, MAX_USER_NOTE_CHARS) : raw
    const next = capped || null

    // Optimistic update first so the bullets render immediately.
    setEditing(false)
    setUserNote(capped)
    onUpdate({ keyTakeawaysUserNote: next })

    try {
      await api.invoke(updateChannel, entityId, { keyTakeawaysUserNote: next })
    } catch (err) {
      console.error('[useUserNote] Save failed:', err)
      setError(err instanceof Error ? err.message : 'Save failed — please try again')
      setEditing(true) // re-open so the user doesn't lose their text
    }
  }, [entityId, onUpdate, updateChannel, userNote])

  return {
    userNote,
    editing,
    error,
    textareaRef,
    startEditing,
    cancelEditing,
    save,
  }
}
