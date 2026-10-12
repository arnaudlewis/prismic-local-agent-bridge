const versionPattern = /^(\d+)\.(\d+)\.(\d+)$/

// Compares major.minor.patch numerically; anything else (a prerelease, a typo) is never newer.
export function isNewerVersion(candidate: string, current: string): boolean {
  const next = versionPattern.exec(candidate)
  const now = versionPattern.exec(current)
  if (next === null || now === null) return false
  for (let index = 1; index <= 3; index++) {
    const difference = Number(next[index]) - Number(now[index])
    if (difference !== 0) return difference > 0
  }
  return false
}
