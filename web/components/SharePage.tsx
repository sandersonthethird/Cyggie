'use client'

import Image from 'next/image'
import SummaryPanel from './SummaryPanel'
import ChatPanel from './ChatPanel'

interface SharePageProps {
  token: string
  title: string
  date: string
  durationSeconds: number | null
  speakerMap: Record<string, string>
  attendees: string[] | null
  summary: string | null
  notes: string | null
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
}: SharePageProps) {
  return (
    <div className="flex h-screen bg-white dark:bg-gray-950">
      <div className="w-[200px] flex-shrink-0 p-6">
        <Image
          src="/logo.png"
          alt="GORP Meeting Intelligence"
          width={160}
          height={87}
          priority
        />
      </div>
      <div className="flex-1 overflow-y-auto border-r border-gray-200 dark:border-gray-800 p-8">
        <SummaryPanel
          title={title}
          date={date}
          durationSeconds={durationSeconds}
          speakerMap={speakerMap}
          attendees={attendees}
          summary={summary}
          notes={notes}
        />
      </div>
      <div className="w-[560px] flex-shrink-0 flex flex-col">
        <ChatPanel token={token} meetingTitle={title} />
      </div>
    </div>
  )
}
