import { useNavigate } from 'react-router-dom'
import type { Citation, CitationType } from '../../../shared/types/chat'
import styles from './CitationChip.module.css'

// M5 — renders the sources an assistant answer drew on, as tappable chips under
// the message. Mirrors the mobile CitationChipRow. The type→route map is kept
// identical to mobile's citationRoute (unit-tested both sides), modulo desktop's
// singular detail paths (/company/:id vs mobile /companies/[id]).

const ICON: Record<CitationType, string> = {
  company: '🏢',
  contact: '👤',
  meeting: '📅',
  note: '📝',
}

/** type → desktop route. Keep in sync with mobile citationRoute. */
export function citationRoute(c: Pick<Citation, 'type' | 'id'>): string {
  switch (c.type) {
    case 'company':
      return `/company/${c.id}`
    case 'contact':
      return `/contact/${c.id}`
    case 'meeting':
      return `/meeting/${c.id}`
    case 'note':
      return `/notes`
  }
}

export function CitationChipRow({ citations }: { citations?: Citation[] | null }) {
  const navigate = useNavigate()
  if (!citations || citations.length === 0) return null
  return (
    <div className={styles.row} aria-label="Sources">
      {citations.map((c) => (
        <button
          key={`${c.type}:${c.id}`}
          type="button"
          className={styles.chip}
          title={c.label}
          onClick={() => navigate(citationRoute(c))}
        >
          <span className={styles.icon} aria-hidden>
            {ICON[c.type]}
          </span>
          <span className={styles.label}>{c.label}</span>
        </button>
      ))}
    </div>
  )
}
