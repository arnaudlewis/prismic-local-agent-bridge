import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

interface WriteCodexHomeArgs {
  dataDir: string
  model?: string
}

export function writeCodexHome(args: WriteCodexHomeArgs): string {
  const { dataDir, model } = args
  const codexHome = join(dataDir, "codex-home")
  mkdirSync(codexHome, { recursive: true, mode: 0o700 })

  const lines = ['model_provider = "openai_chatgpt_plan"']
  if (model !== undefined) lines.push(`model = ${JSON.stringify(model)}`)
  lines.push(
    "",
    "[model_providers.openai_chatgpt_plan]",
    'name = "ChatGPT plan"',
    'base_url = "https://api.openai.com/v1"',
    'env_key = "ACCESS_TOKEN"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "supports_websockets = false",
    "",
  )
  writeFileSync(join(codexHome, "config.toml"), lines.join("\n"))
  return codexHome
}

const CodexAcpPackageSchema = z.object({ bin: z.object({ "codex-acp": z.string() }) })

export function resolveCodexAcpBin(): string {
  const packageUrl = new URL("../node_modules/@agentclientprotocol/codex-acp/package.json", import.meta.url)
  const packagePath = fileURLToPath(packageUrl)
  const packageJson = CodexAcpPackageSchema.parse(JSON.parse(readFileSync(packagePath, "utf8")))
  return resolve(dirname(packagePath), packageJson.bin["codex-acp"])
}
