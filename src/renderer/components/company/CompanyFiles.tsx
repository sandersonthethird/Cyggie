import { useEffect, useMemo, useRef, useState } from 'react'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { CompanyDriveFileRef } from '../../../shared/types/company'
import styles from './CompanyFiles.module.css'
import { api } from '../../api'

interface CompanyFilesLookupResult {
  companyRoot: string | null
  files: CompanyDriveFileRef[]
}

interface CompanyFilesProps {
  companyId: string
  className?: string
}

type ToggleResult =
  | { ok: true; flagged: boolean }
  | {
      ok: false
      code: 'MISSING' | 'UNSUPPORTED_FORMAT' | 'TOO_LARGE' | 'DRIVE_SCOPE_INSUFFICIENT'
      message: string
    }

const FLAGGABLE_EXTENSIONS = new Set(['pdf', 'txt', 'md', 'csv', 'docx', 'xlsx'])
const GOOGLE_NATIVE_MIMES = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
])

function isFlaggable(file: CompanyDriveFileRef): boolean {
  if (!file.id || file.mimeType === 'folder') return false
  if (GOOGLE_NATIVE_MIMES.has(file.mimeType)) return true
  const dot = file.name.lastIndexOf('.')
  if (dot < 0) return false
  return FLAGGABLE_EXTENSIONS.has(file.name.slice(dot + 1).toLowerCase())
}

function googleNativeIcon(mimeType: string): string | null {
  if (mimeType === 'application/vnd.google-apps.document') return '📄'
  if (mimeType === 'application/vnd.google-apps.spreadsheet') return '📊'
  if (mimeType === 'application/vnd.google-apps.presentation') return '📑'
  return null
}

/*
 * Module-level cache: persists scan results across component unmounts.
 * Keyed by companyId. Survives navigation away and back; cleared on ↻ or
 * app restart. Exported so tests can pre-populate or clear between cases.
 */
export const filesCache = new Map<string, CompanyFilesLookupResult>()

