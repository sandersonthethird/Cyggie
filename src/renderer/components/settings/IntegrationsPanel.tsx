import { useEffect, useState } from 'react'
import { Calendar, Mail, HardDrive, CloudUpload, FolderOpen } from 'lucide-react'
import styles from './IntegrationsPanel.module.css'

/*
 * State machine for each integration:
 *
 * Calendar toggle:
 *   OFF + no credentials → click toggle → expand credential form
 *   OFF + form open → click "Connect" → calendarConnecting → ON (form auto-closes)
 *   ON → click toggle → disconnect → OFF
 *   loading=true → toggle disabled
 *
 * Gmail toggle:
 *   calendarConnected=false → toggle disabled ("Requires Google Calendar")
 *   OFF → click → gmailConnecting → ON
 *   ON → click → disconnect → OFF
 *   ON → auto-sync sub-row visible
 *
 * Drive Uploads / Drive Files:
 *   calendarConnected=false → toggle disabled
 *   OFF → click → grant scope → ON
 *   ON → toggle disabled (title: "Revoke by disconnecting Google Calendar")
 */

interface IntegrationsPanelProps {
  // Google Calendar
  calendarConnected: boolean
  calendarConnecting: boolean
  calendarError: string
  googleClientId: string
  googleClientSecret: string
  onGoogleClientIdChange: (value: string) => void
  onGoogleClientSecretChange: (value: string) => void
  onConnectCalendar: () => void
  onDisconnectCalendar: () => void
  // Gmail
  gmailConnected: boolean
  gmailConnecting: boolean
  gmailError: string
  onConnectGmail: () => void
  onDisconnectGmail: () => void
  autoSyncEmails: boolean
  onAutoSyncChange: (value: boolean) => void
  // Google Drive
  hasDriveScope: boolean
  hasDriveFilesScope: boolean
  driveGranting: boolean
  driveFilesGranting: boolean
  driveError: string
  onGrantDriveUploads: () => void
  onGrantDriveFiles: () => void
  // Account email badges
  calendarAccountEmail: string | null
  gmailAccountEmail: string | null
}

interface ToggleProps {
  on: boolean
  onClick?: () => void
  loading?: boolean
  disabled?: boolean
  title?: string
  small?: boolean
  'aria-label'?: string
}

function Toggle({ on, onClick, loading, disabled, title, small, 'aria-label': ariaLabel }: ToggleProps) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      className={`${styles.toggle} ${on ? styles.toggleOn : ''} ${small ? styles.toggleSmall : ''}`}
      onClick={onClick}
      disabled={loading || disabled}
      title={title}
      type="button"
    >
      <span className={styles.toggleThumb} />
    </button>
  )
}

