export interface WebShareResult {
  success: true
  url: string
  token: string
}

export interface WebShareError {
  success: false
  error: 'no_transcript' | 'no_api_key' | 'upload_failed' | 'network_error'
  message: string
}

export type WebShareResponse = WebShareResult | WebShareError

export interface MemoShareResult {
  success: true
  url: string
  token: string
}

export interface MemoShareError {
  success: false
  error: 'no_content' | 'no_api_key' | 'upload_failed' | 'network_error'
  message: string
}

export type MemoShareResponse = MemoShareResult | MemoShareError

export interface MemoRevokeResult {
  success: true
}

export interface MemoRevokeError {
  success: false
  error: 'network_error' | 'revoke_failed'
  message: string
}

export type MemoRevokeResponse = MemoRevokeResult | MemoRevokeError
