import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { Readable, Writable } from "node:stream"
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk"
import type { Client, McpServer, RequestPermissionResponse } from "@agentclientprotocol/sdk"

import { AgentAuthError } from "../agents/provider.ts"
import { browserWindowId } from "../channelKey.ts"
import type { AgentCredentials, AgentProvider } from "../agents/provider.ts"
import { errorMessage } from "../errors.ts"
import { bridgeInfo } from "../protocol.ts"
import { agentMcpPath } from "../prismic/agentMcpProxy.ts"
import { buildChildEnvironment } from "./childEnv.ts"
import { providerOf } from "./context.ts"
import type { Context } from "./context.ts"
import { refreshIdleTimer } from "./idle.ts"
import { flushHeldText, notify, scheduleSave, sendLive, setStatus } from "./output.ts"
import { requestPermission } from "./permissions.ts"
import { makeRoomForAgent } from "./registry.ts"
import { applyInitialConfig, applySelectedConfig, sendAgentState } from "./sessionConfig.ts"
import { handleSessionUpdate } from "./sessionUpdates.ts"
import { cancelPendingPermissions, stopAgent, waitForExit } from "./stop.ts"
import type { AgentFields, Conversation, StartedWith } from "./types.ts"

const tooManyConversationsNotice = "Too many active conversations. Finish or reset one first."
const notConnectedNotice = "This window isn't connected. Connect again from the agent panel."
const signInNotice = "Sign in to Prismic again from the agent panel."

class StartAbortedError extends Error {}

// Makes sure the conversation has a running agent started with the current credentials, Prismic account and window.
// Calls are serialized per conversation. Returns false (after telling the user why) when it can't.
export function ensureAgent(ctx: Context, conversation: Conversation, windowId: string): Promise<boolean> {
  const next = (conversation.ensuring ?? Promise.resolve(true)).then(() =>
    doEnsureAgent(ctx, conversation, windowId),
  )
  conversation.ensuring = next
  return next.finally(() => {
    if (conversation.ensuring === next) conversation.ensuring = undefined
  })
}

type EnsureOutcome = "ready" | "failed" | "abandoned" | "stale"

// Credentials can change while an agent is getting ready (a key replaced or removed). Each attempt notices that and
// gives up on its stale credentials; the second attempt authenticates again, which either gets the new key or tells
// the user there is none. A second staleness is a user flapping the key: the start is abandoned.
async function doEnsureAgent(ctx: Context, conversation: Conversation, windowId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const outcome = await tryEnsureAgent(ctx, conversation, windowId)
    if (outcome === "ready") return true
    if (outcome !== "stale") return false
  }
  return abandonEnsure(ctx, conversation)
}

class StaleCredentialsError extends Error {}

function isLive(ctx: Context, conversation: Conversation): boolean {
  return !conversation.deleted && ctx.conversations.get(conversation.id) === conversation
}

async function tryEnsureAgent(ctx: Context, conversation: Conversation, windowId: string): Promise<EnsureOutcome> {
  // Everything below awaits something; a delete in the meantime must not leave notices or an agent behind.
  // A start that waited in the queue behind another one starts from the generation after a delete: it must notice
  // the delete (or stopAll) by itself, or it would spawn an agent, and issue a grant, for a conversation that is gone.
  if (!isLive(ctx, conversation)) return abandon(ctx, conversation)
  const entryGeneration = conversation.generation
  // Without a pairing there is no MCP to reach, and without a Prismic sign-in the proxy has nothing to swap in.
  const mcpOrigin = ctx.channels.mcpOrigin(windowId)
  if (mcpOrigin === undefined) {
    notify(ctx, conversation, "error", notConnectedNotice)
    setStatus(ctx, conversation, "idle")
    return "failed"
  }
  const prismic = ctx.prismic.auth.status(mcpOrigin)
  if (prismic.status === "signed_out") {
    notify(ctx, conversation, "error", signInNotice)
    setStatus(ctx, conversation, "idle")
    return "failed"
  }
  let provider: AgentProvider
  let credentials: AgentCredentials
  try {
    provider = providerOf(ctx, conversation)
    credentials = await provider.authenticate()
  } catch (error) {
    if (conversation.generation !== entryGeneration) return abandon(ctx, conversation)
    const text = error instanceof AgentAuthError ? error.notice : `Agent error: ${errorMessage(error)}`
    notify(ctx, conversation, "error", text)
    setStatus(ctx, conversation, "idle")
    return "failed"
  }
  if (conversation.generation !== entryGeneration) return abandon(ctx, conversation)
  const isStale = () => credentials.epoch !== undefined && provider.credentialEpoch?.() !== credentials.epoch
  if (isStale()) return "stale"

  const startedWith: StartedWith = {
    credentialsFingerprint: credentials.fingerprint,
    mcpOrigin,
    prismicUserId: prismic.userId,
    windowId,
  }
  const current = conversation.process
  if (current !== undefined && (current.turnActive || sameStartedWith(current.startedWith, startedWith))) {
    return "ready"
  }

  const runtime = provider.runtime
  if (runtime !== undefined && !runtime.isReady()) {
    // Live only: a progress line has no place in the stored transcript.
    sendLive(ctx, conversation, {
      type: "notice",
      tone: "info",
      text: `Downloading ${provider.label} for this computer (${runtime.sizeLabel}). This happens only once.`,
    })
    try {
      await runtime.ensure()
    } catch (error) {
      if (conversation.generation !== entryGeneration) return abandon(ctx, conversation)
      notify(
        ctx,
        conversation,
        "error",
        `Couldn't download ${provider.label}: ${errorMessage(error)}. Send a message to try again.`,
      )
      setStatus(ctx, conversation, "idle")
      return "failed"
    }
    if (conversation.generation !== entryGeneration) return abandon(ctx, conversation)
    if (isStale()) return "stale"
  }

  const stopped = stopAgent(ctx, conversation)
  const stopGeneration = conversation.generation
  if (stopped !== undefined) await waitForExit(stopped)
  if (conversation.generation !== stopGeneration) return abandon(ctx, conversation)
  if (isStale()) return "stale"

  if (!makeRoomForAgent(ctx, conversation)) {
    notify(ctx, conversation, "error", tooManyConversationsNotice)
    setStatus(ctx, conversation, "idle")
    return "failed"
  }

  // Set in the same tick as the cap check above, so concurrent starts can't all pass it.
  conversation.starting = true
  try {
    await startAgent({ ctx, conversation, windowId, credentials, startedWith, isStale })
    return "ready"
  } catch (error) {
    if (error instanceof StaleCredentialsError) return "stale"
    if (error instanceof StartAbortedError || conversation.generation !== stopGeneration) {
      return abandon(ctx, conversation)
    }
    notify(ctx, conversation, "error", `Couldn't start the local agent: ${errorMessage(error)}`)
    setStatus(ctx, conversation, "idle")
    return "failed"
  } finally {
    conversation.starting = false
    conversation.startingChild = undefined
    conversation.startingGrant = undefined
  }
}

