import { useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import { PolymorphicEntitySearch, type PolymorphicEntity } from '../crm/PolymorphicEntitySearch'
import type { AttachedContextEntity } from '../../../shared/types/chat'
import styles from './ContextChipRow.module.css'

interface ResolvedAttachedEntity extends AttachedContextEntity {
  available: boolean
}

interface ContextChipRowProps {
  /** The persisted attached-entity list driving the chips + chat context. */
  attachedEntities: AttachedContextEntity[]
  /** Whether the "+ Add context" picker is available (needs an open session). */
  canAttach: boolean
  onAddEntity: (entity: AttachedContextEntity) => void
  onRemoveEntity: (entity: AttachedContextEntity) => void
}

/**
 * Row of removable context chips above the composer + a persistent
 * "+ Add context" button. Replaces the single ContextChip — the user can now
 * attach the full context of several companies/contacts to one chat and
 * remove/re-add them (the picker is also the "restore" path after removing).
 *
 *   [🏢 Acme ×] [👤 Jane Doe ×] [+ Add context]
 *
 * Chips whose entity no longer resolves (deleted) render greyed + struck —
 * the chat context builder skips them server-side (see queryEntities).
 */
export function ContextChipRow({ attachedEntities, canAttach, onAddEntity, onRemoveEntity }: ContextChipRowProps) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [available, setAvailable] = useState<Record<string, boolean>>({})
  const wrapRef = useRef<HTMLDivElement>(null)

  // Resolve availability (and refresh labels) whenever the set changes.
  useEffect(() => {
    if (attachedEntities.length === 0) {
      setAvailable({})
      return
    }
    let cancelled = false
    void api
      .invoke<ResolvedAttachedEntity[]>(IPC_CHANNELS.CHAT_RESOLVE_ATTACHED_ENTITIES, attachedEntities)
      .then((resolved) => {
        if (cancelled) return
        const next: Record<string, boolean> = {}
        for (const r of resolved) next[`${r.type}:${r.id}`] = r.available
        setAvailable(next)
      })
      .catch((err) => {
        // Fail open: if resolution fails, treat all as available (chat still works).
        console.warn('[context-chip-row] resolve failed', err)
      })
    return () => {
      cancelled = true
    }
  }, [attachedEntities])

  // Close the picker on outside click.
  useEffect(() => {
    if (!pickerOpen) return
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setPickerOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [pickerOpen])

  function handlePick(entity: PolymorphicEntity) {
    onAddEntity({ type: entity.type, id: entity.id, label: entity.name })
    setPickerOpen(false)
  }

  if (!canAttach && attachedEntities.length === 0) return null

  return (
    <div className={styles.wrap} ref={wrapRef}>
      {attachedEntities.length > 0 && <span className={styles.label}>Context:</span>}
      {attachedEntities.map((e) => {
        const key = `${e.type}:${e.id}`
        const isAvailable = available[key] !== false
        const initial = e.label.charAt(0).toUpperCase() || '?'
        const tone = e.type === 'company' ? styles.toneCompany : styles.toneContact
        return (
          <span
            key={key}
            className={`${styles.chip} ${isAvailable ? '' : styles.unavailable}`}
            title={isAvailable ? e.label : `${e.label} (no longer available — excluded from context)`}
          >
            <span className={`${styles.chipIcon} ${tone}`}>{initial}</span>
            <span className={styles.chipName}>{e.label}</span>
            <button
              type="button"
              className={styles.remove}
              onClick={() => onRemoveEntity(e)}
              aria-label={`Remove ${e.label}`}
            >
              ×
            </button>
          </span>
        )
      })}

      {canAttach && (
        <div className={styles.addWrap}>
          <button
            type="button"
            className={styles.addBtn}
            onClick={() => setPickerOpen((v) => !v)}
            aria-haspopup="dialog"
            aria-expanded={pickerOpen}
          >
            + Add context
          </button>
          {pickerOpen && (
            <div className={styles.pickerPopover}>
              <PolymorphicEntitySearch onSelect={handlePick} onClose={() => setPickerOpen(false)} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
