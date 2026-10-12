import { join } from "node:path"
import { Menu, Tray, app, nativeImage, shell } from "electron"
import type { MenuItemConstructorOptions } from "electron"

import type { BridgeProcess, BridgeState } from "./bridgeProcess.ts"
import type { AvailableUpdate } from "./updateCheck.ts"

interface CreateTrayMenuArgs {
  bridge: BridgeProcess
  getUpdate: () => AvailableUpdate | undefined
  // Demo only: Claude on the Claude Code login of this Mac.
  claudeCodeLogin: { isEnabled: () => boolean; toggle: () => void }
}

export interface TrayMenu {
  refresh(): void
}

export function createTrayMenu(args: CreateTrayMenuArgs): TrayMenu {
  const { bridge, getUpdate, claudeCodeLogin } = args
  // The "Template" suffix makes it a template image (tinted for the menu bar), and @2x is picked up automatically.
  const tray = new Tray(nativeImage.createFromPath(join(app.getAppPath(), "assets", "trayTemplate.png")))
  tray.setToolTip("Prismic Agent")

  function refresh(): void {
    const update = getUpdate()
    const items: MenuItemConstructorOptions[] = [
      { label: `Prismic Agent ${app.getVersion()}`, enabled: false },
      { label: statusLabel(bridge.state()), enabled: false },
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
    ]
    if (update !== undefined) {
      items.push({
        label: `Download Prismic Agent ${update.version}…`,
        click: () => void shell.openExternal(update.downloadUrl),
      })
    }
    items.push({ type: "separator" }, { label: "Quit Prismic Agent", click: () => app.quit() })
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
      return "Running: connect from the Page Builder"
    case "port_in_use":
      return "Port 7878 is used by another program"
    case "restarting":
      return `Stopped unexpectedly, restarting in ${state.inSeconds} s`
    case "stopped":
      return "Stopped"
  }
}
