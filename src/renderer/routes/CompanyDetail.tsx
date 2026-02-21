import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { useFeatureFlags } from '../hooks/useFeatureFlags'
import type {
  CompanyDetail as CompanyDetailType,
  CompanyEmailIngestResult,
  CompanyEntityType,
  CompanyEmailRef,
  CompanyFileRef,
  CompanyMeetingRef,
  CompanyNote,
  InvestmentMemoVersion,
  InvestmentMemoWithLatest
} from '../../shared/types/company'
import styles from './CompanyDetail.module.css'

type CompanyTab = 'overview' | 'meetings' | 'emails' | 'files' | 'notes' | 'memo'

const TAB_LABELS: Record<CompanyTab, string> = {
  overview: 'Overview',
  meetings: 'Meetings',
  emails: 'Emails',
  files: 'Files',
  notes: 'Notes',
  memo: 'Memo'
}

const COMPANY_TYPE_OPTIONS: CompanyEntityType[] = [
  'prospect',
  'vc_fund',
  'customer',
  'partner',
  'vendor',
  'other',
  'unknown'
]

function formatDateTime(value: string | null): string {
  if (!value) return 'Unknown'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown'
  return date.toLocaleString()
}

function formatDateHeading(value: string | null): string {
  if (!value) return 'Unknown date'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown date'

  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)

  if (date.toDateString() === today.toDateString()) return 'Today'
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'

  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  })
}

function formatTime(value: string | null): string {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--'
  return date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  })
}

function groupEmailsByDate(emails: CompanyEmailRef[]): Array<[string, CompanyEmailRef[]]> {
  const groups = new Map<string, CompanyEmailRef[]>()
  for (const email of emails) {
    const at = email.receivedAt || email.sentAt
    const heading = formatDateHeading(at)
    const existing = groups.get(heading)
    if (existing) {
      existing.push(email)
    } else {
      groups.set(heading, [email])
    }
  }
  return Array.from(groups.entries())
}

function formatEntityType(entityType: CompanyEntityType): string {
  const labels: Record<CompanyEntityType, string> = {
    prospect: 'Prospect',
    vc_fund: 'VC Fund',
    customer: 'Customer',
    partner: 'Partner',
    vendor: 'Vendor',
    other: 'Other',
    unknown: 'Unknown'
  }
  return labels[entityType]
}

function formatDuration(seconds: number | null): string | null {
  if (!seconds || seconds <= 0) return null
  const minutes = Math.round(seconds / 60)
  return `${minutes} min`
}

function formatFileCoverage(file: CompanyFileRef): string {
  const coverage: string[] = []
  if (file.hasTranscript) coverage.push('Transcript')
  if (file.hasNotes) coverage.push('Notes')
  if (file.hasSummary) coverage.push('Summary')
  if (file.hasRecording) coverage.push('Recording')
  return coverage.length > 0 ? coverage.join(' + ') : 'Meeting files'
}

function buildWebsiteHref(websiteUrl: string | null, primaryDomain: string | null): string | null {
  const candidate = (websiteUrl || '').trim() || (primaryDomain || '').trim()
  if (!candidate) return null
  if (/^https?:\/\//i.test(candidate)) return candidate
  return `https://${candidate}`
}

function toDisplayError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const withoutIpcPrefix = raw.replace(/^Error invoking remote method '.*?':\s*/, '')
  return withoutIpcPrefix.replace(/^Error:\s*/, '')
}

