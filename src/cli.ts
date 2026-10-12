import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"

import { claudeRuntimeArgs, codexRuntimeArgs, createAgentRuntime, daemonRootDir } from "./agents/agentRuntime.ts"
import { resolveUserClaudeHome } from "./agents/claude/claudeConfig.ts"
import { createClaudeProvider } from "./agents/claude/claudeProvider.ts"
import { createChatGptAuth } from "./agents/codex/chatgptAuth.ts"
import { resolveUserCodexHome } from "./agents/codex/codexConfig.ts"
import { createCodexProvider } from "./agents/codex/codexProvider.ts"
import { agentModes } from "./agents/codex/modes.ts"
import type { AgentMode } from "./agents/codex/modes.ts"
import type { AgentProvider, AgentSignInResult } from "./agents/provider.ts"
import { createAgentSessions } from "./agentSessions.ts"
import { startBridgeServer } from "./bridgeServer.ts"
import { connectRateLimit, connectRoutes } from "./connect/connectRoutes.ts"
import { createPendingConnections } from "./connect/pendingConnections.ts"
import { createPairing, forgetPairings } from "./pairing.ts"
import { agentMcpRoutes, createAgentMcpGrants } from "./prismic/agentMcpProxy.ts"
import { editorContextRoutes } from "./prismic/editorContextRoutes.ts"
import { createMcpUpstream } from "./prismic/mcpUpstream.ts"
import { createPrismicAuth, forgetPrismicSignIn } from "./prismic/prismicAuth.ts"
import { createRateLimiter } from "./rateLimit.ts"
import { createApiKeyVault, createDefaultSecretStores } from "./secrets/apiKeyVault.ts"
import { passEnvNamePattern, withheldProxyNames } from "./conversations/childEnv.ts"
import { bridgeInfo } from "./protocol.ts"
import { resolveProjectDir } from "./workspace.ts"
import { createWindowChannels } from "./windowChannels.ts"

const defaultPort = 7878
const defaultOrigin = "http://localhost:5173"
const defaultRefreshMarginMs = 300_000
// The desktop app (desktop/src/bridgeProcess.ts) reads this exit code.
const portInUseExitCode = 3
const accountsRefreshMs = 30_000
const accountsMinGapMs = 5_000
const signInPollMs = 2_000
const signInWatchMs = 5 * 60_000

// The desktop app stops the daemon by closing the IPC channel, and a crashed app takes the daemon down with it. The
// listener is registered before anything is awaited: a disconnect during startup must not leave a daemon nobody
// supervises.
let onDisconnect: (() => void) | undefined
process.once("disconnect", () => (onDisconnect === undefined ? process.exit(0) : onDisconnect()))

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})

