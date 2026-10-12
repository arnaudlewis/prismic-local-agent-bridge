import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { createWriteStream, mkdirSync, renameSync, statSync } from "node:fs"
import type { WriteStream } from "node:fs"
import { get } from "node:http"
import { join } from "node:path"

export type BridgeState =
  | { kind: "starting" }
  | { kind: "running"; editors: string[] }
  | { kind: "port_in_use" }
  | { kind: "restarting"; inSeconds: number }
  | { kind: "stopped" }

export interface CreateBridgeProcessArgs {
  nodePath: string
  cliPath: string
  cwd: string
  logsDir: string
  // Read at every start, so a restart picks up an option the user just changed.
  extraArgs: () => string[]
  onChange: (state: BridgeState) => void
  // Called when the daemon reports its accounts again.
  onAccounts: () => void
}

export type SignOutAccount = "prismic" | "chatgpt"

export interface BridgeProcess {
  signOut(account: SignOutAccount): Promise<boolean>
  start(): void
  stop(): Promise<void>
  restart(): Promise<void>
  startIfStopped(): void
  isStopped(): boolean
  state(): BridgeState
  // One line per account the daemon runs as (Prismic, Codex, Claude); empty until it has reported.
  accounts(): string[]
}

// The daemon exits with this code when its port is taken (portInUseExitCode in src/cli.ts).
const portInUseExitCode = 3
const healthUrl = "http://127.0.0.1:7878/health"
const healthName = "prismic-local-agent-bridge"
const healthIntervalMs = 500
const maxHealthBytes = 1024
const signOutTimeoutMs = 15_000
const healthTimeoutMs = 1000
const portRetryMs = 30_000
const stableAfterMs = 60_000
const stopGraceMs = 10_000
const maxLogBytes = 5 * 1024 * 1024
const restartDelaysSeconds = [1, 2, 5, 10, 30, 60]

export function createBridgeProcess(args: CreateBridgeProcessArgs): BridgeProcess {
  const { nodePath, cliPath, cwd, logsDir, extraArgs, onChange, onAccounts } = args
  let state: BridgeState = { kind: "stopped" }
  let child: ChildProcess | undefined
  let retryTimer: NodeJS.Timeout | undefined
  let stopRequested = false
  let crashes = 0
  const signOutWaiters = new Map<SignOutAccount, (ok: boolean) => void>()
  // Who the daemon runs as, as lines for the menu (src/cli.ts).
  let accounts: string[] = []

  function setState(next: BridgeState): void {
    state = next
    onChange(next)
  }

  function start(): void {
    if (child !== undefined) return
    clearTimeout(retryTimer)
    stopRequested = false

    const log = openLog(logsDir)
    const startedAt = Date.now()
    const spawned = spawn(nodePath, [cliPath, ...extraArgs()], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    })
    child = spawned
    spawned.stdout?.pipe(log, { end: false })
    spawned.stderr?.pipe(log, { end: false })
    // The log closes once both streams have, not when the process exits: its last output can still be in flight.
    let openStreams = 2
    const onStreamClosed = () => {
      openStreams -= 1
      if (openStreams === 0) log.end()
    }
    spawned.stdout?.on("close", onStreamClosed)
    spawned.stderr?.on("close", onStreamClosed)
    let editors: string[] = []
    setState({ kind: "starting" })

    const healthTimer = setInterval(() => {
      void isHealthy().then((healthy) => {
        if (healthy && child === spawned && state.kind === "starting") setState({ kind: "running", editors })
      })
    }, healthIntervalMs)

    let handled = false
    function onGone(code: number | null): void {
      if (handled) return
      handled = true
      clearInterval(healthTimer)
      child = undefined
      accounts = []
      if (stopRequested) return setState({ kind: "stopped" })
      if (code === portInUseExitCode) {
        setState({ kind: "port_in_use" })
        retryTimer = setTimeout(start, portRetryMs)
        return
      }
      if (Date.now() - startedAt >= stableAfterMs) crashes = 0
      const inSeconds = restartDelaysSeconds[Math.min(crashes, restartDelaysSeconds.length - 1)] ?? 60
      crashes += 1
      setState({ kind: "restarting", inSeconds })
      retryTimer = setTimeout(start, inSeconds * 1000)
    }
    spawned.on("exit", onGone)
    spawned.on("error", () => onGone(null))
    spawned.on("message", (message) => {
      const signedOut = readSignedOut(message)
      if (signedOut !== undefined) {
        signOutWaiters.get(signedOut.account)?.(signedOut.ok)
        return
      }
      const reportedAccounts = readAccounts(message)
      if (reportedAccounts !== undefined) {
        accounts = reportedAccounts
        onAccounts()
        return
      }
      const reported = readEditors(message)
      if (reported === undefined) return
      editors = reported
      if (state.kind === "running") setState({ kind: "running", editors })
    })
  }

  function stop(): Promise<void> {
    stopRequested = true
    clearTimeout(retryTimer)
    const running = child
    if (running === undefined) {
      if (state.kind !== "stopped") setState({ kind: "stopped" })
      return Promise.resolve()
    }
    const { promise, resolve } = Promise.withResolvers<void>()
    running.once("exit", () => resolve())
    // The daemon shuts down gracefully when the IPC channel closes (src/cli.ts).
    if (running.connected) running.disconnect()
    const killTimer = setTimeout(() => running.kill("SIGKILL"), stopGraceMs)
    return promise.finally(() => clearTimeout(killTimer))
  }

  // Asks the daemon to sign out of an OAuth account and waits for its answer.
  function signOut(account: SignOutAccount): Promise<boolean> {
    const running = child
    if (running === undefined || !running.connected) return Promise.resolve(false)
    const { promise, resolve } = Promise.withResolvers<boolean>()
    signOutWaiters.set(account, resolve)
    running.send({ type: "sign_out", account }, (error) => {
      if (error !== null) resolve(false)
    })
    const timer = setTimeout(() => resolve(false), signOutTimeoutMs)
    return promise.finally(() => {
      clearTimeout(timer)
      signOutWaiters.delete(account)
    })
  }

  return {
    start,
    signOut,
    stop,
    async restart() {
      await stop()
      start()
    },
    startIfStopped() {
      if (state.kind === "stopped" || state.kind === "port_in_use" || state.kind === "restarting") start()
    },
    isStopped: () => state.kind === "stopped",
    state: () => state,
    accounts: () => accounts,
  }
}

