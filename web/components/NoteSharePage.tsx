'use client'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import SharedHeader from './SharedHeader'
import SharedFooter from './SharedFooter'
import FloatingChatWidget from './FloatingChatWidget'

interface NoteSharePageProps {
  token: string
  title: string
  contentMarkdown: string
  createdAt: string
  logoUrl: string | null
  firmName: string | null
  brandColor: string | null
}

export default function NoteSharePage({ token, title, contentMarkdown, createdAt, logoUrl, firmName, brandColor }: NoteSharePageProps) {
  const formattedDate = new Date(createdAt).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })

  return (
    <div style={{ minHeight: '100vh', background: '#f9fafb', display: 'flex', flexDirection: 'column' }}>
      <SharedHeader
        label={firmName || 'Shared Note'}
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
          <header style={{ marginBottom: 32, paddingBottom: 20, borderBottom: '1px solid #e5e7eb' }}>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: '#111827', margin: '0 0 6px' }}>{title}</h1>
            <p style={{ fontSize: 13, color: '#9ca3af', margin: 0 }}>{formattedDate}</p>
          </header>

          <div className="summary-markdown note-markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{contentMarkdown}</ReactMarkdown>
          </div>

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
      <FloatingChatWidget token={token} apiPath="/api/note-chat" placeholder="Ask about this note…" />
    </div>
  )
}