export function CompanyFiles({ companyId, className }: CompanyFilesProps) {
  const [files, setFiles] = useState<CompanyDriveFileRef[]>([])
  const [companyRoot, setCompanyRoot] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [pathStack, setPathStack] = useState<{ name: string; path: string }[]>([])
  const [flaggedIds, setFlaggedIds] = useState<Set<string>>(new Set())
  const [flagError, setFlagError] = useState<string | null>(null)
  const [needsDriveReauth, setNeedsDriveReauth] = useState(false)
  const [reauthBusy, setReauthBusy] = useState(false)
  const flagErrorTimer = useRef<number | null>(null)

  // Reset folder navigation when switching companies. Use functional
  // setState so the no-op case (already empty) returns the same array
  // reference and doesn't re-trigger the data effect.
  useEffect(() => {
    setPathStack((prev) => (prev.length === 0 ? prev : []))
    setLoaded((prev) => (prev ? false : prev))
  }, [companyId])

  useEffect(() => {
    let cancelled = false
    const currentBrowsePath = pathStack[pathStack.length - 1]?.path

    // Only the root view uses the module-level cache. Subfolder views
    // always re-fetch (deep navigation is exploratory; freshness wins).
    if (pathStack.length === 0) {
      const cached = filesCache.get(companyId)
      if (cached) {
        setFiles(cached.files)
        setCompanyRoot(cached.companyRoot)
        setLoaded(true)
        setLoading(false)
        return
      }
    }

    setFiles([])
    setLoading(true)
    // NOTE: do NOT reset `loaded` here — it stays true after the first
    // successful fetch so the header (breadcrumb + Back button) remains
    // visible during subfolder transitions. If we cleared `loaded`, a
    // user mid-fetch couldn't click "↑ Back" or breadcrumb segments to
    // escape a slow request.
    api
      .invoke<CompanyFilesLookupResult>(IPC_CHANNELS.COMPANY_FILES, companyId, currentBrowsePath)
      .then((data) => {
        if (cancelled) return
        const result: CompanyFilesLookupResult = {
          files: data?.files ?? [],
          companyRoot: data?.companyRoot ?? null,
        }
        if (pathStack.length === 0) filesCache.set(companyId, result)
        setFiles(result.files)
        setCompanyRoot(result.companyRoot)
      })
      .catch((err) => {
        if (!cancelled) console.error(err)
      })
      .finally(() => {
        if (!cancelled) {
          setLoaded(true)
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [companyId, refreshKey, pathStack])

  useEffect(() => {
    let cancelled = false
    api
      .invoke<string[]>(IPC_CHANNELS.COMPANY_FILE_FLAG_GET, companyId)
      .then((ids) => {
        if (cancelled) return
        setFlaggedIds(new Set(ids ?? []))
      })
      .catch(console.error)
    return () => {
      cancelled = true
    }
  }, [companyId, refreshKey])

  useEffect(() => {
    return () => {
      if (flagErrorTimer.current !== null) window.clearTimeout(flagErrorTimer.current)
    }
  }, [])

  function handleRefresh() {
    if (pathStack.length === 0) filesCache.delete(companyId)
    setRefreshKey((k) => k + 1)
  }

  function handleRowClick(file: CompanyDriveFileRef) {
    if (file.mimeType === 'folder') return
    openFile(file)
  }

  function handleRowDoubleClick(file: CompanyDriveFileRef) {
    if (file.mimeType !== 'folder' || !file.id) return
    setPathStack((prev) => [...prev, { name: file.name, path: file.id }])
  }

  function handleBackUp() {
    setPathStack((prev) => prev.slice(0, -1))
  }

  function handleBreadcrumbJump(index: number) {
    setPathStack((prev) => (index === -1 ? [] : prev.slice(0, index + 1)))
  }

  function showFlagError(message: string) {
    setFlagError(message)
    if (flagErrorTimer.current !== null) window.clearTimeout(flagErrorTimer.current)
    flagErrorTimer.current = window.setTimeout(() => setFlagError(null), 4000)
  }

  async function toggleFlag(file: CompanyDriveFileRef, e: React.MouseEvent) {
    e.stopPropagation()
    if (!file.id || !isFlaggable(file)) return
    try {
      const result = await api.invoke<ToggleResult>(IPC_CHANNELS.COMPANY_FILE_FLAG_TOGGLE, {
        companyId,
        fileId: file.id,
        fileName: file.name,
        mimeType: file.mimeType,
      })
      // An older or malformed response (e.g., the pre-validation handler
      // that returned a bare boolean) used to silently no-op here. Surface
      // it instead so the user knows to restart.
      if (!result || typeof result !== 'object' || !('ok' in result)) {
        showFlagError('Could not update flag (unexpected response — try restarting the app)')
        return
      }
      if (!result.ok) {
        if (result.code === 'DRIVE_SCOPE_INSUFFICIENT') {
          setNeedsDriveReauth(true)
          return
        }
        showFlagError(result.message ?? 'Could not update flag')
        return
      }
      setFlaggedIds((prev) => {
        const next = new Set(prev)
        if (result.flagged) next.add(file.id)
        else next.delete(file.id)
        return next
      })
    } catch (err) {
      showFlagError(err instanceof Error ? err.message : 'Could not update flag')
    }
  }

  async function handleDriveReauth() {
    setReauthBusy(true)
    try {
      await api.invoke(IPC_CHANNELS.CALENDAR_REAUTHORIZE, 'drive-files')
      setNeedsDriveReauth(false)
    } catch (err) {
      showFlagError(
        err instanceof Error
          ? `Reconnect failed: ${err.message}`
          : 'Reconnect Google Drive failed',
      )
    } finally {
      setReauthBusy(false)
    }
  }

  function openFile(file: CompanyDriveFileRef) {
    if (file.webViewLink) {
      api.invoke(IPC_CHANNELS.APP_OPEN_EXTERNAL_URL, file.webViewLink).catch(console.error)
    } else if (file.id) {
      api.invoke(IPC_CHANNELS.APP_OPEN_PATH, file.id).catch(console.error)
    }
  }

  const flaggableCount = useMemo(() => files.filter(isFlaggable).length, [files])
  const flaggedCount = useMemo(
    () => files.filter((f) => f.id && flaggedIds.has(f.id)).length,
    [files, flaggedIds]
  )

  const inSubfolder = pathStack.length > 0

  return (
    <div className={`${styles.root} ${className ?? ''}`}>
      {companyRoot && <div className={styles.root_}>Folder: {companyRoot}</div>}
      {loaded && (
        <div className={styles.headerRow}>
          {inSubfolder && (
            <button className={styles.backBtn} onClick={handleBackUp} title="Up one level">↑ Back</button>
          )}
          <nav className={styles.breadcrumb} aria-label="Folder breadcrumb">
            <button
              type="button"
              className={styles.crumb}
              onClick={() => handleBreadcrumbJump(-1)}
              disabled={!inSubfolder}
            >
              Files
            </button>
            {pathStack.map((seg, i) => (
              <span key={seg.path} className={styles.crumbSep}>
                <span className={styles.crumbSlash}> / </span>
                <button
                  type="button"
                  className={styles.crumb}
                  onClick={() => handleBreadcrumbJump(i)}
                  disabled={i === pathStack.length - 1}
                >
                  {seg.name}
                </button>
              </span>
            ))}
          </nav>
          {flaggableCount > 0 && (
            <span className={styles.flaggedCount}>
              {flaggedCount} of {flaggableCount} {inSubfolder ? 'in this folder ' : ''}included in chat
            </span>
          )}
          <button className={styles.refreshBtn} onClick={handleRefresh} title="Refresh files">↻</button>
        </div>
      )}
      {flagError && <div className={styles.flagError}>{flagError}</div>}
      {needsDriveReauth && (
        <div className={styles.reauthBanner}>
          <span className={styles.reauthCopy}>
            Reconnect Google Drive to enable Docs / Sheets / Slides ingestion.
          </span>
          <button
            type="button"
            className={styles.reauthBtn}
            onClick={handleDriveReauth}
            disabled={reauthBusy}
          >
            {reauthBusy ? 'Connecting…' : 'Reconnect Google Drive'}
          </button>
        </div>
      )}
      {loading && <div className={styles.loading}>Loading…</div>}
      {loaded && files.length === 0 && (
        <div className={styles.empty}>
          {inSubfolder
            ? 'This folder is empty, or has been moved/renamed since the listing was loaded.'
            : 'No files found. Configure a folder in Settings to see files here.'}
        </div>
      )}
      {files.map((file) => {
        const flaggable = isFlaggable(file)
        const flagged = !!file.id && flaggedIds.has(file.id)
        const isFolder = file.mimeType === 'folder'
        return (
          <div
            key={file.id}
            className={`${styles.file} ${isFolder ? styles.folderRow : ''}`}
            draggable={!isFolder}
            onDragStart={(e) => {
              e.dataTransfer.setData('application/x-cyggie-file', JSON.stringify({
                path: file.id,
                name: file.name,
                mimeType: file.mimeType
              }))
              e.dataTransfer.effectAllowed = 'copy'
            }}
            onClick={() => handleRowClick(file)}
            onDoubleClick={() => handleRowDoubleClick(file)}
            title={isFolder ? 'Double-click to open' : undefined}
          >
            <div className={styles.fileMain}>
              <div className={styles.fileNameWrap}>
                <div className={styles.fileName}>
                  {isFolder && <span className={styles.folderIcon} aria-hidden>📁 </span>}
                  {!isFolder && googleNativeIcon(file.mimeType) && (
                    <span className={styles.folderIcon} aria-hidden>{googleNativeIcon(file.mimeType)} </span>
                  )}
                  {file.name}
                </div>
                <div className={styles.fileMeta}>
                  {file.mimeType && <span className={styles.type}>{file.mimeType.split('/').pop()}</span>}
                  {file.modifiedAt && (
                    <span className={styles.date}>
                      {new Date(file.modifiedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                    </span>
                  )}
                </div>
              </div>
              {flaggable && (
                <button
                  type="button"
                  className={`${styles.flagToggle} ${flagged ? styles.flagged : ''}`}
                  onClick={(e) => toggleFlag(file, e)}
                  title={flagged ? 'Remove from chat context' : 'Include in chat context'}
                  aria-pressed={flagged}
                >
                  {flagged ? '★' : '☆'}
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
