import { getDb } from '../../../lib/db'
import { sharedMeetings } from '../../../drizzle/schema'
import { eq, and } from 'drizzle-orm'
import { notFound } from 'next/navigation'
import SharePage from '../../../components/SharePage'

interface PageProps {
  params: Promise<{ token: string }>
}

export default async function SharedMeetingPage({ params }: PageProps) {
  const { token } = await params

  const rows = await getDb()
    .select({
      token: sharedMeetings.token,
      title: sharedMeetings.title,
      date: sharedMeetings.date,
      durationSeconds: sharedMeetings.durationSeconds,
      speakerMap: sharedMeetings.speakerMap,
      attendees: sharedMeetings.attendees,
      summary: sharedMeetings.summary,
      notes: sharedMeetings.notes,
      logoUrl: sharedMeetings.logoUrl,
      isActive: sharedMeetings.isActive,
      expiresAt: sharedMeetings.expiresAt,
    })
    .from(sharedMeetings)
    .where(and(eq(sharedMeetings.token, token), eq(sharedMeetings.isActive, true)))
    .limit(1)

  const meeting = rows[0]

  if (!meeting) {
    notFound()
  }

  if (meeting.expiresAt && new Date(meeting.expiresAt) < new Date()) {
    notFound()
  }

  return (
    <SharePage
      token={meeting.token}
      title={meeting.title}
      date={meeting.date.toISOString()}
      durationSeconds={meeting.durationSeconds}
      speakerMap={meeting.speakerMap as Record<string, string>}
      attendees={meeting.attendees as string[] | null}
      summary={meeting.summary}
      notes={meeting.notes}
      logoUrl={meeting.logoUrl ?? null}
    />
  )
}
