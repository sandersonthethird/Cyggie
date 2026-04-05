/**
 * @vitest-environment jsdom
 *
 * Tests for IntegrationsPanel component.
 *
 * Coverage diagram:
 *
 *   Rendering (all integrations disconnected)
 *     ├── Calendar toggle gray, no expansion visible
 *     ├── Gmail toggle disabled + "Requires Google Calendar" subtitle
 *     ├── Drive Uploads toggle disabled
 *     └── Drive Files toggle disabled
 *
 *   Calendar toggle behaviour
 *     ├── OFF click → credential form expands
 *     ├── Expanded click again → credential form collapses
 *     ├── Connected → no expansion rendered
 *     └── calendarConnected prop change true → expansion auto-closes
 *
 *   Gmail toggle behaviour
 *     ├── Enabled when calendarConnected=true
 *     └── ON click → onDisconnectGmail called
 *
 *   Drive sub-rows
 *     ├── Drive Uploads toggle disabled when already granted
 *     └── Drive Files toggle disabled when already granted
 *
 *   Email badges
 *     ├── calendarAccountEmail shown when provided + connected
 *     └── gmailAccountEmail shown when provided + connected
 *
 *   Gmail sub-rows
 *     ├── auto-sync sub-row hidden when gmailConnected=false
 *     └── auto-sync sub-row visible when gmailConnected=true
 *
 *   Error display
 *     └── calendarError shown inside expansion
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { IntegrationsPanel } from '../renderer/components/settings/IntegrationsPanel'

// CSS modules return empty objects in jsdom
vi.mock('../renderer/components/settings/IntegrationsPanel.module.css', () => ({
  default: new Proxy({}, { get: (_: object, prop: string) => prop })
}))

const defaultProps = {
  calendarConnected: false,
  calendarConnecting: false,
  calendarError: '',
  googleClientId: '',
  googleClientSecret: '',
  onGoogleClientIdChange: vi.fn(),
  onGoogleClientSecretChange: vi.fn(),
  onConnectCalendar: vi.fn(),
  onDisconnectCalendar: vi.fn(),
  gmailConnected: false,
  gmailConnecting: false,
  gmailError: '',
  onConnectGmail: vi.fn(),
  onDisconnectGmail: vi.fn(),
  autoSyncEmails: true,
  onAutoSyncChange: vi.fn(),
  hasDriveScope: false,
  hasDriveFilesScope: false,
  driveGranting: false,
  driveFilesGranting: false,
  driveError: '',
  onGrantDriveUploads: vi.fn(),
  onGrantDriveFiles: vi.fn(),
  calendarAccountEmail: null,
  gmailAccountEmail: null,
}

describe('IntegrationsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(cleanup)

  describe('initial state (nothing connected)', () => {
    it('renders the "Available Connections" heading', () => {
      render(<IntegrationsPanel {...defaultProps} />)
      expect(screen.getByText('Available Connections')).toBeInTheDocument()
    })

    it('does not show the Calendar credential form expansion initially', () => {
      render(<IntegrationsPanel {...defaultProps} />)
      expect(screen.queryByPlaceholderText('your-app.apps.googleusercontent.com')).not.toBeInTheDocument()
    })

    it('Gmail toggle is disabled when calendarConnected=false', () => {
      render(<IntegrationsPanel {...defaultProps} />)
      const gmailToggle = screen.getByRole('switch', { name: /Toggle Gmail/i })
      expect(gmailToggle).toBeDisabled()
    })

    it('shows "Requires Google Calendar" subtitle when calendarConnected=false', () => {
      render(<IntegrationsPanel {...defaultProps} />)
      expect(screen.getByText('Requires Google Calendar')).toBeInTheDocument()
    })

    it('Drive Uploads toggle is disabled when calendarConnected=false', () => {
      render(<IntegrationsPanel {...defaultProps} />)
      const driveUploadsToggle = screen.getByRole('switch', { name: /Toggle Drive Uploads/i })
      expect(driveUploadsToggle).toBeDisabled()
    })

    it('Drive Files toggle is disabled when calendarConnected=false', () => {
      render(<IntegrationsPanel {...defaultProps} />)
      const driveFilesToggle = screen.getByRole('switch', { name: /Toggle Drive Files/i })
      expect(driveFilesToggle).toBeDisabled()
    })
  })

  describe('Calendar toggle behaviour', () => {
    it('clicking the Calendar toggle when disconnected opens the credential form', () => {
      render(<IntegrationsPanel {...defaultProps} />)
      const calendarToggle = screen.getByRole('switch', { name: /Toggle Google Calendar/i })
      fireEvent.click(calendarToggle)
      expect(screen.getByPlaceholderText('your-app.apps.googleusercontent.com')).toBeInTheDocument()
    })

    it('clicking the Calendar toggle again collapses the form', () => {
      render(<IntegrationsPanel {...defaultProps} />)
      const calendarToggle = screen.getByRole('switch', { name: /Toggle Google Calendar/i })
      fireEvent.click(calendarToggle)
      fireEvent.click(calendarToggle)
      expect(screen.queryByPlaceholderText('your-app.apps.googleusercontent.com')).not.toBeInTheDocument()
    })

    it('does not show the credential form when calendarConnected=true', () => {
      render(<IntegrationsPanel {...defaultProps} calendarConnected={true} />)
      expect(screen.queryByPlaceholderText('your-app.apps.googleusercontent.com')).not.toBeInTheDocument()
    })

    it('clicking Calendar toggle when connected calls onDisconnectCalendar', () => {
      render(<IntegrationsPanel {...defaultProps} calendarConnected={true} />)
      const calendarToggle = screen.getByRole('switch', { name: /Toggle Google Calendar/i })
      fireEvent.click(calendarToggle)
      expect(defaultProps.onDisconnectCalendar).toHaveBeenCalledOnce()
    })

    it('shows calendarError inside the credential form', () => {
      render(<IntegrationsPanel {...defaultProps} calendarError="Invalid client ID" />)
      const calendarToggle = screen.getByRole('switch', { name: /Toggle Google Calendar/i })
      fireEvent.click(calendarToggle)
      expect(screen.getByText('Invalid client ID')).toBeInTheDocument()
    })

    it('Connect button calls onConnectCalendar', () => {
      render(<IntegrationsPanel {...defaultProps} />)
      const calendarToggle = screen.getByRole('switch', { name: /Toggle Google Calendar/i })
      fireEvent.click(calendarToggle)
      const connectBtn = screen.getByRole('button', { name: /Connect Google Calendar/i })
      fireEvent.click(connectBtn)
      expect(defaultProps.onConnectCalendar).toHaveBeenCalledOnce()
    })
  })

  describe('Gmail toggle behaviour', () => {
    it('Gmail toggle is enabled when calendarConnected=true', () => {
      render(<IntegrationsPanel {...defaultProps} calendarConnected={true} />)
      const gmailToggle = screen.getByRole('switch', { name: /Toggle Gmail/i })
      expect(gmailToggle).not.toBeDisabled()
    })

    it('clicking Gmail toggle when disconnected calls onConnectGmail', () => {
      render(<IntegrationsPanel {...defaultProps} calendarConnected={true} />)
      const gmailToggle = screen.getByRole('switch', { name: /Toggle Gmail/i })
      fireEvent.click(gmailToggle)
      expect(defaultProps.onConnectGmail).toHaveBeenCalledOnce()
    })

    it('clicking Gmail toggle when connected calls onDisconnectGmail', () => {
      render(<IntegrationsPanel {...defaultProps} calendarConnected={true} gmailConnected={true} />)
      const gmailToggle = screen.getByRole('switch', { name: /Toggle Gmail/i })
      fireEvent.click(gmailToggle)
      expect(defaultProps.onDisconnectGmail).toHaveBeenCalledOnce()
    })
  })

  describe('Auto-sync sub-row', () => {
    it('auto-sync sub-row is hidden when gmailConnected=false', () => {
      render(<IntegrationsPanel {...defaultProps} />)
      expect(screen.queryByText('Auto-sync emails on open')).not.toBeInTheDocument()
    })

    it('auto-sync sub-row is visible when gmailConnected=true', () => {
      render(<IntegrationsPanel {...defaultProps} gmailConnected={true} />)
      expect(screen.getByText('Auto-sync emails on open')).toBeInTheDocument()
    })

    it('auto-sync toggle calls onAutoSyncChange', () => {
      render(<IntegrationsPanel {...defaultProps} gmailConnected={true} autoSyncEmails={true} />)
      const autoSyncToggle = screen.getByRole('switch', { name: /Toggle auto-sync emails/i })
      fireEvent.click(autoSyncToggle)
      expect(defaultProps.onAutoSyncChange).toHaveBeenCalledWith(false)
    })
  })

  describe('Drive sub-rows', () => {
    it('Drive Uploads toggle is disabled when hasDriveScope=true', () => {
      render(<IntegrationsPanel {...defaultProps} calendarConnected={true} hasDriveScope={true} />)
      const driveUploadsToggle = screen.getByRole('switch', { name: /Toggle Drive Uploads/i })
      expect(driveUploadsToggle).toBeDisabled()
    })

    it('Drive Files toggle is disabled when hasDriveFilesScope=true', () => {
      render(<IntegrationsPanel {...defaultProps} calendarConnected={true} hasDriveFilesScope={true} />)
      const driveFilesToggle = screen.getByRole('switch', { name: /Toggle Drive Files/i })
      expect(driveFilesToggle).toBeDisabled()
    })

    it('clicking Drive Uploads toggle when not granted calls onGrantDriveUploads', () => {
      render(<IntegrationsPanel {...defaultProps} calendarConnected={true} hasDriveScope={false} />)
      const driveUploadsToggle = screen.getByRole('switch', { name: /Toggle Drive Uploads/i })
      fireEvent.click(driveUploadsToggle)
      expect(defaultProps.onGrantDriveUploads).toHaveBeenCalledOnce()
    })
  })

  describe('Email badges', () => {
    it('shows calendarAccountEmail badge when connected and email is provided', () => {
      render(<IntegrationsPanel {...defaultProps} calendarConnected={true} calendarAccountEmail="cal@example.com" />)
      expect(screen.getByText('cal@example.com')).toBeInTheDocument()
    })

    it('does not show calendarAccountEmail badge when not connected', () => {
      render(<IntegrationsPanel {...defaultProps} calendarConnected={false} calendarAccountEmail="cal@example.com" />)
      expect(screen.queryByText('cal@example.com')).not.toBeInTheDocument()
    })

    it('shows gmailAccountEmail badge when gmail connected and email is provided', () => {
      render(<IntegrationsPanel {...defaultProps} calendarConnected={true} gmailConnected={true} gmailAccountEmail="gmail@example.com" />)
      expect(screen.getByText('gmail@example.com')).toBeInTheDocument()
    })
  })
})
