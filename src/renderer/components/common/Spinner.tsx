import styles from './Spinner.module.css'

interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

export function Spinner({ size = 'md', className }: SpinnerProps) {
  return (
    <span
      className={`${styles.spinner} ${styles[size]}${className ? ` ${className}` : ''}`}
    />
  )
}