function abandon(ctx: Context, conversation: Conversation): "abandoned" {
  setStatus(ctx, conversation, "idle")
  return "abandoned"
}

function abandonEnsure(ctx: Context, conversation: Conversation): false {
  abandon(ctx, conversation)
  return false
}

interface StartAgentArgs {
  ctx: Context
  conversation: Conversation
  windowId: string
  credentials: AgentCredentials
  startedWith: StartedWith
  // True once the credentials were replaced or removed since they were read.
  isStale: () => boolean
}

// Spawns the ACP child, does the handshake, then resumes the stored session (or starts a new one).
async function startAgent(args: StartAgentArgs): Promise<void> {
  const { ctx, conversation, windowId, credentials, startedWith, isStale } = args
  const provider = providerOf(ctx, conversation)
  const { projectDir } = ctx.config
  const generation = conversation.generation
  const resumeSessionId = conversation.resumeSessionId

  const spec = provider.spawnSpec({ projectDir })
  // Right before the spawn, with nothing awaited in between: the last point to refuse stale credentials.
  if (isStale()) throw new StaleCredentialsError()
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
  // The agent reaches the Prismic MCP through the daemon, with a token of its own that is worth nothing elsewhere.
  const grantToken = ctx.prismic.grants.issue({
    mcpOrigin: startedWith.mcpOrigin,
    windowKey: windowId,
    userId: startedWith.prismicUserId,
  })
  // Whatever the generation: a process that is gone must not leave a working token behind.
  child.on("exit", () => ctx.prismic.grants.revoke(grantToken))
  conversation.startingChild = child
  conversation.startingGrant = grantToken
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
    grantToken,
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
  const startedAt = Date.now()

  try {
    const initialized = await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "prismic-local-agent", title: "Prismic Local Agent", version: bridgeInfo.version },
    })
    const initializedAt = Date.now()
    if (conversation.generation !== generation) throw new StartAbortedError()
    if (isStale()) throw new StaleCredentialsError()
    if (initialized.agentCapabilities?.mcpCapabilities?.http !== true) {
      throw new Error("The agent does not support HTTP MCP servers")
    }

    const mcpServers: McpServer[] = [
      {
        type: "http",
        name: "prismic",
        url: `http://127.0.0.1:${ctx.prismic.bridgePort}${agentMcpPath}`,
        headers: [
          { name: "Authorization", value: `Bearer ${grantToken}` },
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
          const loaded = await connection.loadSession({
            sessionId: resumeSessionId,
            cwd: projectDir,
            mcpServers,
            _meta: provider.sessionMeta?.(),
          })
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
      const created = await connection.newSession({ cwd: projectDir, mcpServers, _meta: provider.sessionMeta?.() })
      agent.sessionId = created.sessionId
      agent.configOptions = created.configOptions ?? []
      await applyInitialConfig(provider.initialConfig?.() ?? {}, agent)
    }
    agent.preambleSent = resumed
    console.info(
      `[agent/start] agent=${provider.id} initializeMs=${initializedAt - startedAt} sessionMs=${Date.now() - initializedAt} resumed=${resumed}`,
    )

    if (conversation.generation !== generation) throw new StartAbortedError()
    if (isStale()) throw new StaleCredentialsError()
    conversation.process = agent
    if (resumeSessionId !== undefined) {
      conversation.resumeSessionId = agent.sessionId
      scheduleSave(ctx, conversation)
    }

    await applySelectedConfig(conversation, agent)
    if (conversation.process !== agent) throw new StartAbortedError()
    if (isStale()) {
      // Already the conversation's agent: take it back before it can be used.
      conversation.process = undefined
      throw new StaleCredentialsError()
    }
    sendAgentState(ctx, conversation, agent)
  } catch (error) {
    child.kill("SIGTERM")
    ctx.prismic.grants.revoke(grantToken)
    throw error
  }
}

function handleAgentExit(ctx: Context, conversation: Conversation, child: ChildProcess, code: number | null): void {
  const agent = conversation.process
  if (agent?.child !== child) return
  conversation.process = undefined
  cancelPendingPermissions(ctx, conversation, agent)
  flushHeldText(ctx, conversation)
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
    a.mcpOrigin === b.mcpOrigin &&
    a.prismicUserId === b.prismicUserId &&
    a.windowId === b.windowId
  )
}

