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

// The daemon's answer to a Claude Code sign-in request (src/agents/provider.ts). `reason` is shown to the user.
export type ClaudeSignInResult = { status: "already_signed_in" | "signed_in" } | { status: "failed"; reason: string }

// Which accounts the daemon is signed in to (src/accountsReport.ts): the menu offers to sign in or out accordingly.
export interface SignedInAccounts {
  prismic: boolean
  chatgpt: boolean
}

interface AccountsReport {
  lines: string[]
  signedIn: SignedInAccounts
}

const noAccounts: AccountsReport = { lines: [], signedIn: { prismic: false, chatgpt: false } }

export interface BridgeProcess {
  signOut(account: SignOutAccount): Promise<boolean>
  // Asks the daemon for the ChatGPT authorization URL, to open in the browser.
  signIn(): Promise<string | undefined>
  // Asks the daemon to sign the Claude Code login in (demo mode): it opens the browser itself and answers once the user
  // is done there. Never rejects.
  signInToClaude(): Promise<ClaudeSignInResult>
  start(): void
  stop(): Promise<void>
  restart(): Promise<void>
  startIfStopped(): void
  isStopped(): boolean
  state(): BridgeState
  // One line per account the daemon runs as (Prismic, Codex, Claude); empty until it has reported.
  accounts(): string[]
  // Which accounts the daemon is signed in to; none until it has reported.
  signedIn(): SignedInAccounts
}

// The daemon exits with this code when its port is taken (portInUseExitCode in src/cli.ts).
const portInUseExitCode = 3
const healthUrl = "http://127.0.0.1:7878/health"
const healthName = "prismic-local-agent-bridge"
const healthIntervalMs = 500
const maxHealthBytes = 1024
// The daemon may wait for two 15 s network deadlines (discovery, revocation) before it answers.
const signOutTimeoutMs = 45_000
const signInUrlTimeoutMs = 10_000
// The daemon downloads Claude Code first (15 min at most), then waits for the browser (5 min at most).
const claudeSignInTimeoutMs = 25 * 60_000
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
  const signOutsInFlight = new Map<SignOutAccount, Promise<boolean>>()
  let signInWaiter: ((url: string | undefined) => void) | undefined
  let claudeSignInWaiter: ((result: ClaudeSignInResult) => void) | undefined
  let claudeSignIn: Promise<ClaudeSignInResult> | undefined
  // Who the daemon runs as, and what it is signed in to, for the menu (src/cli.ts).
  let accounts: AccountsReport = noAccounts

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
      accounts = noAccounts
      claudeSignInWaiter?.({ status: "failed", reason: "Prismic Agent stopped before the sign-in finished." })
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
      const signInUrl = readSignInUrl(message)
      if (signInUrl !== undefined) {
        signInWaiter?.(signInUrl)
        return
      }
      const claudeSignInResult = readClaudeSignInResult(message)
      if (claudeSignInResult !== undefined) {
        claudeSignInWaiter?.(claudeSignInResult)
        return
      }
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
    // A second request for the same account joins the first one: one request, one answer.
    const inFlight = signOutsInFlight.get(account)
    if (inFlight !== undefined) return inFlight
    const running = child
    if (running === undefined || !running.connected) return Promise.resolve(false)
    const { promise, resolve } = Promise.withResolvers<boolean>()
    signOutWaiters.set(account, resolve)
    running.send({ type: "sign_out", account }, (error) => {
      if (error !== null) resolve(false)
    })
    const timer = setTimeout(() => resolve(false), signOutTimeoutMs)
    const result = promise.finally(() => {
      clearTimeout(timer)
      signOutWaiters.delete(account)
      signOutsInFlight.delete(account)
    })
    signOutsInFlight.set(account, result)
    return result
  }

  // Asks the daemon to start the ChatGPT sign-in; resolves with the authorization URL to open, or undefined when the
  // daemon doesn't answer in time.
  function signInToChatGpt(): Promise<string | undefined> {
    const running = child
    if (running === undefined || !running.connected) return Promise.resolve(undefined)
    const { promise, resolve } = Promise.withResolvers<string | undefined>()
    signInWaiter = resolve
    running.send({ type: "sign_in", account: "chatgpt" }, (error) => {
      if (error !== null) resolve(undefined)
    })
    const timer = setTimeout(() => resolve(undefined), signInUrlTimeoutMs)
    return promise.finally(() => {
      clearTimeout(timer)
      signInWaiter = undefined
    })
  }

  // A second request joins the first one: one browser sign-in at a time.
  function signInToClaude(): Promise<ClaudeSignInResult> {
    if (claudeSignIn !== undefined) return claudeSignIn
    const running = child
    if (running === undefined || !running.connected) {
      return Promise.resolve({ status: "failed", reason: "Prismic Agent isn't running." })
    }
    const { promise, resolve } = Promise.withResolvers<ClaudeSignInResult>()
    claudeSignInWaiter = resolve
    running.send({ type: "sign_in", account: "claude" }, (error) => {
      if (error !== null) resolve({ status: "failed", reason: "Couldn't reach Prismic Agent." })
    })
    const timer = setTimeout(() => resolve({ status: "failed", reason: "The sign-in took too long." }), claudeSignInTimeoutMs)
    claudeSignIn = promise.finally(() => {
      clearTimeout(timer)
      claudeSignInWaiter = undefined
      claudeSignIn = undefined
    })
    return claudeSignIn
  }

  return {
    start,
    signIn: signInToChatGpt,
    signInToClaude,
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
    accounts: () => accounts.lines,
    signedIn: () => accounts.signedIn,
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

// The daemon's account report (src/cli.ts): who it runs as, as lines, and which accounts it is signed in to.
function readAccounts(message: unknown): AccountsReport | undefined {
  if (typeof message !== "object" || message === null) return undefined
  if (!("type" in message) || message.type !== "accounts" || !("accounts" in message) || !("signedIn" in message)) return undefined
  const { accounts, signedIn } = message
  if (!Array.isArray(accounts) || !accounts.every((line) => typeof line === "string")) return undefined
  if (typeof signedIn !== "object" || signedIn === null) return undefined
  if (!("prismic" in signedIn) || !("chatgpt" in signedIn)) return undefined
  if (typeof signedIn.prismic !== "boolean" || typeof signedIn.chatgpt !== "boolean") return undefined
  return { lines: accounts, signedIn: { prismic: signedIn.prismic, chatgpt: signedIn.chatgpt } }
}

// The daemon's answer to a sign_in request: the URL to open in the browser (src/cli.ts).
function readSignInUrl(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined
  if (!("type" in message) || message.type !== "sign_in_url" || !("url" in message)) return undefined
  return typeof message.url === "string" ? message.url : undefined
}

// The daemon's answer to a sign_in request for Claude (src/cli.ts).
function readClaudeSignInResult(message: unknown): ClaudeSignInResult | undefined {
  if (typeof message !== "object" || message === null) return undefined
  if (!("type" in message) || message.type !== "sign_in_result" || !("account" in message) || message.account !== "claude") {
    return undefined
  }
  if (!("status" in message)) return undefined
  if (message.status === "signed_in" || message.status === "already_signed_in") return { status: message.status }
  if (message.status !== "failed") return undefined
  const reason = "reason" in message && typeof message.reason === "string" ? message.reason : "The sign-in didn't complete."
  return { status: "failed", reason }
}
