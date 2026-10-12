import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { conversationId, session, createHarness, notices, windowA, windowB, chatHistory, editorContextEvents, toolText, windowDocument, contextWindow } from "../testing/harness.ts"
import type { Harness } from "../testing/harness.ts"

describe("structured editor context", () => {
  async function prompt(harness: Harness, text: string, target = windowA) {
    await harness.agents.handleMessage(target, { type: "chat_prompt", text, session })
  }

  it("emits one editor_context for a completed get_editor_context of the prismic server, without leaking content", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    await prompt(
      harness,
      toolText("prismic.get_editor_context", {
        status: "no_pin",
        detected: contextWindow(),
        ambiguous: false,
        otherWindows: [{ windowId: "w2", documentTitle: "Other" }],
      }),
    )

    const events = editorContextEvents(harness.events)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      type: "editor_context",
      toolCallId: expect.any(String),
      context: {
        status: "no_pin",
        ambiguous: false,
        document: {
          id: "DOC1",
          uid: "home",
          title: "Home",
          customTypeLabel: "Page",
          versionStatus: "unclassified",
          locale: "en-us",
          readOnly: false,
        },
        slice: { name: "Hero", variation: "default" },
        field: { label: "Title", type: "StructuredText" },
      },
    })
    const wire = JSON.stringify(harness.events.filter((event) => event.type === "editor_context"))
    for (const leaked of ["document-content-secret", "slice-item-secret", "a.b", "primary.title", "customTypeId", "Other"]) {
      expect(wire).not.toContain(leaked)
    }
  })

  it("never forwards hasUnsavedChanges", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    await prompt(
      harness,
      toolText("prismic.get_editor_context", { status: "no_pin", detected: contextWindow(), ambiguous: false }),
    )

    expect(JSON.stringify(editorContextEvents(harness.events))).not.toContain("hasUnsavedChanges")
  })

  it("passes the document uid through, tolerates its absence and caps it", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    const withoutUid = { ...windowDocument, uid: undefined }
    await prompt(
      harness,
      toolText("prismic.get_editor_context", { status: "no_pin", detected: contextWindow(withoutUid), ambiguous: false }),
    )
    await prompt(
      harness,
      toolText("prismic.get_editor_context", {
        status: "no_pin",
        detected: contextWindow({ ...windowDocument, uid: "u".repeat(1000) }),
        ambiguous: false,
      }),
    )
    await prompt(
      harness,
      toolText("prismic.get_editor_context", {
        status: "no_pin",
        detected: contextWindow({ ...windowDocument, uid: 42 }),
        ambiguous: false,
      }),
    )

    const documents = editorContextEvents(harness.events).map((event) => event.context.document)
    expect(documents[0]).not.toHaveProperty("uid")
    expect(documents[1]?.uid).toBe("u".repeat(300))
    expect(documents[2]).toMatchObject({ id: "DOC1" })
    expect(documents[2]).not.toHaveProperty("uid")
  })

  it("loads a conversation stored with hasUnsavedChanges, strips it and does not re-emit an unchanged summary", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bridge-old-"))
    mkdirSync(join(dataDir, "conversations"), { recursive: true })
    writeFileSync(
      join(dataDir, "conversations", `${conversationId}.json`),
      JSON.stringify({
        version: 1,
        conversationId,
        repository: "repo",
        updatedAt: 1,
        events: [
          {
            type: "editor_context",
            toolCallId: "t1",
            context: {
              status: "no_pin",
              ambiguous: false,
              document: {
                id: "DOC1",
                title: "Home",
                customTypeLabel: "Page",
                versionStatus: "unclassified",
                locale: "en-us",
                readOnly: false,
                hasUnsavedChanges: true,
              },
              slice: { name: "Hero", variation: "default" },
              field: { label: "Title", type: "StructuredText" },
            },
          },
        ],
      }),
    )
    const harness = createHarness({ dataDir })

    await harness.agents.handleMessage(windowA, { type: "chat_open", session })

    const replayed = chatHistory(harness.eventsFor(windowA)).filter((event) => event.type === "editor_context")
    expect(replayed).toHaveLength(1)
    expect(JSON.stringify(replayed)).not.toContain("hasUnsavedChanges")

    // Same summary as the stored one, minus the removed field and without a uid: it must not be emitted again.
    await prompt(
      harness,
      toolText("prismic.get_editor_context", {
        status: "no_pin",
        detected: contextWindow({ ...windowDocument, uid: undefined }),
        ambiguous: false,
      }),
    )
    expect(editorContextEvents(harness.events)).toEqual([])
  })

  it("dedupes an unchanged summary and emits again when it changes", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    const payload = { status: "no_pin", detected: contextWindow(), ambiguous: false }
    await prompt(harness, toolText("prismic.get_editor_context", payload))
    await prompt(harness, toolText("prismic.get_editor_context", { ...payload, otherWindows: [] }))
    expect(editorContextEvents(harness.events)).toHaveLength(1)

    await prompt(
      harness,
      toolText("prismic.get_editor_context", { ...payload, detected: contextWindow({ ...windowDocument, title: "About" }) }),
    )
    expect(editorContextEvents(harness.events).map((event) => event.context.document?.title)).toEqual(["Home", "About"])
  })

  it("uses the pinned window document for pinned_matches and context_changed", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    const other = { ...windowDocument, id: "DOC2", title: "About", focusedSlice: undefined, focusedField: undefined }

    await prompt(
      harness,
      toolText("prismic.get_editor_context", {
        status: "pinned_matches",
        detected: contextWindow(),
        pinned: { documentId: "DOC1", window: contextWindow() },
        ambiguous: false,
      }),
    )
    await prompt(
      harness,
      toolText("prismic.get_editor_context", {
        status: "context_changed",
        detected: contextWindow(other),
        pinned: { documentId: "DOC1", window: contextWindow() },
        ambiguous: true,
      }),
    )

    const [matches, changed] = editorContextEvents(harness.events).map((event) => event.context)
    expect(matches).toMatchObject({ status: "pinned_matches", document: { id: "DOC1" }, slice: { name: "Hero" } })
    expect(matches?.detected).toBeUndefined()
    expect(changed).toMatchObject({
      status: "context_changed",
      ambiguous: true,
      document: { id: "DOC1", title: "Home" },
      slice: { name: "Hero" },
      detected: { id: "DOC2", title: "About" },
      pinned: { id: "DOC1" },
    })
  })

  it("fills only pinned.id for pinned_document_not_open and nothing for no_editor_window", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    await prompt(
      harness,
      toolText("prismic.get_editor_context", {
        status: "pinned_document_not_open",
        detected: contextWindow(),
        pinned: { documentId: "DOC9" },
        ambiguous: false,
      }),
    )
    await prompt(
      harness,
      toolText("prismic.get_editor_context", { status: "no_editor_window", ambiguous: false, otherWindows: [] }),
    )

    expect(editorContextEvents(harness.events).map((event) => event.context)).toEqual([
      { status: "pinned_document_not_open", ambiguous: false, pinned: { id: "DOC9" } },
      { status: "no_editor_window", ambiguous: false },
    ])
  })

  it.each([
    ["not json at all"],
    ['{"status":"nope"}'],
    ["[]"],
    ['{"ambiguous":true}'],
  ])("silently ignores an invalid output %j", async (output) => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    await prompt(harness, toolText("prismic.get_editor_context", output))

    expect(editorContextEvents(harness.events)).toEqual([])
    expect(harness.events.some((event) => event.type === "turn_end")).toBe(true)
    expect(notices(harness.events)).toEqual([])
  })

  it("ignores other tools and other servers", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    const payload = { status: "no_pin", detected: contextWindow(), ambiguous: false }
    await prompt(harness, toolText("prismic.get_document", payload))
    await prompt(harness, toolText("other.get_editor_context", payload))

    expect(editorContextEvents(harness.events)).toEqual([])
  })

  it("tolerates missing and mistyped fields and caps long strings", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    await prompt(
      harness,
      toolText("prismic.get_editor_context", {
        status: "no_pin",
        detected: { document: { id: "DOC1", title: "T".repeat(1000), readOnly: "yes", focusedSlice: "nope" } },
      }),
    )

    const [event] = editorContextEvents(harness.events)
    expect(event?.context).toEqual({
      status: "no_pin",
      ambiguous: false,
      document: { id: "DOC1", title: "T".repeat(300) },
    })
  })

  it("replays the editor context in chat_history, also after a daemon restart, without re-emitting an unchanged one", async () => {
    const first = createHarness()
    await first.agents.handleMessage(windowA, { type: "chat_open", session })
    const payload = { status: "no_pin", detected: contextWindow(), ambiguous: false }
    await prompt(first, toolText("prismic.get_editor_context", payload))
    first.agents.stopAll()

    const second = createHarness({ dataDir: first.dataDir })
    await second.agents.handleMessage(windowB, { type: "chat_open", session })
    const replayed = chatHistory(second.eventsFor(windowB)).filter((event) => event.type === "editor_context")
    expect(replayed).toHaveLength(1)
    expect(JSON.stringify(replayed)).not.toContain("document-content-secret")

    await prompt(second, toolText("prismic.get_editor_context", payload), windowB)
    expect(editorContextEvents(second.eventsFor(windowB))).toEqual([])
  })

  it("does not emit when the tool failed", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    await prompt(harness, toolText("prismic.get_editor_context", "Editor context is only available for a signed-in Prismic user."))

    expect(editorContextEvents(harness.events)).toEqual([])
  })
})
