import { describe, it, expect, vi, afterEach } from 'vitest'
import * as path from 'path'

// Mock fs before importing modules that use it
vi.mock('fs', () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(() => ({ size: 100, mtime: new Date() })),
  readFileSync: vi.fn(() => ''),
  rmSync: vi.fn(),
  existsSync: vi.fn(() => false),
}))

// Mock electron (not available in test environment)
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}))

// Mock internal imports that require electron/DB
vi.mock('../main/database/connection', () => ({ getDatabase: vi.fn() }))
vi.mock('../main/database/repositories/notes.repo', () => ({}))
vi.mock('../main/security/current-user', () => ({ getCurrentUserId: vi.fn() }))
vi.mock('../main/database/repositories/audit.repo', () => ({ logAudit: vi.fn() }))
vi.mock('../main/storage/paths', () => ({ getStoragePath: vi.fn(() => '/storage') }))
vi.mock('../main/services/note-tagging.service', () => ({
  suggestNoteTag: vi.fn(),
  suggestFolderEntityTag: vi.fn(),
}))
vi.mock('../main/ipc/note-hydration', () => ({ hydrateCompanionNote: vi.fn() }))

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// buildFolderPath
// ---------------------------------------------------------------------------
describe('buildFolderPath', () => {
  async function getBuildFolderPath() {
    const mod = await import('../main/ipc/notes.ipc')
    return mod.buildFolderPath
  }

  it('returns empty string for root-level file', async () => {
    const buildFolderPath = await getBuildFolderPath()
    expect(buildFolderPath('/root/notes/kick-off.md', '/root/notes')).toBe('')
  })

  it('returns single segment for one level deep', async () => {
    const buildFolderPath = await getBuildFolderPath()
    expect(buildFolderPath('/root/notes/Work/kick-off.md', '/root/notes')).toBe('Work')
  })

  it('returns slash-joined path for nested file', async () => {
    const buildFolderPath = await getBuildFolderPath()
    expect(buildFolderPath('/root/notes/Work/Q1/kick-off.md', '/root/notes')).toBe('Work/Q1')
  })

  it('always uses / separator regardless of os.sep', async () => {
    const buildFolderPath = await getBuildFolderPath()
    const result = buildFolderPath(
      path.join('/root/notes', 'Work', 'Q1', 'file.md'),
      '/root/notes'
    )
    expect(result).toBe('Work/Q1')
    expect(result).not.toContain('\\')
  })
})

// ---------------------------------------------------------------------------
// buildTitleFromPath
// ---------------------------------------------------------------------------
describe('buildTitleFromPath', () => {
  async function getBuildTitle() {
    const mod = await import('../main/ipc/notes.ipc')
    return mod.buildTitleFromPath
  }

  it('returns filename stem without folder prefix', async () => {
    const buildTitleFromPath = await getBuildTitle()
    expect(buildTitleFromPath('/root/notes/Work/kick-off.md', '/root/notes', 'generic')).toBe('kick-off')
  })

  it('strips Notion UUID for notion format', async () => {
    const buildTitleFromPath = await getBuildTitle()
    expect(buildTitleFromPath('/root/notes/Project Alpha abc123def456abc12345.md', '/root/notes', 'notion')).toBe('Project Alpha')
  })

  it('does not strip UUID for non-notion format', async () => {
    const buildTitleFromPath = await getBuildTitle()
    const result = buildTitleFromPath('/root/notes/Project Alpha abc123def456abc12345.md', '/root/notes', 'generic')
    expect(result).toContain('abc123')
  })
})

