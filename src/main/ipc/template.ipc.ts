import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import * as templateRepo from '../database/repositories/template.repo'
import type { TemplateCategory, OutputFormat } from '../../shared/types/template'

export function registerTemplateHandlers(): void {
  // Seed defaults on first registration
  templateRepo.seedDefaultTemplates()

  ipcMain.handle(IPC_CHANNELS.TEMPLATE_LIST, () => {
    return templateRepo.listTemplates()
  })

  ipcMain.handle(IPC_CHANNELS.TEMPLATE_GET, (_event, id: string) => {
    return templateRepo.getTemplate(id)
  })

  ipcMain.handle(
    IPC_CHANNELS.TEMPLATE_CREATE,
    (
      _event,
      data: {
        name: string
        description: string
        category: TemplateCategory
        systemPrompt: string
        userPromptTemplate: string
        outputFormat: OutputFormat
      }
    ) => {
      return templateRepo.createTemplate(data)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.TEMPLATE_UPDATE,
    (_event, id: string, data: Parameters<typeof templateRepo.updateTemplate>[1]) => {
      return templateRepo.updateTemplate(id, data)
    }
  )

  ipcMain.handle(IPC_CHANNELS.TEMPLATE_DELETE, (_event, id: string) => {
    return templateRepo.deleteTemplate(id)
  })
}
