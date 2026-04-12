import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import remarkGfm from 'remark-gfm'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { InvestmentMemoVersion, InvestmentMemoWithLatest } from '../../../shared/types/company'
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
    text: memo?.latestVersion?.contentMarkdown ?? '',
    isOpen: findOpen,
    onOpen: handleFindOpen,
    onClose: () => setFindOpen(false),
  })

  // Clear share state when company changes
  useEffect(() => {
    setShareUrl(null)
    setShareToken(null)
    setShareError(null)
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

  function handleSaved(version: InvestmentMemoVersion) {
    setMemo((prev) =>
      prev ? { ...prev, latestVersion: version, latestVersionNumber: version.versionNumber } : prev
    )
  }

  async function generate() {
    if (!memo) return
    setProgressText('')
    setErrorMsg('')
    setGenerating(true)
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

  if (!loaded) return <div className={`${styles.root} ${className ?? ''}`}><div className={styles.loading}>Loading…</div></div>

  return (
    <div className={`${styles.root} ${className ?? ''}`}>
      <div className={styles.toolbar}>
        <button className={styles.btn} onClick={() => setModalOpen(true)} disabled={!memo}>Edit</button>
        <button className={styles.btn} onClick={generate} disabled={generating || modalOpen || sharing}>
          {generating && <span className={styles.spinner} />}
          {generating ? 'Generating…' : 'Generate with AI'}
        </button>
        <button
          className={styles.btn}
          onClick={exportPdf}
          disabled={!memo?.latestVersion || exportingPdf || generating}
        >
          {exportingPdf && <span className={styles.spinner} />}
          {exportingPdf ? 'Exporting…' : 'Export PDF'}
        </button>
        {!shareUrl && (
          <button
            className={styles.btn}
            onClick={share}
            disabled={!memo?.latestVersion || sharing || generating}
          >
            {sharing && <span className={styles.spinner} />}
            {sharing ? 'Sharing…' : 'Share'}
          </button>
        )}
        {errorMsg && <span className={styles.errorMsg}>{errorMsg}</span>}
        {pdfMsg && <span className={styles.errorMsg} style={{ color: pdfMsg.startsWith('Saved') ? 'var(--color-text-secondary)' : undefined }}>{pdfMsg}</span>}
        {shareError && <span className={styles.errorMsg}>{shareError}</span>}
        {memo && <span className={styles.version}>v{memo.latestVersionNumber}</span>}
        {shareUrl && <span className={styles.sharedBadge}>Shared</span>}
      </div>

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
        ) : memo?.latestVersion?.contentMarkdown ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>
            {injectFindMarks(memo.latestVersion.contentMarkdown, findMatches, activeMatchIndex)}
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