// ---------------------------------------------------------------------------
// convertHtmlToMarkdown
// ---------------------------------------------------------------------------
describe('convertHtmlToMarkdown', () => {
  async function getConvert() {
    const mod = await import('../main/utils/html-to-markdown')
    return mod.convertHtmlToMarkdown
  }

  it('converts basic HTML tags to Markdown', async () => {
    const convert = await getConvert()
    const { markdown, images } = convert('<p><b>Bold</b> and <i>italic</i></p>')
    expect(markdown).toContain('**Bold**')
    expect(markdown).toContain('_italic_')
    expect(images).toHaveLength(0)
  })

  it('converts hyperlinks to Markdown link syntax', async () => {
    const convert = await getConvert()
    const { markdown } = convert('<a href="https://example.com">Example</a>')
    expect(markdown).toContain('[Example](https://example.com)')
  })

  it('extracts base64 PNG into images[] and inserts placeholder', async () => {
    const convert = await getConvert()
    const fakeBase64 = 'iVBORw0KGgo='
    const html = `<p>Before</p><img src="data:image/png;base64,${fakeBase64}"><p>After</p>`
    const { images } = convert(html)
    expect(images).toHaveLength(1)
    expect(images[0].mimeType).toBe('png')
    expect(images[0].data).toBe(fakeBase64)
  })

  it('ignores non-whitelisted MIME types', async () => {
    const convert = await getConvert()
    const html = `<img src="data:application/octet-stream;base64,abc=">`
    const { images } = convert(html)
    expect(images).toHaveLength(0)
  })

  it('does not throw on malformed HTML', async () => {
    const convert = await getConvert()
    expect(() => convert('<p>Unclosed <b>bold')).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// extractImages
// ---------------------------------------------------------------------------
describe('extractImages', () => {
  async function getExtractImages() {
    const mod = await import('../main/ipc/notes.ipc')
    return mod.extractImages
  }

  async function getFs() {
    return await import('fs')
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes image files to assetsDir and resolves placeholders to asset:// URIs', async () => {
    const fsMod = await getFs()
    vi.mocked(fsMod.mkdirSync).mockReturnValue(undefined)
    vi.mocked(fsMod.writeFileSync).mockReturnValue(undefined)
    const extractImages = await getExtractImages()
    const images = [{ mimeType: 'png', data: 'abc123' }]
    const { markdown, count } = extractImages(
      images,
      '/storage/note-assets/note-uuid-123',
      'Before __IMG_0__ After'
    )
    expect(count).toBe(1)
    expect(markdown).toContain('asset://note-assets/note-uuid-123/image-000.png')
    expect(markdown).not.toContain('__IMG_0__')
    expect(fsMod.writeFileSync).toHaveBeenCalledOnce()
  })

  it('replaces placeholder with [image] if file write fails', async () => {
    const fsMod = await getFs()
    vi.mocked(fsMod.mkdirSync).mockReturnValue(undefined)
    vi.mocked(fsMod.writeFileSync).mockImplementation(() => { throw new Error('disk full') })
    const extractImages = await getExtractImages()
    const images = [{ mimeType: 'png', data: 'abc123' }]
    const { markdown, count } = extractImages(
      images,
      '/storage/note-assets/note-uuid-123',
      'Before __IMG_0__ After'
    )
    expect(count).toBe(0)
    expect(markdown).toContain('[image]')
    expect(markdown).not.toContain('__IMG_0__')
  })

  it('strips remaining placeholders to [image] on total failure', async () => {
    const fsMod = await getFs()
    vi.mocked(fsMod.mkdirSync).mockImplementation(() => { throw new Error('permission denied') })
    vi.mocked(fsMod.writeFileSync).mockImplementation(() => { throw new Error('permission denied') })
    const extractImages = await getExtractImages()
    const images = [{ mimeType: 'png', data: 'abc' }, { mimeType: 'jpeg', data: 'def' }]
    const { markdown } = extractImages(
      images,
      '/storage/note-assets/note-uuid-123',
      '__IMG_0__ text __IMG_1__'
    )
    expect(markdown).not.toContain('__IMG_0__')
    expect(markdown).not.toContain('__IMG_1__')
    expect(markdown).toContain('[image]')
  })
})

// ---------------------------------------------------------------------------
// buildFolderTree (pure function — inlined to avoid CSS module imports)
// ---------------------------------------------------------------------------
interface FolderNode { name: string; fullPath: string; children: FolderNode[] }

function buildFolderTree(paths: string[]): FolderNode[] {
  const roots: FolderNode[] = []
  const nodeMap = new Map<string, FolderNode>()
  for (const fullPath of paths) {
    const segments = fullPath.split('/')
    let currentPath = ''
    let parentNode: FolderNode | null = null
    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment
      if (!nodeMap.has(currentPath)) {
        const node: FolderNode = { name: segment, fullPath: currentPath, children: [] }
        nodeMap.set(currentPath, node)
        if (parentNode) { parentNode.children.push(node) } else { roots.push(node) }
      }
      parentNode = nodeMap.get(currentPath)!
    }
  }
  return roots
}

describe('buildFolderTree', () => {
  it('builds correct nested tree from flat path array', () => {
    const tree = buildFolderTree(['Work', 'Work/Q1', 'Work/Q2', 'Personal'])
    expect(tree).toHaveLength(2)
    expect(tree[0].name).toBe('Work')
    expect(tree[0].children).toHaveLength(2)
    expect(tree[0].children[0].name).toBe('Q1')
    expect(tree[0].children[1].name).toBe('Q2')
    expect(tree[1].name).toBe('Personal')
    expect(tree[1].children).toHaveLength(0)
  })

  it('handles duplicate ancestor paths gracefully', () => {
    const tree = buildFolderTree(['Work', 'Work/Q1', 'Work', 'Work/Q1'])
    expect(tree).toHaveLength(1)
    expect(tree[0].children).toHaveLength(1)
  })

  it('returns empty array for empty input', () => {
    expect(buildFolderTree([])).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// buildFingerprint
// ---------------------------------------------------------------------------
describe('buildFingerprint', () => {
  async function getFingerprint() {
    const mod = await import('../main/ipc/notes.ipc')
    return mod.buildFingerprint
  }

  it('returns first 200 chars of content', async () => {
    const buildFingerprint = await getFingerprint()
    const long = 'a'.repeat(300)
    expect(buildFingerprint(long)).toHaveLength(200)
    expect(buildFingerprint(long)).toBe('a'.repeat(200))
  })

  it('returns full content if shorter than 200 chars', async () => {
    const buildFingerprint = await getFingerprint()
    expect(buildFingerprint('hello')).toBe('hello')
  })
})
