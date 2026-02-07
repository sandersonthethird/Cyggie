import { registerMeetingHandlers } from './meeting.ipc'
import { registerRecordingHandlers } from './recording.ipc'
import { registerSettingsHandlers } from './settings.ipc'
import { registerTemplateHandlers } from './template.ipc'
import { registerSearchHandlers } from './search.ipc'
import { registerSummaryHandlers } from './summary.ipc'
import { registerCalendarHandlers } from './calendar.ipc'
import { registerDriveHandlers } from './drive.ipc'
import { registerChatHandlers } from './chat.ipc'

export function registerAllHandlers(): void {
  registerMeetingHandlers()
  registerRecordingHandlers()
  registerSettingsHandlers()
  registerTemplateHandlers()
  registerSearchHandlers()
  registerSummaryHandlers()
  registerCalendarHandlers()
  registerDriveHandlers()
  registerChatHandlers()
}
