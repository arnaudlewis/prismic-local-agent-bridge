import { afterEach, describe, expect, it, vi } from "vitest"

import { readEditorContext, readRpcResponse } from "./editorContextClient.ts"
import { createMcpUpstream } from "./prismic/mcpUpstream.ts"
import { createFakePrismic } from "./testing/fakePrismic.ts"
import { secretToken, startStub } from "./testing/mcpStub.ts"
import type { Stub, StubMode } from "./testing/mcpStub.ts"

const encoder = new TextEncoder()

function streamOf(chunks: string[], options: { keepOpen?: boolean; onCancel?: () => void } = {}): Response {
  let index = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index]
      if (chunk !== undefined) {
        index += 1
        controller.enqueue(encoder.encode(chunk))
        return
      }
      if (options.keepOpen !== true) controller.close()
      // Otherwise it stays open and never produces anything again, like a server that doesn't end the stream.
      return new Promise(() => {})
    },
    cancel() {
      options.onCancel?.()
    },
  })
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } })
}

function event(message: unknown): string {
  return `event: message\ndata: ${JSON.stringify(message)}\n\n`
}

const answer = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "{}" }] } }

describe("readRpcResponse on an event stream", () => {
  it("does linear work on thousands of small notification events delivered one chunk at a time", async () => {
    const notifications = Array.from({ length: 5000 }, (_, index) =>
      event({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: index } }),
    )
    const parse = vi.spyOn(JSON, "parse")
    const startedAt = performance.now()

    const found = await readRpcResponse(streamOf([...notifications, event(answer)]), true)

    const elapsed = performance.now() - startedAt
    const parseCalls = parse.mock.calls.length
    parse.mockRestore()
    expect(found).toEqual(answer)
    // Every event is parsed once. Re-parsing the accumulated buffer on each chunk would be millions of calls.
    expect(parseCalls).toBeLessThan(5100)
    expect(elapsed).toBeLessThan(2000)
  })

  it("finds a response split across chunks, including inside the delimiter and the data line", async () => {
    const text = event(answer).replace("\n\n", "\r\n\r\n")
    const chunks = [...text].map((character) => character)

    expect(await readRpcResponse(streamOf(chunks), true)).toEqual(answer)
    expect(await readRpcResponse(streamOf([text.slice(0, 20), text.slice(20, text.length - 2), text.slice(-2)]), true)).toEqual(answer)
  })

  it("stops at the first response with the right id and cancels the reader, even when the stream stays open", async () => {
    const onCancel = vi.fn()
    const response = streamOf(
      [event({ jsonrpc: "2.0", id: 2, result: { other: true } }), event(answer), event({ jsonrpc: "2.0", id: 1, result: { late: true } })],
      { keepOpen: true, onCancel },
    )

    expect(await readRpcResponse(response, true)).toEqual(answer)
    expect(onCancel).toHaveBeenCalled()
  })

  it("skips events that are not the response to our request", async () => {
    const response = streamOf([
      event({ jsonrpc: "2.0", method: "notifications/message", params: {} }),
      event({ jsonrpc: "2.0", id: 7, result: {} }),
      "data: not json\n\n",
      "retry: 1000\n\n",
    ])

    expect(await readRpcResponse(response, true)).toBeUndefined()
  })

  it("finds a last event that the stream ends without a trailing blank line", async () => {
    const text = `data: ${JSON.stringify(answer)}`

    expect(await readRpcResponse(streamOf([text.slice(0, 10), text.slice(10)]), true)).toEqual(answer)
  })

  it("keeps the 512 KiB cap on the whole stream", async () => {
    const chunk = `: ${"x".repeat(60 * 1024)}\n`

    await expect(readRpcResponse(streamOf(Array(10).fill(chunk)), true)).rejects.toThrow("response too large")
  })

  it("keeps the 512 KiB cap on a single event that never ends", async () => {
    const chunks = ["data: ", ...Array(600).fill("y".repeat(1024))]

    await expect(readRpcResponse(streamOf(chunks), true)).rejects.toThrow("response too large")
  })

  it("still parses a plain JSON body", async () => {
    const response = new Response(JSON.stringify(answer), { headers: { "Content-Type": "application/json" } })

    expect(await readRpcResponse(response, false)).toEqual(answer)
  })
})

describe("readEditorContext", () => {
  const stubs: Stub[] = []

  afterEach(async () => {
    for (const stub of stubs.splice(0)) await stub.close()
  })

  async function read(mode: StubMode, args: { timeoutMs?: number; pinnedDocumentId?: string } = {}) {
    const stub = await startStub({ mode })
    stubs.push(stub)
    const prismic = createFakePrismic({ accessToken: secretToken })
    const outcome = await readEditorContext({
      upstream: createMcpUpstream({ auth: prismic.auth }),
      mcpOrigin: new URL(stub.url).origin,
      windowId: "window-1",
      pinnedDocumentId: args.pinnedDocumentId,
      timeoutMs: args.timeoutMs,
    })
    return { stub, outcome }
  }

  it("calls get_editor_context for the window with the daemon's access token and returns the tool's JSON", async () => {
    const { stub, outcome } = await read("json", { pinnedDocumentId: "DOC1" })

    expect(outcome).toEqual({ ok: true, value: stub.payload })
    expect(stub.requests).toHaveLength(1)
    expect(stub.requests[0]?.headers.authorization).toBe(`Bearer ${secretToken}`)
    expect(stub.requests[0]?.headers["x-prismic-window-id"]).toBe("window-1")
    expect(stub.requests[0]?.body).toMatchObject({
      method: "tools/call",
      params: { name: "get_editor_context", arguments: { pinnedDocumentId: "DOC1" } },
    })
  })

  it("reads an event-stream answer as well", async () => {
    const { stub, outcome } = await read("sse")

    expect(outcome).toEqual({ ok: true, value: stub.payload })
  })

  // The reasons are fixed categories: they end up in the daemon's logs, so no origin or token may leak into them.
  it.each([
    ["unauthorized", "sign-in required"],
    ["garbage", "invalid response"],
    ["huge", "response too large"],
    ["redirect", "network error"],
  ] as const)("reports %s as %j without following a redirect or leaking anything", async (mode, reason) => {
    const { stub, outcome } = await read(mode)

    expect(outcome).toEqual({ ok: false, reason })
    expect(JSON.stringify(outcome)).not.toContain(secretToken)
    expect(JSON.stringify(outcome)).not.toContain("127.0.0.1")
    expect(stub.elsewhereHits).toBe(0)
  })

  it("gives up on a server that never answers once the timeout passed", async () => {
    const { outcome } = await read("hang", { timeoutMs: 150 })

    expect(outcome).toEqual({ ok: false, reason: "timeout" })
  })
})
