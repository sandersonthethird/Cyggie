import { beforeEach, describe, expect, it, vi } from 'vitest'

// notes.ts transitively imports the api client (expo/RN modules). Mock the
// client so we can assert the PATCH path + body shape without a real fetch.
const apiPatchMock = vi.fn()
const apiPostMock = vi.fn()
const apiDeleteMock = vi.fn()
vi.mock('../client', () => ({
  api: { get: vi.fn(), post: apiPostMock, patch: apiPatchMock, delete: apiDeleteMock },
  ApiError: class ApiError extends Error {},
}))

const { updateNote, createNote, deleteNote } = await import('../notes')

describe('api/notes updateNote', () => {
  beforeEach(() => {
    apiPatchMock.mockReset()
    apiPatchMock.mockResolvedValue({
      id: 'n1',
      title: 'T',
      content: 'body',
      isPinned: false,
      isPrivate: false,
      lamport: '123',
      updatedAt: '2026-06-12T00:00:00.000Z',
    })
  })

  it('PATCHes /notes/:id with the patch + lamport merged into the body', async () => {
    await updateNote('n1', { title: 'T', content: 'body' }, '123')
    expect(apiPatchMock).toHaveBeenCalledWith('/notes/n1', {
      title: 'T',
      content: 'body',
      lamport: '123',
    })
  })

  it('forwards the isPrivate toggle in the PATCH body', async () => {
    await updateNote('n1', { isPrivate: true }, '124')
    expect(apiPatchMock).toHaveBeenCalledWith('/notes/n1', {
      isPrivate: true,
      lamport: '124',
    })
  })

  it('url-encodes the note id', async () => {
    await updateNote('a/b c', { content: 'x' }, '5')
    expect(apiPatchMock.mock.calls[0]?.[0]).toBe('/notes/a%2Fb%20c')
  })

  it('returns the parsed UpdateNoteResult from the gateway', async () => {
    const result = await updateNote('n1', { content: 'body' }, '123')
    expect(result).toMatchObject({ id: 'n1', lamport: '123', content: 'body' })
  })

  it('forwards company/contact tags in the PATCH body', async () => {
    await updateNote('n1', { companyId: 'c1', contactId: null }, '125')
    expect(apiPatchMock).toHaveBeenCalledWith('/notes/n1', {
      companyId: 'c1',
      contactId: null,
      lamport: '125',
    })
  })

  it('propagates a 409 ApiError so the editor can reconcile', async () => {
    const { ApiError } = await import('../client')
    const conflict = new ApiError({ status: 409, code: 'HTTP_409', message: 'conflict' })
    apiPatchMock.mockRejectedValueOnce(conflict)
    await expect(updateNote('n1', { content: 'x' }, '1')).rejects.toBe(conflict)
  })
})

describe('api/notes createNote', () => {
  beforeEach(() => {
    apiPostMock.mockReset()
    apiPostMock.mockResolvedValue({ id: 'new1', title: null, content: '' })
  })

  it('POSTs /notes with the input + lamport merged into the body', async () => {
    await createNote({ content: '', title: null, folderPath: 'F' }, '900')
    expect(apiPostMock).toHaveBeenCalledWith('/notes', {
      content: '',
      title: null,
      folderPath: 'F',
      lamport: '900',
    })
  })

  it('returns the created NoteDetail', async () => {
    const note = await createNote({ content: 'x' }, '901')
    expect(note).toMatchObject({ id: 'new1' })
  })
})

describe('api/notes deleteNote', () => {
  beforeEach(() => {
    apiDeleteMock.mockReset()
    apiDeleteMock.mockResolvedValue({ ok: true })
  })

  it('soft delete (default) hits DELETE /notes/:id with no query', async () => {
    await deleteNote('n1')
    expect(apiDeleteMock).toHaveBeenCalledWith('/notes/n1')
  })

  it('hard delete appends ?hard=true (orphan cleanup)', async () => {
    await deleteNote('n1', { hard: true })
    expect(apiDeleteMock).toHaveBeenCalledWith('/notes/n1?hard=true')
  })

  it('url-encodes the note id', async () => {
    await deleteNote('a/b')
    expect(apiDeleteMock.mock.calls[0]?.[0]).toBe('/notes/a%2Fb')
  })
})
