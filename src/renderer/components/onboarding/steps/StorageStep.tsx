import { useEffect, useState } from 'react'
import { StepLinks } from '../StepLinks'
import { useVoiceLine } from '../../../hooks/useVoice'
import { api } from '../../../api'
import { IPC_CHANNELS } from '../../../../shared/constants/channels'
import { deriveSharedRelPath, looksLikeCloudMount } from '../onboarding-logic'
import styles from '../Onboarding.module.css'

// =============================================================================
// Storage step (Slice 4) — role-aware "where your files live".
//
//   Admin  → picks TWO: the firm shared (Google Drive) folder + own private folder.
//   Member → picks ONE: own private folder; the firm shared folder is inherited
//            (read-only info line, set by the admin).
//
// Always optional + non-blocking: a local private folder is the default, so the
// user can Continue without choosing anything. Warnings (cloud-mount private /
// non-Drive shared) are advisory only.
// =============================================================================

interface OnboardingInfo {
  role: 'admin' | 'member'
  firmName: string | null
  privatePath: string
}

export function StorageStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const sub = useVoiceLine('onboarding', 'storage')
  const [info, setInfo] = useState<OnboardingInfo | null>(null)
  const [privateFolder, setPrivateFolder] = useState<string | null>(null)
  const [privateWarn, setPrivateWarn] = useState<string | null>(null)
  const [sharedFolder, setSharedFolder] = useState<string | null>(null)
  const [sharedWarn, setSharedWarn] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api
      .invoke<OnboardingInfo>(IPC_CHANNELS.STORAGE_ONBOARDING_INFO)
      .then(setInfo)
      .catch(() => setInfo({ role: 'member', firmName: null, privatePath: '' }))
  }, [])

  const pickPrivate = async (): Promise<void> => {
    const path = await api.invoke<string | null>(IPC_CHANNELS.APP_PICK_FOLDER)
    if (!path) return
    setPrivateFolder(path)
    const writable = await api.invoke<boolean>(IPC_CHANNELS.APP_DIR_WRITABLE, path)
    setPrivateWarn(
      !writable
        ? "Cyggie can't write to this folder — choose another."
        : looksLikeCloudMount(path)
          ? 'Heads up: this folder is in a cloud-synced location, so private files would sync off this Mac.'
          : null,
    )
  }

  const pickShared = async (): Promise<void> => {
    const path = await api.invoke<string | null>(IPC_CHANNELS.APP_PICK_FOLDER)
    if (!path) return
    setSharedFolder(path)
    setSharedWarn(
      deriveSharedRelPath(path) == null
        ? "Heads up: this doesn't look like a Google Drive folder, so shared files may not reach your team."
        : null,
    )
  }

  const handleNext = async (): Promise<void> => {
    setBusy(true)
    try {
      if (privateFolder) {
        await api.invoke(IPC_CHANNELS.STORAGE_SET_PRIVATE_DIR, privateFolder)
      }
      if (info?.role === 'admin' && sharedFolder) {
        const rel = deriveSharedRelPath(sharedFolder)
        if (rel) await api.invoke(IPC_CHANNELS.STORAGE_SET_SHARED_DIR, rel)
      }
      onNext()
    } catch (err) {
      console.error('[Onboarding] storage step save failed:', err)
      onNext() // never block onboarding on a storage save
    } finally {
      setBusy(false)
    }
  }

  const isAdmin = info?.role === 'admin'

  return (
    <div className={styles.card}>
      <div className={styles.headBlock}>
        <h1 className={styles.heading}>Where your files live</h1>
        <p className={styles.sub}>{sub}</p>
      </div>

      {/* Private folder — everyone picks one (optional; defaults to the Cyggie folder). */}
      <div className={styles.field}>
        <label className={styles.label}>Your private folder</label>
        <button type="button" className={styles.secondaryBtn} onClick={pickPrivate}>
          <span className={styles.folderPath}>{privateFolder ?? 'Choose a local folder…'}</span>
        </button>
        <span className={styles.hint}>
          Private meeting files stay on this Mac. Defaults to your Cyggie folder.
        </span>
        {privateWarn && <span className={styles.warn}>{privateWarn}</span>}
      </div>

      {isAdmin ? (
        <div className={styles.field}>
          <label className={styles.label}>Firm shared folder (Google Drive)</label>
          <button type="button" className={styles.secondaryBtn} onClick={pickShared}>
            <span className={styles.folderPath}>{sharedFolder ?? 'Choose a Drive folder…'}</span>
          </button>
          <span className={styles.hint}>
            Shared meeting files go here for everyone at your firm.
          </span>
          {sharedWarn && <span className={styles.warn}>{sharedWarn}</span>}
        </div>
      ) : (
        <div className={styles.field}>
          <span className={styles.hint}>
            Shared files go to your firm’s{' '}
            {info?.firmName ? <strong>{info.firmName}</strong> : 'shared'} folder, set by your admin.
          </span>
        </div>
      )}

      <button type="button" className={styles.primaryBtn} disabled={busy} onClick={handleNext}>
        Continue
      </button>
      <StepLinks onBack={onBack} />
    </div>
  )
}
