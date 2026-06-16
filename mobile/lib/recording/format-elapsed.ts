// Shared MM:SS (or H:MM:SS past an hour) formatter for the live recording
// timer. Extracted from record.tsx so the meeting-view recording banner and
// the floating RecordingBubble render an identical timer.
export function formatElapsed(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds))
  const h = Math.floor(safe / 3600)
  const m = Math.floor((safe % 3600) / 60)
  const s = safe % 60
  const pad = (n: number) => n.toString().padStart(2, '0')
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`
  return `${pad(m)}:${pad(s)}`
}
