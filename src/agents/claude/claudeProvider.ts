import { homedir } from "node:os"
import { join } from "node:path"

import { AgentAuthError } from "../provider.ts"
import type { AgentCredentials, AgentProvider } from "../provider.ts"
import type { AgentRuntime } from "../agentRuntime.ts"
import type { ApiKeyVault } from "../../secrets/apiKeyVault.ts"
import { blockedCommands, commandNameCandidates, hiddenCommands, nativeCommandName } from "./commands.ts"
import { describeClaudeCodeLogin } from "./claudeCodeLogin.ts"
import { ensureIsolatedClaudeHome, isolatedClaudeHomePath, resolveClaudeAcpBin } from "./claudeConfig.ts"
import { createKeyRoutes } from "./keyRoutes.ts"
import { validateKeyWithAnthropic } from "./keyValidation.ts"
import type { KeyValidator } from "./keyValidation.ts"
import { identifyToolCall, readToolResult } from "./toolCalls.ts"

export const apiKeyMissingNotice = "Add your Anthropic API key to use Claude."

export interface ClaudeProviderArgs {
  dataDir: string
  vault: ApiKeyVault
  // Set with --use-user-claude: run against this existing Claude config directory instead of an isolated one.
  userClaudeHome: string | undefined
  // Overrides the claude-agent-acp entry point; only tests pass it.
  agentBin?: string
  // Downloads the Claude Code binary on first use; absent when node_modules has it.
  runtime?: AgentRuntime
  // Demo only (--claude-code-login): run with the Claude Code login of this computer instead of an API key.
  useClaudeCodeLogin?: boolean
  // Replaces the request to Anthropic that checks a new key; only tests pass it.
  validateKey?: KeyValidator
  now?: () => number
}

