// Dev-only test fixture — renders NoteSharePage with mock data (no DB required)
import NoteSharePage from '../../../components/NoteSharePage'

export default function TestNoteSharePage() {
  if (process.env.NODE_ENV === 'production') {
    return <div>Not available</div>
  }

  return (
    <NoteSharePage
      token="test-token-12"
      title="Q1 Investment Thesis"
      contentMarkdown={`# Q1 Investment Thesis\n\nWe are focused on infrastructure, AI tooling, and climate tech.\n\n## Key Themes\n\n- Developer productivity\n- Energy transition\n- Foundation models\n`}
      createdAt={new Date('2025-04-01T09:00:00Z').toISOString()}
      logoUrl={null}
      firmName={null}
      brandColor={null}
    />
  )
}
