import { useEffect, useRef, useState } from 'react'
import type { HardcodedFieldDef } from '../../constants/contactFields'
import type { CustomFieldWithValue } from '../../../shared/types/custom-fields'
import styles from './AddFieldDropdown.module.css'

export interface AddFieldDropdownProps {
  entityType: 'contact' | 'company'
  hardcodedDefs: HardcodedFieldDef[]
  customFields: CustomFieldWithValue[]
  addedFields: string[]            // currently in addedFields pref
  hiddenFields: string[]           // currently in hiddenFields pref
  entityData: Record<string, unknown>  // to check which hardcoded fields have values
  fieldPlacements: Record<string, string>   // current section overrides
  sections: { key: string; label: string }[]  // for the section <select> per row
  onToggleField(key: string, checked: boolean): void   // auto-add on check
  onSetSection(key: string, section: string): void     // inline section reassignment
  onCreateCustomField(): void
  onClose(): void
  defaultSection?: string  // pre-scroll to this section group
}

/** Pure helper — extract and test separately */
export function filterAndGroupFields(
  hardcodedDefs: HardcodedFieldDef[],
  customFields: CustomFieldWithValue[],
  addedFields: string[],
  entityData: Record<string, unknown>,
  fieldPlacements: Record<string, string>,
  sections: { key: string; label: string }[],
  query: string,
): Array<{
  sectionKey: string
  sectionLabel: string
  items: Array<{ key: string; label: string; checked: boolean; disabled: boolean; currentSection: string }>
}> {
  const q = query.toLowerCase()

  // Build all items
  const hardcoded = hardcodedDefs.map((def) => {
    const value = entityData[def.key]
    const hasValue = value !== null && value !== undefined && value !== ''
    const checked = hasValue || addedFields.includes(def.key)
    const currentSection = fieldPlacements[def.key] ?? def.defaultSection
    return {
      key: def.key,
      label: def.label,
      checked,
      disabled: hasValue,   // can't uncheck if already has value
      currentSection,
      isCustom: false,
    }
  })

  const custom = customFields.map((field) => {
    const hasValue = field.value !== null && field.value !== undefined
    const key = `custom:${field.id}`
    const checked = hasValue || addedFields.includes(key)
    const currentSection = field.section ?? 'unknown'
    return {
      key,
      label: field.label,
      checked,
      disabled: hasValue,
      currentSection,
      isCustom: true,
    }
  })

  const all = [...hardcoded, ...custom]
  const filtered = q ? all.filter((item) => item.label.toLowerCase().includes(q)) : all

  if (q) {
    // Search mode — flat list under a single "Results" group
    return [
      {
        sectionKey: '__search__',
        sectionLabel: 'Results',
        items: filtered.map(({ isCustom: _, ...rest }) => rest),
      },
    ]
  }

  // Grouped by section
  const sectionMap = new Map<string, typeof filtered>()
  for (const item of filtered) {
    const sec = item.currentSection
    if (!sectionMap.has(sec)) sectionMap.set(sec, [])
    sectionMap.get(sec)!.push(item)
  }

  return sections
    .map((sec) => ({
      sectionKey: sec.key,
      sectionLabel: sec.label,
      items: (sectionMap.get(sec.key) ?? []).map(({ isCustom: _, ...rest }) => rest),
    }))
    .filter((g) => g.items.length > 0)
}

export function AddFieldDropdown({
  hardcodedDefs,
  customFields,
  addedFields,
  hiddenFields: _hiddenFields,
  entityData,
  fieldPlacements,
  sections,
  onToggleField,
  onSetSection,
  onCreateCustomField,
  onClose,
  defaultSection,
}: AddFieldDropdownProps) {
  const [query, setQuery] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // Focus search on mount
  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  // Click-outside to close
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [onClose])

  // Scroll to defaultSection group on mount
  useEffect(() => {
    if (defaultSection) {
      const el = containerRef.current?.querySelector(`[data-section="${defaultSection}"]`)
      el?.scrollIntoView({ block: 'nearest' })
    }
  }, [defaultSection])

  const groups = filterAndGroupFields(
    hardcodedDefs,
    customFields,
    addedFields,
    entityData,
    fieldPlacements,
    sections,
    query,
  )

  return (
    <div ref={containerRef} className={styles.dropdown}>
      <div className={styles.searchRow}>
        <input
          ref={searchRef}
          className={styles.searchInput}
          placeholder="Search fields…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
        />
      </div>

      <div className={styles.list}>
        {groups.map((group) => (
          <div key={group.sectionKey} data-section={group.sectionKey}>
            {group.sectionKey !== '__search__' && (
              <div className={styles.sectionLabel}>{group.sectionLabel}</div>
            )}
            {group.items.map((item) => (
              <label
                key={item.key}
                className={`${styles.item} ${item.disabled ? styles.itemDisabled : ''}`}
              >
                <input
                  type="checkbox"
                  checked={item.checked}
                  disabled={item.disabled}
                  onChange={(e) => onToggleField(item.key, e.target.checked)}
                  className={styles.checkbox}
                />
                <span className={styles.itemLabel}>{item.label}</span>
                <select
                  className={styles.sectionSelect}
                  value={item.currentSection}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => onSetSection(item.key, e.target.value)}
                >
                  {sections.map((sec) => (
                    <option key={sec.key} value={sec.key}>{sec.label}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        ))}

        {groups.length === 0 && query && (
          <div className={styles.noResults}>No fields match "{query}"</div>
        )}
      </div>

      <div className={styles.footer}>
        <button className={styles.createFieldBtn} onClick={onCreateCustomField}>
          + Create custom field
        </button>
      </div>
    </div>
  )
}
