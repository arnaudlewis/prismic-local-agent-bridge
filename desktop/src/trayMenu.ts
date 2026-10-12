import { join } from "node:path"
import { Menu, Tray, app, nativeImage, shell } from "electron"
import type { MenuItemConstructorOptions, NativeImage } from "electron"

import type { BridgeProcess, BridgeState, SignOutAccount } from "./bridgeProcess.ts"
import type { AvailableUpdate } from "./updateCheck.ts"

interface CreateTrayMenuArgs {
  bridge: BridgeProcess
  getUpdate: () => AvailableUpdate | undefined
  // Demo only: Claude on the Claude Code login of this Mac.
  claudeCodeLogin: { isEnabled: () => boolean; toggle: () => void }
  // Asks the user to confirm, then signs the daemon out of that OAuth account.
  signOut: (account: SignOutAccount) => void
  signInToChatGpt: () => void
  checkForUpdates: () => void
}

export interface TrayMenu {
  refresh(): void
}

type IconName = "trayGray" | "trayOrange" | "trayRed" | "trayGreen"

function loadIcon(name: IconName): NativeImage {
  return nativeImage.createFromPath(join(app.getAppPath(), "assets", `${name}.png`))
}

export function createTrayMenu(args: CreateTrayMenuArgs): TrayMenu {
  const { bridge, getUpdate, claudeCodeLogin, signOut, signInToChatGpt, checkForUpdates } = args
  // Colored images, not template ones: a template image is tinted by the menu bar and can't be orange or green. @2x is
  // picked up automatically.
  const icons: Record<IconName, NativeImage> = {
    trayGray: loadIcon("trayGray"),
    trayOrange: loadIcon("trayOrange"),
    trayRed: loadIcon("trayRed"),
    trayGreen: loadIcon("trayGreen"),
  }
  const tray = new Tray(icons.trayGray)
  tray.setToolTip("Prismic Agent")

  function refresh(): void {
    const state = bridge.state()
    tray.setImage(icons[iconNameFor(state)])
    const update = getUpdate()
    const items: MenuItemConstructorOptions[] = [
      { label: `Prismic Agent ${app.getVersion()}`, enabled: false },
      { label: statusLabel(state), enabled: false },
      ...editorLines(state),
      ...accountLines(bridge.accounts()),
      { type: "separator" },
      { label: "Restart", click: () => void bridge.restart() },
      { label: "Show Logs", click: () => void shell.openPath(app.getPath("logs")) },
      {
        label: "Use my Claude Code subscription (demo)",
        type: "checkbox",
        checked: claudeCodeLogin.isEnabled(),
        click: () => claudeCodeLogin.toggle(),
      },
      {
        label: "Open at Login",
        type: "checkbox",
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => {
          app.setLoginItemSettings({ openAtLogin: item.checked })
          refresh()
        },
      },
      {
        label: "Sign Out",
        submenu: [
          { label: "Sign out of Prismic…", click: () => signOut("prismic") },
          { label: "Sign out of ChatGPT…", click: () => signOut("chatgpt") },
        ],
      },
      { label: "Sign in with ChatGPT…", click: () => signInToChatGpt() },
    ]
    if (update !== undefined) {
      items.push({
        label: `Download Prismic Agent ${update.version}…`,
        click: () => void shell.openExternal(update.downloadUrl),
      })
    }
    items.push(
      { label: "Check for Updates…", click: () => checkForUpdates() },
      { type: "separator" },
      { label: "Quit Prismic Agent", click: () => app.quit() },
    )
    tray.setContextMenu(Menu.buildFromTemplate(items))
  }

  refresh()
  return { refresh }
}

function statusLabel(state: BridgeState): string {
  switch (state.kind) {
    case "starting":
      return "Starting…"
    case "running":
      return state.editors.length > 0 ? "Connected to the Page Builder" : "Running: connect from the Page Builder"
    case "port_in_use":
      return "Port 7878 is used by another program"
    case "restarting":
      return `Stopped unexpectedly, restarting in ${state.inSeconds} s`
    case "stopped":
      return "Stopped"
  }
}

// Grey: off. Orange: starting, or running and waiting for a Page Builder. Red: error. Green: linked to a Page Builder.
function iconNameFor(state: BridgeState): IconName {
  switch (state.kind) {
    case "stopped":
      return "trayGray"
    case "starting":
      return "trayOrange"
    case "running":
      return state.editors.length > 0 ? "trayGreen" : "trayOrange"
    case "port_in_use":
    case "restarting":
      return "trayRed"
  }
}

function editorLines(state: BridgeState): MenuItemConstructorOptions[] {
  if (state.kind !== "running") return []
  return state.editors.map((origin) => ({ label: `Linked to ${URL.canParse(origin) ? new URL(origin).host : origin}`, enabled: false }))
}

// Who the daemon runs as (an email, a plan), as the daemon describes it. Empty until it has reported.
function accountLines(accounts: string[]): MenuItemConstructorOptions[] {
  if (accounts.length === 0) return []
  return [{ type: "separator" }, ...accounts.map((line): MenuItemConstructorOptions => ({ label: line, enabled: false }))]
}
