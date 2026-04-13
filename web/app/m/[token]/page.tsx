import { getDb } from '../../../lib/db'
import { sharedMemos } from '../../../drizzle/schema'
import { eq, and } from 'drizzle-orm'
import { notFound } from 'next/navigation'
import MemoSharePage from '../../../components/MemoSharePage'

interface PageProps {
  params: Promise<{ token: string }>
}

export default async function SharedMemoPage({ params }: PageProps) {
  const { token } = await params

  const rows = await getDb()
    .select({
      token: sharedMemos.token,
      title: sharedMemos.title,
      companyName: sharedMemos.companyName,
      contentMarkdown: sharedMemos.contentMarkdown,
      logoUrl: sharedMemos.logoUrl,
      firmName: sharedMemos.firmName,
      brandColor: sharedMemos.brandColor,
      companyLogoUrl: sharedMemos.companyLogoUrl,
      isActive: sharedMemos.isActive,
      expiresAt: sharedMemos.expiresAt,
    })
    .from(sharedMemos)
    .where(and(eq(sharedMemos.token, token), eq(sharedMemos.isActive, true)))
    .limit(1)

  const memo = rows[0]

  if (!memo) {
    notFound()
  }

  if (memo.expiresAt && new Date(memo.expiresAt) < new Date()) {
    notFound()
  }

  return (
    <MemoSharePage
      token={memo.token}
      title={memo.title}
      companyName={memo.companyName}
      contentMarkdown={memo.contentMarkdown}
      logoUrl={memo.logoUrl ?? null}
      firmName={memo.firmName ?? null}
      brandColor={memo.brandColor ?? null}
      companyLogoUrl={memo.companyLogoUrl ?? null}
    />
  )
}
