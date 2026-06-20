import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import Link from '@tiptap/extension-link'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { InvestmentMemoVersion, InvestmentMemoVersionSummary, InvestmentMemoWithLatest, MemoGenerateMeta, MemoPreflightResult } from '../../../shared/types/company'
import { MemoEditModal } from './MemoEditModal'
import { useNotice } from '../common/NoticeModal'
import LargeContextWarningModal from './LargeContextWarningModal'
import { useFindInPage } from '../../hooks/useFindInPage'
import { useTiptapFindHighlight } from '../../hooks/useTiptapFindHighlight'
import { useTiptapMarkdown } from '../../hooks/useTiptapMarkdown'
import { TABLE_EXTENSIONS } from '../../lib/tiptap-extensions'
import { FindHighlight } from '../../lib/find-highlight-extension'
import { CritiqueHighlight } from './CritiqueHighlight'
import { EvidenceSidebar } from './EvidenceSidebar'
import { ResearchLog } from './ResearchLog'
import { MemoSectionProgress } from './MemoSectionProgress'
import { MemoSectionsNav } from './MemoSectionsNav'
import IncorporateCallModal, { type NewMeetingRef as IncorpMeetingRef } from './IncorporateCallModal'
import { CitationHoverLayer } from './CitationHoverLayer'
import { StressTestReportViewer } from './StressTestReportViewer'
import { StressTestReportsSubpanel } from './StressTestReportsSubpanel'
import type { StressTestReport } from '../../../shared/types/stress-test-report'
import { useMemoEvidence } from '../../hooks/useMemoEvidence'
import { preprocessMemoCitations } from '../../lib/memo-citation-preprocessor'
import { useRunForCompany, useRuns } from '../../contexts/RunsContext'
import FindBar from '../common/FindBar'
import { Spinner } from '../common/Spinner'
import styles from './CompanyMemo.module.css'
import { api } from '../../api'

import type { StoredMemoEvidence } from '../../../shared/types/memo-evidence'

interface CompanyMemoProps {
  companyId: string
  className?: string
}

