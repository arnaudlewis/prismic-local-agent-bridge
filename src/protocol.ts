import { z } from "zod"

export const bridgeInfo = { name: "prismic-local-agent-bridge", version: "0.0.0" }

// The agents the daemon can run. Adding one is this line plus an AgentProvider (see src/agents/provider.ts).
export const agentIds = ["codex"] as const

export const AgentIdSchema = z.enum(agentIds)

export type AgentId = z.infer<typeof AgentIdSchema>

export const windowIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Becomes a filename on disk, so it is strict: lowercase UUID v4 only.
export const conversationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const SessionSchema = z.object({
  agent: AgentIdSchema,
  conversationId: z.string().regex(conversationIdPattern),
  // Only http(s), and no credentials in the URL: they would end up in logs and in the MCP configuration of the agent.
  mcpServerUrl: z
    .url({ protocol: /^https?$/ })
    .max(2048)
    // The refinement also runs on values that failed the URL check above, so it must never throw on them.
    .refine((value) => {
      if (!URL.canParse(value)) return false
      const url = new URL(value)
      return url.username === "" && url.password === ""
    }, "The MCP server URL must not contain credentials"),
  prismicToken: z.string().min(1).max(8192),
  repository: z.string().min(1).max(200),
  document: z.object({ id: z.string().min(1).max(300), title: z.string().max(300) }).optional(),
})

export type Session = z.infer<typeof SessionSchema>

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("chat_open"),
    session: SessionSchema,
    preferredConfig: z.record(z.string().max(200), z.string().max(200)).optional(),
  }),
  z.object({ type: z.literal("chat_prompt"), text: z.string().min(1).max(20_000), session: SessionSchema }),
  z.object({
    type: z.literal("set_config_option"),
    configId: z.string().min(1).max(200),
    value: z.string().max(200),
  }),
  z.object({ type: z.literal("chat_cancel") }),
  z.object({ type: z.literal("threads_list"), repository: z.string().min(1).max(200), agent: AgentIdSchema }),
  z.object({ type: z.literal("chat_delete"), conversationId: z.string().regex(conversationIdPattern) }),
  z.object({
    type: z.literal("permission_response"),
    requestId: z.string().min(1).max(200),
    optionId: z.string().max(200).optional(),
  }),
])

export type ClientMessage = z.infer<typeof ClientMessageSchema>

const ToolCallStatusSchema = z.enum(["pending", "in_progress", "completed", "failed"])

export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>

export const EditorContextSummarySchema = z.object({
  status: z.enum(["no_editor_window", "no_pin", "pinned_matches", "context_changed", "pinned_document_not_open"]),
  ambiguous: z.boolean(),
  document: z
    .object({
      id: z.string(),
      uid: z.string().optional(),
      title: z.string(),
      customTypeLabel: z.string().optional(),
      versionStatus: z.string().optional(),
      locale: z.string().optional(),
      readOnly: z.boolean().optional(),
    })
    .optional(),
  slice: z.object({ name: z.string(), variation: z.string().optional() }).optional(),
  field: z.object({ label: z.string(), type: z.string().optional() }).optional(),
  detected: z.object({ id: z.string(), title: z.string() }).optional(),
  pinned: z.object({ id: z.string() }).optional(),
})

export type EditorContextSummary = z.infer<typeof EditorContextSummarySchema>

// Bounds mirror what the transcript enforces when recording, so a stored file always validates on load.
const eventText = z.string().max(100_000)
const eventId = z.string().max(1000)

export const HistoryEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user_message"), text: eventText }),
  z.object({ type: z.literal("agent_message_chunk"), text: eventText, messageId: eventId.optional() }),
  z.object({
    type: z.literal("tool_call"),
    toolCallId: eventId,
    title: eventText,
    status: ToolCallStatusSchema,
  }),
  z.object({
    type: z.literal("tool_call_update"),
    toolCallId: eventId,
    title: eventText.optional(),
    status: ToolCallStatusSchema.optional(),
  }),
  z.object({
    type: z.literal("permission_request"),
    requestId: eventId,
    title: eventText,
    options: z.array(z.object({ optionId: eventId, name: eventId, kind: eventId })).max(20),
  }),
  z.object({ type: z.literal("permission_resolved"), requestId: eventId, optionId: eventId.optional() }),
  z.object({ type: z.literal("notice"), tone: z.enum(["info", "error"]), text: eventText }),
  z.object({ type: z.literal("turn_end"), stopReason: eventId }),
  z.object({ type: z.literal("editor_context"), toolCallId: eventId, context: EditorContextSummarySchema }),
])

export type HistoryEvent = z.infer<typeof HistoryEventSchema>

export interface BridgeConfigOption {
  id: string
  name: string
  category?: string
  currentValue: string
  values: Array<{ value: string; name: string; description?: string }>
}

export interface BridgeCommand {
  name: string
  description: string
  hint?: string
}

export interface ThreadSummary {
  conversationId: string
  title: string
  // Epoch milliseconds of the last user message or finished turn.
  updatedAt: number
}

export type BridgeEvent =
  | { type: "chat_history"; events: HistoryEvent[] }
  | { type: "threads"; threads: ThreadSummary[] }
  | { type: "chat_status"; status: "idle" | "starting" | "running" }
  | { type: "session_config"; options: BridgeConfigOption[] }
  | { type: "available_commands"; commands: BridgeCommand[] }
  | { type: "agent_message_chunk"; text: string; messageId?: string }
  | { type: "tool_call"; toolCallId: string; title: string; status: ToolCallStatus }
  | { type: "tool_call_update"; toolCallId: string; title?: string; status?: ToolCallStatus }
  | {
      type: "permission_request"
      requestId: string
      title: string
      options: Array<{ optionId: string; name: string; kind: string }>
    }
  | { type: "turn_end"; stopReason: string }
  | { type: "editor_context"; toolCallId: string; context: EditorContextSummary }
  | { type: "notice"; tone: "info" | "error"; text: string }

// The events that are both sent live and recorded in the transcript.
export type RecordedBridgeEvent = Extract<BridgeEvent, { type: HistoryEvent["type"] }>

export interface ChatGptStatus {
  status: "signed_out" | "signing_in" | "signed_in"
  email?: string
  planUsage: boolean
  error?: string
}

export type AgentAccountStatus = { kind: "chatgpt" } & ChatGptStatus

export interface AgentStatus {
  agentMode: string
  model?: string
  account: AgentAccountStatus
}

export interface StatusResponse {
  projectDir: string
  agents: Partial<Record<AgentId, AgentStatus>>
}
