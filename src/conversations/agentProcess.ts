import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { Readable, Writable } from "node:stream"
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk"
import type { Client, McpServer, RequestPermissionResponse } from "@agentclientprotocol/sdk"

import { AgentAuthError } from "../agents/provider.ts"
import { browserWindowId } from "../channelKey.ts"
import type { AgentCredentials } from "../agents/provider.ts"
import { errorMessage } from "../errors.ts"
import { bridgeInfo } from "../protocol.ts"
import type { Session } from "../protocol.ts"
import { buildChildEnvironment } from "./childEnv.ts"
import { providerOf } from "./context.ts"
import type { Context } from "./context.ts"
import { refreshIdleTimer } from "./idle.ts"
import { notify, scheduleSave, setStatus } from "./output.ts"
import { requestPermission } from "./permissions.ts"
import { makeRoomForAgent } from "./registry.ts"
import { applyInitialConfig, applySelectedConfig, sendAgentState } from "./sessionConfig.ts"
import { handleSessionUpdate } from "./sessionUpdates.ts"
import { cancelPendingPermissions, stopAgent, waitForExit } from "./stop.ts"
import type { AgentFields, Conversation, StartedWith } from "./types.ts"

const tooManyConversationsNotice = "Too many active conversations. Finish or reset one first."

class StartAbortedError extends Error {}

// Makes sure the conversation has a running agent started with the current credentials, MCP URL, token and window.
// Calls are serialized per conversation. Returns false (after telling the user why) when it can't.
export function ensureAgent(ctx: Context, conversation: Conversation, windowId: string, session: Session): Promise<boolean> {
  const next = (conversation.ensuring ?? Promise.resolve(true)).then(() =>
    doEnsureAgent(ctx, conversation, windowId, session),
  )
  conversation.ensuring = next
  return next.finally(() => {
    if (conversation.ensuring === next) conversation.ensuring = undefined
  })
}

async function doEnsureAgent(ctx: Context, conversation: Conversation, windowId: string, session: Session): Promise<boolean> {
  // Everything below awaits something; a delete in the meantime must not leave notices or an agent behind.
  const entryGeneration = conversation.generation
  let credentials: AgentCredentials
  try {
    credentials = await providerOf(ctx, conversation).authenticate()
  } catch (error) {
    if (conversation.generation !== entryGeneration) return abandonEnsure(ctx, conversation)
    const text = error instanceof AgentAuthError ? error.notice : `Agent error: ${errorMessage(error)}`
    notify(ctx, conversation, "error", text)
    setStatus(ctx, conversation, "idle")
    return false
  }
  if (conversation.generation !== entryGeneration) return abandonEnsure(ctx, conversation)

  const startedWith: StartedWith = {
    credentialsFingerprint: credentials.fingerprint,
    mcpServerUrl: session.mcpServerUrl,
    prismicToken: session.prismicToken,
    windowId,
  }
  const current = conversation.process
  if (current !== undefined && (current.turnActive || sameStartedWith(current.startedWith, startedWith))) {
    return true
  }

  const stopped = stopAgent(ctx, conversation)
  const stopGeneration = conversation.generation
  if (stopped !== undefined) await waitForExit(stopped)
  if (conversation.generation !== stopGeneration) return abandonEnsure(ctx, conversation)

  if (!makeRoomForAgent(ctx, conversation)) {
    notify(ctx, conversation, "error", tooManyConversationsNotice)
    setStatus(ctx, conversation, "idle")
    return false
  }

  // Set in the same tick as the cap check above, so concurrent starts can't all pass it.
  conversation.starting = true
  try {
    await startAgent({ ctx, conversation, windowId, session, credentials, startedWith })
    return true
  } catch (error) {
    if (error instanceof StartAbortedError || conversation.generation !== stopGeneration) {
      return abandonEnsure(ctx, conversation)
    }
    notify(ctx, conversation, "error", `Couldn't start the local agent: ${errorMessage(error)}`)
    setStatus(ctx, conversation, "idle")
    return false
  } finally {
    conversation.starting = false
  }
}

function abandonEnsure(ctx: Context, conversation: Conversation): false {
  setStatus(ctx, conversation, "idle")
  return false
}

interface StartAgentArgs {
  ctx: Context
  conversation: Conversation
  windowId: string
  session: Session
  credentials: AgentCredentials
  startedWith: StartedWith
}

