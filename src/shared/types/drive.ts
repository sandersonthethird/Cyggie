export interface DriveShareResult {
  success: true
  url: string
}

export interface DriveShareError {
  success: false
  error: 'not_connected' | 'no_drive_scope' | 'not_synced' | 'share_failed'
  message: string
}

export type DriveShareResponse = DriveShareResult | DriveShareError
