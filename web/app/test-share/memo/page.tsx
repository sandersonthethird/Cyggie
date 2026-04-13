// Dev-only test fixture — renders MemoSharePage with mock data (no DB required)
import MemoSharePage from '../../../components/MemoSharePage'

export default function TestMemoSharePage() {
  if (process.env.NODE_ENV === 'production') {
    return <div>Not available</div>
  }

  return (
    <MemoSharePage
      token="test-token-12"
      title="Acme Corp Investment Memo"
      companyName="Acme Corp"
      contentMarkdown={`# Acme Corp\n\n**Stage:** Series A\n\n## Summary\n\nAcme Corp is building the next generation of enterprise automation.\n\n## Why Now\n\nAI enables 10x cost reduction in ops-heavy workflows.\n`}
      logoUrl={null}
      firmName={null}
      brandColor={null}
      companyLogoUrl={null}
    />
  )
}
