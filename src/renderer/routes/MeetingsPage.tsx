import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { MeetingBucket, MeetingStatus } from '../../shared/types/meeting'
import type { CompanyEntityType, CompanyPipelineStage } from '../../shared/types/company'
import { ENTITY_TYPE_OPTIONS } from '../../shared/types/company'
import { useMeetings } from '../hooks/useMeetings'
import { MeetingsRail } from '../components/meetings/MeetingsRail'
import { MeetingsFeed } from '../components/meetings/MeetingsFeed'
import { COMPANY_STAGE_OPTIONS } from '../components/common/PipelineStepper'
import styles from './MeetingsPage.module.css'

const VALID_BUCKETS = new Set<MeetingBucket>(['all', 'today', 'upcoming', 'past', 'unreviewed'])
const VALID_STAGES = new Set<CompanyPipelineStage>(COMPANY_STAGE_OPTIONS.map(s => s.value))
const VALID_ENTITY_TYPES = new Set<string>(ENTITY_TYPE_OPTIONS.map(o => o.value))
const VALID_STATUSES = new Set<string>(['scheduled', 'recording', 'transcribed', 'summarized', 'error'])

function parseSetParam<T extends string>(searchParams: URLSearchParams, key: string, validSet: Set<string>): Set<T> | undefined {
  const raw = searchParams.get(key)
  if (!raw) return undefined
  const values = raw.split(',').filter(v => validSet.has(v)) as T[]
  return values.length > 0 ? new Set(values) : undefined
}

export default function MeetingsPage() {
  const [searchParams] = useSearchParams()

  const bucketParam = searchParams.get('bucket') as MeetingBucket | null
  const stageParam = searchParams.get('stage') as CompanyPipelineStage | null

  const bucket: MeetingBucket = bucketParam && VALID_BUCKETS.has(bucketParam) ? bucketParam : 'all'
  const stage = stageParam && VALID_STAGES.has(stageParam) ? stageParam : undefined
  const dateFrom = searchParams.get('dateFrom') || undefined
  const dateTo = searchParams.get('dateTo') || undefined

  const entityTypes = useMemo(
    () => parseSetParam<CompanyEntityType>(searchParams, 'entityType', VALID_ENTITY_TYPES),
    [searchParams]
  )
  const statuses = useMemo(
    () => parseSetParam<MeetingStatus>(searchParams, 'status', VALID_STATUSES),
    [searchParams]
  )

  const { groupedMeetings, filtered, counts } = useMeetings({
    bucket,
    stage,
    searchQuery: searchParams.get('q') ?? '',
    dateFrom,
    dateTo,
    entityTypes,
    statuses,
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
      />
    </div>
  )
}
