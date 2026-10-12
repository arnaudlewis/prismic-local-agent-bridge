import { randomUUID } from "node:crypto"
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk"

import type { ClientMessage } from "../protocol.ts"
import type { Context } from "./context.ts"
import { emit, record } from "./output.ts"
import type { AgentFields, Conversation } from "./types.ts"

const maxPendingPermissions = 20

// An approval the agent asks for: shown in the chat, and answered by the browser (or cancelled).
export function requestPermission(
  ctx: Context,
  conversation: Conversation,
  agent: AgentFields,
  params: RequestPermissionRequest,
): Promise<RequestPermissionResponse> {
  if (agent.pendingPermissions.size >= maxPendingPermissions) {
    return Promise.resolve({ outcome: { outcome: "cancelled" } })
  }
  const requestId = randomUUID()
  return new Promise((resolve) => {
    agent.pendingPermissions.set(requestId, {
      resolve,
      optionIds: new Set(params.options.map((option) => option.optionId)),
      createdAt: Date.now(),
    })
    emit(ctx, conversation, {
      type: "permission_request",
      requestId,
      title: params.toolCall.title ?? "Permission requested",
      options: params.options.map((option) => ({
        optionId: option.optionId,
        name: option.name,
        kind: option.kind,
      })),
    })
  })
}

export function handlePermissionResponse(
  ctx: Context,
  windowId: string,
  message: Extract<ClientMessage, { type: "permission_response" }>,
): void {
  const conversation = ctx.windowConversations.get(windowId)
  const agent = conversation?.process
  const pending = agent?.pendingPermissions.get(message.requestId)
  if (conversation === undefined || agent === undefined || pending === undefined) return
  const { optionId } = message
  if (optionId !== undefined && !pending.optionIds.has(optionId)) {
    console.warn(`Ignored permission response with unknown option from a window`)
    return
  }
  agent.pendingPermissions.delete(message.requestId)
  record(ctx, conversation, { type: "permission_resolved", requestId: message.requestId, optionId })
  pending.resolve(
    optionId === undefined
      ? { outcome: { outcome: "cancelled" } }
      : { outcome: { outcome: "selected", optionId } },
  )
}
