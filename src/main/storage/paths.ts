import { app } from 'electron'
import { join } from 'path'
import { mkdirSync, existsSync } from 'fs'

let storagePath: string = ''

export function getDefaultStoragePath(): string {
  return join(app.getPath('documents'), 'MeetingIntelligence')
}

export function getStoragePath(): string {
  return storagePath || getDefaultStoragePath()
}

export function setStoragePath(path: string): void {
  storagePath = path
  ensureStorageDirs(path)
}

export function initializeStorage(): void {
  const path = getDefaultStoragePath()
  ensureStorageDirs(path)
  storagePath = path
}

function ensureStorageDirs(basePath: string): void {
  const dirs = [basePath, join(basePath, 'transcripts'), join(basePath, 'summaries'), join(basePath, 'recordings')]

  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  }
}

export function getTranscriptsDir(): string {
  return join(getStoragePath(), 'transcripts')
}

export function getSummariesDir(): string {
  return join(getStoragePath(), 'summaries')
}

export function getRecordingsDir(): string {
  return join(getStoragePath(), 'recordings')
}

export function getDatabasePath(): string {
  return join(getStoragePath(), 'echovault.db')
}
