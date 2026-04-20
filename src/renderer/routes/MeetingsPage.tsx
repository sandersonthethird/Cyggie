import { useSearchParams } from 'react-router-dom'
import type { MeetingBucket } from '../../shared/types/meeting'
import type { CompanyPipelineStage } from '../../shared/types/company'
import { useMeetings } from '../hooks/useMeetings'
import { MeetingsRail } from '../components/meetings/MeetingsRail'
import { MeetingsFeed } from '../components/meetings/MeetingsFeed'
import styles from './MeetingsPage.module.css'

const VALID_BUCKETS = new Set<MeetingBucket>(['all', 'today', 'upcoming', 'past', 'unreviewed'])
const VALID_STAGES = new Set<CompanyPipelineStage>(['screening', 'diligence', 'decision', 'documentation', 'pass'])

export default function MeetingsPage() {
  const [searchParams] = useSearchParams()

  const bucketParam = searchParams.get('bucket') as MeetingBucket | null
  const stageParam = searchParams.get('stage') as CompanyPipelineStage | null

  const bucket: MeetingBucket = bucketParam && VALID_BUCKETS.has(bucketParam) ? bucketParam : 'all'
  const stage = stageParam && VALID_STAGES.has(stageParam) ? stageParam : undefined

  const { groupedMeetings, filtered, counts } = useMeetings({
    bucket,
    stage,
    searchQuery: searchParams.get('q') ?? '',
  })

  return (
    <div className={styles.page}>
      <MeetingsRail
        counts={counts}
        activeBucket={stage ? 'all' : bucket}
        activeStage={stage}
      />
      <MeetingsFeed
        groupedMeetings={groupedMeetings}
        filtered={filtered}
        searchQuery={searchParams.get('q') ?? ''}
      />
    </div>
  )
}
