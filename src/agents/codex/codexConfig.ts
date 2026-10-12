import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

const providerId = "openai_chatgpt_plan"

const chatGptPlanProvider = {
  name: "ChatGPT plan",
  base_url: "https://api.openai.com/v1",
  env_key: "ACCESS_TOKEN",
  wire_api: "responses",
  requires_openai_auth: false,
  supports_websockets: false,
}

export function isolatedCodexHomePath(dataDir: string): string {
  return join(dataDir, "codex-home")
}

interface WriteCodexHomeArgs {
  dataDir: string
  model?: string
}

export function writeCodexHome(args: WriteCodexHomeArgs): string {
  const { dataDir, model } = args
  const codexHome = isolatedCodexHomePath(dataDir)
  mkdirSync(codexHome, { recursive: true, mode: 0o700 })

  const lines = [`model_provider = "${providerId}"`]
  if (model !== undefined) lines.push(`model = ${JSON.stringify(model)}`)
  lines.push("", `[model_providers.${providerId}]`)
  for (const [key, value] of Object.entries(chatGptPlanProvider)) {
    lines.push(`${key} = ${JSON.stringify(value)}`)
  }
  lines.push("")
  writeFileSync(join(codexHome, "config.toml"), lines.join("\n"))
  return codexHome
}

export function resolveUserCodexHome(): string {
  const codexHome = resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"))
  if (!existsSync(codexHome) || !statSync(codexHome).isDirectory()) {
    throw new Error(`--use-user-codex needs an existing Codex home, but ${codexHome} was not found`)
  }
  return codexHome
}

// Passed through codex-acp's CODEX_CONFIG env (merged into the session config) so the user's own Codex home stays untouched.
export function buildCodexConfigEnv(args: { model?: string }): string {
  return JSON.stringify({
    model_provider: providerId,
    model_providers: { [providerId]: chatGptPlanProvider },
    ...(args.model === undefined ? {} : { model: args.model }),
  })
}

const CodexAcpPackageSchema = z.object({ bin: z.object({ "codex-acp": z.string() }) })

export function resolveCodexAcpBin(): string {
  const packageUrl = new URL("../../../node_modules/@agentclientprotocol/codex-acp/package.json", import.meta.url)
  const packagePath = fileURLToPath(packageUrl)
  const packageJson = CodexAcpPackageSchema.parse(JSON.parse(readFileSync(packagePath, "utf8")))
  return resolve(dirname(packagePath), packageJson.bin["codex-acp"])
}
