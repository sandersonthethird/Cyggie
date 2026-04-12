import { getDb } from '../../../lib/db'
import { sharedNotes } from '../../../drizzle/schema'
import { eq, and } from 'drizzle-orm'
import { notFound } from 'next/navigation'
import NoteSharePage from '../../../components/NoteSharePage'

interface PageProps {
  params: Promise<{ token: string }>
}

export default async function SharedNotePage({ params }: PageProps) {
  const { token } = await params

  const rows = await getDb()
    .select({
      token: sharedNotes.token,
      title: sharedNotes.title,
      contentMarkdown: sharedNotes.contentMarkdown,
      createdAt: sharedNotes.createdAt,
      logoUrl: sharedNotes.logoUrl,
      isActive: sharedNotes.isActive,
      expiresAt: sharedNotes.expiresAt,
    })
    .from(sharedNotes)
    .where(and(eq(sharedNotes.token, token), eq(sharedNotes.isActive, true)))
    .limit(1)

  const note = rows[0]

  if (!note) {
    notFound()
  }

  if (note.expiresAt && new Date(note.expiresAt) < new Date()) {
    notFound()
  }

  return (
    <NoteSharePage
      token={note.token}
      title={note.title}
      contentMarkdown={note.contentMarkdown}
      createdAt={note.createdAt.toISOString()}
      logoUrl={note.logoUrl ?? null}
    />
  )
}
