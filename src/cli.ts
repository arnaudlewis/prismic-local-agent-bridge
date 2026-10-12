import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"

import { createAgentSessions } from "./agentSessions.ts"
import { startBridgeServer } from "./bridgeServer.ts"
import { createChatGptAuth } from "./agents/codex/chatgptAuth.ts"
import { isolatedCodexHomePath, resolveUserCodexHome } from "./agents/codex/codexConfig.ts"
import { createPairing, forgetPairings } from "./pairing.ts"
import { agentModes, bridgeInfo } from "./protocol.ts"
import type { AgentMode } from "./protocol.ts"
import { resolveProjectDir } from "./workspace.ts"
import { createWindowChannels } from "./windowChannels.ts"

const defaultPort = 7878
const defaultOrigin = "http://localhost:5173"
const defaultRefreshMarginMs = 300_000

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})

async function main(): Promise<void> {
  const options = parseOptions()

  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
  const dataDir = join(configHome, "prismic-local-agent-bridge")
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })

  const project = resolveProjectDir({ explicit: options.project, dataDir })
  const userCodexHome = options.useUserCodex ? resolveUserCodexHome() : undefined
  if (options.forgetPairings) {
    forgetPairings(dataDir)
    console.info("Forgot all paired browsers: every browser must pair again.")
  }
  const pairing = createPairing({ dataDir, onCodeChanged: (code) => console.info(`Pairing code: ${code}`) })
  const channels = createWindowChannels()
  const auth = createChatGptAuth({ dataDir, redirectUri: `http://127.0.0.1:${options.port}/auth/callback` })
  const agents = createAgentSessions({
    channels,
    auth,
    dataDir,
    userCodexHome,
    projectDir: project.path,
    agentMode: options.agentMode,
    model: options.model,
    refreshMarginMs: options.refreshMarginMs,
  })
  const server = await startBridgeServer({
    port: options.port,
    allowedOrigins: options.origins,
    projectDir: project.path,
    agentMode: options.agentMode,
    model: options.model,
    pairing,
    channels,
    auth,
  })

  console.info(`${bridgeInfo.name} ${bridgeInfo.version}`)
  console.info(
    project.isDefaultWorkspace
      ? `Project: ${project.path} (empty workspace, no project files)`
      : `Project: ${project.path}`,
  )
  console.info(`Listening on http://127.0.0.1:${options.port}`)
  console.info(`Allowed origins: ${options.origins.join(", ")}`)
  console.info(`Agent mode: ${options.agentMode}${options.model === undefined ? "" : `, model: ${options.model}`}`)
  console.info(
    userCodexHome === undefined
      ? `Codex home: ${isolatedCodexHomePath(dataDir)} (isolated)`
      : `Codex home: ${userCodexHome} (user)`,
  )
  console.info(`ChatGPT: ${auth.getStatus().status}`)
  console.info(`Paired browsers: ${pairing.pairedBrowserCount()}`)
  console.info(`Pairing code: ${pairing.currentCode()}`)

  function shutdown(): void {
    agents.stopAll()
    void server.close().then(() => process.exit(0))
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

interface CliOptions {
  project: string | undefined
  port: number
  origins: string[]
  model: string | undefined
  agentMode: AgentMode
  useUserCodex: boolean
  forgetPairings: boolean
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
      "forget-pairings": { type: "boolean" },
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

  return {
    project: values.project,
    port,
    origins: values.origin ?? [defaultOrigin],
    model,
    agentMode,
    useUserCodex: values["use-user-codex"] ?? false,
    forgetPairings: values["forget-pairings"] ?? false,
    refreshMarginMs,
  }
}

function isAgentMode(value: string): value is AgentMode {
  return (agentModes as readonly string[]).includes(value)
}
