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
  | { ok: false; code: 'MISSING' | 'UNSUPPORTED_FORMAT' | 'TOO_LARGE'; message: string }

const FLAGGABLE_EXTENSIONS = new Set(['pdf', 'txt', 'md', 'csv'])

function isFlaggable(file: CompanyDriveFileRef): boolean {
  if (!file.id || file.mimeType === 'folder') return false
  const dot = file.name.lastIndexOf('.')
  if (dot < 0) return false
  return FLAGGABLE_EXTENSIONS.has(file.name.slice(dot + 1).toLowerCase())
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
  const [flaggedIds, setFlaggedIds] = useState<Set<string>>(new Set())
  const [flagError, setFlagError] = useState<string | null>(null)
  const flagErrorTimer = useRef<number | null>(null)

  useEffect(() => {
    const cached = filesCache.get(companyId)
    if (cached) {
      setFiles(cached.files)
      setCompanyRoot(cached.companyRoot)
      setLoaded(true)
      setLoading(false)
      return
    }

    setFiles([])
    setCompanyRoot(null)
    setLoaded(false)
    setLoading(true)
    api
      .invoke<CompanyFilesLookupResult>(IPC_CHANNELS.COMPANY_FILES, companyId)
      .then((data) => {
        const result: CompanyFilesLookupResult = {
          files: data?.files ?? [],
          companyRoot: data?.companyRoot ?? null,
        }
        filesCache.set(companyId, result)
        setFiles(result.files)
        setCompanyRoot(result.companyRoot)
      })
      .catch(console.error)
      .finally(() => {
        setLoaded(true)
        setLoading(false)
      })
  }, [companyId, refreshKey])

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
    filesCache.delete(companyId)
    setRefreshKey((k) => k + 1)
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
      })
      if (!result.ok) {
        showFlagError(result.message)
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

  return (
    <div className={`${styles.root} ${className ?? ''}`}>
      {companyRoot && <div className={styles.root_}>Folder: {companyRoot}</div>}
      {loaded && !loading && (
        <div className={styles.headerRow}>
          {flaggableCount > 0 && (
            <span className={styles.flaggedCount}>
              {flaggedCount} of {flaggableCount} included in chat
            </span>
          )}
          <button className={styles.refreshBtn} onClick={handleRefresh} title="Refresh files">↻</button>
        </div>
      )}
      {flagError && <div className={styles.flagError}>{flagError}</div>}
      {loading && <div className={styles.loading}>Loading…</div>}
      {loaded && files.length === 0 && (
        <div className={styles.empty}>No files found. Configure a folder in Settings to see files here.</div>
      )}
      {files.map((file) => {
        const flaggable = isFlaggable(file)
        const flagged = !!file.id && flaggedIds.has(file.id)
        return (
          <div
            key={file.id}
            className={styles.file}
            draggable={file.mimeType !== 'folder'}
            onDragStart={(e) => {
              e.dataTransfer.setData('application/x-cyggie-file', JSON.stringify({
                path: file.id,
                name: file.name,
                mimeType: file.mimeType
              }))
              e.dataTransfer.effectAllowed = 'copy'
            }}
            onClick={() => openFile(file)}
          >
            <div className={styles.fileMain}>
              <div className={styles.fileNameWrap}>
                <div className={styles.fileName}>{file.name}</div>
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
