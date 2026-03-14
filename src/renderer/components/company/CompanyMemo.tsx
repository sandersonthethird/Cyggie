import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { InvestmentMemoWithLatest, InvestmentMemoVersion } from '../../../shared/types/company'
import styles from './CompanyMemo.module.css'

interface CompanyMemoProps {
  companyId: string
  className?: string
}

export function CompanyMemo({ companyId, className }: CompanyMemoProps) {
  const [memo, setMemo] = useState<InvestmentMemoWithLatest | null>(null)
  const [editContent, setEditContent] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [generating, setGenerating] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (loaded) return
    window.api
      .invoke<InvestmentMemoWithLatest>(IPC_CHANNELS.INVESTMENT_MEMO_GET_OR_CREATE, companyId)
      .then((data) => {
        setMemo(data)
        setEditContent(data?.latestVersion?.contentMarkdown ?? '')
      })
      .catch(console.error)
      .finally(() => setLoaded(true))
  }, [companyId, loaded])

  async function save() {
    if (!memo) return
    setSaving(true)
    try {
      const version = await window.api.invoke<InvestmentMemoVersion>(
        IPC_CHANNELS.INVESTMENT_MEMO_SAVE_VERSION,
        memo.id,
        { contentMarkdown: editContent, changeNote: null }
      )
      setMemo((prev) => prev ? { ...prev, latestVersion: version, latestVersionNumber: version.versionNumber } : prev)
      setEditing(false)
    } catch (e) {
      console.error('[CompanyMemo] save failed:', e)
    } finally {
      setSaving(false)
    }
  }

  async function generate() {
    if (!memo) return
    setGenerating(true)
    try {
      const result = await window.api.invoke<{ contentMarkdown: string }>(
        IPC_CHANNELS.INVESTMENT_MEMO_GENERATE,
        companyId
      )
      if (result?.contentMarkdown) {
        setEditContent(result.contentMarkdown)
        setEditing(true)
      }
    } catch (e) {
      console.error('[CompanyMemo] generate failed:', e)
    } finally {
      setGenerating(false)
    }
  }

  if (!loaded) return <div className={`${styles.root} ${className ?? ''}`}><div className={styles.loading}>Loading…</div></div>

  return (
    <div className={`${styles.root} ${className ?? ''}`}>
      <div className={styles.toolbar}>
        {!editing ? (
          <>
            <button className={styles.btn} onClick={() => setEditing(true)}>Edit</button>
            <button className={styles.btn} onClick={generate} disabled={generating}>
              {generating ? 'Generating…' : 'Generate with AI'}
            </button>
          </>
        ) : (
          <>
            <button className={styles.btnPrimary} onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button className={styles.btn} onClick={() => {
              setEditContent(memo?.latestVersion?.contentMarkdown ?? '')
              setEditing(false)
            }}>Cancel</button>
          </>
        )}
        {memo && <span className={styles.version}>v{memo.latestVersionNumber}</span>}
      </div>

      {editing ? (
        <textarea
          ref={textareaRef}
          className={styles.textarea}
          value={editContent}
          onChange={(e) => setEditContent(e.target.value)}
        />
      ) : (
        <div className={styles.preview}>
          {memo?.latestVersion?.contentMarkdown ? (
            <ReactMarkdown rehypePlugins={[rehypeRaw]}>{memo.latestVersion.contentMarkdown}</ReactMarkdown>
          ) : (
            <div className={styles.empty}>No memo content yet. Click Edit or Generate with AI to get started.</div>
          )}
        </div>
      )}
    </div>
  )
}
