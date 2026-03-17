/**
 * Jaro-Winkler string similarity — pure TS, no dependencies.
 * Returns a value in [0, 1] where 1 = identical strings.
 *
 * Used for fuzzy duplicate detection in contact and company repos.
 */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1
  if (a.length === 0 || b.length === 0) return 0

  const matchWindow = Math.max(Math.floor(Math.max(a.length, b.length) / 2) - 1, 0)
  const aMatched = new Array<boolean>(a.length).fill(false)
  const bMatched = new Array<boolean>(b.length).fill(false)

  let matches = 0
  let transpositions = 0

  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - matchWindow)
    const hi = Math.min(b.length - 1, i + matchWindow)
    for (let j = lo; j <= hi; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue
      aMatched[i] = true
      bMatched[j] = true
      matches++
      break
    }
  }

  if (matches === 0) return 0

  let k = 0
  for (let i = 0; i < a.length; i++) {
    if (!aMatched[i]) continue
    while (!bMatched[k]) k++
    if (a[i] !== b[k]) transpositions++
    k++
  }

  const jaro =
    matches / a.length / 3 +
    matches / b.length / 3 +
    (matches - transpositions / 2) / matches / 3

  // Winkler prefix bonus (up to 4 chars)
  let prefix = 0
  for (let i = 0; i < Math.min(4, Math.min(a.length, b.length)); i++) {
    if (a[i] === b[i]) prefix++
    else break
  }

  return jaro + prefix * 0.1 * (1 - jaro)
}
