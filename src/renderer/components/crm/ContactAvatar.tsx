import styles from './ContactAvatar.module.css'

const COLORS = [
  '#3D7A4A', '#7B5EA7', '#C9943A', '#3A7BC9', '#D94545',
  '#2E9E8A', '#7B8FB8', '#B87B3A'
]

interface ContactAvatarProps {
  name: string
  size?: 'sm' | 'md' | 'lg'
}

export function ContactAvatar({ name, size = 'md' }: ContactAvatarProps) {
  const initials = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('')

  const color = COLORS[name.charCodeAt(0) % COLORS.length]

  return (
    <div
      className={`${styles.avatar} ${styles[size]}`}
      style={{ backgroundColor: color }}
      title={name}
    >
      {initials || '?'}
    </div>
  )
}
