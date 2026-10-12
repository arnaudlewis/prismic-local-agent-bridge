import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

export function isolatedClaudeHomePath(dataDir: string): string {
  return join(dataDir, "claude-home")
}

// The configuration directory of the agent when it is isolated from the user's own Claude Code: empty, private,
// and the only place the agent's settings, skills and session files live.
export function ensureIsolatedClaudeHome(dataDir: string): string {
  const path = isolatedClaudeHomePath(dataDir)
  mkdirSync(path, { recursive: true, mode: 0o700 })
  return path
}

// --use-user-claude: the user's real Claude Code directory (CLAUDE_CONFIG_DIR, else ~/.claude): skills, CLAUDE.md,
// MCP servers, settings. It is only ever read; its login (subscription) is never used.
export function resolveUserClaudeHome(): string {
  const path = resolve(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"))
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`--use-user-claude needs an existing Claude config directory, but ${path} was not found`)
  }
  return path
}

const ClaudeAcpPackageSchema = z.object({ bin: z.object({ "claude-agent-acp": z.string() }) })

export function resolveClaudeAcpBin(): string {
  const packageUrl = new URL("../../../node_modules/@agentclientprotocol/claude-agent-acp/package.json", import.meta.url)
  const packagePath = fileURLToPath(packageUrl)
  const packageJson = ClaudeAcpPackageSchema.parse(JSON.parse(readFileSync(packagePath, "utf8")))
  return resolve(dirname(packagePath), packageJson.bin["claude-agent-acp"])
}
