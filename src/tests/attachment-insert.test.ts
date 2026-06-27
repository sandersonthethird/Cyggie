import { describe, it, expect, vi } from 'vitest'

// attachment-insert imports the renderer api shim at module load; the pure
// validators/detectors under test never call it, but mock it so importing the
// module never touches window.api.
vi.mock('../renderer/api', () => ({ api: { invoke: vi.fn() } }))

import {
  validateImageFile,
  validatePdfFile,
  isImageCandidate,
  isPdfCandidate,
} from '../renderer/lib/attachment-insert'
import { ATTACHMENT_MAX_UPLOAD_BYTES, isPdfMime, pdfMimeFromFilename } from '../shared/attachments'

const file = (over: Partial<{ name: string; type: string; size: number }> = {}) => ({
  name: 'x',
  type: '',
  size: 100,
  ...over,
})

describe('isPdfMime / pdfMimeFromFilename', () => {
  it('detects the pdf mime', () => {
    expect(isPdfMime('application/pdf')).toBe(true)
    expect(isPdfMime('image/png')).toBe(false)
  })
  it('detects .pdf by filename, case-insensitive', () => {
    expect(pdfMimeFromFilename('Report.PDF')).toBe('application/pdf')
    expect(pdfMimeFromFilename('note.png')).toBe(null)
    expect(pdfMimeFromFilename('nodot')).toBe(null)
  })
})

describe('validateImageFile', () => {
  it('accepts a png by mime', () => {
    expect(validateImageFile(file({ type: 'image/png', name: 'a.png' }))).toEqual({ ok: true, mime: 'image/png' })
  })
  it('infers mime from extension when type is blank', () => {
    expect(validateImageFile(file({ type: '', name: 'a.jpg' }))).toEqual({ ok: true, mime: 'image/jpeg' })
  })
  it('rejects non-image, empty, and oversize', () => {
    expect(validateImageFile(file({ type: 'application/pdf', name: 'a.pdf' })).ok).toBe(false)
    expect(validateImageFile(file({ type: 'image/png', size: 0 })).ok).toBe(false)
    expect(validateImageFile(file({ type: 'image/png', size: ATTACHMENT_MAX_UPLOAD_BYTES + 1 })).ok).toBe(false)
  })
})

describe('validatePdfFile', () => {
  it('accepts a pdf by mime and by extension', () => {
    expect(validatePdfFile(file({ type: 'application/pdf', name: 'a.pdf' }))).toEqual({ ok: true, mime: 'application/pdf' })
    expect(validatePdfFile(file({ type: '', name: 'a.pdf' }))).toEqual({ ok: true, mime: 'application/pdf' })
  })
  it('rejects non-pdf, empty, and oversize', () => {
    expect(validatePdfFile(file({ type: 'image/png', name: 'a.png' })).ok).toBe(false)
    expect(validatePdfFile(file({ type: 'application/pdf', size: 0 })).ok).toBe(false)
    const big = validatePdfFile(file({ type: 'application/pdf', name: 'a.pdf', size: ATTACHMENT_MAX_UPLOAD_BYTES + 1 }))
    expect(big.ok).toBe(false)
    if (!big.ok) expect(big.reason).toMatch(/too large/i)
  })
})

describe('candidate detectors (image vs pdf are disjoint)', () => {
  const asFile = (type: string, name: string) => ({ type, name }) as unknown as File
  it('classifies images', () => {
    expect(isImageCandidate(asFile('image/png', 'a.png'))).toBe(true)
    expect(isPdfCandidate(asFile('image/png', 'a.png'))).toBe(false)
  })
  it('classifies pdfs (by mime or extension)', () => {
    expect(isPdfCandidate(asFile('application/pdf', 'a'))).toBe(true)
    expect(isPdfCandidate(asFile('', 'a.pdf'))).toBe(true)
    expect(isImageCandidate(asFile('application/pdf', 'a.pdf'))).toBe(false)
  })
})
