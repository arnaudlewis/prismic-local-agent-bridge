import type { ChildProcess } from "node:child_process"
import type { ClientSideConnection, RequestPermissionResponse, SessionConfigOption } from "@agentclientprotocol/sdk"

import type { ToolIdentity } from "../editorContext.ts"
import type { AgentId, BridgeCommand } from "../protocol.ts"
import type { Transcript } from "../transcript.ts"

export interface StartedWith {
  // Changes with the agent's credentials: a running agent started with another one is restarted.
  credentialsFingerprint: string
  // The Prismic MCP origin and user the agent works as: another one restarts it.
  mcpOrigin: string
  prismicUserId: string
  // The MCP header X-Prismic-Window-Id must follow the attached window, so a new window restarts the agent.
  windowId: string
}

export interface PendingPermission {
  resolve: (response: RequestPermissionResponse) => void
  optionIds: Set<string>
  createdAt: number
}

// The running ACP child of a conversation and everything tied to that one process.
export interface AgentFields {
  child: ChildProcess
  connection: ClientSideConnection
  sessionId: string
  startedWith: StartedWith
  // The token this process uses to reach the daemon's MCP proxy; revoked when the process is stopped.
  grantToken: string
  turnActive: boolean
  turnStartedAt: number
  // Set when a detached turn went over its limit and was cancelled; if it still hasn't ended, the agent is stopped.
  cancelRequestedAt: number | undefined
  // True while prompt() is in flight; before that (reading the editor context) a cancel just flags the turn.
  promptInFlight: boolean
  cancelRequested: boolean
  replaying: boolean
  preambleSent: boolean
  configOptions: SessionConfigOption[]
  availableCommands: BridgeCommand[]
  pendingPermissions: Map<string, PendingPermission>
  // MCP tool identity per tool call: agents may leave it out of updates when it hasn't changed since the start report.
  toolIdentities: Map<string, ToolIdentity>
}

export interface Conversation {
  id: string
  agent: AgentId
  repository: string
  // The latest window attached to this conversation: the only one that receives live events.
  windowId: string | undefined
  process: AgentFields | undefined
  // Survives agent restarts so the user's model and effort choices persist; it belongs to its conversation, so a new
  // conversation starts from the defaults.
  selectedConfig: Record<string, string>
  ensuring: Promise<boolean> | undefined
  // True while an agent is being spawned for it: it already counts as a live agent.
  starting: boolean
  // The child that was spawned for it and is still handshaking: stopping the conversation must kill it too.
  startingChild: ChildProcess | undefined
  // Its MCP proxy token: revoked with the child, not left to the child's exit.
  startingGrant: string | undefined
  // Monotonic activity tick, to find the least recently active conversation.
  lastActiveAt: number
  // Bumped whenever the agent is stopped so an in-flight start can notice and abort.
  generation: number
  // Set once a prompt has been accepted: an agent that never got one has nothing to resume.
  resumeSessionId: string | undefined
  // The document the preamble pins for this conversation: passed to get_editor_context on every per-turn read.
  pinnedDocumentId: string | undefined
  // Set once, from the first user message; a conversation without one is never listed.
  title: string | undefined
  // Epoch ms of the last user message or finished turn.
  updatedAt: number
  // Set by chat_delete: nothing may write this conversation to disk anymore.
  deleted: boolean
  // When the conversation became busy (starting, then running), until it is idle: the daemon owns this clock so that a
  // browser that reloads mid-turn shows the real time, not zero.
  busySince: number | undefined
  // The browser asks to see the agent's reasoning (session.showReasoning): when it doesn't, none of it is sent.
  showReasoning: boolean
  // How much reasoning was sent in this busy period (see maxThoughtBytesPerTurn).
  thoughtBytes: number
  lastContextNoticeAt: number | undefined
  transcript: Transcript
  // JSON of the last editor_context event, to emit only when the summary changes.
  lastEditorContext: string | undefined
  saveTimer: NodeJS.Timeout | undefined
  idleTimer: NodeJS.Timeout | undefined
}
