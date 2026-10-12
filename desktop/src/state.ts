import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

export interface AppState {
  // The first launch registers the login item and tells the user what to do next; later launches don't.
  firstRunDone?: boolean
  // Demo only: run Claude on the Claude Code login of this Mac instead of an API key.
  claudeCodeLogin?: boolean
  // The release the user was last notified about, so the notification shows once per release.
  notifiedVersion?: string
}

export interface StateStore {
  get(): AppState
  update(change: AppState): void
}

export function createStateStore(userDataDir: string): StateStore {
  const file = join(userDataDir, "state.json")
  let state = read()

  function read(): AppState {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
      if (typeof parsed !== "object" || parsed === null) return {}
      return {
        ...("firstRunDone" in parsed && parsed.firstRunDone === true ? { firstRunDone: true } : {}),
        ...("claudeCodeLogin" in parsed && parsed.claudeCodeLogin === true ? { claudeCodeLogin: true } : {}),
        ...("notifiedVersion" in parsed && typeof parsed.notifiedVersion === "string"
          ? { notifiedVersion: parsed.notifiedVersion }
          : {}),
      }
    } catch {
      return {}
    }
  }

  return {
    get: () => state,
    update(change) {
      state = { ...state, ...change }
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(state))
    },
  }
}
