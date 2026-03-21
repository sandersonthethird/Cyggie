/**
 * AdminDigestItem — a free-form admin/ops item in the digest.
 * Has a title (plain text, inline-editable) + meeting notes (TipTap).
 */

import { useCallback, useState } from 'react'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { PartnerMeetingItem } from '../../../shared/types/partner-meeting'
import { DigestItemNotes } from './DigestItemNotes'
import { api } from '../../api'
import styles from './AdminDigestItem.module.css'

interface AdminDigestItemProps {
  item: PartnerMeetingItem
  disabled?: boolean
  onUpdate: (updated: PartnerMeetingItem) => void
  onRemove: (itemId: string) => void
}

export function AdminDigestItem({ item, disabled = false, onUpdate, onRemove }: AdminDigestItemProps) {
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState(item.title ?? '')

  const saveField = useCallback(async (field: Record<string, unknown>) => {
    try {
      const updated = await api.invoke<PartnerMeetingItem>(
        IPC_CHANNELS.PARTNER_MEETING_ITEM_UPDATE,
        item.id,
        field
      )
      if (updated) onUpdate(updated)
    } catch (err) {
      console.error('[AdminDigestItem] save failed:', err)
    }
  }, [item.id, onUpdate])

  const handleTitleBlur = useCallback(() => {
    setEditingTitle(false)
    saveField({ title: titleDraft || null })
  }, [titleDraft, saveField])

  const handleNotesSave = useCallback((content: string) => {
    saveField({ meetingNotes: content || null })
  }, [saveField])

  const handleRemove = useCallback(() => {
    api.invoke(IPC_CHANNELS.PARTNER_MEETING_ITEM_DELETE, item.id)
      .then(() => onRemove(item.id))
      .catch(err => console.error('[AdminDigestItem] remove failed:', err))
  }, [item.id, onRemove])

  const handleDiscussed = useCallback(() => {
    saveField({ isDiscussed: !item.isDiscussed })
  }, [item.isDiscussed, saveField])

  return (
    <div className={`${styles.item} ${item.isDiscussed ? styles.discussed : ''}`}>
      <div className={styles.topRow}>
        {editingTitle && !disabled ? (
          <input
            className={styles.titleInput}
            value={titleDraft}
            autoFocus
            onChange={e => setTitleDraft(e.target.value)}
            onBlur={handleTitleBlur}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
            placeholder="Admin item title…"
          />
        ) : (
          <div
            className={`${styles.title} ${!disabled ? styles.clickable : ''}`}
            onClick={() => { if (!disabled) setEditingTitle(true) }}
          >
            {titleDraft || <span className={styles.placeholder}>Admin item…</span>}
          </div>
        )}
        <div className={styles.actions}>
          <button
            className={`${styles.discussedBtn} ${item.isDiscussed ? styles.discussedActive : ''}`}
            onClick={handleDiscussed}
            disabled={disabled}
          >
            ✓ {item.isDiscussed ? 'Discussed' : 'Discuss'}
          </button>
          {!disabled && (
            <button className={styles.removeBtn} onClick={handleRemove} title="Remove">✕</button>
          )}
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionLabel}>Meeting notes</div>
        <DigestItemNotes
          content={item.meetingNotes}
          placeholder="Add meeting notes…"
          disabled={disabled}
          onSave={handleNotesSave}
        />
      </div>
    </div>
  )
}
