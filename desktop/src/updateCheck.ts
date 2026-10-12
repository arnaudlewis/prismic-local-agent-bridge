import { isNewerVersion } from "./version.ts"

export interface AvailableUpdate {
  version: string
  downloadUrl: string
}

const latestReleaseUrl = "https://api.github.com/repos/arnaudlewis/prismic-local-agent-bridge/releases/latest"
const downloadUrl = "https://github.com/arnaudlewis/prismic-local-agent-bridge/releases/latest/download/Prismic-Agent-mac-arm64.dmg"
const firstCheckDelayMs = 10_000
const checkIntervalMs = 6 * 60 * 60 * 1000

interface StartUpdateChecksArgs {
  currentVersion: string
  onUpdate: (update: AvailableUpdate) => void
}

// No electron-updater: an unsigned app can't install updates (Squirrel.Mac checks the signature), so the user is told
// and downloads the new dmg themselves.
export function startUpdateChecks(args: StartUpdateChecksArgs): void {
  const { currentVersion, onUpdate } = args

  async function check(): Promise<void> {
    try {
      const response = await fetch(latestReleaseUrl, {
        headers: { Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const release: unknown = await response.json()
      if (typeof release !== "object" || release === null || !("tag_name" in release)) return
      if (typeof release.tag_name !== "string") return
      const version = release.tag_name.replace(/^v/, "")
      if (isNewerVersion(version, currentVersion)) onUpdate({ version, downloadUrl })
    } catch (error) {
      console.warn("Update check failed:", error instanceof Error ? error.message : String(error))
    }
  }

  setTimeout(() => void check(), firstCheckDelayMs)
  setInterval(() => void check(), checkIntervalMs)
}
