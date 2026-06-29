import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { resolveSpecToMount } from '../main/storage/shared-root'

// resolveSpecToMount is pure — driven entirely by injected listDir/isDir/home,
// so no real filesystem or Drive mount is needed.
const HOME = '/Users/tester'
const CS = join(HOME, 'Library', 'CloudStorage')

describe('resolveSpecToMount — map a firm Drive spec to this machine\'s mount', () => {
  it('returns no-spec when the firm has not set a shared folder', () => {
    expect(resolveSpecToMount(null, { home: HOME })).toEqual({ ok: false, reason: 'no-spec' })
  })

  it('returns no-drive-mount when no GoogleDrive-* mount exists', () => {
    const res = resolveSpecToMount(
      { provider: 'gdrive', relPath: 'Shared drives/Cyggie/Meeting Notes' },
      { home: HOME, listDir: () => ['Dropbox', 'OneDrive-Foo'], isDir: () => true },
    )
    expect(res).toEqual({ ok: false, reason: 'no-drive-mount' })
  })

  it('resolves rel_path under the single mounted Google account', () => {
    const spec = { provider: 'gdrive' as const, relPath: 'Shared drives/Cyggie/Meeting Notes' }
    const expected = join(CS, 'GoogleDrive-sandy@firm.com', spec.relPath)
    const res = resolveSpecToMount(spec, {
      home: HOME,
      listDir: (d) => (d === CS ? ['GoogleDrive-sandy@firm.com'] : []),
      isDir: (p) => p === expected,
    })
    expect(res).toEqual({ ok: true, path: expected })
  })

  it('with multiple Google accounts, picks the one whose tree actually contains rel_path', () => {
    const spec = { provider: 'gdrive' as const, relPath: 'Shared drives/Cyggie/Meeting Notes' }
    const right = join(CS, 'GoogleDrive-bob@firm.com', spec.relPath)
    const res = resolveSpecToMount(spec, {
      home: HOME,
      listDir: (d) =>
        d === CS ? ['GoogleDrive-personal@gmail.com', 'GoogleDrive-bob@firm.com'] : [],
      // Only bob's tree has the folder (personal account doesn't).
      isDir: (p) => p === right,
    })
    expect(res).toEqual({ ok: true, path: right })
  })

  it('returns folder-not-found when a mount exists but rel_path is missing (e.g. online-only/not synced)', () => {
    const res = resolveSpecToMount(
      { provider: 'gdrive', relPath: 'Shared drives/Cyggie/Meeting Notes' },
      {
        home: HOME,
        listDir: (d) => (d === CS ? ['GoogleDrive-sandy@firm.com'] : []),
        isDir: () => false,
      },
    )
    expect(res).toEqual({ ok: false, reason: 'folder-not-found' })
  })
})
