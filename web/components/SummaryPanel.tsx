import Image from 'next/image'
import ReactMarkdown from 'react-markdown'

interface SummaryPanelProps {
  title: string
  date: string
  durationSeconds: number | null
  speakerMap: Record<string, string>
  attendees: string[] | null
  summary: string | null
  notes: string | null
}

export default function SummaryPanel({
  title,
  date,
  durationSeconds,
  speakerMap,
  attendees,
  summary,
  notes,
}: SummaryPanelProps) {
  const formattedDate = new Date(date).toLocaleString()
  const durationMin = durationSeconds ? Math.round(durationSeconds / 60) : null
  const speakerEntries = Object.entries(speakerMap)

  return (
    <div className="max-w-2xl mx-auto">
      <Image
        src="/logo.png"
        alt="GORP Meeting Intelligence"
        width={180}
        height={98}
        className="mb-6"
        priority
      />
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">
        {title}
      </h1>

      <div className="flex flex-wrap gap-4 text-sm text-gray-500 dark:text-gray-400 mb-6">
        <span>{formattedDate}</span>
        {durationMin && <span>{durationMin} min</span>}
      </div>

      {speakerEntries.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-6">
          {speakerEntries.map(([idx, name]) => (
            <span
              key={idx}
              className="px-3 py-1 text-xs font-medium bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-full"
            >
              {name}
            </span>
          ))}
        </div>
      )}

      {notes && (
        <div className="mb-8">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-3">
            Notes
          </h2>
          <div className="whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-300 leading-relaxed">
            {notes}
          </div>
        </div>
      )}

      {summary ? (
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-3">
            Summary
          </h2>
          <div className="summary-markdown text-sm text-gray-800 dark:text-gray-200 leading-relaxed max-w-none">
            <ReactMarkdown>{summary}</ReactMarkdown>
          </div>
        </div>
      ) : (
        <div className="text-center text-gray-400 dark:text-gray-500 py-12">
          No summary available for this meeting.
        </div>
      )}
    </div>
  )
}
