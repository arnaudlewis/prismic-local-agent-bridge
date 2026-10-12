import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { createWriteStream, mkdirSync, renameSync, statSync } from "node:fs"
import type { WriteStream } from "node:fs"
import { get } from "node:http"
import { join } from "node:path"

export type BridgeState =
  | { kind: "starting" }
  | { kind: "running" }
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
}

export interface BridgeProcess {
  start(): void
  stop(): Promise<void>
  restart(): Promise<void>
  startIfStopped(): void
  isStopped(): boolean
  state(): BridgeState
}

// The daemon exits with this code when its port is taken (portInUseExitCode in src/cli.ts).
const portInUseExitCode = 3
const healthUrl = "http://127.0.0.1:7878/health"
const healthName = "prismic-local-agent-bridge"
const healthIntervalMs = 500
const healthTimeoutMs = 1000
const portRetryMs = 30_000
const stableAfterMs = 60_000
const stopGraceMs = 10_000
const maxLogBytes = 5 * 1024 * 1024
const restartDelaysSeconds = [1, 2, 5, 10, 30, 60]

export function createBridgeProcess(args: CreateBridgeProcessArgs): BridgeProcess {
  const { nodePath, cliPath, cwd, logsDir, extraArgs, onChange } = args
  let state: BridgeState = { kind: "stopped" }
  let child: ChildProcess | undefined
  let retryTimer: NodeJS.Timeout | undefined
  let stopRequested = false
  let crashes = 0

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
    setState({ kind: "starting" })

    const healthTimer = setInterval(() => {
      void isHealthy().then((healthy) => {
        if (healthy && child === spawned && state.kind === "starting") setState({ kind: "running" })
      })
    }, healthIntervalMs)

    let handled = false
    function onGone(code: number | null): void {
      if (handled) return
      handled = true
      clearInterval(healthTimer)
      log.end()
      child = undefined
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

  return {
    start,
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
  const request = get(healthUrl, { timeout: healthTimeoutMs }, (response) => {
    let body = ""
    response.setEncoding("utf8")
    response.on("data", (chunk: string) => (body += chunk))
    response.on("end", () => {
      try {
        const parsed: unknown = JSON.parse(body)
        resolve(typeof parsed === "object" && parsed !== null && "name" in parsed && parsed.name === healthName)
      } catch {
        resolve(false)
      }
    })
  })
  request.on("timeout", () => request.destroy())
  request.on("error", () => resolve(false))
  return promise
}
