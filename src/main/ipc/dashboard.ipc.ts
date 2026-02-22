import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import * as dashboardRepo from '../database/repositories/dashboard.repo'
import { getCurrentUserId } from '../security/current-user'
import { logAppEvent } from '../database/repositories/audit.repo'

export function registerDashboardHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.DASHBOARD_GET, () => {
    const userId = getCurrentUserId()
    const data = dashboardRepo.getDashboardData()
    logAppEvent(userId, 'dashboard.loaded', {
      recentActivityCount: data.recentActivity.length,
      staleCompaniesCount: data.needsAttention.staleCompanies.length,
      stuckDealsCount: data.needsAttention.stuckDeals.length
    })
    return data
  })

  ipcMain.handle(
    IPC_CHANNELS.DASHBOARD_ENRICH_CALENDAR,
    (_event, events: Array<{ id: string; attendeeEmails?: string[] | null }>) => {
      return dashboardRepo.enrichCalendarEventsWithCompanyContext(
        (events || []).map((event) => ({
          id: event.id,
          attendeeEmails: event.attendeeEmails || []
        }))
      )
    }
  )
}