// Claude through claude-agent-acp, billed pay-per-token on the user's own Anthropic account with an API key. There is
// no "Sign in with Claude" for third-party apps, and the user's claude.ai subscription must never be used: the agent
// runs with an API key in its environment (which outranks any stored login), with --hide-claude-auth (which makes it
// refuse a session a subscription would pay for) and, by default, in an empty configuration directory of its own.
// The one exception is the demo mode (useClaudeCodeLogin), which is never the default and runs the user's own Claude
// Code login: Anthropic's terms don't allow a subscription in third-party apps, so it is for demonstrations only.
export function createClaudeProvider(args: ClaudeProviderArgs): AgentProvider {
  const { dataDir, vault, userClaudeHome, agentBin, runtime } = args
  const useClaudeCodeLogin = args.useClaudeCodeLogin === true
  const removedListeners: Array<(notice: string) => void> = []

  const routes = createKeyRoutes({
    vault,
    validate: args.validateKey ?? validateKeyWithAnthropic,
    now: args.now ?? Date.now,
    onRemoved: () => {
      for (const listener of removedListeners) listener(apiKeyMissingNotice)
    },
  })

  return {
    id: "claude",
    label: "Claude",
    blockedCommands,
    hiddenCommands,
    protectedConfigIds: ["mode"],
    runtime,
    sessionRestartedNotice: "Started a new agent session; earlier messages aren't in the agent's memory.",

    // The user's own settings (--use-user-claude) may default to a mode that never asks (bypassPermissions): every
    // new session starts in the mode that asks, whatever they say.
    initialConfig: () => ({ mode: "default" }),

    credentialEpoch: () => vault.credentialEpoch(),
    secretValues: () => vault.knownKeys(),

    async authenticate(): Promise<AgentCredentials> {
      if (useClaudeCodeLogin) return { fingerprint: "claude-code-login", env: {} }
      // Before reading the key, never after: a key that changes in between must read as stale, not as fresh.
      const epoch = vault.credentialEpoch()
      const found = await vault.get()
      if (found === undefined) throw new AgentAuthError(apiKeyMissingNotice)
      // The fingerprint changes with the key, so a running agent is restarted (and resumed) with a replaced one.
      return { epoch, fingerprint: vault.fingerprint(found.key), env: { ANTHROPIC_API_KEY: found.key } }
    },

    spawnSpec() {
      if (useClaudeCodeLogin) {
        return {
          command: process.execPath,
          args: [agentBin ?? resolveClaudeAcpBin()],
          env: {
            // Without a directory of its own, Claude Code looks for its login where `claude` put it.
            ...(userClaudeHome === undefined ? {} : { CLAUDE_CONFIG_DIR: userClaudeHome }),
            NO_BROWSER: "1",
            DISABLE_AUTOUPDATER: "1",
            ...runtime?.env(),
          },
        }
      }
      const configDir = userClaudeHome ?? ensureIsolatedClaudeHome(dataDir)
      return {
        command: process.execPath,
        // --hide-claude-auth: refuse every session and turn a claude.ai subscription would pay for.
        args: [agentBin ?? resolveClaudeAcpBin(), "--hide-claude-auth"],
        env: { CLAUDE_CONFIG_DIR: configDir, NO_BROWSER: "1", DISABLE_AUTOUPDATER: "1", ...runtime?.env() },
      }
    },

    nativeCommandName,
    commandNameCandidates,
    identifyToolCall,
    readToolResult,

    preambleAdditions: () => [
      'The tools of the "prismic" MCP server are named mcp__prismic__<tool> (for example mcp__prismic__get_editor_context); where this prompt says get_editor_context, edit_open_document or update_document, those are the tools it means.',
    ],

    describePromptError(error) {
      const message = error instanceof Error ? error.message : String(error)
      if (useClaudeCodeLogin && /authentication required|authentication_error|not logged in|please run \/login/i.test(message)) {
        const checked = userClaudeHome ?? join(homedir(), ".claude")
        return `Claude Code isn't signed in on this computer (checked ${checked}). Run claude in a terminal, sign in with /login, then try again. If you sign in somewhere else, start the bridge with CLAUDE_CONFIG_DIR and --use-user-claude.`
      }
      // claude-agent-acp answers a rejected key (or a signed-out CLI) with an "Authentication required" error.
      if (/authentication required|invalid x-api-key|authentication_error|invalid api key/i.test(message)) {
        return "Anthropic rejected the API key. Check it in the Claude settings, or replace it."
      }
      if (/credit balance is too low/i.test(message)) {
        return "Your Anthropic account has no credit left. Add credit in the Anthropic console."
      }
      return undefined
    },

    async getStatus() {
      if (useClaudeCodeLogin) return { account: { kind: "apiKey", status: "configured", storage: "claude_code" } }
      const status = await vault.status()
      return {
        account: {
          kind: "apiKey",
          status: status.configured ? "configured" : "missing",
          ...(status.keyHint === undefined ? {} : { keyHint: status.keyHint }),
          storage: status.storage,
          ...(status.error === undefined ? {} : { error: status.error }),
        },
      }
    },

    async accountSummary(signal) {
      if (useClaudeCodeLogin) {
        return describeClaudeCodeLogin({ binaryPath: runtime?.binaryPath(), configDir: userClaudeHome, signal })
      }
      const status = await vault.status()
      return status.configured ? `Claude: API key ${status.keyHint ?? "configured"}` : "Claude: no API key yet"
    },

    async bannerLines() {
      if (useClaudeCodeLogin) {
        return [
          "Claude: the Claude Code login of this computer (demo mode: a subscription is not meant for third-party apps)",
          `Claude config: ${userClaudeHome ?? "Claude Code's default directory"} (the Claude Code login is used, not an API key)`,
        ]
      }
      const status = await vault.status()
      const key = status.error !== undefined
        ? status.error
        : status.configured
        ? `Anthropic API key configured (${status.storage}, ${status.keyHint})`
        : `no Anthropic API key yet (it will be kept in ${status.storage === "keychain" ? "the OS keychain" : "a private file, there is no OS keychain"})`
      return [
        `Claude: ${key}`,
        userClaudeHome === undefined
          ? `Claude config: ${isolatedClaudeHomePath(dataDir)} (isolated)`
          : `Claude config: ${userClaudeHome} (user, API key only: its login is never used)`,
      ]
    },

    routes: () => routes,

    onCredentialsRemoved(listener) {
      removedListeners.push(listener)
    },
  }
}
