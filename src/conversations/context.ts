import type { AgentProvider } from "../agents/provider.ts"
import type { ConversationStore } from "../conversationStore.ts"
import type { AgentMcpGrants } from "../prismic/agentMcpProxy.ts"
import type { McpUpstream } from "../prismic/mcpUpstream.ts"
import type { PrismicAuth } from "../prismic/prismicAuth.ts"
import type { AgentId } from "../protocol.ts"
import type { WindowChannels } from "../windowChannels.ts"
import type { MessageRedactor } from "./redaction.ts"
import type { Conversation } from "./types.ts"

// The daemon's own Prismic sign-in and the ways it uses it: the agents never hold a Prismic token.
export interface PrismicRuntime {
  auth: PrismicAuth
  upstream: McpUpstream
  grants: AgentMcpGrants
  // The port of the daemon: the agents reach their MCP proxy on it.
  bridgePort: number
}

// A conversation with no window attached and no turn running is stopped (and dropped from memory) after this long.
export const defaultIdleTtlMs = 6 * 60 * 60 * 1000
// Each agent is a child process holding credentials: resident ones are bounded daemon-wide.
export const defaultMaxLiveAgents = 4
export const defaultMaxConversations = 50
// A conversation nobody is looking at must not run (or wait for an approval) forever.
export const defaultDetachedActivityLimitMs = 30 * 60 * 1000
export const defaultDetachedSweepIntervalMs = 60_000

export interface SessionsConfig {
  projectDir: string
  idleTtlMs: number
  liveAgentLimit: number
  conversationLimit: number
  activityLimitMs: number
  readContextEachTurn: boolean
  // --pass-env: names of daemon variables handed to the agents on top of the allowlist.
  passEnv: readonly string[]
  // Undefined: the client's default (4 s).
  contextReadTimeoutMs: number | undefined
}

// Everything the conversation modules share. They are plain functions over this: no module keeps state of its own.
export interface Context {
  channels: WindowChannels
  store: ConversationStore
  providers: ReadonlyMap<AgentId, AgentProvider>
  config: SessionsConfig
  conversations: Map<string, Conversation>
  windowConversations: Map<string, Conversation>
  // The repository and agent a window last worked with: the fallback for answering a chat_delete of an unknown id.
  windowScopes: Map<string, { repository: string; agent: AgentId }>
  // The unfinished tail of an assistant message per conversation (see redaction.ts).
  redactors: Map<string, MessageRedactor>
  // Monotonic counter behind Conversation.lastActiveAt.
  activity: { tick: number }
  prismic: PrismicRuntime
}

// Every secret the daemon holds: the providers' credentials, the Prismic tokens and the agents' proxy tokens.
export function knownSecrets(ctx: Context): string[] {
  return [
    ...[...ctx.providers.values()].flatMap((provider) => provider.secretValues?.() ?? []),
    ...ctx.prismic.auth.knownTokens(),
    ...ctx.prismic.grants.tokens(),
  ]
}

export function providerOf(ctx: Context, conversation: Conversation): AgentProvider {
  const provider = ctx.providers.get(conversation.agent)
  if (provider === undefined) throw new Error(`The ${conversation.agent} agent isn't available`)
  return provider
}
