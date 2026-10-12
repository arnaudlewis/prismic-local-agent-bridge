import { z } from "zod"

export const bridgeInfo = { name: "prismic-local-agent-bridge", version: "0.0.0" }

export const agentModes = ["read-only", "workspace-write", "agent", "agent-full-access"] as const

export type AgentMode = (typeof agentModes)[number]

export const windowIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Becomes a filename on disk, so it is strict: lowercase UUID v4 only.
export const conversationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const SessionSchema = z.object({
  conversationId: z.string().regex(conversationIdPattern),
  mcpServerUrl: z.url({ protocol: /^https?$/ }),
  prismicToken: z.string().min(1),
  repository: z.string().min(1),
  document: z.object({ id: z.string().min(1), title: z.string() }).optional(),
})

export type Session = z.infer<typeof SessionSchema>

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("chat_open"),
    session: SessionSchema,
    preferredConfig: z.record(z.string(), z.string()).optional(),
  }),
  z.object({ type: z.literal("chat_prompt"), text: z.string().min(1), session: SessionSchema }),
  z.object({ type: z.literal("set_config_option"), configId: z.string().min(1), value: z.string() }),
  z.object({ type: z.literal("chat_cancel") }),
  z.object({ type: z.literal("chat_reset") }),
  z.object({
    type: z.literal("permission_response"),
    requestId: z.string().min(1),
    optionId: z.string().optional(),
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
      title: z.string(),
      customTypeLabel: z.string().optional(),
      versionStatus: z.string().optional(),
      locale: z.string().optional(),
      readOnly: z.boolean().optional(),
      hasUnsavedChanges: z.boolean().optional(),
    })
    .optional(),
  slice: z.object({ name: z.string(), variation: z.string().optional() }).optional(),
  field: z.object({ label: z.string(), type: z.string().optional() }).optional(),
  detected: z.object({ id: z.string(), title: z.string() }).optional(),
  pinned: z.object({ id: z.string() }).optional(),
})

export type EditorContextSummary = z.infer<typeof EditorContextSummarySchema>

export const HistoryEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user_message"), text: z.string() }),
  z.object({ type: z.literal("agent_message_chunk"), text: z.string(), messageId: z.string().optional() }),
  z.object({
    type: z.literal("tool_call"),
    toolCallId: z.string(),
    title: z.string(),
    status: ToolCallStatusSchema,
  }),
  z.object({
    type: z.literal("tool_call_update"),
    toolCallId: z.string(),
    title: z.string().optional(),
    status: ToolCallStatusSchema.optional(),
  }),
  z.object({
    type: z.literal("permission_request"),
    requestId: z.string(),
    title: z.string(),
    options: z.array(z.object({ optionId: z.string(), name: z.string(), kind: z.string() })),
  }),
  z.object({ type: z.literal("permission_resolved"), requestId: z.string(), optionId: z.string().optional() }),
  z.object({ type: z.literal("notice"), tone: z.enum(["info", "error"]), text: z.string() }),
  z.object({ type: z.literal("turn_end"), stopReason: z.string() }),
  z.object({ type: z.literal("editor_context"), toolCallId: z.string(), context: EditorContextSummarySchema }),
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

export type BridgeEvent =
  | { type: "chat_history"; events: HistoryEvent[] }
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

export interface StatusResponse {
  projectDir: string
  agentMode: AgentMode
  model?: string
  chatgpt: ChatGptStatus
}
