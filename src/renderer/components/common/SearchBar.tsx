import { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppStore } from '../../stores/app.store'
import styles from './SearchBar.module.css'

export default function SearchBar() {
  const [value, setValue] = useState('')
  const setSearchQuery = useAppStore((s) => s.setSearchQuery)

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const query = e.target.value
      setValue(query)
      setSearchQuery(query)
    },
    [setSearchQuery]
  )

  const handleClear = useCallback(() => {
    setValue('')
    setSearchQuery('')
  }, [setSearchQuery])

  return (
    <div className={styles.wrapper}>
      <span className={styles.searchIcon}>&#128269;</span>
      <input
        type="text"
        className={styles.input}
        placeholder="Search meetings..."
        value={value}
        onChange={handleChange}
      />
      {value && (
        <button className={styles.clear} onClick={handleClear}>
          &#10005;
        </button>
      )}
    </div>
  )
}
