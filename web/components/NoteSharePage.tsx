'use client'

import ReactMarkdown from 'react-markdown'

interface NoteSharePageProps {
  title: string
  contentMarkdown: string
  createdAt: string
}

export default function NoteSharePage({ title, contentMarkdown, createdAt }: NoteSharePageProps) {
  const formattedDate = new Date(createdAt).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })

  return (
    <div className="min-h-screen bg-white dark:bg-gray-950">
      <div className="max-w-3xl mx-auto px-6 py-10">
        <header className="mb-8 border-b border-gray-200 dark:border-gray-800 pb-6">
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100 mb-1">{title}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">{formattedDate}</p>
        </header>
        <div className="prose prose-sm dark:prose-invert prose-headings:font-semibold prose-h1:text-2xl prose-h2:text-xl prose-h3:text-lg max-w-none">
          <ReactMarkdown>{contentMarkdown}</ReactMarkdown>
        </div>
      </div>
    </div>
  )
}