// Spawns the ACP child, does the handshake, then resumes the stored session (or starts a new one).
async function startAgent(args: StartAgentArgs): Promise<void> {
  const { ctx, conversation, windowId, session, credentials, startedWith } = args
  const provider = providerOf(ctx, conversation)
  const { projectDir } = ctx.config
  const generation = conversation.generation
  const resumeSessionId = conversation.resumeSessionId

  const spec = provider.spawnSpec({ projectDir })
  const child = spawn(spec.command, spec.args, {
    cwd: projectDir,
    stdio: ["pipe", "pipe", "inherit"],
    env: buildChildEnvironment({
      source: process.env,
      provided: [spec.env, credentials.env],
      passEnv: ctx.config.passEnv,
      caseInsensitive: process.platform === "win32",
    }),
  })
  child.on("error", (error) => console.error(`Local agent process error: ${error.message}`))
  child.stdin.on("error", (error) => console.warn(`Local agent stdin error: ${error.message}`))
  child.on("exit", (code) => {
    if (conversation.generation === generation) handleAgentExit(ctx, conversation, child, code)
  })

  // An agent that was stopped or deleted may still talk for a while (or ignore SIGTERM): everything it sends after
  // that must neither reach the transcript, nor the disk, nor wait for an answer nobody can give.
  const client: Client = {
    requestPermission: (params) =>
      conversation.generation === generation
        ? requestPermission(ctx, conversation, agent, params)
        : Promise.resolve<RequestPermissionResponse>({ outcome: { outcome: "cancelled" } }),
    sessionUpdate: (notification) => {
      if (conversation.generation === generation) handleSessionUpdate(ctx, conversation, agent, notification)
    },
  }
  // Node's web stream typings and the SDK's DOM-based ones disagree on the buffer type; the runtime objects are compatible.
  const input = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
  const connection = new ClientSideConnection(() => client, ndJsonStream(Writable.toWeb(child.stdin), input))
  const agent: AgentFields = {
    child,
    connection,
    sessionId: "",
    startedWith,
    turnActive: false,
    turnStartedAt: 0,
    cancelRequestedAt: undefined,
    promptInFlight: false,
    cancelRequested: false,
    replaying: false,
    preambleSent: false,
    configOptions: [],
    availableCommands: [],
    pendingPermissions: new Map(),
    toolIdentities: new Map(),
  }

  try {
    const initialized = await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "prismic-local-agent", title: "Prismic Local Agent", version: bridgeInfo.version },
    })
    if (initialized.agentCapabilities?.mcpCapabilities?.http !== true) {
      throw new Error("The agent does not support HTTP MCP servers")
    }

    const mcpServers: McpServer[] = [
      {
        type: "http",
        name: "prismic",
        url: session.mcpServerUrl,
        headers: [
          { name: "Authorization", value: `Bearer ${session.prismicToken}` },
          { name: "X-Prismic-Window-Id", value: browserWindowId(windowId) },
        ],
      },
    ]

    let resumed = false
    if (resumeSessionId !== undefined) {
      if (initialized.agentCapabilities?.loadSession === true) {
        agent.sessionId = resumeSessionId
        // The agent replays the whole history as updates; they are already in the transcript.
        agent.replaying = true
        try {
          const loaded = await connection.loadSession({ sessionId: resumeSessionId, cwd: projectDir, mcpServers })
          agent.configOptions = loaded.configOptions ?? []
          resumed = true
        } catch (error) {
          console.warn(`Could not resume the agent session: ${errorMessage(error)}`)
        } finally {
          agent.replaying = false
        }
      }
      if (conversation.generation !== generation) throw new StartAbortedError()
      if (!resumed) notify(ctx, conversation, "info", provider.sessionRestartedNotice)
    }
    if (!resumed) {
      agent.sessionId = ""
      const created = await connection.newSession({ cwd: projectDir, mcpServers })
      agent.sessionId = created.sessionId
      agent.configOptions = created.configOptions ?? []
      await applyInitialConfig(provider.initialConfig?.() ?? {}, agent)
    }
    agent.preambleSent = resumed

    if (conversation.generation !== generation) throw new StartAbortedError()
    conversation.process = agent
    if (resumeSessionId !== undefined) {
      conversation.resumeSessionId = agent.sessionId
      scheduleSave(ctx, conversation)
    }

    await applySelectedConfig(conversation, agent)
    if (conversation.process !== agent) throw new StartAbortedError()
    sendAgentState(ctx, conversation, agent)
  } catch (error) {
    child.kill("SIGTERM")
    throw error
  }
}

function handleAgentExit(ctx: Context, conversation: Conversation, child: ChildProcess, code: number | null): void {
  const agent = conversation.process
  if (agent?.child !== child) return
  conversation.process = undefined
  cancelPendingPermissions(ctx, conversation, agent)
  if (agent.turnActive) {
    notify(
      ctx,
      conversation,
      "error",
      `The local agent stopped (exit code ${code ?? "unknown"}). Send a message to restart it.`,
    )
  }
  setStatus(ctx, conversation, "idle")
  scheduleSave(ctx, conversation)
  refreshIdleTimer(ctx, conversation)
}

function sameStartedWith(a: StartedWith, b: StartedWith): boolean {
  return (
    a.credentialsFingerprint === b.credentialsFingerprint &&
    a.mcpServerUrl === b.mcpServerUrl &&
    a.prismicToken === b.prismicToken &&
    a.windowId === b.windowId
  )
}

