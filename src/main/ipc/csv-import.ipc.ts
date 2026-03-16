import { ipcMain, dialog } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type { FieldMapping, ImportType, RunImportOptions } from '../../shared/types/csv-import'
import {
  parseCSVHeaders,
  suggestMappings,
  previewImport,
  runImport
} from '../services/csv-import.service'

let importAbortController: AbortController | null = null

export function registerCsvImportHandlers(): void {
  // Open native file picker, parse headers + 5 sample rows
  ipcMain.handle(IPC_CHANNELS.CSV_OPEN_FILE_DIALOG, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select CSV File',
      filters: [{ name: 'CSV Files', extensions: ['csv', 'txt'] }],
      properties: ['openFile']
    })

    if (result.canceled || result.filePaths.length === 0) return null

    const filePath = result.filePaths[0]
    return parseCSVHeaders(filePath)
  })

  // Parse a file path directly (used by drag-and-drop, skips the dialog)
  ipcMain.handle(IPC_CHANNELS.CSV_PARSE_FILE, async (_event, filePath: string) => {
    return parseCSVHeaders(filePath)
  })

  // LLM (or alias-table fallback) field mapping suggestions
  ipcMain.handle(
    IPC_CHANNELS.CSV_SUGGEST_MAPPINGS,
    async (
      _event,
      headers: string[],
      importType: ImportType,
      sampleRows: Record<string, string>[]
    ) => {
      return suggestMappings(headers, importType, sampleRows)
    }
  )

  // Full parse pass: row count + batch dedup check
  ipcMain.handle(
    IPC_CHANNELS.CSV_PREVIEW,
    async (_event, filePath: string, mappings: FieldMapping[]) => {
      return previewImport(filePath, mappings)
    }
  )

  // Bulk import with progress streaming
  ipcMain.handle(
    IPC_CHANNELS.CSV_IMPORT,
    async (
      event,
      filePath: string,
      mappings: FieldMapping[],
      importType: ImportType,
      options: RunImportOptions = {}
    ) => {
      importAbortController = new AbortController()

      return runImport(
        filePath,
        mappings,
        importType,
        (progress) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send(IPC_CHANNELS.CSV_IMPORT_PROGRESS, progress)
          }
        },
        importAbortController.signal,
        options
      ).finally(() => {
        importAbortController = null
      })
    }
  )

  // Cancel in-flight import
  ipcMain.on(IPC_CHANNELS.CSV_IMPORT_CANCEL, () => {
    importAbortController?.abort()
  })
}
