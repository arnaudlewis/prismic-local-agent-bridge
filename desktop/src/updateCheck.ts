import { isNewerVersion } from "./version.ts"

export interface AvailableUpdate {
  version: string
  downloadUrl: string
}

export type UpdateCheckResult =
  | { kind: "available"; update: AvailableUpdate }
  | { kind: "up_to_date" }
  | { kind: "failed"; reason: string }

const latestReleaseUrl = "https://api.github.com/repos/arnaudlewis/prismic-local-agent-bridge/releases/latest"
const downloadUrl = "https://github.com/arnaudlewis/prismic-local-agent-bridge/releases/latest/download/Prismic-Agent-mac-arm64.dmg"
const firstCheckDelayMs = 10_000
const checkIntervalMs = 6 * 60 * 60 * 1000

// No electron-updater: an unsigned app can't install updates (Squirrel.Mac checks the signature), so the user is told
// and downloads the new dmg themselves.
export async function checkForUpdate(currentVersion: string): Promise<UpdateCheckResult> {
  try {
    const response = await fetch(latestReleaseUrl, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return { kind: "failed", reason: `HTTP ${response.status}` }
    const release: unknown = await response.json()
    if (typeof release !== "object" || release === null || !("tag_name" in release)) {
      return { kind: "failed", reason: "unexpected answer" }
    }
    if (typeof release.tag_name !== "string") return { kind: "failed", reason: "unexpected answer" }
    const version = release.tag_name.replace(/^v/, "")
    return isNewerVersion(version, currentVersion)
      ? { kind: "available", update: { version, downloadUrl } }
      : { kind: "up_to_date" }
  } catch (error) {
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) }
  }
}

interface StartUpdateChecksArgs {
  currentVersion: string
  onUpdate: (update: AvailableUpdate) => void
}

// Checks shortly after launch, then every few hours. A failure (offline, rate limit) is only logged: the manual check
// from the menu reports it.
export function startUpdateChecks(args: StartUpdateChecksArgs): void {
  const { currentVersion, onUpdate } = args

  async function check(): Promise<void> {
    const result = await checkForUpdate(currentVersion)
    if (result.kind === "available") onUpdate(result.update)
    if (result.kind === "failed") console.warn(`Update check failed: ${result.reason}`)
  }

  setTimeout(() => void check(), firstCheckDelayMs)
  setInterval(() => void check(), checkIntervalMs)
}
