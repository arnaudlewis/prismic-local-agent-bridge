import type { ChildProcess } from "node:child_process"

import type { Context } from "./context.ts"
import { flushHeldText, record } from "./output.ts"
import type { AgentFields, Conversation } from "./types.ts"

const exitGraceMs = 3000

// Resolves every permission request the agent is waiting on as cancelled, and notes it in the transcript.
export function cancelPendingPermissions(ctx: Context, conversation: Conversation, agent: AgentFields): void {
  for (const [requestId, pending] of agent.pendingPermissions) {
    record(ctx, conversation, { type: "permission_resolved", requestId })
    pending.resolve({ outcome: { outcome: "cancelled" } })
  }
  agent.pendingPermissions.clear()
}

// Bumping the generation makes every in-flight continuation and every late callback of the old agent stale.
export function stopAgent(ctx: Context, conversation: Conversation): ChildProcess | undefined {
  conversation.generation += 1
  // A child that is still handshaking isn't conversation.process yet, and must not outlive the stop.
  conversation.startingChild?.kill("SIGTERM")
  conversation.startingChild = undefined
  if (conversation.startingGrant !== undefined) ctx.prismic.grants.revoke(conversation.startingGrant)
  conversation.startingGrant = undefined
  // What an unfinished message was holding back is the last of the old agent: it comes out now, not never.
  flushHeldText(ctx, conversation)
  ctx.redactors.delete(conversation.id)
  const agent = conversation.process
  conversation.process = undefined
  if (agent === undefined) return undefined
  cancelPendingPermissions(ctx, conversation, agent)
  agent.child.kill("SIGTERM")
  ctx.prismic.grants.revoke(agent.grantToken)
  return agent.child
}

export function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      resolve()
    }, exitGraceMs)
    child.once("exit", () => {
      clearTimeout(timer)
      resolve()
    })
  })
}
