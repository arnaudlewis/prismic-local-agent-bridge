import type { IncomingMessage, ServerResponse } from "node:http"

import type { ToolIdentity } from "../editorContext.ts"
import type { AgentId, AgentStatus } from "../protocol.ts"

// An agent the daemon can run over ACP. Everything the conversation machinery (src/conversations) needs to know
// about one agent is here, so that Codex is just the first provider: see src/agents/codex/codexProvider.ts.
export interface AgentProvider {
  readonly id: AgentId
  // Shown in the banner and in messages.
  readonly label: string
  // Slash commands that are never forwarded to the agent (and dropped from its command list), and commands the UI
  // has a control for (dropped from the list but still forwarded when typed).
  readonly blockedCommands: readonly string[]
  readonly hiddenCommands: readonly string[]
  // Config option ids the browser may not set when opening a chat (only through an explicit set_config_option).
  readonly protectedConfigIds: readonly string[]
  // Config applied to every NEW agent session before anything else (a resumed one keeps its own). It makes the
  // starting mode the bridge's choice rather than whatever the agent's own settings say. If it can't be applied, the
  // agent is not started: a mode that is too permissive must never be the fallback.
  initialConfig?(): Record<string, string>
  // Notice sent when a stored agent session can't be resumed and a new one starts.
  readonly sessionRestartedNotice: string

  // Makes sure the agent can be started: refreshes or checks the account and returns what the child needs. Throws
  // AgentAuthError (with a user-facing notice) when it can't.
  authenticate(): Promise<AgentCredentials>
  // How to start the ACP child: command, arguments and environment. May prepare config files first.
  spawnSpec(args: { projectDir: string }): AgentSpawnSpec

  // The native slash command a prompt would run inside the agent (lowercased), or undefined when the agent would
  // not treat it as one. This MUST mirror the agent's own parsing: it is what the blocklist is checked against.
  nativeCommandName(text: string): string | undefined
  // Every command name the text could run under a more lenient reading than the agent's own (odd whitespace, case).
  // They are all checked against the blocklist, so a parsing difference can only over-block, never let a command by.
  // Defaults to nativeCommandName.
  commandNameCandidates?(text: string): string[]
  // MCP tool calls as the agent reports them (identity of a call, and its result once finished), used to catch
  // the result of get_editor_context.
  identifyToolCall(update: ToolUpdate): ToolIdentity | undefined
  readToolResult(update: ToolUpdate): unknown
  // A user-facing message for a prompt error this agent knows about (usage limits, ...), else undefined.
  describePromptError?(error: unknown): string | undefined
  // Extra lines for the preamble sent with the first prompt of a conversation.
  preambleAdditions?(): string[]

  // The agent's part of GET /status.
  getStatus(): AgentStatus | Promise<AgentStatus>
  // Startup banner lines.
  bannerLines(): string[] | Promise<string[]>
  // Called once with a listener; the provider calls it when its credentials were removed, with the notice to show.
  // The conversations running on that agent are stopped at once (turns cancelled, approvals denied).
  onCredentialsRemoved?(listener: (notice: string) => void): void
  // HTTP routes of its own (sign-in flows, ...).
  routes?(): ProviderRoute[]
}

export interface AgentCredentials {
  // Changes whenever the credentials do: a running agent started with another value is restarted.
  fingerprint: string
  // Environment variables carrying the credentials to the child.
  env: Record<string, string>
}

export interface AgentSpawnSpec {
  command: string
  args: string[]
  env: Record<string, string>
  // Variables of the daemon's own environment the child must NOT inherit (another credential, another endpoint).
  removeEnv?: string[]
}

export interface ToolUpdate {
  toolCallId: string
  name?: string | null
  title?: string | null
  _meta?: unknown
  status?: string | null
  rawInput?: unknown
  rawOutput?: unknown
  content?: unknown
}

export interface ProviderRoute {
  method: "GET" | "POST" | "PUT" | "DELETE"
  path: string
  // "bearer" needs a paired browser's token; "none" is for redirects coming back from a sign-in page.
  auth: "bearer" | "none"
  // Browser requests to a route normally need an allowed Origin; sign-in callbacks can't have one.
  originExempt?: boolean
  handle(context: { req: IncomingMessage; res: ServerResponse; url: URL }): Promise<void> | void
}

// Thrown by authenticate(): `notice` is shown to the user as is.
export class AgentAuthError extends Error {
  notice: string

  constructor(notice: string) {
    super(notice)
    this.notice = notice
  }
}
