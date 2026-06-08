import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { HardcodedFieldDef } from '../../constants/contactFields'
import type { CustomFieldWithValue } from '../../../shared/types/custom-fields'
import styles from './AddFieldDropdown.module.css'

/**
 * Editor descriptor returned by the parent's `getFieldEditor`. The modal renders
 * `renderEditor(draft, onChange)` inline under a checked field and calls
 * `commit(draft)` on Save. This keeps the modal decoupled from how each field
 * type is edited/persisted (PropertyRow for simple/ref/tag/multiselect fields,
 * bespoke pickers for investor/source-name fields).
 */
export interface FieldEditor {
  initialValue: unknown
  renderEditor(value: unknown, onChange: (v: unknown) => void): ReactNode
  commit(value: unknown): Promise<void>
}

export interface AddFieldDropdownProps {
  entityType: 'contact' | 'company'
  hardcodedDefs: HardcodedFieldDef[]
  customFields: CustomFieldWithValue[]
  addedFields: string[]            // currently in addedFields pref
  hiddenFields: string[]           // currently in hiddenFields pref
  entityData: Record<string, unknown>  // to check which hardcoded fields have values
  fieldPlacements: Record<string, string>   // current section overrides
  sections: { key: string; label: string }[]  // for the section <select> per row
  onToggleField(key: string, checked: boolean): void   // applied on Save
  onSetSection(key: string, section: string): void     // applied on Save
  onCreateCustomField(): void
  onClose(): void
  defaultSection?: string  // pre-scroll to this section group
  /** Resolve an inline value editor for a field key (null = not inline-editable). */
  getFieldEditor(fieldKey: string): FieldEditor | null
}

/*
 * ── Buffered modal state machine ───────────────────────────────────────────
 *   Nothing is applied to the panel/store until Save. The dismiss guard makes
 *   accidental clicks/Escape non-destructive once a session has changes.
 *
 *   check field ──► checked.add(key) → renders getFieldEditor(key)?.renderEditor
 *   type value ───► drafts[key] = value (via the editor's onChange)
 *   section <sel> ► sectionOverride[key]
 *   uncheck ──────► checked.delete(key)
 *
 *   SAVE   ► blur active editor → onToggleField diffs → onSetSection diffs
 *          → commit changed drafts (allSettled) → onClose
 *   CANCEL ► onClose (nothing was applied = revert)
 *   ESC / click-outside ► dirty ? ignore : Cancel   (also ignores listbox portals)
 */

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

