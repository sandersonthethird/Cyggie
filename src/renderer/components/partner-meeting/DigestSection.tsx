/**
 * DigestSection — a collapsible section (Priorities, New Deals, etc.) in the digest.
 * Renders a list of items and an "+ Add" button (company picker for non-admin sections;
 * direct add for Admin).
 */

import { useCallback, useState } from 'react'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { DigestSection as DigestSectionId, PartnerMeetingItem } from '../../../shared/types/partner-meeting'
import type { CompanySummary } from '../../../shared/types/company'
import { CompanyDigestItem } from './CompanyDigestItem'
import { AdminDigestItem } from './AdminDigestItem'
import { AddToSyncModal } from './AddToSyncModal'
import { api } from '../../api'
import styles from './DigestSection.module.css'

const SECTION_LABELS: Record<DigestSectionId, string> = {
  priorities: 'Priorities',
  new_deals: 'Screening',
  existing_deals: 'Diligence',
  portfolio_updates: 'Portfolio Updates',
  passing: 'Passing',
  admin: 'Admin',
  other: 'Other',
}

interface DigestSectionProps {
  sectionId: DigestSectionId
  items: PartnerMeetingItem[]
  digestId: string
  disabled?: boolean
  onItemsChange: (updater: (items: PartnerMeetingItem[]) => PartnerMeetingItem[]) => void
}

export function DigestSection({ sectionId, items, digestId, disabled = false, onItemsChange }: DigestSectionProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [addModal, setAddModal] = useState(false)

  const handleUpdate = useCallback((updated: PartnerMeetingItem) => {
    onItemsChange(all => all.map(i => i.id === updated.id ? updated : i))
  }, [onItemsChange])

  const handleRemove = useCallback((itemId: string) => {
    onItemsChange(all => all.filter(i => i.id !== itemId))
  }, [onItemsChange])

  const handleAdded = useCallback((item: PartnerMeetingItem) => {
    onItemsChange(all => {
      const exists = all.find(i => i.id === item.id)
      if (exists) return all.map(i => i.id === item.id ? item : i)
      return [...all, item]
    })
  }, [onItemsChange])

  const handleAddAdmin = useCallback(async () => {
    try {
      const item = await api.invoke<PartnerMeetingItem>(
        IPC_CHANNELS.PARTNER_MEETING_ITEM_ADD,
        digestId,
        { companyId: null, section: 'admin', title: null }
      )
      onItemsChange(all => [...all, item])
    } catch (err) {
      console.error('[DigestSection] add admin item failed:', err)
    }
  }, [digestId, onItemsChange])

  const sectionItems = items.filter(i => i.section === sectionId)

  return (
    <div className={styles.section}>
      <div className={styles.header}>
        <button className={styles.toggle} onClick={() => setCollapsed(v => !v)}>
          {collapsed ? '▶' : '▾'} {SECTION_LABELS[sectionId]}
          {sectionItems.length > 0 && (
            <span className={styles.count}>{sectionItems.length}</span>
          )}
        </button>
        {!disabled && (
          <button
            className={styles.addBtn}
            onClick={sectionId === 'admin' ? handleAddAdmin : () => setAddModal(true)}
            title={sectionId === 'admin' ? 'Add admin item' : 'Add company to section'}
          >
            + Add
          </button>
        )}
      </div>

      {!collapsed && (
        <div className={styles.items}>
          {sectionItems.length === 0 ? (
            <div className={styles.emptyState}>No items in this section</div>
          ) : (
            sectionItems.map(item =>
              item.companyId ? (
                <CompanyDigestItem
                  key={item.id}
                  item={item}
                  disabled={disabled}
                  onUpdate={handleUpdate}
                  onRemove={handleRemove}
                />
              ) : (
                <AdminDigestItem
                  key={item.id}
                  item={item}
                  disabled={disabled}
                  onUpdate={handleUpdate}
                  onRemove={handleRemove}
                />
              )
            )
          )}
        </div>
      )}

      {addModal && (
        // AddToSyncModal needs a company. For non-admin sections, we show a company search first.
        // This is handled via CompanySearchForAdd embedded in the modal trigger area.
        <CompanySearchForAdd
          sectionId={sectionId}
          onClose={() => setAddModal(false)}
          onAdded={(item) => { handleAdded(item); setAddModal(false) }}
        />
      )}
    </div>
  )
}

// ─── Company search wrapper ────────────────────────────────────────────────────
// Lets user pick a company then opens AddToSyncModal pre-filled with that company.

interface CompanySearchForAddProps {
  sectionId: DigestSectionId
  onClose: () => void
  onAdded: (item: PartnerMeetingItem) => void
}

function CompanySearchForAdd({ sectionId, onClose, onAdded }: CompanySearchForAddProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<CompanySummary[]>([])
  const [selected, setSelected] = useState<CompanySummary | null>(null)
  const [loading, setLoading] = useState(false)

  const search = useCallback(async (q: string) => {
    if (!q.trim()) { setResults([]); return }
    setLoading(true)
    try {
      const companies = await api.invoke<CompanySummary[]>(IPC_CHANNELS.COMPANY_LIST, { query: q, limit: 8, view: 'all' })
      setResults(companies)
    } catch {
      setResults([])
    } finally {
      setLoading(false)
    }
  }, [])

  // Debounce search
  const [debounceTimer, setDebounceTimer] = useState<ReturnType<typeof setTimeout> | null>(null)
  const handleQueryChange = (q: string) => {
    setQuery(q)
    if (debounceTimer) clearTimeout(debounceTimer)
    setDebounceTimer(setTimeout(() => search(q), 300))
  }

  if (selected) {
    return (
      <AddToSyncModal
        company={selected}
        onClose={onClose}
        onAdded={onAdded}
      />
    )
  }

  return (
    <div className={styles.searchOverlay} onClick={onClose}>
      <div className={styles.searchBox} onClick={e => e.stopPropagation()}>
        <input
          className={styles.searchInput}
          autoFocus
          placeholder="Search companies…"
          value={query}
          onChange={e => handleQueryChange(e.target.value)}
        />
        {loading && <div className={styles.searchLoading}>Searching…</div>}
        {results.length > 0 && (
          <div className={styles.searchResults}>
            {results.map(c => (
              <button
                key={c.id}
                className={styles.searchResult}
                onClick={() => setSelected(c)}
              >
                {c.canonicalName}
                {c.pipelineStage && <span className={styles.stageChip}>{c.pipelineStage}</span>}
              </button>
            ))}
          </div>
        )}
        {query.trim() && !loading && results.length === 0 && (
          <div className={styles.searchEmpty}>No companies found</div>
        )}
      </div>
    </div>
  )
}
