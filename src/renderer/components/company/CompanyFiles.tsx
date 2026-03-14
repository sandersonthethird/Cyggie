import { useEffect, useState } from 'react'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { CompanyDriveFileRef } from '../../../shared/types/company'
import styles from './CompanyFiles.module.css'

interface CompanyFilesLookupResult {
  companyRoot: string | null
  files: CompanyDriveFileRef[]
}

interface CompanyFilesProps {
  companyId: string
  className?: string
}

export function CompanyFiles({ companyId, className }: CompanyFilesProps) {
  const [files, setFiles] = useState<CompanyDriveFileRef[]>([])
  const [companyRoot, setCompanyRoot] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (loaded || loading) return
    setLoading(true)
    window.api
      .invoke<CompanyFilesLookupResult>(IPC_CHANNELS.COMPANY_FILES, companyId)
      .then((data) => {
        setFiles(data?.files ?? [])
        setCompanyRoot(data?.companyRoot ?? null)
      })
      .catch(console.error)
      .finally(() => {
        setLoaded(true)
        setLoading(false)
      })
  }, [companyId, loaded, loading])

  function openFile(file: CompanyDriveFileRef) {
    if (file.webViewLink) {
      window.api.invoke(IPC_CHANNELS.APP_OPEN_EXTERNAL_URL, file.webViewLink).catch(console.error)
    } else if (file.id) {
      window.api.invoke(IPC_CHANNELS.APP_OPEN_PATH, file.id).catch(console.error)
    }
  }

  return (
    <div className={`${styles.root} ${className ?? ''}`}>
      {companyRoot && <div className={styles.root_}>Folder: {companyRoot}</div>}
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
