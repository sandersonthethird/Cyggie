/**
 * Returns deterministic pastel background + dark text colors for a chip element.
 * The hash is computed once and both HSL values are derived from the same hue.
 */
export function chipStyle(str: string): { background: string; color: string } {
  let h = 0
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) & 0xffff
  const hue = h % 360
  return {
    background: `hsl(${hue}, 60%, 88%)`,
    color: `hsl(${hue}, 45%, 28%)`,
  }
}