export function CompanyMemo({ companyId, className }: CompanyMemoProps) {
  const notice = useNotice()
  const [memo, setMemo] = useState<InvestmentMemoWithLatest | null>(null)
  const [latestGenerateMeta, setLatestGenerateMeta] = useState<MemoGenerateMeta | null>(null)
  // Pre-flight modal: when generation context will be large, show file
  // breakdown + cost estimate and let the user Cancel/Continue.
  const [largeContextModal, setLargeContextModal] = useState<{
    preflight: MemoPreflightResult
    onConfirm: () => void
    onCancel: () => void
  } | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [progressText, setProgressText] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  // Incorporate-new-material flow: discovery result + which meetingIds the user
  // confirmed (kept so the triage-failed section-pick can re-run with them).
  const [incorporateModal, setIncorporateModal] = useState<{
    phase: 'confirm' | 'pick'
    meetings: IncorpMeetingRef[]
    noteCount: number
    emailCount: number
    sectionOptions: string[]
  } | null>(null)
  const [incorporating, setIncorporating] = useState(false)
  const pendingIncorporateMeetingIds = useRef<string[]>([])

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
  const isUntouchedTemplate =
    !viewingVersion &&
    memo?.latestVersionNumber === 1 &&
    memo?.latestVersion?.changeNote === 'Initial draft'

  // Read-only TipTap editor for the memo preview. Recreated on company switch
  // and on version switch so it loads the right content for the active version.
  // Find matches are pushed into FindHighlight as <mark> decorations (matching
  // the same wiring on MeetingDetail's summary card).
  const { editor: memoEditor, loadContent: loadMemoContent } = useTiptapMarkdown(
    {
      extensions: [
        StarterKit,
        Markdown,
        Link.configure({ openOnClick: true }),
        ...TABLE_EXTENSIONS,
        FindHighlight,
        CritiqueHighlight,
      ],
      editable: false,
    },
    [companyId, displayedVersion?.id],
  )

  // Load evidence rows for the active version. Drives critique heatmap,
  // hover sidebar, section-source popover, AND the inline citation
  // preprocessor.
  const { evidence, loaded: evidenceLoaded } = useMemoEvidence(displayedVersion?.id)

  // Rewrite `[source: <url>]` → `[¹](<url>)` before loading into TipTap, so
  // hovering a citation in the rendered memo can resolve back to its
  // evidence row. bySource is the URL→rows lookup the hover layer consumes.
  const {
    processedMarkdown: processedMemoMarkdown,
    bySource: citationBySource,
    citationUrls,
  } = useMemo(() => {
    const raw = displayedVersion?.contentMarkdown ?? ''
    if (!raw) {
      return {
        processedMarkdown: '',
        bySource: new Map<string, readonly import('../../../shared/types/memo-evidence').StoredMemoEvidence[]>(),
        citationUrls: new Set<string>(),
      }
    }
    const result = preprocessMemoCitations(raw, evidence)
    // Set of canonical URLs the preprocessor rewrote. The hover layer uses
    // this as its discriminator (rather than bySource) so citation markers
    // without matching evidence rows still get the minimal domain popover.
    const urls = new Set(result.citationNumber.keys())
    return { ...result, citationUrls: urls }
  }, [displayedVersion?.contentMarkdown, evidence])

  // Load the active version's markdown into the editor whenever it changes.
  // BLOCK on evidence load completing so the citation preprocessor sees the
  // matching evidence rows and rewrites `[source: url]` → `[¹](url)` BEFORE
  // TipTap's first setContent. Otherwise the user briefly sees raw [source:]
  // text, then a content swap resets scroll + find-in-page state.
  // The editor is recreated on the deps above, so this fires once per recreation.
  useEffect(() => {
    if (!memoEditor) return
    if (!evidenceLoaded) return
    loadMemoContent(processedMemoMarkdown)
  }, [memoEditor, processedMemoMarkdown, evidenceLoaded]) // eslint-disable-line react-hooks/exhaustive-deps

  // Guard: Cmd+F must not open find in the background when modal is active
  const handleFindOpen = useCallback(
    () => { if (!modalOpen) setFindOpen(true) },
    [modalOpen]
  )

  // Close find when generation starts (prevents stale find reappearing after gen ends)
  useEffect(() => { if (generating) setFindOpen(false) }, [generating])

  // Feed editor.state.doc.textContent (NOT editor.getText() — see find-highlight-extension.ts
  // header for why) so match offsets align with FindHighlight's cursor walk.
  // Falls back to the raw markdown while the editor mounts so find still has a target text.
  const findTargetText = memoEditor
    ? memoEditor.state.doc.textContent
    : (displayedVersion?.contentMarkdown ?? '')

  const {
    query: findQuery,
    setQuery: setFindQuery,
    matchCount,
    activeMatchIndex,
    matches: findMatches,
    goToNext,
    goToPrev,
  } = useFindInPage({
    text: findTargetText,
    isOpen: findOpen,
    onOpen: handleFindOpen,
    onClose: () => setFindOpen(false),
  })

  // Push matches into the editor's FindHighlight extension as <mark> decorations.
  useTiptapFindHighlight(memoEditor, findMatches, activeMatchIndex)

  // Clear share + version state when company changes
  useEffect(() => {
    setShareUrl(null)
    setShareToken(null)
    setShareError(null)
    setViewingVersion(null)
    setVhOpen(false)
  }, [companyId])

  // ─── Stress-test agent integration ────────────────────────────────────
  const runs = useRuns()
  const stressRun = useRunForCompany('thesis_stress_test', companyId)
  const stressInFlight = stressRun?.status === 'running'

  // ─── Memo producer agent integration ──────────────────────────────────
  // The producer agent broadcasts AgentEvents (including section_started /
  // section_completed) on the same THESIS_STRESS_TEST_PROGRESS channel that
  // RunsContext listens to. We pick out the producer run for this company
  // here so the MemoSectionProgress component can render section state.
  const producerRun = useRunForCompany('memo_producer', companyId)
  const producerInFlight = producerRun?.status === 'running'

  // Cost badge: running average across recent stress-test runs for this company.
  const [costEstimate, setCostEstimate] = useState<number | null>(null)
  useEffect(() => {
    void api
      .invoke<number | null>(IPC_CHANNELS.AGENT_RUNS_AVERAGE_COST, {
        kind: 'thesis_stress_test',
        companyId,
        lastN: 10,
      })
      .then(avg => setCostEstimate(avg))
      .catch(() => setCostEstimate(null))
  }, [companyId, stressRun?.status])

  // After a stress-test completes, open the report viewer with the newly
  // saved report. Memo is NEVER mutated by stress-test under the new product
  // model, so we do NOT auto-open the edit modal (Edit button still works).
  // The versionId field on the 'done' event carries the new stress_test_report
  // id (agent_runs.result_version_id is reused as a generic artifact ref).
  const [activeStressReportId, setActiveStressReportId] = useState<string | null>(null)
  const [activeStressReport, setActiveStressReport] = useState<StressTestReport | null>(null)
  const [stressReportsRefreshKey, setStressReportsRefreshKey] = useState(0)
  // Latest report id for THIS memo, used to drive the "Reports" button in the
  // MemoSectionsNav (only rendered when a report exists). Independent of the
  // post-completion auto-open path — this stays populated across navigation
  // and refresh, so the user always has a one-click way back to the report.
  const [latestStressReportId, setLatestStressReportId] = useState<string | null>(null)
  useEffect(() => {
    return runs.onCompletion(run => {
      if (run.kind !== 'thesis_stress_test' || run.companyId !== companyId) return
      if (run.status === 'success' && run.versionId) {
        setActiveStressReportId(run.versionId)
        setStressReportsRefreshKey(k => k + 1)
        // Toast banner so the user always sees the run finished, even if
        // they were on a different tab when the agent returned.
        notice.show({
          variant: 'success',
          title: 'Stress-test complete',
          message: 'Report saved. Click "Reports" in the Sections bar to view, or scroll to the Stress-test reports section.',
        })
      }
    })
  }, [runs, companyId, notice])

  // Fetch the full report when a stress-test just completed.
  useEffect(() => {
    if (!activeStressReportId) return
    let cancelled = false
    void (async () => {
      try {
        const full = await api.invoke<StressTestReport | null>(
          IPC_CHANNELS.STRESS_TEST_REPORT_GET,
          activeStressReportId,
        )
        if (!cancelled && full) setActiveStressReport(full)
      } catch (err) {
        console.error('[stress-test-report] fetch after run failed:', err)
      }
    })()
    return () => { cancelled = true }
  }, [activeStressReportId])

  // Track the LATEST report id for this memo. Drives the "Reports" button
  // in MemoSectionsNav (visible only when a report exists). Refreshes when
  // the memo changes or after a new stress-test run persists.
  useEffect(() => {
    if (!memo?.id) {
      setLatestStressReportId(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const list = await api.invoke<Array<{ id: string }>>(
          IPC_CHANNELS.STRESS_TEST_REPORT_LIST,
          memo.id,
        )
        if (cancelled) return
        setLatestStressReportId(list && list.length > 0 ? list[0].id : null)
      } catch (err) {
        console.error('[stress-test-report] list-for-button failed:', err)
        if (!cancelled) setLatestStressReportId(null)
      }
    })()
    return () => { cancelled = true }
  }, [memo?.id, stressReportsRefreshKey])

  // Click handler for the Reports button: opens the viewer with the latest report.
  const openLatestReport = useCallback(() => {
    if (!latestStressReportId) return
    setActiveStressReportId(latestStressReportId)
  }, [latestStressReportId])

  // (evidence + preprocessed-markdown moved earlier in the component so they
  // can feed the loadMemoContent useEffect; see top of body.)

  // Push critique claim_text strings into TipTap as decorations (red wavy underline).
  const critiqueClaims = useMemo(
    () => evidence.filter(e => e.isCritique).map(e => e.claimText),
    [evidence]
  )
  useEffect(() => {
    if (!memoEditor) return
    memoEditor.commands.setCritiqueClaims(critiqueClaims)
  }, [memoEditor, critiqueClaims])

  // Right-click context-menu lookup: when the user right-clicks anywhere in
  // the rendered memo, capture the selection (or fall back to the closest
  // sentence) and open the EvidenceSidebar focused on it.
  const [activeClaim, setActiveClaim] = useState<string>('')
  const memoBodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = memoBodyRef.current
    if (!el) return
    function handleContextMenu(e: MouseEvent) {
      const selection = window.getSelection()?.toString().trim()
      if (selection && selection.length >= 6) {
        e.preventDefault()
        setActiveClaim(selection)
      }
    }
    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement
      if (target.classList.contains('critique-highlight')) {
        const text = target.textContent?.trim() ?? ''
        if (text) setActiveClaim(text)
      }
    }
    el.addEventListener('contextmenu', handleContextMenu)
    el.addEventListener('click', handleClick)
    return () => {
      el.removeEventListener('contextmenu', handleContextMenu)
      el.removeEventListener('click', handleClick)
    }
  }, [memoEditor])

  async function stressTest() {
    if (!memo?.latestVersion?.contentMarkdown) return
    if ((memo.latestVersion.contentMarkdown ?? '').trim().length < 200) {
      setErrorMsg('Memo is too short to stress-test — generate a memo first')
      return
    }
    setErrorMsg('')
    try {
      const result = await api.invoke<{ runId: string }>(
        IPC_CHANNELS.THESIS_STRESS_TEST_START,
        { companyId },
      )
      // RunsContext picks up the run via the 'started' AgentEvent.
      // result.runId is also the in-flight controller key.
      void result
    } catch (e) {
      setErrorMsg((e instanceof Error && e.message) || 'Stress-test failed to start')
    }
  }

  async function abortStressTest() {
    if (!stressRun) return
    await runs.abortRun(stressRun.runId)
  }
  // ──────────────────────────────────────────────────────────────────────

  useEffect(() => {
    return api.on(IPC_CHANNELS.INVESTMENT_MEMO_GENERATE_PROGRESS, (chunk) => {
      if (chunk === null) return
      setProgressText((prev) => prev + (chunk as string))
    })
  }, [])

  useEffect(() => { setLoaded(false) }, [companyId])

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
      // Pre-flight: cheap context-size check. When estimated total context
      // exceeds LARGE_CONTEXT_WARNING_CHARS, show the warning modal so the
      // user can deselect files (via the Files tab) before paying the LLM cost.
      let preflight: MemoPreflightResult | null = null
      try {
        preflight = await api.invoke<MemoPreflightResult>(
          IPC_CHANNELS.INVESTMENT_MEMO_PREFLIGHT,
          companyId,
        )
      } catch (preflightErr) {
        // Preflight failure is non-fatal — proceed to generate without warning.
        console.warn('[CompanyMemo] preflight failed:', preflightErr)
      }

      if (preflight?.willTriggerWarning) {
        const confirmed = await new Promise<boolean>(resolve => {
          setLargeContextModal({
            preflight: preflight!,
            onConfirm: () => resolve(true),
            onCancel: () => resolve(false),
          })
        })
        setLargeContextModal(null)
        if (!confirmed) {
          // User declined; bail without firing GENERATE.
          return
        }
      }

      const result = await api.invoke<{
        success: boolean
        contentMarkdown?: string
        version?: InvestmentMemoVersion
        /** Optional in case an old main bundle is running while renderer is fresh during dev hot-reload. */
        meta?: MemoGenerateMeta
        /** Set when the user clicked Cancel mid-generation. */
        error?: 'aborted' | string
      }>(
        IPC_CHANNELS.INVESTMENT_MEMO_GENERATE,
        companyId
      )

      const classified = classifyGenerateResponse(result)
      if (classified.kind === 'aborted') {
        // Cancel mid-generation: silent return (no toast, no error state).
        return
      }
      if (classified.kind === 'error') {
        // Surface the producer agent's real failure reason (bad key, API
        // error, too few sections, …) instead of the generic empty message.
        setErrorMsg(classified.message)
        return
      }
      if (classified.kind === 'empty') {
        setErrorMsg('Generation returned empty content — try again')
        return
      }
      // classified.kind === 'success'
      setMemo((prev) =>
        prev ? { ...prev, latestVersion: classified.version, latestVersionNumber: classified.version.versionNumber } : prev
      )
      if (classified.meta) {
        setLatestGenerateMeta(classified.meta)
        // Toast when pre-research had nothing to query (truly empty company:
        // no nicheSignal, no description, no industry, no founders).
        const toast = emptyResearchToastOptions(classified.meta)
        if (toast) notice.show(toast)
      }
      setModalOpen(true)
    } catch (e) {
      console.error('[CompanyMemo] generate failed:', e)
      setErrorMsg('Generation failed — try again')
    } finally {
      setProgressText('')
      setGenerating(false)
    }
  }

  /**
   * Cancel an in-flight memo generation. Fires the abort IPC; the main
   * process aborts the AbortController, in-flight Exa + LLM calls reject
   * with AbortError, the GENERATE handler returns { success: false,
   * error: 'aborted' }, and our generate() try/catch handles it silently.
   */
  async function cancelGenerate() {
    try {
      await api.invoke(IPC_CHANNELS.INVESTMENT_MEMO_GENERATE_ABORT, companyId)
    } catch (e) {
      console.warn('[CompanyMemo] cancel failed:', e)
    }
  }

  /**
   * Incorporate-new-material: discover meetings/notes/emails added since the
   * last memo version, then open the confirm modal. The actual run happens in
   * runIncorporate() once the user confirms.
   */
  async function openIncorporate() {
    if (!memo || incorporating || generating) return
    setErrorMsg('')
    try {
      const disc = await api.invoke<{
        hasMemo: boolean
        sinceIso: string | null
        meetings: IncorpMeetingRef[]
        noteCount: number
        emailCount: number
      }>(IPC_CHANNELS.INVESTMENT_MEMO_LIST_NEW_MATERIAL, companyId)
      if (!disc.hasMemo) {
        notice.show({ variant: 'success', title: 'No memo yet', message: 'Generate a memo first, then you can incorporate new calls into it.' })
        return
      }
      if (disc.meetings.length === 0 && disc.noteCount === 0 && disc.emailCount === 0) {
        notice.show({ variant: 'success', title: 'Nothing new', message: 'No new calls, notes, or emails since the last memo version.' })
        return
      }
      setIncorporateModal({
        phase: 'confirm',
        meetings: disc.meetings,
        noteCount: disc.noteCount,
        emailCount: disc.emailCount,
        sectionOptions: [],
      })
    } catch (e) {
      console.error('[CompanyMemo] list-new-material failed:', e)
      setErrorMsg('Could not check for new material — try again')
    }
  }

  /**
   * Run the targeted incorporate. `sections` is set only on the manual-pick
   * fallback path (after triage returned `needsSectionPick`). On success the
   * memo's latest version is swapped in place, exactly like generate().
   */
  async function runIncorporate(meetingIds: string[], sections?: string[]) {
    pendingIncorporateMeetingIds.current = meetingIds
    setIncorporating(true)
    setErrorMsg('')
    try {
      const result = await api.invoke<{
        success?: boolean
        needsSectionPick?: boolean
        sections?: string[]
        contentMarkdown?: string
        version?: InvestmentMemoVersion
        meta?: MemoGenerateMeta & { sectionsSubmitted?: string[] }
        error?: string
        errorCode?: string
        aborted?: boolean
      }>(IPC_CHANNELS.INVESTMENT_MEMO_INCORPORATE_CALL, { companyId, meetingIds, sections })

      if (result.aborted) { setIncorporateModal(null); return }
      if (result.needsSectionPick) {
        // Triage failed → switch the open modal to manual section pick (re-runs
        // with the same confirmed meetingIds).
        setIncorporateModal((prev) =>
          prev ? { ...prev, phase: 'pick', sectionOptions: result.sections ?? [] } : prev,
        )
        return
      }
      if (result.errorCode === 'no_changes') {
        setIncorporateModal(null)
        notice.show({ variant: 'success', title: 'No changes', message: 'The new material didn’t change any sections.' })
        return
      }
      const classified = classifyGenerateResponse(result)
      if (classified.kind === 'aborted') { setIncorporateModal(null); return }
      if (classified.kind === 'error') { setErrorMsg(classified.message); setIncorporateModal(null); return }
      if (classified.kind === 'empty') { setErrorMsg('Update returned empty content — try again'); setIncorporateModal(null); return }
      // success
      setMemo((prev) =>
        prev ? { ...prev, latestVersion: classified.version, latestVersionNumber: classified.version.versionNumber } : prev,
      )
      if (classified.meta) setLatestGenerateMeta(classified.meta)
      setIncorporateModal(null)
      const n = result.meta?.sectionsSubmitted?.length
      notice.show({
        variant: 'success',
        title: 'Memo updated',
        message: n ? `Updated ${n} section${n === 1 ? '' : 's'} from the new material.` : 'Memo updated from the new material.',
      })
    } catch (e) {
      console.error('[CompanyMemo] incorporate failed:', e)
      setErrorMsg('Incorporate failed — try again')
      setIncorporateModal(null)
    } finally {
      setIncorporating(false)
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
    window.api.invoke(IPC_CHANNELS.APP_OPEN_EXTERNAL_URL, shareUrl)
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
          {generating && <Spinner size="sm" />}
          {generating ? 'Generating…' : 'Generate with AI'}
        </button>
        {generating && (
          <button
            className={styles.btn}
            onClick={cancelGenerate}
            title="Cancel in-flight memo generation"
          >
            Cancel
          </button>
        )}
        <button
          className={styles.btn}
          onClick={openIncorporate}
          disabled={!memo?.latestVersion || generating || incorporating || modalOpen || sharing || !!viewingVersion}
          title="Fold new calls, notes, or emails since the last memo into the affected sections (cheaper than a full regenerate)"
        >
          {incorporating && <Spinner size="sm" />}
          {incorporating ? 'Incorporating…' : 'Incorporate new call'}
        </button>
        <button
          className={styles.btn}
          onClick={stressInFlight ? abortStressTest : stressTest}
          disabled={
            !memo?.latestVersion?.contentMarkdown ||
            (memo.latestVersion.contentMarkdown ?? '').trim().length < 200 ||
            generating ||
            modalOpen ||
            !!viewingVersion
          }
          title={stressInFlight ? 'Cancel stress-test' : 'Adversarial review of the existing memo'}
        >
          {stressInFlight && <Spinner size="sm" />}
          {stressInFlight ? 'Cancel stress-test' : 'Stress-test'}
          {!stressInFlight && costEstimate != null ? (
            <span className={styles.costBadge}>~${costEstimate.toFixed(2)}</span>
          ) : null}
        </button>
        <button
          className={styles.btn}
          onClick={exportPdf}
          disabled={!memo?.latestVersion || exportingPdf || generating || !!viewingVersion}
        >
          {exportingPdf && <Spinner size="sm" />}
          {exportingPdf ? 'Exporting…' : 'Export PDF'}
        </button>
        {!shareUrl && (
          <button
            className={styles.btn}
            onClick={share}
            disabled={!memo?.latestVersion || sharing || generating || !!viewingVersion}
          >
            {sharing && <Spinner size="sm" />}
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
              {vhLoading && <Spinner size="sm" />}
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
            {restoring && <Spinner size="sm" />}
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

      {stressRun && (stressInFlight || stressRun.status !== 'success' || stressRun.events.length > 0) && (
        <ResearchLog run={stressRun} />
      )}

      {/* Section-refresh nav (Delight #5). Only shown when we have a
          displayable memo (not during initial generation; not on empty
          template). Refresh in flight reuses the per-company mutex with
          legacy GENERATE — disabled while either is running. */}
      {!generating && displayedVersion?.contentMarkdown && !isUntouchedTemplate && (
        <MemoSectionsNav
          companyId={companyId}
          markdown={displayedVersion.contentMarkdown}
          evidence={evidence}
          busy={generating || producerInFlight}
          onSectionRefreshed={(version) => {
            setMemo((prev) =>
              prev
                ? { ...prev, latestVersion: version, latestVersionNumber: version.versionNumber }
                : prev,
            )
          }}
          onError={(msg) => setErrorMsg(msg)}
          onOpenSidebar={setActiveClaim}
          hasStressTestReport={latestStressReportId !== null}
          onOpenLatestReport={openLatestReport}
        />
      )}

      <div className={styles.preview} ref={memoBodyRef}>
        {generating ? (
          // Section-by-section progress when the producer agent is the
          // active backend; falls back to the legacy text-stream preview
          // for the legacy single-call path.
          producerRun && producerRun.events.length > 0 ? (
            <MemoSectionProgress events={producerRun.events} status={producerRun.status} />
          ) : (
            <pre className={styles.progressText}>{progressText || 'Starting generation…'}</pre>
          )
        ) : loadingVersion ? (
          <div className={styles.loading}>Loading version…</div>
        ) : isUntouchedTemplate || !displayedVersion?.contentMarkdown ? (
          <div className={styles.empty}>No memo yet. Click Generate with AI to create one.</div>
        ) : (
          <EditorContent editor={memoEditor} />
        )}
      </div>

      {memo?.id && !generating && (
        <StressTestReportsSubpanel
          memoId={memo.id}
          refreshKey={stressReportsRefreshKey}
        />
      )}

      {/* Hover layer for inline `[¹](url)` citations (Delight #4). Only mounts
          when there's at least one citation→evidence match, so plain memos
          without citations don't attach listeners. */}
      {!generating && displayedVersion?.contentMarkdown && citationUrls.size > 0 && (
        <CitationHoverLayer
          containerRef={memoBodyRef}
          bySource={citationBySource}
          citationUrls={citationUrls}
        />
      )}

      {latestGenerateMeta && displayedVersion?.id === memo?.latestVersion?.id && (
        <SourcesUsedFooter meta={latestGenerateMeta} />
      )}

      <EvidenceSidebar
        versionId={displayedVersion?.id ?? null}
        activeClaim={activeClaim}
        onClose={() => setActiveClaim('')}
      />

      {memo && modalOpen && (
        <MemoEditModal
          memo={memo}
          onSaved={handleSaved}
          onClose={() => setModalOpen(false)}
          initialFindQuery={findOpen ? findQuery : undefined}
        />
      )}

      <LargeContextWarningModal
        open={largeContextModal !== null}
        preflight={largeContextModal?.preflight ?? null}
        onConfirm={() => largeContextModal?.onConfirm()}
        onCancel={() => largeContextModal?.onCancel()}
      />

      {activeStressReport && (
        <StressTestReportViewer
          report={activeStressReport}
          onClose={() => {
            setActiveStressReport(null)
            setActiveStressReportId(null)
          }}
        />
      )}

      {incorporateModal && (
        <IncorporateCallModal
          phase={incorporateModal.phase}
          meetings={incorporateModal.meetings}
          noteCount={incorporateModal.noteCount}
          emailCount={incorporateModal.emailCount}
          sectionOptions={incorporateModal.sectionOptions}
          busy={incorporating}
          onConfirm={(meetingIds) => runIncorporate(meetingIds)}
          onPickSections={(sections) => runIncorporate(pendingIncorporateMeetingIds.current, sections)}
          onCancel={() => { if (!incorporating) setIncorporateModal(null) }}
        />
      )}
    </div>
  )
}

/**
 * Build the "Based on N meetings, M notes…" sentence from a MemoGenerateMeta.
 * Pure function, exported for testing. Returns null when the meta has no
 * non-zero counts (would render an empty footer).
 */
export function buildSourcesUsedSentence(meta: MemoGenerateMeta): string | null {
  const parts: string[] = []
  if (meta.meetingCount > 0) parts.push(`${meta.meetingCount} ${meta.meetingCount === 1 ? 'meeting' : 'meetings'}`)
  const totalNotes = meta.companyNoteCount + meta.contactNoteCount
  if (totalNotes > 0) {
    const breakdown = meta.contactNoteCount > 0 ? ` (${meta.contactNoteCount} contact-tagged)` : ''
    parts.push(`${totalNotes} ${totalNotes === 1 ? 'note' : 'notes'}${breakdown}`)
  }
  if (meta.fileCount > 0) parts.push(`${meta.fileCount} ${meta.fileCount === 1 ? 'file' : 'files'}`)
  if (meta.emailCount > 0) parts.push(`${meta.emailCount} ${meta.emailCount === 1 ? 'email' : 'emails'}`)
  if (meta.externalResearchQueryCount > 0) {
    parts.push(`${meta.externalResearchQueryCount} web ${meta.externalResearchQueryCount === 1 ? 'search' : 'searches'}`)
  }
  if (parts.length === 0) return null
  return `Based on ${parts.join(', ')}.`
}

/**
 * Decide whether to fire the "skipped web research" toast. Pure decision
 * function so tests can call it directly without rendering. Returns the
 * notice options (or null when no toast should fire).
 */
export function emptyResearchToastOptions(
  meta: MemoGenerateMeta | null | undefined,
): { variant: 'success'; title: string; message: string } | null {
  if (!meta) return null
  if (meta.externalResearchQueryCount > 0) return null
  return {
    variant: 'success',
    title: 'Memo generated',
    message: 'Skipped web research — not enough company info yet',
  }
}

/**
 * Classify a GENERATE IPC response into one of three outcomes the renderer
 * cares about. Pure function so tests can verify the cancel/empty/success
 * branches without rendering CompanyMemo (which has TipTap + RunsContext +
 * dozens of hooks — too heavy for a direct render test).
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │  Inputs                          → Outcome                    │
 *   │  result.error === 'aborted'      → 'aborted' (silent return,  │
 *   │                                     no error toast)            │
 *   │  success === false (w/ message)  → 'error' (show real reason)  │
 *   │  no contentMarkdown / no version → 'empty' (generic error)     │
 *   │  otherwise                       → 'success' (commit version) │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * The 'error' branch surfaces the producer agent's real failure reason
 * (e.g. "No Claude API key configured…", TooFewSections, an API 4xx) instead
 * of masking every failure as generic empty content — which previously made
 * configuration problems undiagnosable.
 */
export type GenerateResponseClassification =
  | { kind: 'aborted' }
  | { kind: 'empty' }
  | { kind: 'error'; message: string }
  | { kind: 'success'; contentMarkdown: string; version: InvestmentMemoVersion; meta?: MemoGenerateMeta }

export function classifyGenerateResponse(result: {
  success?: boolean
  contentMarkdown?: string
  version?: InvestmentMemoVersion
  meta?: MemoGenerateMeta
  error?: 'aborted' | string
} | null | undefined): GenerateResponseClassification {
  if (!result) return { kind: 'empty' }
  if (result.error === 'aborted') return { kind: 'aborted' }
  if (result.success === false) {
    return { kind: 'error', message: result.error || 'Generation failed — try again' }
  }
  if (!result.contentMarkdown || !result.version) return { kind: 'empty' }
  return {
    kind: 'success',
    contentMarkdown: result.contentMarkdown,
    version: result.version,
    meta: result.meta,
  }
}

/**
 * Small footer below the rendered memo summarizing the sources the LLM
 * actually saw. Renders only when a fresh generation just happened (we have
 * a meta) AND we're viewing the latest version. Drops when the user
 * navigates to an older version (the meta describes the latest generation,
 * not arbitrary historical versions).
 */
export function SourcesUsedFooter({ meta }: { meta: MemoGenerateMeta }) {
  const sentence = buildSourcesUsedSentence(meta)
  if (!sentence) return null
  return (
    <div className={styles.sourcesFooter} role="note" aria-label="Sources used to generate this memo">
      {sentence}
    </div>
  )
}
