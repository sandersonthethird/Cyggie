export function getLastSyncedLabel(key: string): string {
  const raw = localStorage.getItem(key)
  if (!raw) return 'Never synced'
  const ms = new Date(raw).getTime()
  if (isNaN(ms)) return 'Never synced'
  const mins = Math.floor((Date.now() - ms) / 60000)
  if (mins < 1) return 'Last synced just now'
  if (mins < 60) return `Last synced ${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `Last synced ${hours}h ago`
  return `Last synced ${Math.floor(hours / 24)}d ago`
}