async function main(): Promise<void> {
  const options = parseOptions()

  const dataDir = process.env.PRISMIC_AI_HOME ?? join(homedir(), ".prismic-ai")
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })

  if (options.signOutPrismic) {
    await forgetPrismicSignIn(dataDir)
    console.info("Removed the stored Prismic sign-in.")
    return
  }

  const project = resolveProjectDir({ explicit: options.project, dataDir })
  const userCodexHome = options.useUserCodex ? resolveUserCodexHome() : undefined
  const userClaudeHome = options.useUserClaude ? resolveUserClaudeHome() : undefined
  if (options.forgetPairings) {
    forgetPairings(dataDir)
    console.info("Forgot all paired browsers: every browser must pair again.")
  }
  const pairing = createPairing({ dataDir })
  const chatgptAuth = createChatGptAuth({ dataDir, redirectUri: `http://127.0.0.1:${options.port}/auth/callback` })
  // The agent registry: each provider is one agent a browser can pick with `session.agent`. To add one, implement
  // AgentProvider (src/agents/provider.ts), add its id to `agentIds` in protocol.ts and list it here.
  const providers: AgentProvider[] = [
    createCodexProvider({
      dataDir,
      auth: chatgptAuth,
      userCodexHome,
      agentMode: options.agentMode,
      model: options.model,
      refreshMarginMs: options.refreshMarginMs,
      runtime: createAgentRuntime({ dataDir, rootDir: daemonRootDir, ...codexRuntimeArgs() }),
    }),
    createClaudeProvider({
      dataDir,
      vault: createApiKeyVault(
        await createDefaultSecretStores({ dataDir, name: "claude-api-key", label: "Anthropic API key" }),
      ),
      userClaudeHome,
      useClaudeCodeLogin: options.claudeCodeLogin,
      runtime: createAgentRuntime({ dataDir, rootDir: daemonRootDir, ...claudeRuntimeArgs() }),
    }),
  ]
  const channels = createWindowChannels()
  // State of publishAccounts below; declared first because a Page Builder can connect as soon as the server listens.
  let collectingAccounts = false
  let accountsRequestedAgain = false
  // Aborted at shutdown: it stops a `claude auth status` that is still running.
  const accountsAbort = new AbortController()
  // The desktop app (desktop/src/bridgeProcess.ts) shows which Page Builders are linked. The IPC channel is private
  // to it, unlike /health, which any allowed page can read.
  channels.onEditorsChanged((origins) => {
    if (process.connected) process.send?.({ type: "editors", origins })
    // A Page Builder that just connected is often where the user signed in.
    publishAccounts()
  })
  const prismicAuth = await createPrismicAuth({ dataDir, port: options.port })
  // The desktop app signs the daemon out of its OAuth accounts from its menu, over the same private IPC channel.
  process.on("message", (message) => {
    const account = readSignOutRequest(message)
    if (account === undefined) return
    const signedOut = account === "prismic" ? prismicAuth.signOutEverywhere() : chatgptAuth.signOut()
    void signedOut
      .then(() => true, () => false)
      .then((ok) => {
        if (process.connected) process.send?.({ type: "signed_out", account, ok })
        publishAccounts()
      })
  })
  // And starts the ChatGPT sign-in: it answers with the authorization URL, which the app opens in the browser. The
  // callback comes back to the daemon (/auth/callback), and the accounts are published once the sign-in is over.
  let watchingChatGptSignIn = false
  process.on("message", (message) => {
    if (!isChatGptSignInRequest(message)) return
    const url = chatgptAuth.startSignIn()
    if (process.connected) process.send?.({ type: "sign_in_url", account: "chatgpt", url })
    if (watchingChatGptSignIn) return
    watchingChatGptSignIn = true
    const startedAt = Date.now()
    const timer = setInterval(() => {
      if (chatgptAuth.getStatus().status === "signing_in" && Date.now() - startedAt < signInWatchMs) return
      clearInterval(timer)
      watchingChatGptSignIn = false
      publishAccounts()
    }, signInPollMs)
    timer.unref()
  })
  // The demo mode's Claude Code login: the app asks for it right after enabling the mode. `claude auth login` opens
  // the browser by itself, so the answer only comes once the user is done there (or it failed, or timed out).
  let signingInToClaude = false
  process.on("message", (message) => {
    if (!isClaudeSignInRequest(message) || signingInToClaude) return
    signingInToClaude = true
    const claude = providers.find((provider) => provider.id === "claude")
    const signedIn: Promise<AgentSignInResult> =
      claude?.signIn?.(accountsAbort.signal) ??
      Promise.resolve({ status: "failed", reason: "The Claude Code login isn't enabled." })
    void signedIn.then((result) => {
      signingInToClaude = false
      // Aborted at shutdown: nobody is listening for the answer.
      if (accountsAbort.signal.aborted) return
      if (process.connected) process.send?.({ type: "sign_in_result", account: "claude", ...result })
      publishAccounts()
    })
  })
  const upstream = createMcpUpstream({ auth: prismicAuth })
  const grants = createAgentMcpGrants()
  const agents = createAgentSessions({
    channels,
    dataDir,
    projectDir: project.path,
    providers,
    passEnv: options.passEnv,
    prismic: { auth: prismicAuth, upstream, grants, bridgePort: options.port },
  })
  const server = await startBridgeServer({
    port: options.port,
    extraOrigins: options.origins,
    projectDir: project.path,
    providers,
    routes: [
      ...connectRoutes({
        pending: createPendingConnections(),
        pairing,
        prismicAuth,
        extraOrigins: options.origins,
        port: options.port,
        projectDir: project.path,
        limiter: createRateLimiter(connectRateLimit),
      }),
      ...agentMcpRoutes({ grants, upstream, channels, prismicAuth }),
      ...editorContextRoutes({ prismicAuth, upstream }),
    ],
    pairing,
    prismicAuth,
    channels,
  }).catch((error: unknown) => exitWhenPortInUse(error, options.port))

  console.info(`${bridgeInfo.name} ${bridgeInfo.version}`)
  console.info(
    project.isDefaultWorkspace
      ? `Project: ${project.path} (empty workspace, no project files)`
      : `Project: ${project.path}`,
  )
  console.info(`Listening on http://127.0.0.1:${options.port}`)
  console.info(`Allowed origins: deployed Page Builders, ${options.origins.join(", ")}`)
  for (const provider of providers) {
    for (const line of await provider.bannerLines()) console.info(line)
  }
  const withheld = withheldProxyNames({ source: process.env, passEnv: options.passEnv })
  if (withheld.length > 0) {
    console.info(`Proxy credentials not passed to agents: ${withheld.join(", ")} (use --pass-env ${withheld.join(" --pass-env ")} to allow)`)
  }
  if (options.passEnv.length > 0) console.info(`Passing to the agents (--pass-env): ${options.passEnv.join(", ")}`)
  console.info(`Paired browsers: ${pairing.pairedBrowserCount()}`)
  console.info(`Prismic local agent bridge on http://127.0.0.1:${options.port}. Connect from the agent panel in the Page Builder.`)
  publishAccounts()
  setInterval(publishAccounts, accountsRefreshMs).unref()

  // The desktop app shows who the daemon runs as (an email, a plan): over the private IPC channel, never the browser.
  // One collection at a time, and at least accountsMinGapMs between two: a page that connects and disconnects in a loop
  // must not be able to start a `claude auth status` per change.
  function publishAccounts(): void {
    if (!process.connected) return
    if (collectingAccounts) {
      accountsRequestedAgain = true
      return
    }
    collectingAccounts = true
    void describeAccounts()
      .then((accounts) => {
        // A newer collection is already queued (an account changed meanwhile): this snapshot is out of date.
        if (!accountsRequestedAgain && process.connected) process.send?.({ type: "accounts", accounts })
      })
      .finally(() => {
        setTimeout(() => {
          collectingAccounts = false
          if (!accountsRequestedAgain) return
          accountsRequestedAgain = false
          publishAccounts()
        }, accountsMinGapMs).unref()
      })
  }

  async function describeAccounts(): Promise<string[]> {
    const users = prismicAuth.signedInUsers()
    const lines = [users.length === 0 ? "Prismic: not signed in" : `Prismic: signed in as ${users.join(", ")}`]
    for (const provider of providers) {
      if (provider.accountSummary !== undefined) {
        lines.push(await provider.accountSummary(accountsAbort.signal).catch(() => `${provider.label}: unknown`))
      }
    }
    return lines
  }

  let shuttingDown = false
  function shutdown(): void {
    if (shuttingDown) return
    shuttingDown = true
    accountsAbort.abort()
    agents.stopAll()
    void server.close().then(() => process.exit(0))
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
  onDisconnect = shutdown
}

