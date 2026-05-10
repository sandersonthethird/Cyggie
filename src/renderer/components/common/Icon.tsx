import type { CSSProperties, ReactElement } from 'react'

export type IconKey =
  | 'globe'
  | 'tag'
  | 'pin'
  | 'user'
  | 'flag'
  | 'handshake'
  | 'calendar'
  | 'money'
  | 'link'
  | 'mail'
  | 'phone'
  | 'cap'
  | 'briefcase'
  | 'circle-dashed'

interface IconProps {
  name: IconKey | string | undefined
  size?: number
  className?: string
  style?: CSSProperties
  'aria-hidden'?: boolean
}

const PATHS: Record<IconKey, ReactElement> = {
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a13 13 0 0 1 0 18a13 13 0 0 1 0-18" />
    </>
  ),
  tag: (
    <>
      <path d="M20.59 13.41 13.41 20.59a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
      <circle cx="7" cy="7" r="1.5" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21s-7-7.58-7-12a7 7 0 1 1 14 0c0 4.42-7 12-7 12z" />
      <circle cx="12" cy="9" r="2.5" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  flag: (
    <>
      <path d="M5 21V4" />
      <path d="M5 4h11l-2 4 2 4H5" />
    </>
  ),
  handshake: (
    <>
      <path d="M3 11l4-4h4l3 3" />
      <path d="M21 13l-4 4h-4l-3-3" />
      <path d="M11 10l3 3" />
      <path d="M14 7l3 3" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 9h18" />
      <path d="M8 3v4" />
      <path d="M16 3v4" />
    </>
  ),
  money: (
    <>
      <path d="M12 3v18" />
      <path d="M16 7H9.5a2.5 2.5 0 0 0 0 5h5a2.5 2.5 0 0 1 0 5H7" />
    </>
  ),
  link: (
    <>
      <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 7l9 6 9-6" />
    </>
  ),
  phone: (
    <>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2A19.79 19.79 0 0 1 2.08 4.18 2 2 0 0 1 4.07 2h3a2 2 0 0 1 2 1.72 12.83 12.83 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.58 2.81.7A2 2 0 0 1 22 16.92z" />
    </>
  ),
  cap: (
    <>
      <path d="M2 9l10-5 10 5-10 5z" />
      <path d="M6 11v5a6 6 0 0 0 12 0v-5" />
    </>
  ),
  briefcase: (
    <>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
      <path d="M3 13h18" />
    </>
  ),
  'circle-dashed': (
    <>
      <circle cx="12" cy="12" r="9" strokeDasharray="3 3" />
    </>
  ),
}

const warned = new Set<string>()

export function Icon({ name, size = 12, className, style, 'aria-hidden': ariaHidden = true }: IconProps) {
  const key = (name ?? 'circle-dashed') as IconKey
  const paths = PATHS[key] ?? PATHS['circle-dashed']
  if (!PATHS[key] && name && !warned.has(name)) {
    warned.add(name)
    console.warn(`[Icon] unknown icon name: "${name}" — falling back to circle-dashed`)
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden={ariaHidden}
    >
      {paths}
    </svg>
  )
}
