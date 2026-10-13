// Minimal stand-in for codex-acp used by agentSessions tests: speaks newline-delimited JSON-RPC on stdio.
import { appendFileSync } from "node:fs"
import { createInterface } from "node:readline"

// FAKE_AGENT_MODE_VALUES makes the mode option look like another agent's (Claude's modes, say): the first value is
// where the session starts, which stands for the agent's own settings choosing a mode.
const modeValues = process.env.FAKE_AGENT_MODE_VALUES?.split(",") ?? ["read-only", "workspace-write", "agent", "agent-full-access"]

let mode = process.env.INITIAL_AGENT_MODE ?? modeValues[0] ?? "read-only"
let collaborationMode = "default"

function configOptions() {
  return [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: mode,
      options: modeValues.map((value) => ({ value, name: value })),
    },
    {
      id: "collaboration_mode",
      name: "Collaboration mode",
      category: "collaboration_mode",
      type: "select",
      currentValue: collaborationMode,
      options: [
        { value: "default", name: "Default" },
        { value: "plan", name: "Plan" },
      ],
    },
  ]
}

const commandNames = process.env.FAKE_AGENT_COMMANDS?.split(",") ?? ["status", "mcp", "plan", "compact", "rename", "logout", "review", "review-branch", "review-commit", "goal", "$skill"]

function notify(update: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fake-session", update } })}\n`)
}

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function fail(id: unknown, message: string): void {
  write({ jsonrpc: "2.0", id, error: { code: -32603, message } })
}