/** Compute the set of field keys that count as "checked" at open time. */
function computeInitialChecked(
  hardcodedDefs: HardcodedFieldDef[],
  customFields: CustomFieldWithValue[],
  addedFields: string[],
  entityData: Record<string, unknown>,
): Set<string> {
  const s = new Set<string>()
  for (const def of hardcodedDefs) {
    const value = entityData[def.key]
    const hasValue = value !== null && value !== undefined && value !== ''
    if (hasValue || addedFields.includes(def.key)) s.add(def.key)
  }
  for (const f of customFields) {
    const key = `custom:${f.id}`
    const hasValue = f.value !== null && f.value !== undefined
    if (hasValue || addedFields.includes(key)) s.add(key)
  }
  return s
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
  getFieldEditor,
}: AddFieldDropdownProps) {
  const [query, setQuery] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // ── Buffered session state ──
  // Snapshot of what was checked / which section each key was in at open time,
  // so Save can diff and Cancel is a no-op.
  const initial = useRef<{ checked: Set<string>; sectionByKey: Record<string, string> }>(null as never)
  if (initial.current === null) {
    const sectionByKey: Record<string, string> = {}
    for (const def of hardcodedDefs) sectionByKey[def.key] = fieldPlacements[def.key] ?? def.defaultSection
    for (const f of customFields) {
      const k = `custom:${f.id}`
      sectionByKey[k] = fieldPlacements[k] ?? f.section ?? 'unknown'
    }
    initial.current = {
      checked: computeInitialChecked(hardcodedDefs, customFields, addedFields, entityData),
      sectionByKey,
    }
  }

  const [checked, setChecked] = useState<Set<string>>(() => new Set(initial.current.checked))
  const [sectionOverride, setSectionOverride] = useState<Record<string, string>>({})
  const [drafts, setDrafts] = useState<Record<string, unknown>>({})
  // Synchronous mirror of drafts so handleSave can read the value a just-blurred
  // editor records during the forced blur (F1).
  const draftsRef = useRef<Record<string, unknown>>({})

  function recordDraft(key: string, value: unknown) {
    draftsRef.current = { ...draftsRef.current, [key]: value }
    setDrafts(draftsRef.current)
  }

  function toggleChecked(key: string, on: boolean) {
    setChecked((prev) => {
      const next = new Set(prev)
      if (on) next.add(key); else next.delete(key)
      return next
    })
  }

  const dirty =
    checked.size !== initial.current.checked.size ||
    [...checked].some((k) => !initial.current.checked.has(k)) ||
    Object.keys(sectionOverride).some((k) => sectionOverride[k] !== initial.current.sectionByKey[k]) ||
    Object.keys(drafts).length > 0
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty

  // Focus search on mount
  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  // Click-outside → Cancel, but only when there are no unsaved changes, and
  // never when the click lands inside a portal popover (select/date dropdowns
  // render to document.body with role="listbox").
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      const target = e.target as HTMLElement | null
      if (!target) return
      if (containerRef.current?.contains(target)) return
      if (target.closest?.('[role="listbox"]')) return
      if (dirtyRef.current) return
      onClose()
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

  function handleCancel() {
    onClose()
  }

  async function handleSave() {
    // Flush any focused editor so its latest value lands in draftsRef (F1).
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    await Promise.resolve()

    // 1) Field add/remove diffs
    for (const key of checked) if (!initial.current.checked.has(key)) onToggleField(key, true)
    for (const key of initial.current.checked) if (!checked.has(key)) onToggleField(key, false)

    // 2) Section diffs
    for (const key of Object.keys(sectionOverride)) {
      if (sectionOverride[key] !== initial.current.sectionByKey[key]) onSetSection(key, sectionOverride[key])
    }

    // 3) Value writes — only for still-checked, editable fields whose draft changed
    const writes: Promise<unknown>[] = []
    for (const key of Object.keys(draftsRef.current)) {
      if (!checked.has(key)) continue
      const ed = getFieldEditor(key)
      if (!ed) continue
      const val = draftsRef.current[key]
      if (val === ed.initialValue) continue
      writes.push(
        Promise.resolve(ed.commit(val)).catch((err) =>
          console.error('AddField: failed to save value for', key, err),
        ),
      )
    }
    await Promise.allSettled(writes)
    onClose()
  }

  // Group/section state is driven by buffered local state: merge section
  // overrides into placements and use local `checked` for the synthetic
  // addedFields so grouping + checkbox state stay consistent while editing.
  const mergedPlacements = { ...fieldPlacements, ...sectionOverride }
  const groups = filterAndGroupFields(
    hardcodedDefs,
    customFields,
    [...checked],
    entityData,
    mergedPlacements,
    sections,
    query,
  )

  return (
    <div
      ref={containerRef}
      className={styles.dropdown}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !dirtyRef.current) handleCancel()
      }}
    >
      <div className={styles.searchRow}>
        <input
          ref={searchRef}
          className={styles.searchInput}
          placeholder="Search fields…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className={styles.columnHeader}>
        <span className={styles.columnHeaderField}>Field</span>
        <span className={styles.columnHeaderSection}>Section</span>
      </div>

      <div className={styles.list}>
        {groups.map((group) => (
          <div key={group.sectionKey} data-section={group.sectionKey}>
            {group.sectionKey !== '__search__' && (
              <div className={styles.sectionLabel}>{group.sectionLabel}</div>
            )}
            {group.items.map((item) => {
              const isChecked = checked.has(item.key)
              const editor = isChecked ? getFieldEditor(item.key) : null
              const draftValue = item.key in drafts ? drafts[item.key] : editor?.initialValue
              return (
                <div key={item.key} className={styles.itemWrap}>
                  <label className={`${styles.item} ${item.disabled ? styles.itemDisabled : ''}`}>
                    <input
                      type="checkbox"
                      checked={isChecked}
                      disabled={item.disabled}
                      onChange={(e) => toggleChecked(item.key, e.target.checked)}
                      className={styles.checkbox}
                    />
                    <span className={styles.itemLabel}>{item.label}</span>
                    <select
                      className={styles.sectionSelect}
                      value={item.currentSection}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setSectionOverride((s) => ({ ...s, [item.key]: e.target.value }))}
                    >
                      {sections.map((sec) => (
                        <option key={sec.key} value={sec.key}>{sec.label}</option>
                      ))}
                    </select>
                  </label>
                  {editor && (
                    <div className={styles.inlineEditorRow}>
                      {editor.renderEditor(draftValue, (v) => recordDraft(item.key, v))}
                    </div>
                  )}
                </div>
              )
            })}
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
        <button className={styles.cancelBtn} onClick={handleCancel}>Cancel</button>
        <button className={styles.saveBtn} onClick={() => void handleSave()}>Save</button>
      </div>
    </div>
  )
}
