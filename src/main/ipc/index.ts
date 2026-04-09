import { registerMeetingHandlers } from './meeting.ipc'
import { registerRecordingHandlers } from './recording.ipc'
import { registerSettingsHandlers } from './settings.ipc'
import { registerTemplateHandlers } from './template.ipc'
import { registerSearchHandlers } from './search.ipc'
import { registerSummaryHandlers } from './summary.ipc'
import { registerCalendarHandlers } from './calendar.ipc'
import { registerGmailHandlers } from './gmail.ipc'
import { registerDriveHandlers } from './drive.ipc'
import { registerChatHandlers } from './chat.ipc'
import { registerWebShareHandlers } from './web-share.ipc'
import { registerVideoHandlers } from './video.ipc'
import { registerCompanyHandlers } from './company.ipc'
import { registerCompanyNotesHandlers } from './company-notes.ipc'
import { registerCompanyChatHandlers } from './company-chat.ipc'
import { registerInvestmentMemoHandlers } from './investment-memo.ipc'
import { registerContactHandlers } from './contacts.ipc'
import { registerUserHandlers } from './user.ipc'
import { registerDashboardHandlers } from './dashboard.ipc'
import { registerPipelineHandlers } from './pipeline.ipc'
import { registerUnifiedSearchHandlers } from './unified-search.ipc'
import { registerTaskHandlers } from './task.ipc'
import { registerCustomFieldsIpc } from './custom-fields.ipc'
import { registerContactNotesHandlers } from './contact-notes.ipc'
import { registerCsvImportHandlers } from './csv-import.ipc'
import { registerUserPreferencesHandlers } from './user-preferences.ipc'
import { registerContactChatHandlers } from './contact-chat.ipc'
import { registerCompanyDecisionHandlers } from './company-decision.ipc'
import { registerNotesHandlers } from './notes.ipc'
import { registerPartnerMeetingIpc } from './partner-meeting.ipc'
import { registerWindowHandlers } from './window.ipc'
import { registerCrmChatHandlers } from './crm-chat.ipc'

export function registerAllHandlers(): void {
  registerMeetingHandlers()
  registerRecordingHandlers()
  registerSettingsHandlers()
  registerTemplateHandlers()
  registerSearchHandlers()
  registerSummaryHandlers()
  registerCalendarHandlers()
  registerGmailHandlers()
  registerDriveHandlers()
  registerChatHandlers()
  registerWebShareHandlers()
  registerVideoHandlers()
  registerCompanyHandlers()
  registerCompanyNotesHandlers()
  registerCompanyChatHandlers()
  registerInvestmentMemoHandlers()
  registerContactHandlers()
  registerUserHandlers()
  registerDashboardHandlers()
  registerPipelineHandlers()
  registerUnifiedSearchHandlers()
  registerTaskHandlers()
  registerCustomFieldsIpc()
  registerContactNotesHandlers()
  registerCsvImportHandlers()
  registerUserPreferencesHandlers()
  registerContactChatHandlers()
  registerCompanyDecisionHandlers()
  registerNotesHandlers()
  registerPartnerMeetingIpc()
  registerWindowHandlers()
  registerCrmChatHandlers()
}
