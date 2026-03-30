import { useEffect, useState } from 'react'
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

/*
 * Module-level cache: persists scan results across component unmounts.
 * Keyed by companyId. Survives navigation away and back; cleared on ↻ or
 * app restart. Exported so tests can pre-populate or clear between cases.
 *
 * State flow:
 *
 *   mount / companyId change / refreshKey change
 *     │
 *     ▼
 *   filesCache.get(companyId)
 *     │
 *   HIT ──► setFiles/setLoaded(true), return (no IPC)
 *     │
 *   MISS ──► setLoading(true) ──► IPC: COMPANY_FILES
 *                                     │
 *                              filesCache.set ──► setFiles / setLoaded(true)
 *
 *   ↻ button ──► filesCache.delete ──► setRefreshKey(k+1) ──► re-run effect
 */
export const filesCache = new Map<string, CompanyFilesLookupResult>()

export function CompanyFiles({ companyId, className }: CompanyFilesProps) {
  const [files, setFiles] = useState<CompanyDriveFileRef[]>([])
  const [companyRoot, setCompanyRoot] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

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

  function handleRefresh() {
    filesCache.delete(companyId)
    setRefreshKey((k) => k + 1)
  }

  function openFile(file: CompanyDriveFileRef) {
    if (file.webViewLink) {
      api.invoke(IPC_CHANNELS.APP_OPEN_EXTERNAL_URL, file.webViewLink).catch(console.error)
    } else if (file.id) {
      api.invoke(IPC_CHANNELS.APP_OPEN_PATH, file.id).catch(console.error)
    }
  }

  return (
    <div className={`${styles.root} ${className ?? ''}`}>
      {companyRoot && <div className={styles.root_}>Folder: {companyRoot}</div>}
      {loaded && !loading && (
        <button className={styles.refreshBtn} onClick={handleRefresh} title="Refresh files">↻</button>
      )}
      {loading && <div className={styles.loading}>Loading…</div>}
      {loaded && files.length === 0 && (
        <div className={styles.empty}>No files found. Configure a folder in Settings to see files here.</div>
      )}
      {files.map((file) => (
        <div key={file.id} className={styles.file} onClick={() => openFile(file)}>
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
      ))}
    </div>
  )
}