function openLog(logsDir: string): WriteStream {
  mkdirSync(logsDir, { recursive: true })
  const file = join(logsDir, "bridge.log")
  try {
    if (statSync(file).size > maxLogBytes) renameSync(file, join(logsDir, "bridge.1.log"))
  } catch {
    // No log yet.
  }
  return createWriteStream(file, { flags: "a" })
}

function isHealthy(): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>()
  // The signal is a deadline for the whole response (the timeout option only fires on inactivity), and the body is
  // capped: whoever owns the port, another local user included, must not be able to keep the app busy.
  const request = get(healthUrl, { signal: AbortSignal.timeout(healthTimeoutMs) }, (response) => {
    let body = ""
    response.setEncoding("utf8")
    response.on("data", (chunk: string) => {
      body += chunk
      if (body.length > maxHealthBytes) request.destroy()
    })
    response.on("end", () => {
      try {
        const parsed: unknown = JSON.parse(body)
        resolve(typeof parsed === "object" && parsed !== null && "name" in parsed && parsed.name === healthName)
      } catch {
        resolve(false)
      }
    })
    response.on("close", () => resolve(false))
    response.on("error", () => resolve(false))
  })
  request.on("error", () => resolve(false))
  return promise
}

// What the daemon reports over IPC (src/cli.ts): the page origins of the Page Builders linked to it.
function readEditors(message: unknown): string[] | undefined {
  if (typeof message !== "object" || message === null) return undefined
  if (!("type" in message) || message.type !== "editors" || !("origins" in message)) return undefined
  const { origins } = message
  if (!Array.isArray(origins) || !origins.every((origin) => typeof origin === "string")) return undefined
  return origins
}

// The daemon's answer to a sign_out request (src/cli.ts).
function readSignedOut(message: unknown): { account: SignOutAccount; ok: boolean } | undefined {
  if (typeof message !== "object" || message === null) return undefined
  if (!("type" in message) || message.type !== "signed_out" || !("account" in message) || !("ok" in message)) {
    return undefined
  }
  const { account, ok } = message
  if ((account !== "prismic" && account !== "chatgpt") || typeof ok !== "boolean") return undefined
  return { account, ok }
}

// The daemon's account lines (src/cli.ts): who it runs as, for the menu.
function readAccounts(message: unknown): string[] | undefined {
  if (typeof message !== "object" || message === null) return undefined
  if (!("type" in message) || message.type !== "accounts" || !("accounts" in message)) return undefined
  const { accounts } = message
  if (!Array.isArray(accounts) || !accounts.every((line) => typeof line === "string")) return undefined
  return accounts
}
