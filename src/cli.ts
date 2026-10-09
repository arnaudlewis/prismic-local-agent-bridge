import { mkdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"

import { createAgentSessions } from "./agentSessions.ts"
import { startBridgeServer } from "./bridgeServer.ts"
import { createChatGptAuth } from "./chatgptAuth.ts"
import { createPairing } from "./pairing.ts"
import { agentModes, bridgeInfo } from "./protocol.ts"
import type { AgentMode } from "./protocol.ts"
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

  const pairing = createPairing({ onCodeChanged: (code) => console.info(`Pairing code: ${code}`) })
  const channels = createWindowChannels()
  const auth = createChatGptAuth({ dataDir, redirectUri: `http://127.0.0.1:${options.port}/auth/callback` })
  const agents = createAgentSessions({
    channels,
    auth,
    dataDir,
    projectDir: options.projectDir,
    agentMode: options.agentMode,
    model: options.model,
    refreshMarginMs: options.refreshMarginMs,
  })
  const server = await startBridgeServer({
    port: options.port,
    allowedOrigins: options.origins,
    projectDir: options.projectDir,
    agentMode: options.agentMode,
    model: options.model,
    pairing,
    channels,
    auth,
  })

  console.info(`${bridgeInfo.name} ${bridgeInfo.version}`)
  console.info(`Project: ${options.projectDir}`)
  console.info(`Listening on http://127.0.0.1:${options.port}`)
  console.info(`Allowed origins: ${options.origins.join(", ")}`)
  console.info(`Agent mode: ${options.agentMode}${options.model === undefined ? "" : `, model: ${options.model}`}`)
  console.info(`ChatGPT: ${auth.getStatus().status}`)
  console.info(`Pairing code: ${pairing.currentCode()}`)

  function shutdown(): void {
    agents.stopAll()
    void server.close().then(() => process.exit(0))
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

interface CliOptions {
  projectDir: string
  port: number
  origins: string[]
  model: string | undefined
  agentMode: AgentMode
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
    },
    strict: true,
  })

  const projectDir = resolve(values.project ?? process.cwd())
  if (!isDirectory(projectDir)) throw new Error(`--project must be an existing directory: ${projectDir}`)

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
    projectDir,
    port,
    origins: values.origin ?? [defaultOrigin],
    model,
    agentMode,
    refreshMarginMs,
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isAgentMode(value: string): value is AgentMode {
  return (agentModes as readonly string[]).includes(value)
}
