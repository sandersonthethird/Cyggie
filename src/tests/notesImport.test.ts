import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  buildTitleFromPath,
  stripNotionUUID,
  collectFiles,
  buildFingerprint,
  processFile
} from '../main/ipc/notes.ipc'

// ---------------------------------------------------------------------------
// Temp dir helpers
// ---------------------------------------------------------------------------
let tmpDir: string

function mkTmp() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-import-'))
}

function write(rel: string, content = 'hello world') {
  const full = path.join(tmpDir, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
  return full
}

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

// ---------------------------------------------------------------------------
// collectFiles
// ---------------------------------------------------------------------------
describe('collectFiles', () => {
  it('returns .txt and .md files at root level', () => {
    mkTmp()
    write('a.txt')
    write('b.md')
    write('c.jpg')
    const result = collectFiles(tmpDir)
    expect(result).toHaveLength(2)
    expect(result.some(f => f.endsWith('a.txt'))).toBe(true)
    expect(result.some(f => f.endsWith('b.md'))).toBe(true)
  })

  it('recurses into subfolders', () => {
    mkTmp()
    write('sub/deep.md')
    write('sub/nested/deeper.txt')
    const result = collectFiles(tmpDir)
    expect(result).toHaveLength(2)
  })

  it('returns empty array for empty folder', () => {
    mkTmp()
    expect(collectFiles(tmpDir)).toEqual([])
  })

  it('ignores non-.txt/.md files', () => {
    mkTmp()
    write('doc.pdf')
    write('image.png')
    write('note.md')
    const result = collectFiles(tmpDir)
    expect(result).toHaveLength(1)
    expect(result[0].endsWith('note.md')).toBe(true)
  })

  it('is case-insensitive for extension', () => {
    mkTmp()
    write('NOTE.TXT')
    write('doc.MD')
    const result = collectFiles(tmpDir)
    expect(result).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// buildTitleFromPath
// ---------------------------------------------------------------------------
describe('buildTitleFromPath', () => {
  it('root-level file: uses filename as title', () => {
    mkTmp()
    const f = write('kick-off.md')
    expect(buildTitleFromPath(f, tmpDir, 'generic')).toBe('kick-off')
  })

  it('one subfolder deep: prefixes with parent folder name', () => {
    mkTmp()
    const f = write('Work/kick-off.md')
    expect(buildTitleFromPath(f, tmpDir, 'generic')).toBe('Work — kick-off')
  })

  it('two subfolders deep: uses immediate parent only', () => {
    mkTmp()
    const f = write('a/b/note.md')
    expect(buildTitleFromPath(f, tmpDir, 'generic')).toBe('b — note')
  })

  it('strips file extension', () => {
    mkTmp()
    const f = write('my-note.txt')
    expect(buildTitleFromPath(f, tmpDir, 'generic')).toBe('my-note')
  })

  it('notion format: strips UUID suffix from filename', () => {
    mkTmp()
    const f = write('Project Alpha abc123def456abc1abc12345.md')
    expect(buildTitleFromPath(f, tmpDir, 'notion')).toBe('Project Alpha')
  })

  it('generic format: leaves UUID-like suffix intact', () => {
    mkTmp()
    const f = write('Project Alpha abc123def456abc1abc12345.md')
    expect(buildTitleFromPath(f, tmpDir, 'generic')).toBe('Project Alpha abc123def456abc1abc12345')
  })
})

// ---------------------------------------------------------------------------
// stripNotionUUID
// ---------------------------------------------------------------------------
describe('stripNotionUUID', () => {
  it('strips 32-char hex UUID from end of title', () => {
    expect(stripNotionUUID('My Note abc123def456abc1abc12345abcd1234')).toBe('My Note')
  })

  it('strips 20-char hex UUID from end of title', () => {
    expect(stripNotionUUID('My Note abc123def456abc12345')).toBe('My Note')
  })

  it('leaves title without UUID unchanged', () => {
    expect(stripNotionUUID('Clean Title')).toBe('Clean Title')
  })

  it('handles mixed-case UUID', () => {
    expect(stripNotionUUID('Note ABC123DEF456ABC1ABC12345')).toBe('Note')
  })

  it('does not strip short hex-like word', () => {
    expect(stripNotionUUID('Note abc123')).toBe('Note abc123')
  })
})

// ---------------------------------------------------------------------------
// buildFingerprint
// ---------------------------------------------------------------------------
describe('buildFingerprint', () => {
  it('returns first 200 chars of content', () => {
    const long = 'x'.repeat(300)
    expect(buildFingerprint(long)).toBe('x'.repeat(200))
  })

  it('short content uses full content', () => {
    expect(buildFingerprint('hello')).toBe('hello')
  })

  it('exactly 200 chars returns full content', () => {
    const exact = 'a'.repeat(200)
    expect(buildFingerprint(exact)).toBe(exact)
  })
})

// ---------------------------------------------------------------------------
// processFile
// ---------------------------------------------------------------------------
describe('processFile', () => {
  it('returns file content and title for a valid file', () => {
    mkTmp()
    const f = write('my-note.md', 'Some content here')
    const result = processFile(f, tmpDir, 'generic')
    expect(result.skip).toBe(false)
    expect(result.title).toBe('my-note')
    expect(result.content).toBe('Some content here')
    expect(result.fingerprint).toBe('Some content here')
  })

  it('skips empty files', () => {
    mkTmp()
    const f = write('empty.md', '   ')
    const result = processFile(f, tmpDir, 'generic')
    expect(result.skip).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('skips and reports files over 2MB', () => {
    mkTmp()
    const big = 'x'.repeat(2 * 1024 * 1024 + 1)
    const f = write('big.md', big)
    const result = processFile(f, tmpDir, 'generic')
    expect(result.skip).toBe(true)
    expect(result.error).toMatch(/too large/)
  })
})
