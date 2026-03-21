/**
 * CompanyDigestItem — a single company entry in a digest section.
 *
 * Fields:
 *   - Company name (links to company profile)
 *   - Stage chip (inline-editable → updates CRM; item stays in current section)
 *   - Company Brief: lazy-mount TipTap via DigestItemNotes (collapsed by default)
 *   - Status update ("what happened this week"): plain textarea, inline-editable
 *   - Meeting notes: lazy-mount TipTap via DigestItemNotes
 *   - [✓ Discussed] toggle
 *   - [×] remove button
 *   - ↩ carry-over badge if item.carryOver = true
 */

import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { PartnerMeetingItem } from '../../../shared/types/partner-meeting'
import type { CompanyPipelineStage } from '../../../shared/types/company'
import { DigestItemNotes } from './DigestItemNotes'
import { api } from '../../api'
import styles from './CompanyDigestItem.module.css'

const STAGE_LABELS: Record<string, string> = {
  screening: 'Screening',
  diligence: 'Diligence',
  decision: 'Decision',
  documentation: 'Docs',
  pass: 'Pass',
}

const STAGE_OPTIONS: CompanyPipelineStage[] = ['screening', 'diligence', 'decision', 'documentation', 'pass']

interface CompanyDigestItemProps {
  item: PartnerMeetingItem
  disabled?: boolean
  onUpdate: (updated: PartnerMeetingItem) => void
  onRemove: (itemId: string) => void
}

export function CompanyDigestItem({ item, disabled = false, onUpdate, onRemove }: CompanyDigestItemProps) {
  const navigate = useNavigate()
  const [stage, setStage] = useState<string | null>(null) // null = unloaded; we don't own stage state
  const [briefCollapsed, setBriefCollapsed] = useState(true)
  const [editingStatus, setEditingStatus] = useState(false)
  const [statusDraft, setStatusDraft] = useState(item.statusUpdate ?? '')

  const saveField = useCallback(async (field: Partial<Parameters<typeof api.invoke>[1]>) => {
    try {
      const updated = await api.invoke<PartnerMeetingItem>(
        IPC_CHANNELS.PARTNER_MEETING_ITEM_UPDATE,
        item.id,
        field
      )
      if (updated) onUpdate(updated)
    } catch (err) {
      console.error('[CompanyDigestItem] save failed:', err)
    }
  }, [item.id, onUpdate])

  const handleBriefSave = useCallback((content: string) => {
    saveField({ brief: content || null })
  }, [saveField])

  const handleNotesSave = useCallback((content: string) => {
    saveField({ meetingNotes: content || null })
  }, [saveField])

  const handleDiscussed = useCallback(() => {
    saveField({ isDiscussed: !item.isDiscussed })
  }, [item.isDiscussed, saveField])

  const handleStatusBlur = useCallback(() => {
    setEditingStatus(false)
    saveField({ statusUpdate: statusDraft || null })
  }, [statusDraft, saveField])

  const handleRemove = useCallback(() => {
    api.invoke(IPC_CHANNELS.PARTNER_MEETING_ITEM_DELETE, item.id)
      .then(() => onRemove(item.id))
      .catch(err => console.error('[CompanyDigestItem] remove failed:', err))
  }, [item.id, onRemove])

  return (
    <div className={`${styles.item} ${item.isDiscussed ? styles.discussed : ''}`}>
      <div className={styles.topRow}>
        <div className={styles.nameArea}>
          {item.carryOver && <span className={styles.carryBadge} title="Carried over from last week">↩</span>}
          <button
            className={styles.companyLink}
            onClick={() => navigate(`/company/${item.companyId}`)}
            title="Open company profile"
          >
            {item.companyName ?? 'Unknown Company'}
          </button>
        </div>
        <div className={styles.actions}>
          <button
            className={`${styles.discussedBtn} ${item.isDiscussed ? styles.discussedActive : ''}`}
            onClick={handleDiscussed}
            disabled={disabled}
            title={item.isDiscussed ? 'Mark as not discussed' : 'Mark as discussed'}
          >
            ✓ {item.isDiscussed ? 'Discussed' : 'Discuss'}
          </button>
          {!disabled && (
            <button className={styles.removeBtn} onClick={handleRemove} title="Remove from digest">✕</button>
          )}
        </div>
      </div>

      {/* Company brief — collapsed by default */}
      <div className={styles.section}>
        <button
          className={styles.sectionToggle}
          onClick={() => setBriefCollapsed(v => !v)}
        >
          {briefCollapsed ? '▶' : '▾'} Company Brief
        </button>
        {!briefCollapsed && (
          <DigestItemNotes
            content={item.brief}
            placeholder="Add a company brief…"
            disabled={disabled}
            onSave={handleBriefSave}
          />
        )}
      </div>

      {/* Status update */}
      <div className={styles.section}>
        <div className={styles.sectionLabel}>This week</div>
        {editingStatus && !disabled ? (
          <textarea
            className={styles.statusTextarea}
            value={statusDraft}
            autoFocus
            onChange={e => setStatusDraft(e.target.value)}
            onBlur={handleStatusBlur}
            rows={2}
          />
        ) : (
          <div
            className={`${styles.statusText} ${!disabled ? styles.clickable : ''}`}
            onClick={() => { if (!disabled) setEditingStatus(true) }}
          >
            {statusDraft || <span className={styles.placeholder}>Click to add…</span>}
          </div>
        )}
      </div>

      {/* Meeting notes */}
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
