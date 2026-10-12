import { extractToolResultJson } from "./editorContext.ts"

const maxResponseBytes = 512 * 1024
const defaultTimeoutMs = 4000

interface ReadEditorContextArgs {
  mcpServerUrl: string
  prismicToken: string
  windowId: string
  pinnedDocumentId: string | undefined
  timeoutMs?: number
}

// `reason` is a fixed category: neither the URL, the token nor any part of the response ever ends up in it.
export type ReadEditorContextOutcome = { ok: true; value: unknown } | { ok: false; reason: string }

class ReadFailure extends Error {}

// Calls get_editor_context on the Prismic MCP server for the window the chat is bound to. The server is stateless,
// so a bare tools/call is enough (no initialize). Returns the tool's JSON result (contract B), never throws.
export async function readEditorContext(args: ReadEditorContextArgs): Promise<ReadEditorContextOutcome> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? defaultTimeoutMs)
  try {
    return { ok: true, value: await callTool(args, controller) }
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof ReadFailure)) return { ok: false, reason: "timeout" }
    return { ok: false, reason: error instanceof ReadFailure ? error.message : "network error" }
  } finally {
    clearTimeout(timer)
  }
}

async function callTool(args: ReadEditorContextArgs, controller: AbortController): Promise<unknown> {
  const response = await fetch(args.mcpServerUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.prismicToken}`,
      "X-Prismic-Window-Id": args.windowId,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "get_editor_context",
        arguments: args.pinnedDocumentId === undefined ? {} : { pinnedDocumentId: args.pinnedDocumentId },
      },
    }),
    // Only the configured URL is ever contacted: a redirect, to another origin or not, is a failure.
    redirect: "manual",
    signal: controller.signal,
  })

  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel()
    throw new ReadFailure("redirect refused")
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new ReadFailure(`http ${response.status}`)
  }
  const declaredLength = Number(response.headers.get("content-length"))
  if (declaredLength > maxResponseBytes) {
    await response.body?.cancel()
    throw new ReadFailure("response too large")
  }

  const isEventStream = (response.headers.get("content-type") ?? "").includes("text/event-stream")
  const rpc = await readRpcResponse(response, isEventStream)
  if (rpc === undefined) throw new ReadFailure("invalid response")
  if (rpc.error !== undefined && rpc.error !== null) throw new ReadFailure("tool call failed")
  const result = rpc.result
  if (typeof result === "object" && result !== null && (result as { isError?: unknown }).isError === true) {
    throw new ReadFailure("tool call failed")
  }
  const value = extractToolResultJson({ rawOutput: { result, error: null } })
  if (value === undefined) throw new ReadFailure("invalid response")
  return value
}

interface RpcResponse {
  id?: unknown
  result?: unknown
  error?: unknown
}

// Reads at most 512 KiB. An event stream is parsed as it arrives and the read stops at the first JSON-RPC response
// to our request, because a server may keep the stream open after answering. Exported for tests.
export async function readRpcResponse(response: Response, isEventStream: boolean): Promise<RpcResponse | undefined> {
  const reader = response.body?.getReader()
  if (reader === undefined) return undefined
  const decoder = new TextDecoder()
  const stream = isEventStream ? createEventStreamParser() : undefined
  let text = ""
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxResponseBytes) throw new ReadFailure("response too large")
      const decoded = decoder.decode(value, { stream: true })
      if (stream === undefined) {
        text += decoded
        continue
      }
      const found = stream.push(decoded)
      if (found !== undefined) return found
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const rest = decoder.decode()
  if (stream === undefined) return parseRpc(text + rest)
  return stream.push(rest) ?? stream.finish()
}

// Each complete event (blank-line delimited) is looked at exactly once: only the unconsumed tail is kept, and only
// the newly received text is scanned for a delimiter, so the work is linear in the size of the stream.
function createEventStreamParser() {
  const delimiter = /\r?\n\r?\n/g
  let pending = ""

  function parseEvent(event: string): RpcResponse | undefined {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n")
    return data === "" ? undefined : parseRpc(data)
  }

  return {
    push(chunk: string): RpcResponse | undefined {
      // A delimiter can straddle two chunks: start 3 characters before the new text (len("\r\n\r") ).
      delimiter.lastIndex = Math.max(0, pending.length - 3)
      pending += chunk
      let consumed = 0
      for (let match = delimiter.exec(pending); match !== null; match = delimiter.exec(pending)) {
        const found = parseEvent(pending.slice(consumed, match.index))
        consumed = match.index + match[0].length
        if (found !== undefined) return found
        delimiter.lastIndex = consumed
      }
      pending = pending.slice(consumed)
      return undefined
    },
    // The stream may end without the blank line after its last event.
    finish(): RpcResponse | undefined {
      const found = pending === "" ? undefined : parseEvent(pending)
      pending = ""
      return found
    },
  }
}

// Only the response to our request (id 1) counts: notifications and other messages in the stream are skipped.
function parseRpc(text: string): RpcResponse | undefined {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return undefined
  const message = json as RpcResponse
  return message.id === 1 && (message.result !== undefined || message.error !== undefined) ? message : undefined
}