function exitWhenPortInUse(error: unknown, port: number): never {
  if ((error as NodeJS.ErrnoException | null)?.code !== "EADDRINUSE") throw error
  console.error(`Port ${port} is already in use (is another Prismic agent bridge running?)`)
  process.exit(portInUseExitCode)
}

// A message of the desktop app asking to sign out of an OAuth account (desktop/src/bridgeProcess.ts).
function readSignOutRequest(message: unknown): "prismic" | "chatgpt" | undefined {
  if (typeof message !== "object" || message === null) return undefined
  if (!("type" in message) || message.type !== "sign_out" || !("account" in message)) return undefined
  return message.account === "prismic" || message.account === "chatgpt" ? message.account : undefined
}

// A message of the desktop app asking to start the ChatGPT sign-in (desktop/src/bridgeProcess.ts).
function isChatGptSignInRequest(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false
  return "type" in message && message.type === "sign_in" && "account" in message && message.account === "chatgpt"
}

// A message of the desktop app asking to sign the Claude Code login in (desktop/src/bridgeProcess.ts).
function isClaudeSignInRequest(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false
  return "type" in message && message.type === "sign_in" && "account" in message && message.account === "claude"
}

interface CliOptions {
  project: string | undefined
  port: number
  origins: string[]
  model: string | undefined
  agentMode: AgentMode
  useUserCodex: boolean
  useUserClaude: boolean
  claudeCodeLogin: boolean
  passEnv: string[]
  forgetPairings: boolean
  signOutPrismic: boolean
  refreshMarginMs: number
}