function respond(id: unknown, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`)
}

interface Message {
  id?: unknown
  method?: string
  result?: { outcome?: { outcome?: string; optionId?: string } }
  params?: {
    configId?: string
    value?: string
    prompt?: Array<{ text: string }>
    mcpServers?: Array<{ url?: string; headers: Array<{ name: string; value: string }> }>
    _meta?: unknown
  }
}

// How the current session was established and the window it is bound to, echoed back in replies so tests can see it.
let sessionKind = "new"
let windowHeader = ""
let heldPromptId: unknown
let permissionPromptId: unknown
let toolCounter = 0

function captureWindowHeader(message: Message): void {
  const headers = message.params?.mcpServers?.[0]?.headers ?? []
  windowHeader = headers.find((header) => header.name === "X-Prismic-Window-Id")?.value ?? ""
  // What the agent was given to reach the MCP: kept out of the chat, where the daemon redacts its own tokens.
  const authorization = headers.find((header) => header.name === "Authorization")?.value ?? ""
  if (process.env.FAKE_AGENT_MCP_LOG !== undefined) {
    appendFileSync(
      process.env.FAKE_AGENT_MCP_LOG,
      `${JSON.stringify({ url: message.params?.mcpServers?.[0]?.url, authorization, meta: message.params?._meta })}\n`,
    )
  }
}

function publishCommands(): void {
  notify({
    sessionUpdate: "available_commands_update",
    availableCommands: commandNames.map((name) => ({ name, description: name, input: null })),
  })
}

function chunk(text: string): void {
  notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } })
}

// How the process reacts to SIGTERM: leave at once (like a normal agent), ignore it, or take a while to leave.
let onSigterm: "exit" | "ignore" | number = "exit"

function startLog(line: string): void {
  if (process.env.FAKE_AGENT_START_LOG !== undefined) appendFileSync(process.env.FAKE_AGENT_START_LOG, `${line}\n`)
}

process.on("SIGTERM", () => {
  startLog("sigterm")
  if (onSigterm === "ignore") return
  if (typeof onSigterm === "number") setTimeout(() => process.exit(0), onSigterm)
  else process.exit(0)
})

function log(line: string): void {
  if (process.env.FAKE_AGENT_LOG !== undefined) appendFileSync(process.env.FAKE_AGENT_LOG, `${line}\n`)
}

// Simulates an agent that keeps talking after the bridge stopped it: it ignores SIGTERM, then sends text and a
// permission request, and logs how the bridge answered. It exits by itself shortly after.
function misbehave(): void {
  onSigterm = "ignore"
  setTimeout(() => process.exit(0), 3000).unref()
  setTimeout(() => {
    chunk("late-text")
    write({
      jsonrpc: "2.0",
      id: "perm-late",
      method: "session/request_permission",
      params: {
        sessionId: "fake-session",
        toolCall: { toolCallId: "late-tool", title: "Late tool" },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      },
    })
  }, 300)
}

// FAKE_AGENT_THOUGHTS="first|second": the agent's reasoning, sent in these pieces before anything else of every turn, as
// one thought message (FAKE_AGENT_THOUGHT_ID, "thought-1" by default, "none" for pieces without a message id).
// "@pad:<n>" stands for n harmless characters, and FAKE_AGENT_THOUGHT_REPEAT=<n> sends the whole list n times: a stream
// too large to put in an environment variable.
function thoughtPieces(): string[] {
  const pieces = (process.env.FAKE_AGENT_THOUGHTS?.split("|") ?? []).map((piece) => {
    const pad = /^@pad:(\d+)$/.exec(piece)
    return pad === null ? piece : "x".repeat(Number(pad[1]))
  })
  return Array.from({ length: Number(process.env.FAKE_AGENT_THOUGHT_REPEAT ?? 1) }, () => pieces).flat()
}

function thought(text: string): void {
  const id = process.env.FAKE_AGENT_THOUGHT_ID ?? "thought-1"
  const messageId = id === "none" ? undefined : id
  notify({ sessionUpdate: "agent_thought_chunk", messageId, content: { type: "text", text } })
}

function think(): void {
  for (const text of thoughtPieces()) thought(text)
}

// "think-slowly": the same pieces FAKE_AGENT_THOUGHT_DELAY_MS apart (the first at once), then a reply and the end of the
// turn: a window can change what it asks for between two of them.
function thinkSlowly(message: Message): void {
  const pieces = thoughtPieces()
  const delay = Number(process.env.FAKE_AGENT_THOUGHT_DELAY_MS ?? 0)
  pieces.forEach((text, index) => setTimeout(() => thought(text), index * delay))
  setTimeout(() => {
    chunk("slow-reply")
    respond(message.id, { stopReason: "end_turn" })
  }, pieces.length * delay)
}

function handlePrompt(message: Message): void {
  if ((message.params?.prompt ?? []).some((block) => block.text.startsWith("think-slowly"))) {
    thinkSlowly(message)
    return
  }
  think()
  const blocks = message.params?.prompt ?? []
  // The bridge appends a one-line reminder after the user's text on regular prompts; the user's text is the block before it.
  const text = blocks.filter((block) => !block.text.startsWith("Reminder: call get_editor_context")).at(-1)?.text ?? ""
  // The names (never the values) of the environment this process was started with.
  if (text.startsWith("dump-env-names")) {
    const names = Object.keys(process.env).filter((name) => !name.startsWith("__CF_")).sort()
    chunk(`envnames:${names.join(",")}`)
    respond(message.id, { stopReason: "end_turn" })
    return
  }
  // "delay-exit <ms>": from now on SIGTERM takes this long to make the process leave (an old agent that is slow to stop).
  if (text.startsWith("delay-exit ")) {
    onSigterm = Number(text.slice("delay-exit ".length))
    respond(message.id, { stopReason: "end_turn" })
    return
  }
  // The last 4 characters of a variable: enough to tell which key an agent was started with, while the daemon
  // redacts the key itself from anything it forwards.
  if (text.startsWith("env-tail ")) {
    const name = text.slice("env-tail ".length).trim()
    chunk(`envtail:${name}=${(process.env[name] ?? "").slice(-4)}`)
    respond(message.id, { stopReason: "end_turn" })
    return
  }
  if (text.startsWith("say-chunks ") || text.startsWith("hold-after-chunks ")) {
    const holds = text.startsWith("hold-after-chunks ")
    // "say-chunks <messageId> <chunk>|<chunk>|...": one message sent in pieces, like a model streaming a reply.
    const [, messageId = "", ...rest] = text.split(" ")
    // "hold-after-chunks": the same, but the turn never ends (the daemon stops the agent).
    for (const piece of rest.join(" ").split("|")) {
      // "@tool" is not text: another event of the turn (a tool call that starts, then finishes) in the middle of the message.
      if (piece === "@tool") {
        const toolCallId = `mid-${toolCounter++}`
        notify({ sessionUpdate: "tool_call", toolCallId, title: "Run tool", status: "in_progress" })
        notify({ sessionUpdate: "tool_call_update", toolCallId, status: "completed" })
        continue
      }
      notify({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: piece } })
    }
    if (!holds) respond(message.id, { stopReason: "end_turn" })
    return
  }
  if (text.startsWith("echo-env ")) {
    const name = text.slice("echo-env ".length).trim()
    chunk(`env:${name}=${process.env[name] ?? ""}`)
    respond(message.id, { stopReason: "end_turn" })
    return
  }
  if (text.startsWith("fail-prompt")) {
    fail(message.id, text)
    return
  }
  // "emit-claude-tool <server> <tool> <json>": an MCP call the way claude-agent-acp reports it: the tool is named
  // mcp__<server>__<tool> (as name and title), the result comes back as content blocks with the name in _meta.
  if (text.startsWith("emit-claude-tool ")) {
    const [, server = "", tool = "", ...rest] = text.split(" ")
    const name = `mcp__${server}__${tool}`
    notify({ sessionUpdate: "tool_call", toolCallId: "claude-1", name, title: name, kind: "other", status: "pending", rawInput: {} })
    notify({
      sessionUpdate: "tool_call_update",
      toolCallId: "claude-1",
      status: "completed",
      _meta: { claudeCode: { toolName: name } },
      content: [{ type: "content", content: { type: "text", text: rest.join(" ") } }],
    })
    respond(message.id, { stopReason: "end_turn" })
    return
  }
  // A tool call in a format codex-acp doesn't use: title "Prismic/<tool>" and rawOutput { json }.
  if (text.startsWith("emit-custom-tool ")) {
    notify({ sessionUpdate: "tool_call", toolCallId: "custom-1", title: "Prismic/get_editor_context", status: "in_progress" })
    notify({
      sessionUpdate: "tool_call_update",
      toolCallId: "custom-1",
      status: "completed",
      rawOutput: { json: JSON.parse(text.slice("emit-custom-tool ".length)) },
    })
    respond(message.id, { stopReason: "end_turn" })
    return
  }
  if (text.includes("flood-permissions")) {
    heldPromptId = message.id
    for (let index = 0; index < 25; index++) {
      write({
        jsonrpc: "2.0",
        id: `perm-f-${index}`,
        method: "session/request_permission",
        params: {
          sessionId: "fake-session",
          toolCall: { toolCallId: `flood-${index}`, title: `Flood ${index}` },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        },
      })
    }
    return
  }
  if (text.includes("late-output")) {
    misbehave()
    return
  }
  if (text.includes("hold")) {
    chunk("working")
    heldPromptId = message.id
    return
  }
  if (text.includes("ask-permission-with-key")) {
    permissionPromptId = message.id
    write({
      jsonrpc: "2.0",
      id: "perm-1",
      method: "session/request_permission",
      params: {
        sessionId: "fake-session",
        toolCall: { toolCallId: "tool-1", title: `Run with ${process.env.ANTHROPIC_API_KEY ?? ""}` },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      },
    })
    return
  }
  if (text.includes("ask-permission")) {
    permissionPromptId = message.id
    write({
      jsonrpc: "2.0",
      id: "perm-1",
      method: "session/request_permission",
      params: {
        sessionId: "fake-session",
        toolCall: { toolCallId: "tool-1", title: "Run tool" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      },
    })
    return
  }
  chunk(`ctx:${sessionKind}:${windowHeader}`)
  // "emit-tool <server>.<tool> <text>": an MCP tool call shaped like codex-acp's reports. Like codex-acp, the
  // completed update leaves out the title and rawInput because they are unchanged since the start report.
  if (text.startsWith("emit-tool ")) {
    const [, identity = "", ...rest] = text.split(" ")
    const [server = "", tool = ""] = identity.split(".")
    const output = rest.join(" ")
    const toolCallId = `mcp-${toolCounter++}`
    notify({
      sessionUpdate: "tool_call",
      toolCallId,
      title: `mcp.${server}.${tool}`,
      status: "in_progress",
      rawInput: { server, tool, arguments: {} },
    })
    notify({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "completed",
      rawOutput: { result: { content: [{ type: "text", text: output }], structuredContent: null }, error: null },
    })
    respond(message.id, { stopReason: "end_turn" })
    return
  }
  if (text.includes("use-tool")) {
    notify({ sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Run tool", status: "in_progress" })
    notify({ sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed" })
  }
  for (const block of blocks) chunk(`prompt:${block.text}`)
  respond(message.id, { stopReason: "end_turn" })
}

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line) as Message
  switch (message.method) {
    case "initialize": {
      // `start:<last 4 characters of the API key it was given>`: which credentials this process was started with.
      startLog(`start:${(process.env.ANTHROPIC_API_KEY ?? "").slice(-4)}`)
      const answer = () =>
        respond(message.id, {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } },
        })
      const delay = Number(process.env.FAKE_AGENT_INIT_DELAY_MS ?? 0)
      if (delay > 0) setTimeout(answer, delay)
      else answer()
      break
    }
    case "session/new": {
      sessionKind = "new"
      // It has been given its MCP config (and logged it) before it stalls or dies: the handshake never completes.
      captureWindowHeader(message)
      if (process.env.FAKE_AGENT_EXIT_ON_NEW_SESSION !== undefined) process.exit(1)
      const answer = () => {
        publishCommands()
        respond(message.id, { sessionId: "fake-session", configOptions: configOptions() })
      }
      const stall = Number(process.env.FAKE_AGENT_NEW_SESSION_DELAY_MS ?? 0)
      if (stall > 0) {
        // Like an agent that ignores SIGTERM while it is busy starting.
        onSigterm = "ignore"
        setTimeout(() => {
          answer()
          setTimeout(() => process.exit(0), 200)
        }, stall)
      } else answer()
      break
    }
    case "session/load":
      if (process.env.FAKE_AGENT_FAIL_LOAD !== undefined) {
        fail(message.id, "Internal error")
        break
      }
      sessionKind = "load"
      captureWindowHeader(message)
      publishCommands()
      notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "replayed-history" } })
      respond(message.id, { configOptions: configOptions() })
      break
    case "session/set_config_option":
      if (message.params?.configId === "mode" && message.params.value !== undefined) mode = message.params.value
      if (message.params?.configId === "collaboration_mode" && message.params.value !== undefined) {
        collaborationMode = message.params.value
      }
      if (process.env.FAKE_AGENT_SLOW_CONFIG_MS !== undefined) {
        // Answers late and survives SIGTERM, like an agent whose RPC is still in flight when the bridge resets.
        onSigterm = "ignore"
        setTimeout(() => {
          respond(message.id, { configOptions: configOptions() })
          setTimeout(() => process.exit(0), 200)
        }, Number(process.env.FAKE_AGENT_SLOW_CONFIG_MS))
        break
      }
      respond(message.id, { configOptions: configOptions() })
      break
    case "session/prompt":
      handlePrompt(message)
      break
    case "session/cancel":
      if (heldPromptId !== undefined) respond(heldPromptId, { stopReason: "cancelled" })
      heldPromptId = undefined
      break
    default:
      if (message.method === undefined && typeof message.id === "string" && message.id.startsWith("perm-f-")) {
        log(`flood:${message.result?.outcome?.outcome}`)
      } else if (message.method === undefined && message.id === "perm-late") {
        log(`late-permission:${message.result?.outcome?.outcome}`)
        process.exit(0)
      } else if (message.method === undefined && message.id === "perm-1") {
        const outcome = message.result?.outcome
        chunk(`permission:${outcome?.outcome === "selected" ? outcome.optionId : outcome?.outcome}`)
        respond(permissionPromptId, { stopReason: "end_turn" })
        permissionPromptId = undefined
      } else if (message.id !== undefined && message.method !== undefined) {
        respond(message.id, {})
      }
  }
}
