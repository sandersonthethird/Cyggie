/**
 * AddToSyncModal — "Add to Partner Sync" quick-add modal.
 *
 * Flow:
 *   1. Mount → fire PARTNER_MEETING_GET_ACTIVE + PARTNER_MEETING_GENERATE_BRIEF in parallel
 *   2. Section auto-detected from company pipeline stage; user can change
 *   3. Brief shown pre-expanded (always editable from the start)
 *   4. If company already in digest → pre-fills with existing data; submit = update
 *   5. If LLM fails → brief field shows blank; add is never blocked
 *
 * Section auto-detection:
 *   screening/diligence (new this week) → new_deals
 *   screening/diligence (older)         → existing_deals
 *   pass                                → passing
 *   portfolio entity_type               → portfolio_updates
 *   null/other                          → priorities
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import Link from '@tiptap/extension-link'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { DigestSection, PartnerMeetingItem } from '../../../shared/types/partner-meeting'
import type { CompanySummary } from '../../../shared/types/company'
import { api } from '../../api'
import styles from './AddToSyncModal.module.css'

const SECTION_LABELS: Record<DigestSection, string> = {
  priorities: 'Priorities',
  new_deals: 'New Deals',
  existing_deals: 'Existing Deals',
  portfolio_updates: 'Portfolio Updates',
  passing: 'Passing',
  admin: 'Admin',
  other: 'Other',
}

const ALL_SECTIONS: DigestSection[] = [
  'priorities', 'new_deals', 'existing_deals', 'portfolio_updates', 'passing', 'other',
]

function autoDetectSection(company: CompanySummary): DigestSection {
  if (company.entityType === 'portfolio') return 'portfolio_updates'
  if (company.pipelineStage === 'pass') return 'passing'
  if (company.pipelineStage === 'screening' || company.pipelineStage === 'diligence') {
    const sevenDaysAgo = new Date()
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
    if (new Date(company.createdAt) >= sevenDaysAgo) return 'new_deals'
    return 'existing_deals'
  }
  return 'priorities'
}

interface AddToSyncModalProps {
  company: CompanySummary
  onClose: () => void
  onAdded?: (item: PartnerMeetingItem) => void
}

type ModalState =
  | { status: 'loading' }
  | { status: 'ready'; digestId: string; existingItem: PartnerMeetingItem | null }
  | { status: 'submitting'; digestId: string }
  | { status: 'error'; message: string }

export function AddToSyncModal({ company, onClose, onAdded }: AddToSyncModalProps) {
  const [state, setState] = useState<ModalState>({ status: 'loading' })
  const [section, setSection] = useState<DigestSection>(autoDetectSection(company))
  const [briefContent, setBriefContent] = useState<string>('')
  const [statusUpdate, setStatusUpdate] = useState('')
  const [briefLoading, setBriefLoading] = useState(false)

  const briefEditor = useEditor({
    extensions: [StarterKit, Markdown, Link.configure({ openOnClick: false })],
    content: '',
    onUpdate: ({ editor: e }) => {
      setBriefContent(e.storage.markdown?.getMarkdown?.() ?? e.getText())
    },
  })

  // Load active digest + existing item + generate brief in parallel
  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const digest = await api.invoke<{ id: string; items?: PartnerMeetingItem[] }>(
          IPC_CHANNELS.PARTNER_MEETING_GET_ACTIVE
        )

        const existingItem = digest.items?.find(i => i.companyId === company.id) ?? null

        if (!cancelled) {
          setState({ status: 'ready', digestId: digest.id, existingItem })

          if (existingItem) {
            // Pre-fill from existing item
            setSection(existingItem.section)
            const existing = existingItem.brief ?? ''
            setBriefContent(existing)
            briefEditor?.commands.setContent(existing)
            setStatusUpdate(existingItem.statusUpdate ?? '')
          } else {
            // Generate brief from AI
            setBriefLoading(true)
            api.invoke<{ brief: string | null }>(IPC_CHANNELS.PARTNER_MEETING_GENERATE_BRIEF, company.id)
              .then(result => {
                if (!cancelled && result.brief) {
                  setBriefContent(result.brief)
                  briefEditor?.commands.setContent(result.brief)
                }
              })
              .catch(() => { /* Brief failed — leave blank, don't block add */ })
              .finally(() => { if (!cancelled) setBriefLoading(false) })
          }
        }
      } catch (err) {
        if (!cancelled) {
          setState({ status: 'error', message: 'Failed to load digest.' })
        }
      }
    }

    load()
    return () => { cancelled = true }
  }, [company.id]) // briefEditor excluded: ref-stable after mount

  // Sync briefContent into editor when it loads late (AI brief arrives after editor mounts)
  const prevBriefRef = useRef('')
  useEffect(() => {
    if (briefContent && briefContent !== prevBriefRef.current && briefEditor && !briefLoading) {
      prevBriefRef.current = briefContent
      const current = briefEditor.storage.markdown?.getMarkdown?.() ?? briefEditor.getText()
      if (!current.trim()) {
        briefEditor.commands.setContent(briefContent)
      }
    }
  }, [briefContent, briefLoading, briefEditor])

  const handleSubmit = useCallback(async () => {
    if (state.status !== 'ready') return
    setState(s => ({ ...s, status: 'submitting' as const, digestId: (s as { digestId: string }).digestId }))

    try {
      const item = await api.invoke<PartnerMeetingItem>(
        IPC_CHANNELS.PARTNER_MEETING_ITEM_ADD,
        state.digestId,
        {
          companyId: company.id,
          section,
          brief: briefContent || null,
          statusUpdate: statusUpdate || null,
        }
      )
      onAdded?.(item)
      onClose()
    } catch (err) {
      setState({ status: 'error', message: 'Failed to save. Please try again.' })
    }
  }, [state, company.id, section, briefContent, statusUpdate, onAdded, onClose])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') handleSubmit()
  }, [onClose, handleSubmit])

  const isExisting = state.status === 'ready' && !!state.existingItem
  const isBusy = state.status === 'loading' || state.status === 'submitting'

  return createPortal(
    <div className={styles.overlay} onClick={onClose} onKeyDown={handleKeyDown}>
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-label="Add to Partner Sync"
        onClick={e => e.stopPropagation()}
      >
        <div className={styles.header}>
          <div>
            <h2 className={styles.title}>Add to Partner Sync</h2>
            <div className={styles.companyName}>{company.canonicalName}</div>
          </div>
          <button className={styles.closeBtn} onClick={onClose} title="Close">✕</button>
        </div>

        {state.status === 'error' && (
          <div className={styles.errorMsg}>{state.message}</div>
        )}

        <div className={styles.body}>
          {/* Section picker */}
          <div className={styles.field}>
            <label className={styles.label}>Section</label>
            <select
              className={styles.select}
              value={section}
              onChange={e => setSection(e.target.value as DigestSection)}
              disabled={isBusy}
            >
              {ALL_SECTIONS.map(s => (
                <option key={s} value={s}>{SECTION_LABELS[s]}</option>
              ))}
            </select>
          </div>

          {/* Company brief — always pre-expanded */}
          <div className={styles.field}>
            <label className={styles.label}>
              Company Brief
              {briefLoading && <span className={styles.generating}> ✨ Generating…</span>}
            </label>
            <div className={styles.tiptapWrap}>
              <EditorContent editor={briefEditor} />
            </div>
          </div>

          {/* Status update */}
          <div className={styles.field}>
            <label className={styles.label}>What happened this week?</label>
            <textarea
              className={styles.textarea}
              value={statusUpdate}
              onChange={e => setStatusUpdate(e.target.value)}
              placeholder="Optional — describe recent activity, key developments…"
              rows={3}
              disabled={isBusy}
            />
          </div>
        </div>

        <div className={styles.footer}>
          <button className={styles.cancelBtn} onClick={onClose} disabled={isBusy}>
            Cancel
          </button>
          <button
            className={styles.submitBtn}
            onClick={handleSubmit}
            disabled={isBusy}
          >
            {isBusy
              ? 'Saving…'
              : isExisting
                ? 'Update'
                : 'Add to Sync ▸'
            }
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
