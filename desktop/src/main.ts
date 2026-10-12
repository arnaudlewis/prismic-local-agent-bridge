import { join } from "node:path"
import { Notification, app, dialog, shell } from "electron"

import { createBridgeProcess } from "./bridgeProcess.ts"
import type { BridgeState } from "./bridgeProcess.ts"
import { createStateStore } from "./state.ts"
import type { StateStore } from "./state.ts"
import { createTrayMenu } from "./trayMenu.ts"
import type { TrayMenu } from "./trayMenu.ts"
import { startUpdateChecks } from "./updateCheck.ts"
import type { AvailableUpdate } from "./updateCheck.ts"
import { isNewerVersion } from "./version.ts"

if (app.requestSingleInstanceLock({ version: app.getVersion() })) {
  run()
} else {
  app.quit()
}

function run(): void {
  const resources = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "build")
  // Set before `ready`: it decides where app.getPath("logs") (~/Library/Logs/Prismic Agent) points.
  app.setAppLogsPath()
  let state: StateStore | undefined
  let tray: TrayMenu | undefined
  let update: AvailableUpdate | undefined

  const bridge = createBridgeProcess({
    nodePath: join(resources, "runtime", "node"),
    cliPath: join(resources, "bridge", "src", "cli.ts"),
    cwd: join(resources, "bridge"),
    logsDir: app.getPath("logs"),
    extraArgs: () => (state?.get().claudeCodeLogin === true ? ["--claude-code-login"] : []),
    onChange: onBridgeChange,
  })

  // A prismic-agent:// link launches the app. Any website can open one, so the URL's content is ignored.
  app.on("open-url", (event) => {
    event.preventDefault()
    if (app.isReady()) bridge.startIfStopped()
  })

  app.on("second-instance", (_event, _argv, _cwd, data) => {
    if (isNewerCopy(data)) {
      // A newer copy was just dragged over this one and opened: relaunch it from disk once the daemon is stopped.
      app.relaunch()
      app.quit()
      return
    }
    bridge.startIfStopped()
  })

  app.on("before-quit", (event) => {
    if (bridge.isStopped()) return
    event.preventDefault()
    void bridge.stop().then(() => app.quit())
  })

  // No window: closing the last one (a dialog is none) must not quit the app.
  app.on("window-all-closed", () => {})

  void app.whenReady().then(onReady)

  function onReady(): void {
    // Only shown in the Dock when it runs unpackaged; the packaged app is a menu bar app (LSUIElement).
    app.dock?.hide()
    state = createStateStore(app.getPath("userData"))
    if (state.get().firstRunDone !== true) app.setLoginItemSettings({ openAtLogin: true })

    tray = createTrayMenu({
      bridge,
      getUpdate: () => update,
      claudeCodeLogin: { isEnabled: () => state?.get().claudeCodeLogin === true, toggle: () => void toggleClaudeCodeLogin() },
    })
    bridge.start()
    startUpdateChecks({ currentVersion: app.getVersion(), onUpdate: onUpdateFound })
  }

  function onBridgeChange(next: BridgeState): void {
    tray?.refresh()
    if (next.kind !== "running" || state === undefined || state.get().firstRunDone === true) return
    state.update({ firstRunDone: true })
    new Notification({
      title: "Prismic Agent is running",
      body: "Go back to the Page Builder and click Connect in the agent panel.",
    }).show()
  }

  function onUpdateFound(found: AvailableUpdate): void {
    update = found
    tray?.refresh()
    if (state === undefined || state.get().notifiedVersion === found.version) return
    state.update({ notifiedVersion: found.version })
    const notification = new Notification({
      title: `Prismic Agent ${found.version} is available`,
      body: "Click to download it, then open it and drag it over the old one in Applications.",
    })
    notification.on("click", () => void shell.openExternal(found.downloadUrl))
    notification.show()
  }

  async function toggleClaudeCodeLogin(): Promise<void> {
    if (state === undefined) return
    if (state.get().claudeCodeLogin !== true) {
      const { response } = await dialog.showMessageBox({
        type: "warning",
        message: "Use your Claude Code subscription?",
        detail:
          "For demos only. Anthropic's terms don't allow a Claude subscription in third-party apps. " +
          "Claude Code must already be signed in on this Mac (run claude in a terminal, then /login). " +
          "The agent restarts, and the Page Builder stops asking for an Anthropic API key.",
        buttons: ["Enable for the demo", "Cancel"],
        defaultId: 1,
        cancelId: 1,
      })
      if (response !== 0) {
        // Electron already flipped the checkbox when it was clicked: rebuild the menu from the real state.
        tray?.refresh()
        return
      }
    }
    state.update({ claudeCodeLogin: state.get().claudeCodeLogin !== true })
    await bridge.restart()
    tray?.refresh()
  }

  function isNewerCopy(data: unknown): boolean {
    if (typeof data !== "object" || data === null || !("version" in data)) return false
    return typeof data.version === "string" && isNewerVersion(data.version, app.getVersion())
  }
}
