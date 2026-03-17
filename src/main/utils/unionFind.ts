/**
 * Simple union-find (disjoint set) for transitive cluster merging.
 * Used for fuzzy duplicate detection in contact and company repos.
 */
export class UnionFind {
  private parent: Map<string, string> = new Map()

  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x)
    const root = this.parent.get(x)!
    if (root !== x) {
      this.parent.set(x, this.find(root))
    }
    return this.parent.get(x)!
  }

  union(a: string, b: string): void {
    this.parent.set(this.find(a), this.find(b))
  }

  clusters(): Map<string, string[]> {
    const result = new Map<string, string[]>()
    for (const key of this.parent.keys()) {
      const root = this.find(key)
      const existing = result.get(root)
      if (existing) existing.push(key)
      else result.set(root, [key])
    }
    return result
  }
}
