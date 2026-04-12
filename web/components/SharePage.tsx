'use client'

import SummaryPanel from './SummaryPanel'
import SharedHeader from './SharedHeader'
import SharedFooter from './SharedFooter'
import FloatingChatWidget from './FloatingChatWidget'

interface SharePageProps {
  token: string
  title: string
  date: string
  durationSeconds: number | null
  speakerMap: Record<string, string>
  attendees: string[] | null
  summary: string | null
  notes: string | null
  logoUrl: string | null
  firmName: string | null
  brandColor: string | null
}

export default function SharePage({
  token,
  title,
  date,
  durationSeconds,
  speakerMap,
  attendees,
  summary,
  notes,
  logoUrl,
  firmName,
  brandColor,
}: SharePageProps) {
  return (
    <div style={{ minHeight: '100vh', background: '#f9fafb', display: 'flex', flexDirection: 'column' }}>
      <SharedHeader
        label={firmName || 'Shared Meeting Note'}
        logoUrl={logoUrl ?? undefined}
        labelColor={brandColor ?? undefined}
      />

      <main style={{ flex: 1, padding: '32px 24px 100px' }}>
        <article style={{
          maxWidth: 840,
          margin: '0 auto',
          background: '#fff',
          borderRadius: 12,
          boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
          padding: '40px 48px',
        }}>
          <SummaryPanel
            title={title}
            date={date}
            durationSeconds={durationSeconds}
            speakerMap={speakerMap}
            attendees={attendees}
            summary={summary}
            notes={notes}
          />
          <div style={{
            marginTop: 40,
            paddingTop: 16,
            borderTop: '1px solid #e5e7eb',
            textAlign: 'center',
            fontSize: 12,
            color: '#d1d5db',
            letterSpacing: '0.03em',
          }}>
            Powered by Cyggie
          </div>
        </article>
      </main>

      <SharedFooter />
      <FloatingChatWidget token={token} apiPath="/api/chat" placeholder="Ask about this meeting…" />
    </div>
  )
}
