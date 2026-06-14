import { Redirect } from 'expo-router'

// Placeholder route backing the center "new meeting" tab slot. The tab's
// custom button (RecordTabButton) pushes /record directly and never triggers
// default navigation, so this screen normally never mounts. The <Redirect>
// is a backstop: if anything ever navigates to /new-meeting (a stray deep
// link, a future default-press regression), it lands on the recorder instead
// of a blank screen. Named `new-meeting` to avoid colliding with /record.
export default function NewMeetingPlaceholder() {
  return <Redirect href="/record" />
}
