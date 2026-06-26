/**
 * A loading placeholder that speaks in the brand voice (and winks late at
 * night). Drop-in replacement for a hardcoded "Loading…" string — pass the
 * caller's row className so it fits the surrounding layout.
 *
 * New loading states should prefer this over a bare "Loading…" so they pick up
 * the brand voice and the user's intensity setting for free.
 */
import { useLoadingLine } from '../../hooks/useVoice'
import type { SubKey } from '@shared/voice'

interface LoadingRowProps {
  className?: string
  /** Catalog sub-key (default 'generic'); e.g. 'integrations' for syncs. */
  sub?: SubKey
  /** Local hour (0–23) to unlock the late-night line pool. */
  hour?: number
}

export default function LoadingRow({ className, sub = 'generic', hour }: LoadingRowProps) {
  const line = useLoadingLine(sub, hour)
  return <div className={className}>{line}</div>
}
