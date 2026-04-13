// Dev-only test fixture — renders SharePage with mock data (no DB required)
import SharePage from '../../../components/SharePage'

export default function TestMeetingSharePage() {
  if (process.env.NODE_ENV === 'production') {
    return <div>Not available</div>
  }

  return (
    <SharePage
      token="test-token-12"
      title="Acme Corp — Series A Discussion"
      date={new Date('2025-04-10T14:00:00Z').toISOString()}
      durationSeconds={3600}
      speakerMap={{ '0': 'Alice', '1': 'Bob' }}
      attendees={['Alice', 'Bob']}
      summary="Discussion covered Series A terms, valuation, and timeline."
      notes="Follow up on cap table by EOW."
      logoUrl={null}
      firmName={null}
      brandColor={null}
      companies={null}
    />
  )
}