function parseOptions(): CliOptions {
  const { values } = parseArgs({
    options: {
      project: { type: "string" },
      port: { type: "string" },
      origin: { type: "string", multiple: true },
      model: { type: "string" },
      "agent-mode": { type: "string" },
      "use-user-codex": { type: "boolean" },
      "use-user-claude": { type: "boolean" },
      "claude-code-login": { type: "boolean" },
      "forget-pairings": { type: "boolean" },
      "sign-out-prismic": { type: "boolean" },
      "pass-env": { type: "string", multiple: true },
    },
    strict: true,
  })

  const port = values.port === undefined ? defaultPort : Number(values.port)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid --port: ${values.port}`)

  const model = values.model
  if (model !== undefined && !/^[A-Za-z0-9._:-]+$/.test(model)) throw new Error(`Invalid --model: ${model}`)

  const agentMode = values["agent-mode"] ?? "read-only"
  if (!isAgentMode(agentMode)) throw new Error(`Invalid --agent-mode: ${agentMode} (${agentModes.join(" | ")})`)

  const rawMargin = process.env.PRISMIC_BRIDGE_TOKEN_REFRESH_MARGIN_MS
  const refreshMarginMs = rawMargin === undefined ? defaultRefreshMarginMs : Number(rawMargin)
  if (!Number.isFinite(refreshMarginMs) || refreshMarginMs < 0) {
    throw new Error(`Invalid PRISMIC_BRIDGE_TOKEN_REFRESH_MARGIN_MS: ${rawMargin}`)
  }

  const origins = [...new Set([defaultOrigin, ...(values.origin ?? [])])]
  for (const origin of origins) {
    if (!URL.canParse(origin) || new URL(origin).origin !== origin) {
      throw new Error(`Invalid --origin: ${origin} (use an exact origin such as https://example.com)`)
    }
  }

  const passEnv = [...new Set(values["pass-env"] ?? [])]
  for (const name of passEnv) {
    if (!passEnvNamePattern.test(name)) throw new Error(`Invalid --pass-env name: ${name} (it must match ${passEnvNamePattern.source})`)
  }

  return {
    project: values.project,
    port,
    origins,
    model,
    agentMode,
    useUserCodex: values["use-user-codex"] ?? false,
    useUserClaude: values["use-user-claude"] ?? false,
    claudeCodeLogin: values["claude-code-login"] ?? false,
    forgetPairings: values["forget-pairings"] ?? false,
    signOutPrismic: values["sign-out-prismic"] ?? false,
    passEnv,
    refreshMarginMs,
  }
}

function isAgentMode(value: string): value is AgentMode {
  return (agentModes as readonly string[]).includes(value)
}
