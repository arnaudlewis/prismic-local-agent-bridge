import { z } from "zod"

export const bridgeInfo = { name: "prismic-local-agent-bridge", version: "0.0.0" }

export const agentModes = ["read-only", "workspace-write", "agent"] as const

export type AgentMode = (typeof agentModes)[number]

export const windowIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const SessionSchema = z.object({
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

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed"

export interface BridgeConfigOption {
  id: string
  name: string
  category?: string
  currentValue: string
  values: Array<{ value: string; name: string; description?: string }>
}

export type BridgeEvent =
  | { type: "chat_status"; status: "idle" | "starting" | "running" }
  | { type: "session_config"; options: BridgeConfigOption[] }
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
  | { type: "notice"; tone: "info" | "error"; text: string }

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
