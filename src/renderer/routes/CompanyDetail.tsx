import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type { CompanyDetail as CompanyDetailType } from '../../shared/types/company'
import { CompanyPropertiesPanel } from '../components/company/CompanyPropertiesPanel'
import { CompanyTimeline } from '../components/company/CompanyTimeline'
import { CompanyContacts } from '../components/company/CompanyContacts'
import { CompanyNotes } from '../components/company/CompanyNotes'
import { CompanyMemo } from '../components/company/CompanyMemo'
import { CompanyFiles } from '../components/company/CompanyFiles'
import { usePanelResize } from '../hooks/usePanelResize'
import styles from './CompanyDetail.module.css'

type CompanyTab = 'timeline' | 'contacts' | 'notes' | 'memo' | 'files'

export default function CompanyDetail() {
  const { companyId: id } = useParams<{ companyId: string }>()
  const [company, setCompany] = useState<CompanyDetailType | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<CompanyTab>('timeline')
  const { leftWidth, dividerProps } = usePanelResize()

  useEffect(() => {
    if (!id) return
    setLoading(true)
    window.api
      .invoke<CompanyDetailType>(IPC_CHANNELS.COMPANY_GET, id)
      .then((data) => setCompany(data ?? null))
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [id])

  function handleUpdate(updates: Record<string, unknown>) {
    setCompany((prev) => prev ? { ...prev, ...updates } : prev)
  }

  if (loading) {
    return <div className={styles.loading}>Loading…</div>
  }
  if (!company) {
    return <div className={styles.notFound}>Company not found.</div>
  }

  const tabs: Array<{ key: CompanyTab; label: string; badge?: number }> = [
    {
      key: 'timeline',
      label: 'Timeline',
      badge: (company.meetingCount || 0) + (company.emailCount || 0) + (company.noteCount || 0) || undefined
    },
    { key: 'contacts', label: 'Contacts', badge: company.contactCount || undefined },
    { key: 'notes', label: 'Notes', badge: company.noteCount || undefined },
    { key: 'memo', label: 'Memo' },
    { key: 'files', label: 'Files' }
  ]

  return (
    <div className={styles.layout} style={{ gridTemplateColumns: `${leftWidth}px 4px 1fr` }}>
      {/* Left panel — properties */}
      <div className={styles.leftPanel}>
        <CompanyPropertiesPanel company={company} onUpdate={handleUpdate} />
      </div>

      {/* Resizable divider */}
      <div className={styles.divider} {...dividerProps} />

      {/* Right panel — tabs */}
      <div className={styles.rightPanel}>
        <div className={styles.tabBar}>
          {tabs.map((tab) => (
            <button
              key={tab.key}
              className={`${styles.tabBtn} ${activeTab === tab.key ? styles.tabActive : ''}`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
              {tab.badge != null && tab.badge > 0 && (
                <span className={styles.tabBadge}>{tab.badge}</span>
              )}
            </button>
          ))}
        </div>

        {/* All tabs always mounted (CSS hide/show) to preserve CompanyMemo draft state */}
        <div className={styles.tabContent}>
          <CompanyTimeline
            companyId={company.id}
            className={activeTab !== 'timeline' ? styles.hidden : ''}
          />
          <CompanyContacts
            companyId={company.id}
            className={activeTab !== 'contacts' ? styles.hidden : ''}
          />
          <CompanyNotes
            companyId={company.id}
            className={activeTab !== 'notes' ? styles.hidden : ''}
          />
          <CompanyMemo
            companyId={company.id}
            className={activeTab !== 'memo' ? styles.hidden : ''}
          />
          <CompanyFiles
            companyId={company.id}
            className={activeTab !== 'files' ? styles.hidden : ''}
          />
        </div>
      </div>
    </div>
  )
}
