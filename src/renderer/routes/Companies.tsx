import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { useFeatureFlag } from '../hooks/useFeatureFlags'
import EmptyState from '../components/common/EmptyState'
import type { CompanyListFilter, CompanySummary } from '../../shared/types/company'
import styles from './Companies.module.css'

type CompanyScope = 'prospects' | 'all' | 'vc_fund' | 'unknown'

const SCOPE_LABELS: Record<CompanyScope, string> = {
  prospects: 'Prospects',
  all: 'All Orgs',
  vc_fund: 'VC Funds',
  unknown: 'Unknown'
}

function formatLastTouch(value: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return `${diffDays}d ago`
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function daysSince(value: string | null): number | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24))
}

function buildFilter(query: string, scope: CompanyScope): CompanyListFilter {
  const filter: CompanyListFilter = {
    query: query.trim(),
    limit: 400
  }

  if (scope === 'prospects') {
    filter.view = 'all'
    filter.entityTypes = ['prospect']
    return filter
  }

  filter.view = 'all'
  if (scope === 'vc_fund') filter.entityTypes = ['vc_fund']
  if (scope === 'unknown') filter.entityTypes = ['unknown']
  return filter
}

export default function Companies() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { enabled: companiesEnabled, loading: flagsLoading } = useFeatureFlag('ff_companies_ui_v1')
  const [companies, setCompanies] = useState<CompanySummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scope, setScope] = useState<CompanyScope>('prospects')
  const [newName, setNewName] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [newDomain, setNewDomain] = useState('')
  const query = (searchParams.get('q') || '').trim()
  const showCreate = searchParams.get('new') === '1'

  const openCreateForm = useCallback(() => {
    const next = new URLSearchParams(searchParams)
    next.set('new', '1')
    setSearchParams(next)
  }, [searchParams, setSearchParams])

  const closeCreateForm = useCallback(() => {
    const next = new URLSearchParams(searchParams)
    next.delete('new')
    setSearchParams(next)
  }, [searchParams, setSearchParams])

  const fetchCompanies = useCallback(async () => {
    if (!companiesEnabled) return
    setLoading(true)
    setError(null)
    try {
      const results = await window.api.invoke<CompanySummary[]>(
        IPC_CHANNELS.COMPANY_LIST,
        buildFilter(query, scope)
      )
      setCompanies(results)
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [companiesEnabled, query, scope])

  useEffect(() => {
    fetchCompanies()
  }, [fetchCompanies])

  const handleCreateCompany = async () => {
    if (!newName.trim()) return
    try {
      const created = await window.api.invoke<CompanySummary>(
        IPC_CHANNELS.COMPANY_CREATE,
        {
          canonicalName: newName.trim(),
          description: newDescription.trim() || null,
          primaryDomain: newDomain.trim() || null,
          entityType: 'prospect'
        }
      )
      closeCreateForm()
      setNewName('')
      setNewDescription('')
      setNewDomain('')
      await fetchCompanies()
      navigate(`/company/${created.id}`)
    } catch (err) {
      setError(String(err))
    }
  }

  if (!flagsLoading && !companiesEnabled) {
    return (
      <EmptyState
        title="Companies disabled"
        description="Enable the companies feature flag in Settings to use this page."
      />
    )
  }

  const showEmptyState = !loading && companies.length === 0 && !query && !showCreate

  return (
    <div className={styles.container}>
      <div className={styles.scopeRow}>
        {(Object.keys(SCOPE_LABELS) as CompanyScope[]).map((s) => (
          <button
            key={s}
            className={`${styles.scopeButton} ${scope === s ? styles.activeScope : ''}`}
            onClick={() => setScope(s)}
          >
            {SCOPE_LABELS[s]}
          </button>
        ))}
      </div>

      {showCreate && (
        <div className={styles.createCard}>
          <input className={styles.input} placeholder="Company name" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <input className={styles.input} placeholder="Domain (optional)" value={newDomain} onChange={(e) => setNewDomain(e.target.value)} />
          <textarea className={styles.textarea} placeholder="Description (optional)" value={newDescription} onChange={(e) => setNewDescription(e.target.value)} />
          <button className={styles.createBtn} onClick={handleCreateCompany}>Create</button>
        </div>
      )}

      {error && <div className={styles.error}>{error}</div>}

      {query && (
        <p className={styles.resultCount}>
          {loading ? 'Searching...' : `${companies.length} result${companies.length !== 1 ? 's' : ''}`}
        </p>
      )}

      <div className={styles.scrollArea}>
        {showEmptyState ? (
          <EmptyState
            title="No companies yet"
            description="Companies are auto-detected from meeting attendees, or you can add one manually."
            action={{ label: '+ New Company', onClick: openCreateForm }}
          />
        ) : (
          <>
            <div className={styles.section}>
              <h3 className={styles.sectionHeader}>
                {SCOPE_LABELS[scope]} ({companies.length})
              </h3>
              <div className={styles.list}>
                {companies.map((company) => {
                  const touchDays = daysSince(company.lastTouchpoint)
                  const warmthClass = touchDays == null
                    ? styles.warmthUnknown
                    : touchDays < 14
                        ? styles.warmthGreen
                        : touchDays <= 30
                            ? styles.warmthYellow
                            : styles.warmthRed
                  return (
                    <div
                      key={company.id}
                      className={styles.card}
                      onClick={() => navigate(`/company/${company.id}`)}
                    >
                      <div className={styles.cardRow}>
                        <span className={styles.cardName}>{company.canonicalName}</span>
                        <span className={styles.cardDomain}>{company.primaryDomain || ''}</span>
                      </div>
                      <div className={styles.cardRow}>
                        <span className={styles.cardMeta}>
                          {[
                            company.meetingCount > 0 && `${company.meetingCount} meeting${company.meetingCount !== 1 ? 's' : ''}`,
                            company.emailCount > 0 && `${company.emailCount} email${company.emailCount !== 1 ? 's' : ''}`
                          ].filter(Boolean).join(', ') || 'No activity'}
                        </span>
                        <div className={styles.touchMeta}>
                          <span className={styles.cardStage}>
                            {formatLastTouch(company.lastTouchpoint)}
                          </span>
                          <span className={`${styles.warmthBadge} ${warmthClass}`}>
                            {touchDays == null ? '--' : `${touchDays}d`}
                          </span>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            {!loading && companies.length === 0 && query && (
              <p className={styles.noResults}>No companies match your search.</p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
