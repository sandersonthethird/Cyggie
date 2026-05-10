/**
 * Empty predicate matching PropertyRow.formatValue's nullish/empty-string check.
 * Source of truth — keep in sync with PropertyRow.tsx (formatValue, line ~66).
 */
export function isEmptyValue(value: unknown): boolean {
  return value == null || value === ''
}

/**
 * Count the number of fields in a section whose value is non-empty.
 * Used by the section header count pill in <CollapsibleSection>.
 *
 * Hidden fields (in `hiddenFields`) are excluded from the count regardless of
 * value. `addedFields` and `showAllFields` are NOT considered here — they affect
 * which rows are *rendered*, not how many real values exist. The count answers
 * "how much real data is in this section?" (decision: count = non-empty only).
 */
export function getVisibleFieldCount(
  fieldKeys: string[],
  getValue: (key: string) => unknown,
  hiddenFields: ReadonlyArray<string>,
): number {
  const hidden = new Set(hiddenFields)
  let count = 0
  for (const key of fieldKeys) {
    if (hidden.has(key)) continue
    if (!isEmptyValue(getValue(key))) count += 1
  }
  return count
}
