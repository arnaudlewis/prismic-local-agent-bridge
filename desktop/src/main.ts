import { join } from "node:path"
import { Notification, app, dialog, shell } from "electron"

import { createBridgeProcess } from "./bridgeProcess.ts"
import type { BridgeState, SignOutAccount } from "./bridgeProcess.ts"
import { createStateStore } from "./state.ts"
import type { StateStore } from "./state.ts"
import { createTrayMenu } from "./trayMenu.ts"
import type { TrayMenu } from "./trayMenu.ts"
import { checkForUpdate, startUpdateChecks } from "./updateCheck.ts"
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
    onAccounts: () => tray?.refresh(),
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
    // Stopping the daemon ends a pending Claude sign-in as failed: that is not a failure to roll back.
    claudeToggleCount += 1
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
      signOut: (account) => void confirmAndSignOut(account),
      signInToChatGpt: () => void startChatGptSignIn(),
      checkForUpdates: () => void checkForUpdatesNow(),
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

  async function startChatGptSignIn(): Promise<void> {
    const url = await bridge.signIn()
    // The URL comes from our own daemon; only a web page is ever opened.
    if (url !== undefined && URL.canParse(url) && new URL(url).protocol === "https:") {
      void shell.openExternal(url)
      return
    }
    await dialog.showMessageBox({
      type: "error",
      message: "Couldn't start the ChatGPT sign-in",
      detail: "Check that Prismic Agent is running (the menu says so), then try again.",
    })
  }

  async function confirmAndSignOut(account: SignOutAccount): Promise<void> {
    const label = account === "prismic" ? "Prismic" : "ChatGPT"
    const { response } = await dialog.showMessageBox({
      type: "question",
      message: `Sign out of ${label}?`,
      detail:
        account === "prismic"
          ? "The agents can't read or edit your content until you sign in to Prismic again from the Page Builder."
          : "Codex stops working until you sign in with ChatGPT again from the Page Builder.",
      buttons: ["Sign Out", "Cancel"],
      defaultId: 1,
      cancelId: 1,
    })
    if (response !== 0) return
    if (await bridge.signOut(account)) {
      new Notification({ title: `Signed out of ${label}` }).show()
      return
    }
    await dialog.showMessageBox({
      type: "error",
      message: `Couldn't sign out of ${label}`,
      detail: "Check that Prismic Agent is running (the menu says so), then try again.",
    })
  }

  async function checkForUpdatesNow(): Promise<void> {
    const result = await checkForUpdate(app.getVersion())
    if (result.kind === "failed") {
      await dialog.showMessageBox({ type: "error", message: "Couldn't check for updates", detail: result.reason })
      return
    }
    if (result.kind === "up_to_date") {
      await dialog.showMessageBox({
        type: "info",
        message: "Prismic Agent is up to date",
        detail: `Version ${app.getVersion()} is the latest.`,
      })
      return
    }
    update = result.update
    tray?.refresh()
    const { response } = await dialog.showMessageBox({
      type: "info",
      message: `Prismic Agent ${result.update.version} is available`,
      detail: "Download it, open it and drag it over the old one in Applications.",
      buttons: ["Download", "Later"],
      defaultId: 0,
      cancelId: 1,
    })
    if (response === 0) void shell.openExternal(result.update.downloadUrl)
  }

  // Bumped at every toggle: the answer of a sign-in the user has since turned off (or off and on again) is not theirs.
  let claudeToggleCount = 0

  async function toggleClaudeCodeLogin(): Promise<void> {
    if (state === undefined) return
    const isEnabling = state.get().claudeCodeLogin !== true
    if (isEnabling) {
      const { response } = await dialog.showMessageBox({
        type: "warning",
        message: "Use your Claude Code subscription?",
        detail:
          "For demos only. Anthropic's terms don't allow a Claude subscription in third-party apps. " +
          "If Claude Code isn't signed in on this Mac, your browser opens to sign in with your Claude account. " +
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
    claudeToggleCount += 1
    const toggle = claudeToggleCount
    state.update({ claudeCodeLogin: isEnabling })
    await bridge.restart()
    tray?.refresh()
    if (isEnabling) await signInToClaudeCode(toggle)
  }

  // Right after the demo mode is enabled: the daemon signs Claude Code in when nobody is (it opens the browser). When
  // that fails the mode is turned off again, so that "on" always means a Claude the Page Builder can use.
  async function signInToClaudeCode(toggle: number): Promise<void> {
    const result = await bridge.signInToClaude()
    if (state === undefined || toggle !== claudeToggleCount) return
    if (result.status !== "failed") {
      if (result.status === "signed_in") {
        new Notification({ title: "Signed in to Claude Code", body: "Claude is ready in the Page Builder." }).show()
      }
      return
    }
    state.update({ claudeCodeLogin: false })
    await bridge.restart()
    tray?.refresh()
    await dialog.showMessageBox({
      type: "error",
      message: "Couldn't sign in to Claude Code",
      detail: `${result.reason} The demo option is off again: turn it on to try again.`,
    })
  }

  function isNewerCopy(data: unknown): boolean {
    if (typeof data !== "object" || data === null || !("version" in data)) return false
    return typeof data.version === "string" && isNewerVersion(data.version, app.getVersion())
  }
}
