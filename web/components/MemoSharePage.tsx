'use client'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import ChatPanel from './ChatPanel'

interface MemoSharePageProps {
  token: string
  title: string
  companyName: string
  contentMarkdown: string
  logoUrl: string | null
  companyLogoUrl: string | null
}

export default function MemoSharePage({
  token,
  title,
  companyName,
  contentMarkdown,
  logoUrl,
  companyLogoUrl,
}: MemoSharePageProps) {
  return (
    <div className="flex flex-col h-screen bg-white dark:bg-gray-950">
      {/* Header: firm logo left | title center | company logo right */}
      <div className="flex items-center gap-3 px-8 py-4 border-b border-gray-200 dark:border-gray-800 flex-shrink-0">
        {/* Firm logo (left) */}
        {logoUrl ? (
          <img
            src={logoUrl}
            alt="Firm logo"
            className="h-8 w-8 rounded object-contain flex-shrink-0"
          />
        ) : (
          <div className="h-8 w-8 flex-shrink-0" />
        )}

        {/* Title + company name (center, flex fill) */}
        <div className="flex-1 min-w-0 text-center">
          <h1 className="text-base font-semibold text-gray-900 dark:text-gray-100 truncate">{title}</h1>
          <p className="text-xs text-gray-500 dark:text-gray-400">{companyName}</p>
        </div>

        {/* Company logo (right) */}
        {companyLogoUrl ? (
          <img
            src={companyLogoUrl}
            alt={`${companyName} logo`}
            className="h-8 w-8 rounded object-contain flex-shrink-0"
          />
        ) : (
          <div className="h-8 w-8 flex-shrink-0" />
        )}
      </div>

      {/* Memo content — scrollable */}
      <div className="flex-1 overflow-y-auto px-8 py-6 min-h-0">
        <div className="max-w-3xl mx-auto summary-markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{contentMarkdown}</ReactMarkdown>
        </div>
      </div>

      {/* Chat bar pinned to bottom */}
      <div className="flex-shrink-0 border-t border-gray-200 dark:border-gray-800" style={{ maxHeight: '45vh' }}>
        <ChatPanel
          token={token}
          meetingTitle={title}
          apiPath="/api/memo-chat"
          showHeader={false}
        />
      </div>
    </div>
  )
}
