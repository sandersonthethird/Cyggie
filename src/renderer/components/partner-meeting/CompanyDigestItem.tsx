/**
 * CompanyDigestItem — a single company entry in a digest section.
 *
 * Fields:
 *   - [▾/▶] collapse toggle (new_deals, existing_deals, portfolio_updates only)
 *   - Company name (links to company profile)
 *   - Stage chip (inline-editable → updates CRM; item stays in current section)
 *   - Company Brief: lazy-mount TipTap via DigestItemNotes (collapsed by default)
 *   - Status update ("what happened this week"): plain textarea, inline-editable
 *   - Meeting notes: lazy-mount TipTap via DigestItemNotes
 *   - [✓ Discussed] toggle
 *   - [×] remove button
 *   - ↩ carry-over badge if item.carryOver = true
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { PartnerMeetingItem } from '../../../shared/types/partner-meeting'
import type { CompanyPipelineStage } from '../../../shared/types/company'
import { DigestItemNotes } from './DigestItemNotes'
import { api } from '../../api'
import { withOptimisticUpdate } from '../../utils/withOptimisticUpdate'
import styles from './CompanyDigestItem.module.css'

const STAGE_LABELS: Record<string, string> = {
  screening: 'Screening',
  diligence: 'Diligence',
  decision: 'Decision',
  documentation: 'Docs',
  pass: 'Pass',
}

const STAGE_OPTIONS: CompanyPipelineStage[] = ['screening', 'diligence', 'decision', 'documentation', 'pass']

// keep in sync with chipScreening/chipDiligence/etc. in CompanyPropertiesPanel.module.css
const STAGE_COLORS: Record<string, { bg: string; color: string }> = {
  screening:     { bg: '#dbeafe', color: '#1e40af' },
  diligence:     { bg: '#ede9fe', color: '#4c1d95' },
  decision:      { bg: '#ffedd5', color: '#9a3412' },
  documentation: { bg: '#ccfbf1', color: '#0f766e' },
  pass:          { bg: '#e5e7eb', color: '#374151' },
}

interface CompanyDigestItemProps {
  item: PartnerMeetingItem
  disabled?: boolean
  onUpdate: (updated: PartnerMeetingItem) => void
  onRemove: (itemId: string) => void
}

export function CompanyDigestItem({ item, disabled = false, onUpdate, onRemove }: CompanyDigestItemProps) {
  const navigate = useNavigate()
  const [stage, setStage] = useState<string | null>(item.pipelineStage)
  const [stageOpen, setStageOpen] = useState(false)
  const stageRef = useRef<HTMLDivElement>(null)
  const [itemCollapsed, setItemCollapsed] = useState(false)
  const [generatingBrief, setGeneratingBrief] = useState(false)
  const [briefGenError, setBriefGenError] = useState(false)

  const saveField = useCallback(async (field: Partial<Parameters<typeof api.invoke>[1]>) => {
    try {
      await withOptimisticUpdate(
        () => onUpdate({ ...item, ...field } as PartnerMeetingItem),
        () => api.invoke<PartnerMeetingItem>(IPC_CHANNELS.PARTNER_MEETING_ITEM_UPDATE, item.id, field),
        () => onUpdate(item),
        (updated) => { if (updated) onUpdate(updated) },
      )
    } catch (err) {
      console.error('[CompanyDigestItem] save failed:', err)
    }
  }, [item, onUpdate])

  const handleBriefSave = useCallback((content: string) => {
    saveField({ brief: content || null })
  }, [saveField])

  const handleNotesSave = useCallback((content: string) => {
    saveField({ meetingNotes: content || null })
  }, [saveField])

  const handleDiscussed = useCallback(() => {
    saveField({ isDiscussed: !item.isDiscussed })
  }, [item.isDiscussed, saveField])

  const handleRemove = useCallback(() => {
    api.invoke(IPC_CHANNELS.PARTNER_MEETING_ITEM_DELETE, item.id)
      .then(() => onRemove(item.id))
      .catch(err => console.error('[CompanyDigestItem] remove failed:', err))
  }, [item.id, onRemove])

  const handleGenerateBrief = useCallback(async () => {
    if (!item.companyId) return
    setGeneratingBrief(true)
    setBriefGenError(false)
    try {
      const { brief } = await api.invoke<{ brief: string | null }>(
        IPC_CHANNELS.PARTNER_MEETING_GENERATE_BRIEF,
        item.companyId
      )
      if (brief) {
        await saveField({ brief })
      } else {
        setBriefGenError(true)
        setTimeout(() => setBriefGenError(false), 3000)
      }
    } catch (err) {
      console.error('[CompanyDigestItem] brief generation failed:', err)
      setBriefGenError(true)
      setTimeout(() => setBriefGenError(false), 3000)
    } finally {
      setGeneratingBrief(false)
    }
  }, [item.companyId, saveField])

  const handleStageChange = useCallback(async (newStage: CompanyPipelineStage) => {
    if (!item.companyId) return
    const prevStage = stage
    setStage(newStage)       // optimistic
    setStageOpen(false)
    try {
      await api.invoke(IPC_CHANNELS.COMPANY_UPDATE, item.companyId, { pipelineStage: newStage })
      // DecisionLog entry created automatically by company.ipc — no extra work needed
      if (newStage === 'pass') {
        await saveField({ section: 'passing' })  // saveField has its own try/catch
      }
    } catch (err) {
      console.error('[CompanyDigestItem] stage change failed:', err)
      setStage(prevStage)    // revert on failure
    }
  }, [item.companyId, stage, saveField])

  // Close stage dropdown when clicking outside
  useEffect(() => {
    if (!stageOpen) return
    function handleMouseDown(e: MouseEvent) {
      if (!stageRef.current?.contains(e.target as Node)) setStageOpen(false)
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [stageOpen])

  return (
    <div className={`${styles.item} ${item.isDiscussed ? styles.discussed : ''}`}>
      <div className={styles.topRow}>
        <div className={styles.nameArea}>
          {(item.section === 'new_deals' || item.section === 'existing_deals' || item.section === 'portfolio_updates') && (
            <button
              className={styles.collapseToggle}
              onClick={() => setItemCollapsed(v => !v)}
              title={itemCollapsed ? 'Expand' : 'Collapse'}
            >
              {itemCollapsed ? '▶' : '▾'}
            </button>
          )}
          <button
            className={styles.companyLink}
            onClick={() => navigate(`/company/${item.companyId}`)}
            title="Open company profile"
          >
            {item.companyName ?? 'Unknown Company'}
          </button>
        </div>
        {item.companyId && !disabled && (
          <div ref={stageRef} className={styles.stageChipWrap}>
            <button
              className={styles.stageChip}
              style={stage ? { background: STAGE_COLORS[stage]?.bg, color: STAGE_COLORS[stage]?.color } : {}}
              onClick={() => setStageOpen(v => !v)}
            >
              {STAGE_LABELS[stage ?? ''] ?? '—'}
            </button>
            {stageOpen && (
              <div className={styles.stageDropdown}>
                {STAGE_OPTIONS.map(s => (
                  <button
                    key={s}
                    className={styles.stageOption}
                    style={{ background: STAGE_COLORS[s]?.bg, color: STAGE_COLORS[s]?.color }}
                    onClick={() => handleStageChange(s)}
                  >
                    {STAGE_LABELS[s]}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
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

      {/* Generate brief button — active items only, shown when brief is absent */}
      {!disabled && !item.brief && !itemCollapsed && (
        <div className={styles.briefGenArea}>
          <button
            className={styles.briefGenBtn}
            onClick={handleGenerateBrief}
            disabled={generatingBrief}
            title="Generate a brief from CRM data (contacts, meetings, notes)"
          >
            {generatingBrief ? '✨ Generating…' : '✨ Generate from CRM data'}
          </button>
          {briefGenError && <span className={styles.briefGenError}>⚠ Failed</span>}
        </div>
      )}

      {/* Company brief — inline below name row; hidden for archived items with no brief */}
      {(!disabled || item.brief) && !itemCollapsed && (
        <DigestItemNotes
          content={item.brief}
          placeholder="Add a company brief…"
          disabled={disabled}
          onSave={handleBriefSave}
        />
      )}

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