export function IntegrationsPanel({
  calendarConnected,
  calendarConnecting,
  calendarError,
  googleClientId,
  googleClientSecret,
  onGoogleClientIdChange,
  onGoogleClientSecretChange,
  onConnectCalendar,
  onDisconnectCalendar,
  gmailConnected,
  gmailConnecting,
  gmailError,
  onConnectGmail,
  onDisconnectGmail,
  autoSyncEmails,
  onAutoSyncChange,
  hasDriveScope,
  hasDriveFilesScope,
  driveGranting,
  driveFilesGranting,
  driveError,
  onGrantDriveUploads,
  onGrantDriveFiles,
  calendarAccountEmail,
  gmailAccountEmail,
}: IntegrationsPanelProps) {
  const [calendarExpanded, setCalendarExpanded] = useState(false)

  // Auto-collapse credential form once Calendar is connected
  useEffect(() => {
    if (calendarConnected) setCalendarExpanded(false)
  }, [calendarConnected])

  function handleCalendarToggle() {
    if (calendarConnected) {
      onDisconnectCalendar()
    } else {
      setCalendarExpanded((v) => !v)
    }
  }

  return (
    <section className={styles.container}>
      <div className={styles.cardHeader}>
        <span className={styles.cardTitle}>Available Connections</span>
      </div>

      <div className={styles.integrationList}>

        {/* ── Google Calendar ── */}
        <div className={styles.integrationRow}>
          <Calendar size={20} className={styles.integrationIcon} />
          <div className={styles.integrationInfo}>
            <span className={styles.integrationName}>Google Calendar</span>
            {calendarConnected && calendarAccountEmail && (
              <span className={styles.accountBadge}>{calendarAccountEmail}</span>
            )}
          </div>
          <Toggle
            on={calendarConnected}
            loading={calendarConnecting}
            onClick={handleCalendarToggle}
            aria-label="Toggle Google Calendar"
          />
        </div>

        {/* Calendar credential expansion */}
        {!calendarConnected && calendarExpanded && (
          <div className={styles.expansion}>
            <p className={styles.expansionHint}>
              Create OAuth credentials in the{' '}
              <a
                href="https://console.cloud.google.com/apis/credentials"
                target="_blank"
                rel="noreferrer"
              >
                Google Cloud Console
              </a>
              . Enable the <strong>Calendar API</strong> and <strong>Drive API</strong>, then create
              a Desktop OAuth client.
            </p>
            <div className={styles.expansionField}>
              <label className={styles.expansionLabel}>Client ID</label>
              <input
                className={styles.expansionInput}
                value={googleClientId}
                onChange={(e) => onGoogleClientIdChange(e.target.value)}
                placeholder="your-app.apps.googleusercontent.com"
              />
            </div>
            <div className={styles.expansionField}>
              <label className={styles.expansionLabel}>Client Secret (optional for PKCE)</label>
              <input
                type="password"
                className={styles.expansionInput}
                value={googleClientSecret}
                onChange={(e) => onGoogleClientSecretChange(e.target.value)}
                placeholder="Optional"
              />
            </div>
            {calendarError && <p className={styles.expansionError}>{calendarError}</p>}
            <button
              className={styles.expansionConnectBtn}
              onClick={onConnectCalendar}
              disabled={calendarConnecting}
              type="button"
            >
              {calendarConnecting ? 'Connecting...' : 'Connect Google Calendar'}
            </button>
          </div>
        )}

        <div className={styles.divider} />

        {/* ── Gmail ── */}
        <div className={styles.integrationRow}>
          <Mail size={20} className={styles.integrationIcon} />
          <div className={styles.integrationInfo}>
            <span className={styles.integrationName}>Gmail</span>
            {gmailConnected && gmailAccountEmail ? (
              <span className={styles.accountBadge}>{gmailAccountEmail}</span>
            ) : !calendarConnected ? (
              <span className={styles.integrationSubtitle}>Requires Google Calendar</span>
            ) : null}
          </div>
          <Toggle
            on={gmailConnected}
            loading={gmailConnecting}
            disabled={!calendarConnected}
            onClick={gmailConnected ? onDisconnectGmail : onConnectGmail}
            aria-label="Toggle Gmail"
          />
        </div>
        {gmailError && <p className={styles.rowError}>{gmailError}</p>}

        {/* Auto-sync sub-row */}
        {gmailConnected && (
          <div className={styles.subRow}>
            <div className={styles.subRowInfo}>
              <span className={styles.subRowLabel}>Auto-sync emails on open</span>
            </div>
            <Toggle
              on={autoSyncEmails}
              onClick={() => onAutoSyncChange(!autoSyncEmails)}
              small
              aria-label="Toggle auto-sync emails"
            />
          </div>
        )}

        <div className={styles.divider} />

        {/* ── Google Drive ── */}
        <div className={styles.integrationRow}>
          <HardDrive size={20} className={styles.integrationIcon} />
          <div className={styles.integrationInfo}>
            <span className={styles.integrationName}>Google Drive</span>
            <span className={styles.integrationSubtitle}>
              Same OAuth credentials as Calendar
            </span>
          </div>
        </div>

        {/* Drive Uploads sub-row */}
        <div className={styles.subRow}>
          <CloudUpload size={14} className={styles.subRowIcon} />
          <div className={styles.subRowInfo}>
            <span className={styles.subRowLabel}>Drive Uploads</span>
            <span className={styles.integrationSubtitle}>Save meeting files to Drive</span>
          </div>
          <Toggle
            on={hasDriveScope}
            loading={driveGranting}
            disabled={!calendarConnected || hasDriveScope}
            title={hasDriveScope ? 'Revoke by disconnecting Google Calendar' : undefined}
            onClick={onGrantDriveUploads}
            aria-label="Toggle Drive Uploads"
          />
        </div>

        {/* Drive Files sub-row */}
        <div className={styles.subRow} style={{ paddingBottom: 14 }}>
          <FolderOpen size={14} className={styles.subRowIcon} />
          <div className={styles.subRowInfo}>
            <span className={styles.subRowLabel}>Drive Files</span>
            <span className={styles.integrationSubtitle}>Browse company folders</span>
          </div>
          <Toggle
            on={hasDriveFilesScope}
            loading={driveFilesGranting}
            disabled={!calendarConnected || hasDriveFilesScope}
            title={hasDriveFilesScope ? 'Revoke by disconnecting Google Calendar' : undefined}
            onClick={onGrantDriveFiles}
            aria-label="Toggle Drive Files"
          />
        </div>

        {driveError && <p className={styles.rowError}>{driveError}</p>}

      </div>
    </section>
  )
}