export default function CompanyDetail() {
  const { companyId = '' } = useParams()
  const navigate = useNavigate()
  const { values: flags, loading: flagsLoading } = useFeatureFlags([
    'ff_companies_ui_v1',
    'ff_company_notes_v1',
    'ff_investment_memo_v1'
  ])

  const [activeTab, setActiveTab] = useState<CompanyTab>('overview')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [company, setCompany] = useState<CompanyDetailType | null>(null)
  const [meetings, setMeetings] = useState<CompanyMeetingRef[]>([])
  const [emails, setEmails] = useState<CompanyEmailRef[]>([])
  const [files, setFiles] = useState<CompanyFileRef[]>([])
  const [notes, setNotes] = useState<CompanyNote[]>([])
  const [noteTitle, setNoteTitle] = useState('')
  const [noteContent, setNoteContent] = useState('')
  const [memo, setMemo] = useState<InvestmentMemoWithLatest | null>(null)
  const [memoVersions, setMemoVersions] = useState<InvestmentMemoVersion[]>([])
  const [memoDraft, setMemoDraft] = useState('')
  const [memoChangeNote, setMemoChangeNote] = useState('')
  const [savingMemo, setSavingMemo] = useState(false)
  const [exportingMemo, setExportingMemo] = useState(false)
  const [ingestingEmails, setIngestingEmails] = useState(false)
  const [emailIngestSummary, setEmailIngestSummary] = useState<string | null>(null)
  const [expandedEmailId, setExpandedEmailId] = useState<string | null>(null)
  const [updatingType, setUpdatingType] = useState(false)

  const tabs = useMemo(() => {
    const items: CompanyTab[] = ['overview', 'meetings', 'emails', 'files']
    if (flags.ff_company_notes_v1) items.push('notes')
    if (flags.ff_investment_memo_v1) items.push('memo')
    return items
  }, [flags.ff_company_notes_v1, flags.ff_investment_memo_v1])

  const loadData = useCallback(async () => {
    if (!companyId || !flags.ff_companies_ui_v1) return

    setLoading(true)
    setError(null)
    try {
      const companyResult = await window.api.invoke<CompanyDetailType | null>(
        IPC_CHANNELS.COMPANY_GET,
        companyId
      )
      setCompany(companyResult)
      if (!companyResult) {
        setMeetings([])
        setEmails([])
        setFiles([])
        setNotes([])
        setMemo(null)
        setMemoVersions([])
        setMemoDraft('')
        return
      }

      const partialErrors: string[] = []

      const [
        meetingsSettled,
        emailsSettled,
        filesSettled,
        notesSettled,
        memoSettled
      ] = await Promise.allSettled([
        window.api.invoke<CompanyMeetingRef[]>(IPC_CHANNELS.COMPANY_MEETINGS, companyId),
        window.api.invoke<CompanyEmailRef[]>(IPC_CHANNELS.COMPANY_EMAILS, companyId),
        window.api.invoke<CompanyFileRef[]>(IPC_CHANNELS.COMPANY_FILES, companyId),
        flags.ff_company_notes_v1
          ? window.api.invoke<CompanyNote[]>(IPC_CHANNELS.COMPANY_NOTES_LIST, companyId)
          : Promise.resolve([]),
        flags.ff_investment_memo_v1
          ? window.api.invoke<InvestmentMemoWithLatest>(IPC_CHANNELS.INVESTMENT_MEMO_GET_OR_CREATE, companyId)
          : Promise.resolve(null)
      ])

      if (meetingsSettled.status === 'fulfilled') {
        setMeetings(meetingsSettled.value)
      } else {
        setMeetings([])
        partialErrors.push('Failed to load meetings')
      }

      if (emailsSettled.status === 'fulfilled') {
        setEmails(emailsSettled.value)
      } else {
        setEmails([])
        partialErrors.push('Failed to load emails')
      }

      if (filesSettled.status === 'fulfilled') {
        setFiles(filesSettled.value)
      } else {
        setFiles([])
        partialErrors.push('Failed to load files')
      }

      if (notesSettled.status === 'fulfilled') {
        setNotes(notesSettled.value)
      } else {
        setNotes([])
        partialErrors.push('Failed to load notes')
      }

      let memoResult: InvestmentMemoWithLatest | null = null
      if (memoSettled.status === 'fulfilled') {
        memoResult = memoSettled.value
      } else {
        partialErrors.push('Failed to load memo')
      }

      setMemo(memoResult)
      if (memoResult) {
        try {
          const versions = await window.api.invoke<InvestmentMemoVersion[]>(
            IPC_CHANNELS.INVESTMENT_MEMO_LIST_VERSIONS,
            memoResult.id
          )
          setMemoVersions(versions)
        } catch {
          setMemoVersions([])
          partialErrors.push('Failed to load memo versions')
        }
        setMemoDraft(memoResult.latestVersion?.contentMarkdown || '')
      } else {
        setMemoVersions([])
        setMemoDraft('')
      }

      if (partialErrors.length > 0) {
        setError(partialErrors.join(' | '))
      }
    } catch (err) {
      setCompany(null)
      setError(toDisplayError(err))
    } finally {
      setLoading(false)
    }
  }, [companyId, flags.ff_companies_ui_v1, flags.ff_company_notes_v1, flags.ff_investment_memo_v1])

  useEffect(() => {
    loadData()
  }, [loadData])

  useEffect(() => {
    if (!tabs.includes(activeTab)) {
      setActiveTab(tabs[0] || 'overview')
    }
  }, [activeTab, tabs])

  useEffect(() => {
    setEmailIngestSummary(null)
    setExpandedEmailId(null)
  }, [companyId])

  useEffect(() => {
    if (emails.length === 0) {
      setExpandedEmailId(null)
      return
    }
    if (expandedEmailId && !emails.some((email) => email.id === expandedEmailId)) {
      setExpandedEmailId(null)
    }
  }, [emails, expandedEmailId])

  const handleAddNote = async () => {
    if (!companyId || !noteContent.trim()) return
    try {
      await window.api.invoke<CompanyNote>(IPC_CHANNELS.COMPANY_NOTES_CREATE, {
        companyId,
        title: noteTitle.trim() || null,
        content: noteContent.trim()
      })
      setNoteTitle('')
      setNoteContent('')
      const updated = await window.api.invoke<CompanyNote[]>(IPC_CHANNELS.COMPANY_NOTES_LIST, companyId)
      setNotes(updated)
    } catch (err) {
      setError(toDisplayError(err))
    }
  }

  const handleTogglePinNote = async (note: CompanyNote) => {
    try {
      await window.api.invoke<CompanyNote>(
        IPC_CHANNELS.COMPANY_NOTES_UPDATE,
        note.id,
        { isPinned: !note.isPinned }
      )
      const updated = await window.api.invoke<CompanyNote[]>(IPC_CHANNELS.COMPANY_NOTES_LIST, companyId)
      setNotes(updated)
    } catch (err) {
      setError(toDisplayError(err))
    }
  }

  const handleDeleteNote = async (noteId: string) => {
    try {
      await window.api.invoke<boolean>(IPC_CHANNELS.COMPANY_NOTES_DELETE, noteId)
      const updated = await window.api.invoke<CompanyNote[]>(IPC_CHANNELS.COMPANY_NOTES_LIST, companyId)
      setNotes(updated)
    } catch (err) {
      setError(toDisplayError(err))
    }
  }

  const handleSaveMemo = async () => {
    if (!memo || !memoDraft.trim()) return
    setSavingMemo(true)
    try {
      await window.api.invoke<InvestmentMemoVersion>(
        IPC_CHANNELS.INVESTMENT_MEMO_SAVE_VERSION,
        memo.id,
        {
          contentMarkdown: memoDraft,
          changeNote: memoChangeNote.trim() || null
        }
      )
      setMemoChangeNote('')
      const refreshedMemo = await window.api.invoke<InvestmentMemoWithLatest>(
        IPC_CHANNELS.INVESTMENT_MEMO_GET_OR_CREATE,
        companyId
      )
      setMemo(refreshedMemo)
      const refreshedVersions = await window.api.invoke<InvestmentMemoVersion[]>(
        IPC_CHANNELS.INVESTMENT_MEMO_LIST_VERSIONS,
        refreshedMemo.id
      )
      setMemoVersions(refreshedVersions)
    } catch (err) {
      setError(toDisplayError(err))
    } finally {
      setSavingMemo(false)
    }
  }

  const handleMemoStatusChange = async (status: 'draft' | 'review' | 'final' | 'archived') => {
    if (!memo) return
    try {
      const updated = await window.api.invoke<InvestmentMemoWithLatest>(
        IPC_CHANNELS.INVESTMENT_MEMO_SET_STATUS,
        memo.id,
        status
      )
      setMemo((prev) => (prev ? { ...updated, latestVersion: prev.latestVersion } : prev))
    } catch (err) {
      setError(toDisplayError(err))
    }
  }

  const handleExportMemo = async () => {
    if (!memo) return
    setExportingMemo(true)
    try {
      const result = await window.api.invoke<{ success: boolean; path?: string; error?: string }>(
        IPC_CHANNELS.INVESTMENT_MEMO_EXPORT_PDF,
        memo.id
      )
      if (!result.success) {
        throw new Error(result.error || 'Failed to export memo')
      }
    } catch (err) {
      setError(toDisplayError(err))
    } finally {
      setExportingMemo(false)
    }
  }

  const handleIngestCompanyEmails = async () => {
    if (!companyId) return
    setIngestingEmails(true)
    setError(null)
    try {
      const result = await window.api.invoke<CompanyEmailIngestResult>(
        IPC_CHANNELS.COMPANY_EMAIL_INGEST,
        companyId
      )
      setEmailIngestSummary(
        `${result.insertedMessageCount} new, ${result.updatedMessageCount} updated, ${result.linkedMessageCount} linked`
      )
      await loadData()
      setActiveTab('emails')
    } catch (err) {
      setError(toDisplayError(err))
    } finally {
      setIngestingEmails(false)
    }
  }

  const handleCompanyTypeChange = useCallback(async (nextType: CompanyEntityType) => {
    if (!companyId || !company || nextType === company.entityType) return
    setUpdatingType(true)
    setError(null)
    try {
      const updated = await window.api.invoke<CompanyDetailType | null>(
        IPC_CHANNELS.COMPANY_UPDATE,
        companyId,
        {
          entityType: nextType,
          classificationSource: 'manual',
          classificationConfidence: 1
        }
      )
      if (updated) {
        setCompany(updated)
      }
    } catch (err) {
      setError(toDisplayError(err))
    } finally {
      setUpdatingType(false)
    }
  }, [companyId, company])

  if (!flagsLoading && !flags.ff_companies_ui_v1) {
    return (
      <div className={styles.page}>
        <div className={styles.empty}>Companies view is disabled by feature flag.</div>
      </div>
    )
  }

  if (!companyId) {
    return (
      <div className={styles.page}>
        <div className={styles.empty}>Missing company id.</div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className={styles.page}>
        <div className={styles.meta}>Loading company...</div>
      </div>
    )
  }

  if (!company) {
    return (
      <div className={styles.page}>
        <div className={styles.empty}>{error || 'Company not found.'}</div>
      </div>
    )
  }

  const tabCounts: Partial<Record<CompanyTab, number>> = {
    meetings: meetings.length,
    emails: emails.length,
    files: files.length,
    notes: notes.length,
    memo: memo?.latestVersionNumber ?? 0
  }
  const websiteHref = buildWebsiteHref(company.websiteUrl, company.primaryDomain)
  const websiteLabel = (company.websiteUrl || '').trim() || (company.primaryDomain || '').trim()

  return (
    <div className={styles.page}>
      <button className={styles.backButton} onClick={() => navigate('/companies')}>
        {'< Back to Companies'}
      </button>

      <div className={styles.headerCard}>
        <h2 className={styles.title}>{company.canonicalName}</h2>
        <div className={styles.headerMeta}>
          <span>{company.primaryDomain || 'No domain'}</span>
          <label className={styles.typeControl}>
            <span>Type:</span>
            <select
              className={styles.typeSelect}
              value={company.entityType}
              onChange={(e) => handleCompanyTypeChange(e.target.value as CompanyEntityType)}
              disabled={updatingType}
            >
              {COMPANY_TYPE_OPTIONS.map((type) => (
                <option key={type} value={type}>
                  {formatEntityType(type)}
                </option>
              ))}
            </select>
          </label>
          <span>Stage: {company.stage || 'Unspecified'}</span>
          <span>Status: {company.status}</span>
          <span>Last touch: {formatDateTime(company.lastTouchpoint)}</span>
        </div>
        <div className={styles.businessBlock}>
          <div className={styles.businessLabel}>Business Description</div>
          <p className={styles.businessText}>
            {(company.description || '').trim() || 'No business description added yet.'}
          </p>
          <div className={styles.websiteRow}>
            <span className={styles.businessLabel}>Website</span>
            {websiteHref ? (
              <a
                className={styles.websiteLink}
                href={websiteHref}
                target="_blank"
                rel="noreferrer"
              >
                {websiteLabel}
              </a>
            ) : (
              <span className={styles.noWebsite}>No website on file.</span>
            )}
          </div>
        </div>
        <div className={styles.tagsRow}>
          {company.industries.length > 0 && (
            <div className={styles.tagGroup}>
              <strong>Industry</strong>
              {company.industries.map((item) => (
                <span key={item} className={styles.tag}>{item}</span>
              ))}
            </div>
          )}
          {company.themes.length > 0 && (
            <div className={styles.tagGroup}>
              <strong>Themes</strong>
              {company.themes.map((item) => (
                <span key={item} className={styles.tag}>{item}</span>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className={styles.tabRow}>
        {tabs.map((tab) => (
          <button
            key={tab}
            className={`${styles.tab} ${activeTab === tab ? styles.activeTab : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            <span className={styles.tabLabel}>{TAB_LABELS[tab]}</span>
            {tabCounts[tab] !== undefined && (
              <span className={styles.tabCount}>{tabCounts[tab]}</span>
            )}
          </button>
        ))}
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {activeTab === 'overview' && (
        <div className={styles.section}>
          <div className={styles.meta}>
            Use the tabs above to review meetings, emails, notes, and memo versions for this company.
          </div>
        </div>
      )}

      {activeTab === 'meetings' && (
        <div className={styles.section}>
          {meetings.length === 0 && (
            <div className={styles.empty}>No meetings linked to this company yet.</div>
          )}
          <div className={styles.stack}>
            {meetings.map((meeting) => (
              <button
                key={meeting.id}
                className={styles.versionCard}
                onClick={() => navigate(`/meeting/${meeting.id}`)}
              >
                <div className={styles.timelineTop}>
                  <strong>{meeting.title}</strong>
                  <span className={styles.timelineWhen}>{formatDateTime(meeting.date)}</span>
                </div>
                <div className={styles.timelineSubtitle}>
                  {[meeting.status, formatDuration(meeting.durationSeconds)].filter(Boolean).join(' | ')}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {activeTab === 'emails' && (
        <div className={styles.section}>
          <div className={styles.emailActions}>
            <button
              className={styles.secondaryButton}
              onClick={handleIngestCompanyEmails}
              disabled={ingestingEmails}
            >
              {ingestingEmails ? 'Ingesting from Gmail...' : 'Ingest from Gmail'}
            </button>
            {emailIngestSummary && (
              <span className={styles.emailIngestMeta}>{emailIngestSummary}</span>
            )}
          </div>
          {emails.length === 0 && (
            <div className={styles.empty}>No emails linked to this company yet.</div>
          )}
          {emails.length > 0 && (
            <div className={styles.emailListView}>
              {groupEmailsByDate(emails).map(([dateHeading, groupedEmails]) => (
                <div key={dateHeading} className={styles.emailDateGroup}>
                  <div className={styles.emailDateHeader}>
                    <span>{dateHeading}</span>
                  </div>
                  <div className={styles.emailRows}>
                    {groupedEmails.map((email) => {
                      const expanded = expandedEmailId === email.id
                      return (
                        <button
                          key={email.id}
                          className={`${styles.emailRow} ${expanded ? styles.emailRowExpanded : ''}`}
                          onClick={() => setExpandedEmailId((prev) => (prev === email.id ? null : email.id))}
                        >
                          <div className={styles.emailRowTop}>
                            <span className={styles.emailRowSubject}>{email.subject?.trim() || '(no subject)'}</span>
                            <span className={styles.emailRowTime}>{formatTime(email.receivedAt || email.sentAt)}</span>
                          </div>
                          <div className={styles.emailRowMeta}>
                            {email.fromName ? `${email.fromName} <${email.fromEmail}>` : email.fromEmail}
                          </div>
                          {expanded ? (
                            <div className={styles.emailRowBody}>
                              {email.bodyText?.trim()
                                || email.snippet?.trim()
                                || 'No email body available for this message.'}
                            </div>
                          ) : (
                            email.snippet && <div className={styles.emailRowSnippet}>{email.snippet}</div>
                          )}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
              <div className={styles.meta}>
                Click an email row to {expandedEmailId ? 'collapse/expand details' : 'expand details'}.
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'files' && (
        <div className={styles.section}>
          {files.length === 0 && (
            <div className={styles.empty}>No meeting files linked to this company yet.</div>
          )}
          <div className={styles.stack}>
            {files.map((file) => (
              <button
                key={file.id}
                className={styles.versionCard}
                onClick={() => navigate(`/meeting/${file.meetingId}`)}
              >
                <div className={styles.timelineTop}>
                  <strong>{file.title}</strong>
                  <span className={styles.timelineWhen}>{formatDateTime(file.date)}</span>
                </div>
                <div className={styles.timelineSubtitle}>
                  {[
                    file.status,
                    formatFileCoverage(file),
                    file.artifactCount > 0 ? `${file.artifactCount} artifacts` : null
                  ].filter(Boolean).join(' | ')}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {activeTab === 'notes' && (
        <div className={styles.section}>
          <div className={styles.editor}>
            <input
              className={styles.input}
              placeholder="Optional note title"
              value={noteTitle}
              onChange={(e) => setNoteTitle(e.target.value)}
            />
            <textarea
              className={styles.textarea}
              placeholder="Add company-specific notes, risks, and follow-ups"
              value={noteContent}
              onChange={(e) => setNoteContent(e.target.value)}
            />
            <button className={styles.primaryButton} onClick={handleAddNote}>
              Add Note
            </button>
          </div>

          <div className={styles.stack}>
            {notes.length === 0 && (
              <div className={styles.empty}>No notes yet for this company.</div>
            )}
            {notes.map((note) => (
              <div key={note.id} className={styles.noteCard}>
                <div className={styles.noteHeader}>
                  <strong>{note.title || 'Untitled note'}</strong>
                  <div className={styles.noteActions}>
                    <button className={styles.actionBtn} onClick={() => handleTogglePinNote(note)}>
                      {note.isPinned ? 'Unpin' : 'Pin'}
                    </button>
                    <button className={styles.actionBtn} onClick={() => handleDeleteNote(note.id)}>
                      Delete
                    </button>
                  </div>
                </div>
                <div className={styles.noteBody}>{note.content}</div>
                <div className={styles.noteMeta}>
                  Updated: {formatDateTime(note.updatedAt)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab === 'memo' && (
        <div className={styles.section}>
          {!memo && (
            <div className={styles.meta}>Loading memo...</div>
          )}
          {memo && (
            <>
              <div className={styles.memoToolbar}>
                <div>
                  <strong>{memo.title}</strong>
                  <div className={styles.noteMeta}>
                    Status: {memo.status} | Latest version: {memo.latestVersionNumber}
                  </div>
                </div>
                <div className={styles.memoActions}>
                  <select
                    className={styles.select}
                    value={memo.status}
                    onChange={(e) =>
                      handleMemoStatusChange(e.target.value as 'draft' | 'review' | 'final' | 'archived')
                    }
                  >
                    <option value="draft">Draft</option>
                    <option value="review">Review</option>
                    <option value="final">Final</option>
                    <option value="archived">Archived</option>
                  </select>
                  <button
                    className={styles.secondaryButton}
                    onClick={handleExportMemo}
                    disabled={exportingMemo}
                  >
                    {exportingMemo ? 'Exporting...' : 'Export PDF'}
                  </button>
                </div>
              </div>

              <textarea
                className={styles.memoEditor}
                value={memoDraft}
                onChange={(e) => setMemoDraft(e.target.value)}
                placeholder="Write investment memo in markdown"
              />
              <input
                className={styles.input}
                placeholder="Version note (optional)"
                value={memoChangeNote}
                onChange={(e) => setMemoChangeNote(e.target.value)}
              />
              <button
                className={styles.primaryButton}
                onClick={handleSaveMemo}
                disabled={savingMemo}
              >
                {savingMemo ? 'Saving...' : 'Save New Version'}
              </button>

              <div className={styles.stack}>
                {memoVersions.map((version) => (
                  <button
                    key={version.id}
                    className={styles.versionCard}
                    onClick={() => setMemoDraft(version.contentMarkdown)}
                  >
                    <div className={styles.timelineTop}>
                      <strong>Version {version.versionNumber}</strong>
                      <span className={styles.timelineWhen}>{formatDateTime(version.createdAt)}</span>
                    </div>
                    {version.changeNote && (
                      <div className={styles.timelineSubtitle}>{version.changeNote}</div>
                    )}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
