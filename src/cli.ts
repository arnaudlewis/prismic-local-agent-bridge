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
import type { AgentProvider } from "./agents/provider.ts"
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
  // The agent registry: each provider is one agent a browser can pick with `session.agent`. To add one, implement
  // AgentProvider (src/agents/provider.ts), add its id to `agentIds` in protocol.ts and list it here.
  const providers: AgentProvider[] = [
    createCodexProvider({
      dataDir,
      auth: createChatGptAuth({ dataDir, redirectUri: `http://127.0.0.1:${options.port}/auth/callback` }),
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
  // The desktop app (desktop/src/bridgeProcess.ts) shows which Page Builders are linked. The IPC channel is private
  // to it, unlike /health, which any allowed page can read.
  channels.onEditorsChanged((origins) => {
    if (process.connected) process.send?.({ type: "editors", origins })
  })
  const prismicAuth = await createPrismicAuth({ dataDir, port: options.port })
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

  let shuttingDown = false
  function shutdown(): void {
    if (shuttingDown) return
    shuttingDown = true
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
