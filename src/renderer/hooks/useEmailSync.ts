import { useEffect, useRef, useState } from 'react'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type { CompanyEmailIngestResult } from '../../shared/types/company'
import type { ContactEmailIngestResult } from '../../shared/types/contact'
import type { AppSettings } from '../../shared/types/settings'
import { getLastSyncedLabel } from '../utils/sync'
import { api } from '../api'

type EntityType = 'company' | 'contact'
type IngestResult = CompanyEmailIngestResult | ContactEmailIngestResult

interface ProgressPayload {
  phase: 'discovering' | 'fetching'
  fetched: number
  total: number
  companyId?: string
  contactId?: string
}

interface UseEmailSyncReturn {
  isSyncing: boolean
  syncError: string | null
  syncResult: IngestResult | null
  lastSyncedLabel: string
  progressMsg: string | null
  handleSync: () => Promise<void>
  handleCancel: () => void
}

function getChannels(entityType: EntityType) {
  if (entityType === 'company') {
    return {
      ingest: IPC_CHANNELS.COMPANY_EMAIL_INGEST,
      cancel: IPC_CHANNELS.COMPANY_EMAIL_INGEST_CANCEL,
      progress: IPC_CHANNELS.COMPANY_EMAIL_INGEST_PROGRESS,
    }
  }
  return {
    ingest: IPC_CHANNELS.CONTACT_EMAIL_INGEST,
    cancel: IPC_CHANNELS.CONTACT_EMAIL_INGEST_CANCEL,
    progress: IPC_CHANNELS.CONTACT_EMAIL_INGEST_PROGRESS,
  }
}

function getStorageKey(entityType: EntityType, entityId: string) {
  return `sync:${entityType}:${entityId}`
}

function getProgressFilter(entityType: EntityType, entityId: string) {
  return (payload: ProgressPayload): boolean => {
    if (entityType === 'company') return payload.companyId === entityId
    return payload.contactId === entityId
  }
}

export function useEmailSync(
  entityType: EntityType,
  entityId: string,
  onSyncSuccess?: () => void
): UseEmailSyncReturn {
  const channels = getChannels(entityType)
  const storageKey = getStorageKey(entityType, entityId)
  const matchesEntity = getProgressFilter(entityType, entityId)

  const isMountedRef = useRef(true)
  useEffect(() => {
    isMountedRef.current = true
    return () => { isMountedRef.current = false }
  }, [])

  const [isSyncing, setIsSyncing] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [syncResult, setSyncResult] = useState<IngestResult | null>(null)
  const [progressMsg, setProgressMsg] = useState<string | null>(null)
  const [lastSyncedLabel, setLastSyncedLabel] = useState<string>(
    () => getLastSyncedLabel(storageKey)
  )

  const handleSync = async () => {
    if (!isMountedRef.current) return
    setIsSyncing(true)
    setSyncError(null)
    setSyncResult(null)
    setProgressMsg('Discovering emails…')

    const unsubscribe = api.on(
      channels.progress,
      (...args: unknown[]) => {
        try {
          const p = args[0] as ProgressPayload
          if (!matchesEntity(p) || !isMountedRef.current) return
          if (p.phase === 'discovering') {
            setProgressMsg('Discovering emails…')
          } else {
            setProgressMsg(`Fetching ${p.fetched} of ${p.total}…`)
          }
        } catch {
          // Prevent unhandled errors in IPC listener
        }
      }
    )

    try {
      const result = await api.invoke<IngestResult>(channels.ingest, entityId)
      if (!isMountedRef.current) return
      setSyncResult(result)
      localStorage.setItem(storageKey, new Date().toISOString())
      setLastSyncedLabel('Last synced just now')
      onSyncSuccess?.()
    } catch (err) {
      if (!isMountedRef.current) return
      setSyncError(err instanceof Error ? err.message : 'Sync failed.')
    } finally {
      unsubscribe()
      setProgressMsg(null)
      if (isMountedRef.current) setIsSyncing(false)
    }
  }

  const handleCancel = () => {
    api.invoke(channels.cancel, entityId).catch(() => {})
  }

  // Auto-sync on mount if last-synced > 24h and autoSyncEmails is enabled
  const didAutoSync = useRef(false)
  useEffect(() => {
    if (didAutoSync.current) return
    didAutoSync.current = true

    const raw = localStorage.getItem(storageKey)
    const ms = raw ? new Date(raw).getTime() : NaN
    const elapsed = isNaN(ms) ? Infinity : Date.now() - ms
    if (elapsed <= 24 * 60 * 60 * 1000) return

    window.api
      .invoke<AppSettings>(IPC_CHANNELS.SETTINGS_GET_ALL)
      .then((settings) => {
        if ((settings as unknown as Record<string, string>)?.autoSyncEmails !== 'false' && isMountedRef.current) {
          handleSync()
        }
      })
      .catch(() => {
        // If settings fail to load, skip auto-sync silently
      })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return {
    isSyncing,
    syncError,
    syncResult,
    lastSyncedLabel,
    progressMsg,
    handleSync,
    handleCancel,
  }
}
