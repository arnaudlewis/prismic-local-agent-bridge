# Prismic Agent (macOS app)

A menu bar app that keeps the bridge daemon running on its own: it starts at login, restarts after a crash, and
installs without a terminal. It ships a Node runtime and the daemon's source, so nothing else has to be installed.
macOS on Apple Silicon only. The app is not signed with an Apple Developer ID (see "Open an unsigned app").

The daemon itself is documented in the [root README](../README.md). This file covers the app, how to install it, how it
runs the daemon, and how to release it.

- [Install and open it](#install-and-open-it)
- [Open an unsigned app](#open-an-unsigned-app)
- [The menu bar icon and menu](#the-menu-bar-icon-and-menu)
- [How the daemon runs](#how-the-daemon-runs)
- [Accounts](#accounts)
- [Updates](#updates)
- [Build it](#build-it)
- [Release it](#release-it)
- [Troubleshooting](#troubleshooting)

## Install and open it

1. Download `Prismic-Agent-mac-arm64.dmg` from the
   [latest release](https://github.com/arnaudlewis/prismic-local-agent-bridge/releases/latest).
2. Open the dmg and drag **Prismic Agent** to **Applications**.
3. Open it once (see the next section: macOS blocks the first launch). A Prismic mark appears in the menu bar and a
   notification says the agent is running.
4. In the Page Builder, open the agent panel and click **Connect**. The panel finds the app on its own.

The first time you use Codex or Claude, the daemon downloads that agent's program (about 120 MB for Codex, about
100 MB for Claude), checks it against the checksum pinned in `package-lock.json`, and keeps it. This happens once per
agent and per version. Nothing is bundled in the app for them.

Prismic Agent registers itself as a login item the first time it runs. Untick **Open at Login** in its menu to
undo that.

## Open an unsigned app

The app is signed ad hoc (`Signature=adhoc`) and not notarized, because there is no Apple Developer ID yet. macOS
Gatekeeper therefore refuses the first launch of a copy that was downloaded with a browser. This is expected: it is
not a sign that the file is damaged. Do it once per version that you download.

**macOS 15 (Sequoia) and later**

1. Double-click **Prismic Agent** in Applications. A dialog says Apple could not verify it. Click **Done**
   (not "Move to Trash").
2. Open **System Settings > Privacy & Security** and scroll to **Security**. It says "Prismic Agent was blocked to
   protect your Mac".
3. Click **Open Anyway**, enter your password, then click **Open Anyway** again in the last dialog.

**macOS 13 and 14**: right-click (or Control-click) the app, choose **Open**, then **Open** again in the dialog.
If that dialog has no Open button, use the System Settings steps above.

**From a terminal** (skips the dialogs by removing the quarantine flag the browser put on the file):

```sh
xattr -dr com.apple.quarantine "/Applications/Prismic Agent.app"
```

Other things to expect:

- A browser asks to let the Page Builder "access apps on your device" (Chrome, Edge): click **Allow**. The panel talks
  to the app on `http://127.0.0.1:7878`.
- Safari cannot be used with a deployed (https) Page Builder: it blocks every request from an https page to
  `127.0.0.1` (WebKit bug 171934). Use Chrome. The panel says so.
- macOS may ask once to let the Claude program read an item of your Keychain (Claude Code demo mode only, see
  below). Click **Allow**.
- A Mac without the Xcode Command Line Tools may offer to install them the first time an agent runs `git`.

## The menu bar icon and menu

The icon is the Prismic mark. Its color tells the state of the daemon:

| Color  | Meaning                                                                    |
| ------ | -------------------------------------------------------------------------- |
| Grey   | Stopped.                                                                   |
| Orange | Starting, or running and waiting for a Page Builder to connect.            |
| Red    | An error: the daemon crashed and is restarting, or port 7878 is taken.     |
| Green  | Running and linked to at least one Page Builder (its host is in the menu). |

The menu, top to bottom:

- The version, the status line, and one **Linked to `<host>`** line per connected Page Builder.
- **Accounts**: who the daemon runs as. `Prismic: signed in as <user id>` (the daemon only knows an id, not an email),
  `Codex: <ChatGPT email>` or `not signed in`, and `Claude: <email> (<plan>)` in demo mode, otherwise `Claude: API key
  ...abcd`. Refreshed every 30 seconds, when a Page Builder connects, and after a sign-in or sign-out.
- **Restart**, **Show Logs** (opens `~/Library/Logs/Prismic Agent/`).
- **Project folder** (a line naming it), **Choose Project Folder...** and **Clear Project Folder**: the website folder
  the agent works in, so it can change the code at the same time as the content in Prismic. It runs the daemon with
  `--project <folder>` and restarts it. Without a folder the agent works in an empty private workspace. The folder is
  remembered; if it has since been moved or deleted, the line says "(not found)" and the daemon starts without it.
  The folder only sets where the agent starts: what it may change is decided by the mode picked in the panel (Codex
  starts in `read-only`, Claude asks before every action), and a Documents, Desktop or Downloads folder makes macOS
  ask once for access.
- **Use my Claude Code subscription (demo)**: off by default, see "Claude Code demo mode".
- **Open at Login**.
- **Sign Out > Prismic / ChatGPT**: asks to confirm, then signs the daemon out and revokes the Prismic refresh token.
  The Prismic sign-out covers every Prismic environment the daemon is signed in to.
- **Sign in with ChatGPT...**: opens the ChatGPT sign-in in your browser. Signing in to Prismic can only be done
  from the Page Builder, because it depends on which Prismic environment the editor uses.
- **Download Prismic Agent X...** (only when a newer release exists), **Check for Updates...**, **Quit**.

A `prismic-agent://` link opens the app (the panel's "Open Prismic Agent" button uses it). The link's content is
ignored on purpose: any web page can open one.

## How the daemon runs

The app does not contain a second implementation: it runs `src/cli.ts` of the bridge with its own Node 24 runtime
(`Contents/Resources/runtime/node`), from `Contents/Resources/bridge/`. The daemon keeps its repository layout there
(`src/*.ts` next to its own `node_modules`) because it resolves its adapters relative to `src/` and Node refuses to
strip types from files under a `node_modules` path.

**Where things are**

| What                                  | Where                                                                  |
| ------------------------------------- | ---------------------------------------------------------------------- |
| Daemon data (pairings, conversations) | `$PRISMIC_AI_HOME`, else `~/.prismic-ai`                               |
| Downloaded agent programs             | `~/.prismic-ai/runtimes/<package>@<version>/` (a `.complete` file marks a finished download; old versions are removed) |
| Daemon log                            | `~/Library/Logs/Prismic Agent/bridge.log` (rotated to `bridge.1.log` above 5 MiB) |
| App state                             | `~/Library/Application Support/Prismic Agent/state.json`               |

Secrets (the Prismic sign-in, the ChatGPT credentials, an Anthropic API key) stay where the daemon already keeps them:
the macOS Keychain, or a private file when there is none. The app never reads them.

**Network.** The daemon listens on `127.0.0.1:7878` only. Browsers may use it from `http://localhost:5173` and from
deployed Page Builders (`https://<repository>.prismic.io`, `.wroom.io`, and the `dev-tools`, `platform`,
`marketing-tools` and `devops` `-wroom.com` environments), after the user approved the pairing in the Prismic popup.
The app passes no `--origin`: to allow another origin, run the daemon from a checkout.

**Supervision.** `desktop/src/bridgeProcess.ts` starts the daemon as a child process with an IPC channel and watches it:

- It polls `GET /health` every 500 ms until the answer's `name` is `prismic-local-agent-bridge`, then the state is
  running.
- A crash restarts it after 1, 2, 5, 10, 30, then 60 seconds. The counter resets once it ran for a minute.
- Exit code **3** means port 7878 is taken (for example by `npm start` in a checkout). The app shows red and retries
  every 30 seconds, without counting it as a crash.
- Stopping closes the IPC channel, which the daemon treats as a request to shut down cleanly (agents stopped). After
  10 seconds the app kills it. If the app itself crashes, the daemon notices the closed channel and exits, so it
  never runs unsupervised.
- Only one copy of the app runs. Opening a newer copy while an older one runs makes the older one relaunch from disk.

**IPC messages** (Node's private channel between the app and its daemon; a browser cannot send or read them):

| Direction     | Message                                                  | Meaning                                                              |
| ------------- | -------------------------------------------------------- | -------------------------------------------------------------------- |
| daemon to app | `{type: "editors", origins: string[]}`                   | Page origins of the Page Builders linked right now (green or orange). |
| daemon to app | `{type: "accounts", accounts: string[]}`                 | The account lines of the menu.                                       |
| app to daemon | `{type: "sign_out", account: "prismic" or "chatgpt"}`    | Sign out of that account.                                            |
| daemon to app | `{type: "signed_out", account, ok}`                      | The answer.                                                          |
| app to daemon | `{type: "sign_in", account: "chatgpt"}`                  | Start the ChatGPT sign-in.                                           |
| daemon to app | `{type: "sign_in_url", account: "chatgpt", url}`         | The URL the app opens in the browser.                                |

Account lines are collected one at a time and at least 5 seconds apart, and aborted when the daemon shuts down.

**Claude Code demo mode.** The menu item runs the daemon with `--claude-code-login`: Claude uses the Claude Code
login of this Mac instead of an Anthropic API key, and the Page Builder stops asking for a key. It is for demos only:
Anthropic's terms do not allow a Claude subscription in third-party apps. Enabling it asks for confirmation and
restarts the daemon, which then checks `claude auth status`: when Claude Code isn't signed in on this Mac, it runs
`claude auth login --claudeai`, which opens your browser to sign in with your Claude account. If that fails or isn't
finished within 5 minutes, the option goes back to off and a dialog says why. Turning the option off while the browser
is open stops the sign-in. It signs in with the default configuration (without `CLAUDE_CONFIG_DIR`). Check with
the program the daemon uses:

```sh
env -i PATH=/usr/bin:/bin HOME=$HOME USER=$USER LOGNAME=$LOGNAME SHELL=$SHELL TMPDIR=$TMPDIR \
  ~/.prismic-ai/runtimes/anthropic-ai+claude-agent-sdk-darwin-arm64@*/claude auth status
```

It must print `"loggedIn": true`. (`USER` has to be set: Claude Code finds its Keychain item with it.)

## Accounts

| Account  | Signed in from                              | Signed out from                          |
| -------- | ------------------------------------------- | ---------------------------------------- |
| Prismic  | The Page Builder (agent panel)              | The app menu, or the panel               |
| ChatGPT  | The Page Builder, or the app menu           | The app menu, or the panel               |
| Claude   | An API key in the panel, or Claude Code login (demo mode) | The panel (key), or `claude` `/logout` |

## Updates

The app asks `https://api.github.com/repos/arnaudlewis/prismic-local-agent-bridge/releases/latest` 10 seconds after it
starts and then every 6 hours. When the release is newer than the app (a plain `major.minor.patch` comparison):

- the menu shows **Download Prismic Agent X...**, and
- a notification appears once per release. Clicking it opens the download.

**Check for Updates...** does the same check on demand and says "up to date", "X is available" or why it failed.
The check reads the public GitHub API, so it answers `HTTP 404` while the repository is private.

The app cannot update itself: Squirrel.Mac only installs signed updates. To update, download the new dmg, quit
Prismic Agent from its menu, drag the new app over the old one in Applications, and open it (macOS asks again to open an
unsigned app: see above). When a Page Builder finds an app older than the panel needs, it says so and links to the
download.

## Build it

On a Mac with Apple Silicon and Node 24 (the repository pins what the daemon's tests pass on):

```sh
npm ci                   # at the repository root: the daemon's dependencies
cd desktop
npm ci
npm start                # compile, then run the app from source (uses desktop/build/)
npm run dist             # dmg in desktop/release/ (no publishing)
```

What `npm run dist` does:

1. `tsc -p .` compiles `desktop/src` to `desktop/dist`.
2. `scripts/prepareResources.ts` downloads Node 24.15.0 (checking its SHA-256 against `SHASUMS256.txt`), copies the
   daemon's `src` without tests, runs `npm ci --omit=dev --ignore-scripts` in `desktop/build/bridge`, and removes the two
   agent packages (`@openai/codex-darwin-arm64` and `@anthropic-ai/claude-agent-sdk-darwin-arm64`). It fails if either
   is missing, so an upstream rename cannot ship 250 MB by accident.
3. `electron-builder` packs the app. `scripts/afterPack.cjs` copies `build/bridge/node_modules` into
   `Resources/bridge/` (electron-builder never copies a `node_modules` through `extraResources`), before the app is
   signed. The signature is ad hoc (`mac.identity: "-"`).

Run `npm run prepare-resources` yourself before `npm start` the first time. To check an app after a build:

```sh
codesign -dv "release/mac-arm64/Prismic Agent.app" 2>&1 | grep Signature   # Signature=adhoc
ls "release/mac-arm64/Prismic Agent.app/Contents/Resources/bridge/node_modules/@openai"   # no codex-darwin-arm64
```

The tray icons (`assets/tray*.png`) and the app icon (`build-resources/icon.png`) are rendered from the SVGs next to
them with `rsvg-convert -w 18 -h 18 assets/trayGreen.svg -o assets/trayGreen.png` (`@2x` at 36 px, the app icon at
1024 px). They are committed.

## Release it

A release is a git tag. Pushing `v<version>` runs `.github/workflows/release-desktop.yml` on a GitHub-hosted Apple
Silicon runner (`macos-15`). It needs no secret besides the `GITHUB_TOKEN` GitHub gives every run.

1. **Bring `main` up to date and green.** At the repository root: `npm run check && npm test`. Rebase onto
   `origin/main` if it moved (the history stays linear).
2. **Bump the version** in `desktop/package.json` (`version`) and commit it. It is the only place: the app reads it,
   the update check compares against it, and the workflow refuses a tag that differs from it.
3. **Tag and push:**

   ```sh
   git tag v0.1.0
   git push origin main v0.1.0
   ```

4. **Watch the run** (Actions tab, or `gh run watch`). It checks the tag against `desktop/package.json`, runs the
   daemon's checks and tests, builds the app (`npm run dist`), then creates the GitHub Release once with `gh` and
   uploads the dmg, its block map and `latest-mac.yml` to it. If a run fails halfway, re-run it: the upload replaces
   what is already there.
5. **Verify the result:**

   ```sh
   curl -sI https://github.com/arnaudlewis/prismic-local-agent-bridge/releases/latest/download/Prismic-Agent-mac-arm64.dmg | head -1   # a redirect (302)
   ```

   Download the dmg in a browser and go through "Open an unsigned app" once, from a clean state if you can: this is
   what users do. A running older app notices the new release within 6 hours, or at once with **Check for Updates...**.

The dmg's name has no version (`Prismic-Agent-mac-arm64.dmg`) so that `releases/latest/download/<name>`, the link the
Page Builder's install button uses, never changes.

**If a release is wrong:** delete the GitHub release and the tag
(`gh release delete v0.1.1 --cleanup-tag --yes`), fix it, and release the next version. Do not reuse a version number:
apps that already saw it will not offer it again.

**Not done yet** (worth it as soon as there is an Apple Developer ID): signing with it, notarization (then
`xattr`/Open Anyway disappear), and `electron-updater` for in-place updates.

## Troubleshooting

| Symptom                                              | What to look at                                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| No icon in the menu bar                              | The app may not be running (open it). On a crowded menu bar macOS hides the icons that do not fit: close or move others. |
| Red icon, "Port 7878 is used by another program"    | Another bridge runs (`lsof -nP -iTCP:7878 -sTCP:LISTEN`). Stop it: the app takes over within 30 s.      |
| Red icon, "restarting"                               | Open **Show Logs** and read the end of `bridge.log`.                                                    |
| Orange icon that stays orange                        | No Page Builder is connected: open the agent panel and click Connect. Check it runs on an allowed origin. |
| The panel offers to install the app                  | The app is not running, or the browser blocks the request (Safari on https). Open the app, and click Allow if the browser asks. |
| "Claude Code isn't signed in on this computer"       | Demo mode only. Turn the option off and on again to open the sign-in, or run `claude`, then `/login`, then check with the `auth status` command above. |
| "Couldn't download Codex/Claude"                     | No network, or a proxy. The error says why; send another message to try again.                          |
| "Couldn't check for updates: HTTP 404"               | The repository is private, or no release exists yet.                                                    |
| macOS says the app is damaged or from an unidentified developer | See "Open an unsigned app".                                                                  |
