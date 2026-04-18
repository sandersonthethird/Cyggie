import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import remarkGfm from 'remark-gfm'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { InvestmentMemoVersion, InvestmentMemoVersionSummary, InvestmentMemoWithLatest } from '../../../shared/types/company'
import { MemoEditModal } from './MemoEditModal'
import { useFindInPage, injectFindMarks } from '../../hooks/useFindInPage'
import FindBar from '../common/FindBar'
import styles from './CompanyMemo.module.css'
import { api } from '../../api'

interface CompanyMemoProps {
  companyId: string
  className?: string
}

export function CompanyMemo({ companyId, className }: CompanyMemoProps) {
  const [memo, setMemo] = useState<InvestmentMemoWithLatest | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [progressText, setProgressText] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const [modalOpen, setModalOpen] = useState(false)

  const [exportingPdf, setExportingPdf] = useState(false)
  const [pdfMsg, setPdfMsg] = useState<string | null>(null)
  const pdfMsgTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [sharing, setSharing] = useState(false)
  const [shareUrl, setShareUrl] = useState<string | null>(null)
  const [shareToken, setShareToken] = useState<string | null>(null)
  const [shareError, setShareError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [revoking, setRevoking] = useState(false)

  const [findOpen, setFindOpen] = useState(false)

  // Version history state
  const [vhOpen, setVhOpen] = useState(false)
  const [vhLoading, setVhLoading] = useState(false)
  const [versions, setVersions] = useState<InvestmentMemoVersionSummary[]>([])
  const [viewingVersion, setViewingVersion] = useState<InvestmentMemoVersion | null>(null)
  const [loadingVersion, setLoadingVersion] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const vhTriggerRef = useRef<HTMLButtonElement>(null)
  const vhMenuRef = useRef<HTMLDivElement>(null)

  const displayedVersion = viewingVersion ?? memo?.latestVersion ?? null

  // Guard: Cmd+F must not open find in the background when modal is active
  const handleFindOpen = useCallback(
    () => { if (!modalOpen) setFindOpen(true) },
    [modalOpen]
  )

  // Close find when generation starts (prevents stale find reappearing after gen ends)
  useEffect(() => { if (generating) setFindOpen(false) }, [generating])

  const {
    query: findQuery,
    setQuery: setFindQuery,
    matchCount,
    activeMatchIndex,
    matches: findMatches,
    goToNext,
    goToPrev,
  } = useFindInPage({
    text: displayedVersion?.contentMarkdown ?? '',
    isOpen: findOpen,
    onOpen: handleFindOpen,
    onClose: () => setFindOpen(false),
  })

  // Clear share + version state when company changes
  useEffect(() => {
    setShareUrl(null)
    setShareToken(null)
    setShareError(null)
    setViewingVersion(null)
    setVhOpen(false)
  }, [companyId])

  useEffect(() => {
    return api.on(IPC_CHANNELS.INVESTMENT_MEMO_GENERATE_PROGRESS, (chunk) => {
      if (chunk === null) return
      setProgressText((prev) => prev + (chunk as string))
    })
  }, [])

  useEffect(() => {
    if (loaded) return
    window.api
      .invoke<InvestmentMemoWithLatest>(IPC_CHANNELS.INVESTMENT_MEMO_GET_OR_CREATE, companyId)
      .then((data) => setMemo(data))
      .catch(console.error)
      .finally(() => setLoaded(true))
  }, [companyId, loaded])

  // Click-outside-to-close for version dropdown
  useEffect(() => {
    if (!vhOpen) return
    function handle(e: MouseEvent) {
      if (
        vhMenuRef.current && !vhMenuRef.current.contains(e.target as Node) &&
        vhTriggerRef.current && !vhTriggerRef.current.contains(e.target as Node)
      ) {
        setVhOpen(false)
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [vhOpen])

  function handleSaved(version: InvestmentMemoVersion) {
    setMemo((prev) =>
      prev ? { ...prev, latestVersion: version, latestVersionNumber: version.versionNumber } : prev
    )
  }

  async function openVersionHistory() {
    if (vhOpen) { setVhOpen(false); return }
    if (!memo) return
    setVhLoading(true)
    setErrorMsg('')
    try {
      const list = await api.invoke<InvestmentMemoVersionSummary[]>(
        IPC_CHANNELS.INVESTMENT_MEMO_LIST_VERSIONS,
        memo.id,
        true
      )
      setVersions(list)
      setVhOpen(true)
    } catch (e) {
      console.error('[CompanyMemo] list versions failed:', e)
      setErrorMsg('Failed to load version history')
    } finally {
      setVhLoading(false)
    }
  }

  async function selectVersion(summary: InvestmentMemoVersionSummary) {
    if (summary.versionNumber === memo?.latestVersionNumber) {
      setViewingVersion(null)
      setVhOpen(false)
      return
    }
    setLoadingVersion(true)
    setErrorMsg('')
    setVhOpen(false)
    try {
      const version = await api.invoke<InvestmentMemoVersion | null>(
        IPC_CHANNELS.INVESTMENT_MEMO_GET_VERSION,
        summary.id
      )
      if (!version) {
        setErrorMsg('Version not found')
        return
      }
      setViewingVersion(version)
    } catch (e) {
      console.error('[CompanyMemo] get version failed:', e)
      setErrorMsg('Failed to load version')
    } finally {
      setLoadingVersion(false)
    }
  }

  async function restoreVersion() {
    if (!memo || !viewingVersion || restoring) return
    setRestoring(true)
    setErrorMsg('')
    try {
      const newVersion = await api.invoke<InvestmentMemoVersion>(
        IPC_CHANNELS.INVESTMENT_MEMO_SAVE_VERSION,
        memo.id,
        {
          contentMarkdown: viewingVersion.contentMarkdown,
          changeNote: `Restored from v${viewingVersion.versionNumber}`
        }
      )
      setMemo((prev) =>
        prev ? { ...prev, latestVersion: newVersion, latestVersionNumber: newVersion.versionNumber } : prev
      )
      setViewingVersion(null)
    } catch (e) {
      console.error('[CompanyMemo] restore failed:', e)
      setErrorMsg('Restore failed — try again')
    } finally {
      setRestoring(false)
    }
  }

  async function generate() {
    if (!memo) return
    setProgressText('')
    setErrorMsg('')
    setGenerating(true)
    setViewingVersion(null)
    try {
      const result = await api.invoke<{ contentMarkdown: string; version: InvestmentMemoVersion }>(
        IPC_CHANNELS.INVESTMENT_MEMO_GENERATE,
        companyId
      )
      if (!result?.contentMarkdown) {
        setErrorMsg('Generation returned empty content — try again')
        return
      }
      setMemo((prev) =>
        prev ? { ...prev, latestVersion: result.version, latestVersionNumber: result.version.versionNumber } : prev
      )
      setModalOpen(true)
    } catch (e) {
      console.error('[CompanyMemo] generate failed:', e)
      setErrorMsg('Generation failed — try again')
    } finally {
      setProgressText('')
      setGenerating(false)
    }
  }

  async function exportPdf() {
    if (!memo?.latestVersion || exportingPdf) return
    setExportingPdf(true)
    setPdfMsg(null)
    try {
      const result = await api.invoke<{ success: boolean; path: string }>(
        IPC_CHANNELS.INVESTMENT_MEMO_EXPORT_PDF,
        memo.id
      )
      if (result?.success) {
        const fileName = result.path.split('/').pop() ?? 'memo.pdf'
        setPdfMsg(`Saved: ${fileName}`)
        if (pdfMsgTimer.current) clearTimeout(pdfMsgTimer.current)
        pdfMsgTimer.current = setTimeout(() => setPdfMsg(null), 3000)
      } else {
        setPdfMsg('Export failed — try again')
      }
    } catch {
      setPdfMsg('Export failed — try again')
    } finally {
      setExportingPdf(false)
    }
  }

  async function share() {
    if (!memo?.latestVersion || sharing) return
    setSharing(true)
    setShareError(null)
    try {
      const result = await api.invoke<{ success: boolean; url: string; token: string; error?: string; message?: string }>(
        IPC_CHANNELS.INVESTMENT_MEMO_SHARE_LINK,
        memo.id
      )
      if (result?.success) {
        setShareUrl(result.url)
        setShareToken(result.token)
      } else {
        setShareError(result?.message ?? 'Share failed — try again')
      }
    } catch {
      setShareError('Share failed — try again')
    } finally {
      setSharing(false)
    }
  }

  async function copyLink() {
    if (!shareUrl) return
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API failed — select the URL text as fallback
      const el = document.getElementById('memo-share-url')
      if (el) {
        const range = document.createRange()
        range.selectNodeContents(el)
        window.getSelection()?.removeAllRanges()
        window.getSelection()?.addRange(range)
      }
    }
  }

  function openInBrowser() {
    if (!shareUrl) return
    window.api.invoke('shell:open-external', shareUrl)
  }

  async function revokeShare() {
    if (!shareToken || revoking) return
    setRevoking(true)
    try {
      await api.invoke(IPC_CHANNELS.INVESTMENT_MEMO_REVOKE_SHARE, shareToken)
      setShareUrl(null)
      setShareToken(null)
    } catch {
      // best-effort — clear local state anyway
      setShareUrl(null)
      setShareToken(null)
    } finally {
      setRevoking(false)
    }
  }

  function formatVersionDate(iso: string): string {
    const d = new Date(iso)
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
      ', ' +
      d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  }

  if (!loaded) return <div className={`${styles.root} ${className ?? ''}`}><div className={styles.loading}>Loading…</div></div>

  return (
    <div className={`${styles.root} ${className ?? ''}`}>
      <div className={styles.toolbar}>
        <button className={styles.btn} onClick={() => setModalOpen(true)} disabled={!memo || !!viewingVersion}>Edit</button>
        <button className={styles.btn} onClick={generate} disabled={generating || modalOpen || sharing || !!viewingVersion}>
          {generating && <span className={styles.spinner} />}
          {generating ? 'Generating…' : 'Generate with AI'}
        </button>
        <button
          className={styles.btn}
          onClick={exportPdf}
          disabled={!memo?.latestVersion || exportingPdf || generating || !!viewingVersion}
        >
          {exportingPdf && <span className={styles.spinner} />}
          {exportingPdf ? 'Exporting…' : 'Export PDF'}
        </button>
        {!shareUrl && (
          <button
            className={styles.btn}
            onClick={share}
            disabled={!memo?.latestVersion || sharing || generating || !!viewingVersion}
          >
            {sharing && <span className={styles.spinner} />}
            {sharing ? 'Sharing…' : 'Share'}
          </button>
        )}
        {errorMsg && <span className={styles.errorMsg}>{errorMsg}</span>}
        {pdfMsg && <span className={styles.errorMsg} style={{ color: pdfMsg.startsWith('Saved') ? 'var(--color-text-secondary)' : undefined }}>{pdfMsg}</span>}
        {shareError && <span className={styles.errorMsg}>{shareError}</span>}
        {memo && (
          <div className={styles.versionDropdownWrap}>
            <button
              ref={vhTriggerRef}
              className={styles.versionBtn}
              onClick={openVersionHistory}
              disabled={vhLoading}
            >
              {vhLoading && <span className={styles.spinner} />}
              v{memo.latestVersionNumber} ▾
            </button>
            {vhOpen && (
              <div ref={vhMenuRef} className={styles.versionMenu}>
                {versions.length === 0 ? (
                  <div className={styles.versionEmpty}>No version history yet</div>
                ) : versions.map((v) => (
                  <button
                    key={v.id}
                    className={`${styles.versionOption} ${
                      v.id === (viewingVersion?.id ?? memo.latestVersion?.id) ? styles.versionOptionActive : ''
                    }`}
                    onClick={() => selectVersion(v)}
                  >
                    <span className={styles.versionNum}>v{v.versionNumber}</span>
                    <span className={styles.versionDate}>{formatVersionDate(v.createdAt)}</span>
                    {v.changeNote && <span className={styles.versionNote}>{v.changeNote}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {shareUrl && <span className={styles.sharedBadge}>Shared</span>}
      </div>

      {viewingVersion && (
        <div className={styles.versionBanner}>
          <span className={styles.versionBannerText}>
            Viewing v{viewingVersion.versionNumber} · {formatVersionDate(viewingVersion.createdAt)}
            {viewingVersion.changeNote && ` · ${viewingVersion.changeNote}`}
          </span>
          <button className={styles.btn} onClick={() => setViewingVersion(null)}>Back to latest</button>
          <button className={styles.btnPrimary} onClick={restoreVersion} disabled={restoring}>
            {restoring && <span className={styles.spinner} />}
            {restoring ? 'Restoring…' : 'Restore this version'}
          </button>
        </div>
      )}

      {shareUrl && (
        <div className={styles.shareRow}>
          <span id="memo-share-url" className={styles.shareUrlText}>{shareUrl}</span>
          <button className={styles.btn} onClick={copyLink}>{copied ? 'Copied!' : 'Copy link'}</button>
          <button className={styles.btn} onClick={openInBrowser}>Open</button>
          <button className={styles.btn} onClick={revokeShare} disabled={revoking}>
            {revoking ? 'Revoking…' : 'Revoke'}
          </button>
        </div>
      )}

      {findOpen && (
        <FindBar
          query={findQuery}
          onQueryChange={setFindQuery}
          matchCount={matchCount}
          activeMatchIndex={activeMatchIndex}
          onNext={goToNext}
          onPrev={goToPrev}
          onClose={() => setFindOpen(false)}
        />
      )}

      <div className={styles.preview}>
        {generating ? (
          <pre className={styles.progressText}>{progressText || 'Starting generation…'}</pre>
        ) : loadingVersion ? (
          <div className={styles.loading}>Loading version…</div>
        ) : displayedVersion?.contentMarkdown ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>
            {injectFindMarks(displayedVersion.contentMarkdown, findMatches, activeMatchIndex)}
          </ReactMarkdown>
        ) : (
          <div className={styles.empty}>No memo content yet. Click Edit or Generate with AI to get started.</div>
        )}
      </div>

      {memo && modalOpen && (
        <MemoEditModal
          memo={memo}
          onSaved={handleSaved}
          onClose={() => setModalOpen(false)}
          initialFindQuery={findOpen ? findQuery : undefined}
        />
      )}
    </div>
  )
}
