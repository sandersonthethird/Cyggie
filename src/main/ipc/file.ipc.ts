import { ipcMain, dialog } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { readLocalFile } from '../storage/file-manager'

const SUPPORTED_EXTS = ['.pdf', '.txt', '.md', '.csv']

export function registerFileHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.FILE_READ_CONTENT,
    async (_event, filePath: string): Promise<{ content: string | null; error: string | null }> => {
      if (!filePath?.trim()) return { content: null, error: 'No file path provided' }

      const ext = filePath.includes('.') ? '.' + filePath.split('.').pop()!.toLowerCase() : ''
      if (!SUPPORTED_EXTS.includes(ext)) {
        return { content: null, error: `Unsupported format. Supported: ${SUPPORTED_EXTS.join(', ')}` }
      }

      try {
        const content = await readLocalFile(filePath)
        if (!content) return { content: null, error: 'File could not be read (empty or unreadable)' }
        return { content, error: null }
      } catch (err) {
        return { content: null, error: String(err) }
      }
    }
  )
}
