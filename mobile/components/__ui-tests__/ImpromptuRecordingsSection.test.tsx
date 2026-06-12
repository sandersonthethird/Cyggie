import { render, screen, fireEvent } from '@testing-library/react-native'
import { ImpromptuRecordingsSection } from '../ImpromptuRecordingsSection'
import { ApiError } from '../../lib/api/client'
import type { MeetingDetail } from '../../lib/api/meetings'

// First MC.runner test — proves the Jest + jest-expo + RNTL stack renders
// real RN component trees and that we can query / fire events on them.
// Component under test: ImpromptuRecordingsSection ("My Recordings" section
// of the calendar Past tab, shipped in T16 / commit c07cdf2).

function makeMeeting(overrides: Partial<MeetingDetail> = {}): MeetingDetail {
  return {
    id: 'm_default',
    title: 'Default recording',
    date: '2026-05-25T14:00:00.000Z',
    durationSeconds: 1800,
    status: 'transcribed',
    updatedAt: '2026-05-25T14:30:00.000Z',
    lamport: '0',
    scheduledEndAt: null,
    calendarEventId: null,
    wasImpromptu: true,
    isGroupEvent: false,
    meetingPlatform: null,
    meetingUrl: null,
    location: null,
    notes: null,
    summary: null,
    speakerCount: 1,
    hasTranscript: true,
    transcriptSegments: [],
    linkedCompanies: [],
    linkedContacts: [],
    attendeeContacts: [],
    ...overrides,
  }
}

describe('ImpromptuRecordingsSection', () => {
  test('renders skeleton while loading with no data yet', () => {
    render(
      <ImpromptuRecordingsSection
        meetings={null}
        isLoading
        error={null}
        onPress={() => {}}
      />,
    )

    // Header always visible alongside the skeleton.
    expect(screen.getByText('MY RECORDINGS')).toBeOnTheScreen()
    expect(screen.getByTestId('impromptu-skeleton')).toBeOnTheScreen()
    expect(screen.queryByTestId('impromptu-section')).toBeNull()
  })

  test('renders inline error with the ApiError code + message', () => {
    const err = new ApiError({
      status: 503,
      code: 'GATEWAY_UNAVAILABLE',
      message: 'Gateway is down',
    })
    render(
      <ImpromptuRecordingsSection
        meetings={null}
        isLoading={false}
        error={err}
        onPress={() => {}}
      />,
    )

    expect(screen.getByText('MY RECORDINGS')).toBeOnTheScreen()
    const errNode = screen.getByTestId('impromptu-error')
    expect(errNode).toHaveTextContent('GATEWAY_UNAVAILABLE')
    expect(errNode).toHaveTextContent('Gateway is down')
  })

  test('returns null when empty (no header, no skeleton)', () => {
    render(
      <ImpromptuRecordingsSection
        meetings={[]}
        isLoading={false}
        error={null}
        onPress={() => {}}
      />,
    )

    expect(screen.queryByText('MY RECORDINGS')).toBeNull()
    expect(screen.queryByTestId('impromptu-skeleton')).toBeNull()
    expect(screen.queryByTestId('impromptu-section')).toBeNull()
  })

  test('renders header + meeting rows; tap fires onPress with the meeting id', () => {
    const onPress = jest.fn()
    const meetings = [
      makeMeeting({ id: 'm_aaa', title: 'Walk and talk' }),
      makeMeeting({ id: 'm_bbb', title: 'Cafe chat' }),
    ]

    render(
      <ImpromptuRecordingsSection
        meetings={meetings}
        isLoading={false}
        error={null}
        onPress={onPress}
      />,
    )

    expect(screen.getByText('MY RECORDINGS')).toBeOnTheScreen()
    expect(screen.getByTestId('impromptu-section')).toBeOnTheScreen()
    expect(screen.getByText('Walk and talk')).toBeOnTheScreen()
    expect(screen.getByText('Cafe chat')).toBeOnTheScreen()

    fireEvent.press(screen.getByText('Walk and talk'))
    expect(onPress).toHaveBeenCalledTimes(1)
    expect(onPress).toHaveBeenCalledWith('m_aaa')

    fireEvent.press(screen.getByText('Cafe chat'))
    expect(onPress).toHaveBeenCalledTimes(2)
    expect(onPress).toHaveBeenLastCalledWith('m_bbb')
  })
})
