import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

import { conversationId, session, createHarness, windowA, windowB, chatHistory, agentText, liveAgentText, conversationFile, conversationIdFor, sessionFor, windowFor, openAndPrompt, openScope, writeStored, threadEvents, lastThreads, indexFile, readIndex, pause } from "../testing/harness.ts"
import type { Harness } from "../testing/harness.ts"

describe("thread list", () => {
  async function list(harness: Harness, repository = "repo", target = windowA) {
    await openScope(harness, target, repository)
    await harness.agents.handleMessage(target, { type: "threads_list", repository, agent: "codex" })
    return lastThreads(harness.eventsFor(target))
  }

  it("answers threads_list directly with { type: 'threads', threads: [{ conversationId, title, updatedAt }] }", async () => {
    const harness = createHarness()
    writeStored(harness.dataDir, conversationIdFor(1), { title: "First", updatedAt: 1000 })
    await openScope(harness, windowA)

    await harness.agents.handleMessage(windowA, { type: "threads_list", repository: "repo", agent: "codex" })

    expect(harness.eventsFor(windowA)).toEqual([
      { type: "threads", threads: [{ conversationId: conversationIdFor(1), title: "First", updatedAt: 1000 }] },
    ])
  })

  it("sorts by updatedAt, newest first, and lists at most 50", async () => {
    const harness = createHarness()
    for (let index = 0; index < 60; index++) {
      writeStored(harness.dataDir, conversationIdFor(index), { title: `Thread ${index}`, updatedAt: 1000 + index })
    }

    const threads = await list(harness)

    expect(threads).toHaveLength(50)
    expect(threads?.[0]).toEqual({ conversationId: conversationIdFor(59), title: "Thread 59", updatedAt: 1059 })
    expect(threads?.map((thread) => thread.updatedAt)).toEqual(Array.from({ length: 50 }, (_, index) => 1059 - index))
  })

  it("only lists the conversations of the requested repository", async () => {
    const harness = createHarness()
    writeStored(harness.dataDir, conversationIdFor(1), { repository: "repo", title: "Mine", updatedAt: 1 })
    writeStored(harness.dataDir, conversationIdFor(2), { repository: "other", title: "Theirs", updatedAt: 2 })

    expect((await list(harness, "repo"))?.map((thread) => thread.title)).toEqual(["Mine"])
    expect((await list(harness, "other"))?.map((thread) => thread.title)).toEqual(["Theirs"])
    expect(await list(harness, "nobody")).toEqual([])
  })

  it("never lists an empty chat", async () => {
    const harness = createHarness()
    writeStored(harness.dataDir, conversationIdFor(1), { title: "Real", updatedAt: 1 })
    writeStored(harness.dataDir, conversationIdFor(2), {
      updatedAt: 2,
      events: [{ type: "notice", tone: "error", text: "Couldn't start the local agent" }],
    })
    await harness.agents.handleMessage(windowB, { type: "chat_open", session: sessionFor(3) })

    expect((await list(harness))?.map((thread) => thread.title)).toEqual(["Real"])
  })

  it("derives the title from the first message and keeps it", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })

    await harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "  Shorten\n the   hero title  ", session })
    await harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "and now something else", session })

    const threads = await list(harness)
    expect(threads?.map((thread) => thread.title)).toEqual(["Shorten the hero title"])
    const stored = JSON.parse(readFileSync(conversationFile(harness), "utf8")) as { title?: string; updatedAt: number }
    expect(stored.title).toBe("Shorten the hero title")
    expect(threads?.[0]?.updatedAt).toBe(stored.updatedAt)
  })

  it("titles an old conversation without a stored title from its first user message", async () => {
    const harness = createHarness()
    writeStored(harness.dataDir, conversationIdFor(1), {
      updatedAt: 5,
      events: [{ type: "agent_message_chunk", text: "hi" }, { type: "user_message", text: "Old question\nabout slices" }],
    })

    expect((await list(harness))?.map((thread) => thread.title)).toEqual(["Old question about slices"])
  })

  it("orders live conversations by their last activity", async () => {
    const harness = createHarness()
    await openAndPrompt(harness, 1, "first thread")
    await pause(5)
    await openAndPrompt(harness, 2, "second thread")
    await pause(5)

    expect((await list(harness, "repo", windowFor(2)))?.map((thread) => thread.title)).toEqual(["second thread", "first thread"])

    await pause(5)
    await harness.agents.handleMessage(windowFor(1), { type: "chat_prompt", text: "more", session: sessionFor(1) })

    expect((await list(harness, "repo", windowFor(2)))?.map((thread) => thread.title)).toEqual(["first thread", "second thread"])
  })
})

describe("thread index", () => {
  async function list(harness: Harness) {
    await openScope(harness, windowA)
    await harness.agents.handleMessage(windowA, { type: "threads_list", repository: "repo", agent: "codex" })
    return lastThreads(harness.eventsFor(windowA))
  }

  it("is rebuilt from the conversation files when missing, then written privately", async () => {
    const harness = createHarness()
    writeStored(harness.dataDir, conversationIdFor(1), { title: "One", updatedAt: 1 })
    writeStored(harness.dataDir, conversationIdFor(2), { title: "Two", updatedAt: 2 })
    expect(existsSync(indexFile(harness.dataDir))).toBe(false)

    expect((await list(harness))?.map((thread) => thread.title)).toEqual(["Two", "One"])

    expect(statSync(indexFile(harness.dataDir)).mode & 0o777).toBe(0o600)
    expect(readIndex(harness.dataDir)).toEqual({
      version: 1,
      entries: expect.arrayContaining([
        { conversationId: conversationIdFor(1), agent: "codex", repository: "repo", title: "One", updatedAt: 1 },
        { conversationId: conversationIdFor(2), agent: "codex", repository: "repo", title: "Two", updatedAt: 2 },
      ]),
    })
  })

  it("is rebuilt when corrupt, with a warning that doesn't print its content", async () => {
    const harness = createHarness()
    writeStored(harness.dataDir, conversationIdFor(1), { title: "One", updatedAt: 1 })
    writeFileSync(indexFile(harness.dataDir), '{"version":1,"entries":"SECRET-CONTENT"}')
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    expect((await list(harness))?.map((thread) => thread.title)).toEqual(["One"])

    expect(warn).toHaveBeenCalled()
    expect(warn.mock.calls.flat().join(" ")).not.toContain("SECRET-CONTENT")
    warn.mockRestore()
    expect(readIndex(harness.dataDir).entries).toHaveLength(1)
  })

  it("is not parsed when too large or not a regular file, and is rebuilt instead", async () => {
    const harness = createHarness()
    writeStored(harness.dataDir, conversationIdFor(1), { title: "One", updatedAt: 1 })
    writeFileSync(indexFile(harness.dataDir), " ".repeat(300 * 1024))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    expect((await list(harness))?.map((thread) => thread.title)).toEqual(["One"])
    warn.mockRestore()
  })

  it("is rebuilt from at most 200 files", async () => {
    const harness = createHarness()
    for (let index = 0; index < 250; index++) {
      writeStored(harness.dataDir, conversationIdFor(index), { title: `T${index}`, updatedAt: index })
    }

    const threads = await list(harness)

    expect(threads).toHaveLength(50)
    expect(readIndex(harness.dataDir).entries.length).toBeLessThanOrEqual(200)
  })

  it("is not rebuilt when it is fine, and its entries are trusted for listing", async () => {
    const harness = createHarness()
    writeStored(harness.dataDir, conversationIdFor(1), { title: "From file", updatedAt: 1 })
    writeFileSync(
      indexFile(harness.dataDir),
      JSON.stringify({
        version: 1,
        entries: [{ conversationId: conversationIdFor(1), repository: "repo", title: "From index", updatedAt: 9 }],
      }),
    )

    expect(await list(harness)).toEqual([{ conversationId: conversationIdFor(1), title: "From index", updatedAt: 9 }])
  })

  it("drops entries whose file vanished", async () => {
    const harness = createHarness()
    writeStored(harness.dataDir, conversationIdFor(1), { title: "Stays", updatedAt: 1 })
    writeStored(harness.dataDir, conversationIdFor(2), { title: "Vanishes", updatedAt: 2 })
    await list(harness)
    rmSync(join(harness.dataDir, "conversations", `${conversationIdFor(2)}.json`))

    expect((await list(harness))?.map((thread) => thread.title)).toEqual(["Stays"])
    expect(readIndex(harness.dataDir).entries.map((entry) => entry.title)).toEqual(["Stays"])
  })

  it("is updated when a conversation is saved and deleted", async () => {
    const harness = createHarness()
    await openAndPrompt(harness, 1, "hello index")
    await vi.waitFor(() => expect(readIndex(harness.dataDir).entries.map((entry) => entry.title)).toEqual(["hello index"]))

    await harness.agents.handleMessage(windowFor(1), { type: "chat_delete", conversationId: conversationIdFor(1) })

    expect(readIndex(harness.dataDir).entries).toEqual([])
  })

  it("is pruned together with the old files at startup, and is not pruned itself for being old", async () => {
    const harness = createHarness()
    writeStored(harness.dataDir, conversationIdFor(1), { title: "Old", updatedAt: 1 })
    writeStored(harness.dataDir, conversationIdFor(2), { title: "Recent", updatedAt: 2 })
    await list(harness)
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
    utimesSync(join(harness.dataDir, "conversations", `${conversationIdFor(1)}.json`), old, old)
    utimesSync(indexFile(harness.dataDir), old, old)

    const restarted = createHarness({ dataDir: harness.dataDir })

    expect(existsSync(join(harness.dataDir, "conversations", `${conversationIdFor(1)}.json`))).toBe(false)
    expect(readIndex(harness.dataDir).entries.map((entry) => entry.title)).toEqual(["Recent"])
    await openScope(restarted, windowA)
    await restarted.agents.handleMessage(windowA, { type: "threads_list", repository: "repo", agent: "codex" })
    expect(lastThreads(restarted.eventsFor(windowA))?.map((thread) => thread.title)).toEqual(["Recent"])
  })
})

describe("thread list pushes", () => {
  it("pushes the list after the first user message and again after turn_end", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    harness.eventsFor(windowA).length = 0

    await harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "hello there", session })

    const events = harness.eventsFor(windowA)
    const kinds = events.map((event) => event.type)
    const pushes = threadEvents(events)
    expect(pushes).toHaveLength(2)
    expect(pushes[0]).toEqual([{ conversationId, title: "hello there", updatedAt: expect.any(Number) }])
    expect(kinds.indexOf("threads")).toBeLessThan(kinds.indexOf("turn_end"))
    expect(kinds.lastIndexOf("threads")).toBeGreaterThan(kinds.indexOf("turn_end"))
    expect(pushes[1]?.[0]?.updatedAt).toBeGreaterThanOrEqual(pushes[0]?.[0]?.updatedAt ?? 0)
  })

  it("pushes nothing for later user messages before their turn ends, and nothing for an untitled chat", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })

    expect(threadEvents(harness.eventsFor(windowA))).toEqual([])
    await harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "/status", session })
    harness.eventsFor(windowA).length = 0
    await harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "second", session })

    const kinds = harness.eventsFor(windowA).map((event) => event.type)
    expect(threadEvents(harness.eventsFor(windowA))).toHaveLength(1)
    expect(kinds.indexOf("threads")).toBeGreaterThan(kinds.indexOf("turn_end"))
  })

  it("refreshes updatedAt in the pushed list after each turn", async () => {
    const harness = createHarness()
    await openAndPrompt(harness, 1, "one")
    const first = lastThreads(harness.eventsFor(windowFor(1)))?.[0]?.updatedAt ?? 0
    await pause(5)

    await harness.agents.handleMessage(windowFor(1), { type: "chat_prompt", text: "two", session: sessionFor(1) })

    expect(lastThreads(harness.eventsFor(windowFor(1)))?.[0]?.updatedAt).toBeGreaterThan(first)
  })

  it("does not push to a window that no conversation is attached to", async () => {
    const harness = createHarness()
    await openAndPrompt(harness, 1, "one")
    harness.agents.detachWindow(windowFor(1))
    const before = harness.eventsFor(windowFor(1)).length

    await harness.agents.handleMessage(windowFor(2), { type: "threads_list", repository: "repo", agent: "codex" })

    expect(harness.eventsFor(windowFor(1))).toHaveLength(before)
  })
})

describe("chat_delete", () => {
  it("stops the running agent, removes the file and index entry, detaches the window and answers with the new list", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    const turn = harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "hold on", session })
    await vi.waitFor(() => expect(liveAgentText(harness.eventsFor(windowA))).toContain("working"))
    await vi.waitFor(() => expect(existsSync(conversationFile(harness))).toBe(true))
    harness.eventsFor(windowA).length = 0

    await harness.agents.handleMessage(windowA, { type: "chat_delete", conversationId })

    // The turn of the stopped agent is over: nothing is left running.
    await turn
    expect(harness.eventsFor(windowA)).toEqual([{ type: "threads", threads: [] }])
    expect(existsSync(conversationFile(harness))).toBe(false)
    expect(readIndex(harness.dataDir).entries).toEqual([])
    await pause(700)
    expect(existsSync(conversationFile(harness))).toBe(false)

    // The window is detached: its messages no longer reach the deleted conversation.
    harness.eventsFor(windowA).length = 0
    await harness.agents.handleMessage(windowA, { type: "set_config_option", configId: "mode", value: "agent" })
    expect(harness.eventsFor(windowA)).toEqual([
      { type: "notice", tone: "info", text: "The local agent isn't running yet." },
    ])
  })

  it("lets the same id start again from scratch", async () => {
    const harness = createHarness()
    await openAndPrompt(harness, 1, "old")
    await harness.agents.handleMessage(windowFor(1), { type: "chat_delete", conversationId: conversationIdFor(1) })

    await harness.agents.handleMessage(windowFor(1), { type: "chat_open", session: sessionFor(1) })

    expect(chatHistory(harness.eventsFor(windowFor(1))).at(-1)).toBeUndefined()
    expect(lastThreads(harness.eventsFor(windowFor(1)))).toEqual([])
  })

  it("deletes a stored thread that is not running, by id", async () => {
    const harness = createHarness()
    writeStored(harness.dataDir, conversationIdFor(1), { title: "Stored", updatedAt: 1 })
    writeStored(harness.dataDir, conversationIdFor(2), { title: "Kept", updatedAt: 2 })
    await openScope(harness, windowA)

    await harness.agents.handleMessage(windowA, { type: "chat_delete", conversationId: conversationIdFor(1) })

    expect(lastThreads(harness.eventsFor(windowA))?.map((thread) => thread.title)).toEqual(["Kept"])
    expect(existsSync(join(harness.dataDir, "conversations", `${conversationIdFor(1)}.json`))).toBe(false)
    expect(existsSync(join(harness.dataDir, "conversations", `${conversationIdFor(2)}.json`))).toBe(true)
  })

  it("keeps the window on its own thread when another thread is deleted", async () => {
    const harness = createHarness()
    await openAndPrompt(harness, 1, "mine")
    await openAndPrompt(harness, 2, "other")
    harness.agents.detachWindow(windowFor(2))

    await harness.agents.handleMessage(windowFor(1), { type: "chat_delete", conversationId: conversationIdFor(2) })

    expect(lastThreads(harness.eventsFor(windowFor(1)))?.map((thread) => thread.title)).toEqual(["mine"])
    harness.eventsFor(windowFor(1)).length = 0
    await harness.agents.handleMessage(windowFor(1), { type: "chat_prompt", text: "still here", session: sessionFor(1) })
    expect(liveAgentText(harness.eventsFor(windowFor(1)))).toContain("prompt:still here")
  })

  it("answers an unknown id with the current list and changes nothing", async () => {
    const harness = createHarness()
    writeStored(harness.dataDir, conversationIdFor(1), { title: "Known", updatedAt: 1 })
    await openScope(harness, windowA)
    await harness.agents.handleMessage(windowA, { type: "threads_list", repository: "repo", agent: "codex" })
    harness.eventsFor(windowA).length = 0

    await harness.agents.handleMessage(windowA, { type: "chat_delete", conversationId: conversationIdFor(99) })

    expect(harness.eventsFor(windowA)).toEqual([
      { type: "threads", threads: [{ conversationId: conversationIdFor(1), title: "Known", updatedAt: 1 }] },
    ])
    expect(existsSync(join(harness.dataDir, "conversations", `${conversationIdFor(1)}.json`))).toBe(true)
  })

  it("does not delete a file the daemon doesn't know (not running, not in the index)", async () => {
    const harness = createHarness()
    writeStored(harness.dataDir, conversationIdFor(5), {
      updatedAt: 1,
      events: [{ type: "notice", tone: "info", text: "no user message, so never indexed" }],
    })

    await harness.agents.handleMessage(windowA, { type: "chat_delete", conversationId: conversationIdFor(5) })

    expect(existsSync(join(harness.dataDir, "conversations", `${conversationIdFor(5)}.json`))).toBe(true)
  })

  it("writes nothing for a deleted conversation afterwards, even if its agent keeps talking", async () => {
    const logFile = join(mkdtempSync(join(tmpdir(), "bridge-del-")), "late.log")
    process.env.FAKE_AGENT_LOG = logFile
    try {
      const harness = createHarness()
      await harness.agents.handleMessage(windowA, { type: "chat_open", session })
      void harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "late-output", session })
      await vi.waitFor(() => expect(harness.eventsFor(windowA).some((event) => event.type === "chat_status" && event.status === "running")).toBe(true))

      await harness.agents.handleMessage(windowA, { type: "chat_delete", conversationId })
      await vi.waitFor(() => expect(existsSync(logFile)).toBe(true), { timeout: 4000 })
      await pause(700)

      expect(readFileSync(logFile, "utf8")).toContain("late-permission:cancelled")
      expect(existsSync(conversationFile(harness))).toBe(false)
      expect(readIndex(harness.dataDir).entries).toEqual([])
    } finally {
      delete process.env.FAKE_AGENT_LOG
    }
  })
})

describe("switching threads", () => {
  it("detaches the previous conversation from the window: its events no longer reach it", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session: sessionFor(1) })
    const turn = harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "hold on", session: sessionFor(1) })
    await vi.waitFor(() => expect(liveAgentText(harness.eventsFor(windowA))).toContain("working"))

    await harness.agents.handleMessage(windowA, { type: "chat_open", session: sessionFor(2) })
    harness.eventsFor(windowA).length = 0
    // Thread 1 is still running, now detached: finish it from another window.
    await harness.agents.handleMessage(windowB, { type: "chat_open", session: sessionFor(1) })
    await harness.agents.handleMessage(windowB, { type: "chat_cancel" })
    await turn

    expect(harness.eventsFor(windowA)).toEqual([])
    expect(harness.eventsFor(windowB)).toContainEqual({ type: "turn_end", stopReason: "cancelled" })
  })

  it("keeps recording what a detached thread's agent does, and replays it when it is opened again", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session: sessionFor(1) })
    void harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "late-output", session: sessionFor(1) })
    await vi.waitFor(() => expect(harness.eventsFor(windowA).some((event) => event.type === "chat_status" && event.status === "running")).toBe(true))

    await harness.agents.handleMessage(windowA, { type: "chat_open", session: sessionFor(2) })
    const sentAfterSwitch = harness.eventsFor(windowA).length
    await pause(600)

    expect(harness.eventsFor(windowA)).toHaveLength(sentAfterSwitch)
    expect(liveAgentText(harness.eventsFor(windowA))).not.toContain("late-text")

    await harness.agents.handleMessage(windowA, { type: "chat_open", session: sessionFor(1) })
    const history = chatHistory(harness.eventsFor(windowA))
    expect(agentText(history)).toContain("late-text")
    expect(history.some((event) => event.type === "permission_request")).toBe(true)
  })

  it("shows the right history for each thread when switching in one window", async () => {
    const harness = createHarness()
    await openAndPrompt(harness, 1, "about thread one")
    await openAndPrompt(harness, 2, "about thread two")
    await harness.agents.handleMessage(windowFor(1), { type: "chat_open", session: sessionFor(1) })
    const first = chatHistory(harness.eventsFor(windowFor(1)))
    await harness.agents.handleMessage(windowFor(1), { type: "chat_open", session: sessionFor(2) })
    const second = chatHistory(harness.eventsFor(windowFor(1)))

    expect(first[0]).toEqual({ type: "user_message", text: "about thread one" })
    expect(second[0]).toEqual({ type: "user_message", text: "about thread two" })
  })

  it("lets two windows show different threads, each getting only its own events", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowFor(1), { type: "chat_open", session: sessionFor(1) })
    await harness.agents.handleMessage(windowFor(2), { type: "chat_open", session: sessionFor(2) })

    await harness.agents.handleMessage(windowFor(1), { type: "chat_prompt", text: "for one", session: sessionFor(1) })
    await harness.agents.handleMessage(windowFor(2), { type: "chat_prompt", text: "for two", session: sessionFor(2) })

    expect(liveAgentText(harness.eventsFor(windowFor(1)))).toContain("prompt:for one")
    expect(liveAgentText(harness.eventsFor(windowFor(1)))).not.toContain("for two")
    expect(liveAgentText(harness.eventsFor(windowFor(2)))).toContain("prompt:for two")
    expect(liveAgentText(harness.eventsFor(windowFor(2)))).not.toContain("for one")
    await harness.agents.handleMessage(windowFor(1), { type: "threads_list", repository: "repo", agent: "codex" })
    expect(lastThreads(harness.eventsFor(windowFor(1)))?.map((thread) => thread.title).sort()).toEqual(["for one", "for two"])
  })

  it("isolates the mode and config per conversation", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session: sessionFor(1) })
    await harness.agents.handleMessage(windowA, { type: "set_config_option", configId: "mode", value: "agent" })

    await harness.agents.handleMessage(windowA, { type: "chat_open", session: sessionFor(2), preferredConfig: { mode: "agent-full-access" } })

    expect(harness.lastMode()?.currentValue).toBe("read-only")
  })
})

describe("thread list scope", () => {
  async function ask(harness: Harness, target: string, repository: string) {
    harness.eventsFor(target).length = 0
    await harness.agents.handleMessage(target, { type: "threads_list", repository, agent: "codex" })
    return lastThreads(harness.eventsFor(target))
  }

  function seed(harness: Harness): void {
    writeStored(harness.dataDir, conversationIdFor(1), { repository: "repo", title: "Mine", updatedAt: 2 })
    writeStored(harness.dataDir, conversationIdFor(2), { repository: "other", title: "Secret of another repository", updatedAt: 1 })
  }

  it("answers an empty list to a window that never sent a session", async () => {
    const harness = createHarness()
    seed(harness)

    expect(await ask(harness, windowA, "repo")).toEqual([])
    expect(await ask(harness, windowA, "other")).toEqual([])
  })

  it("lists the repository of the window's session, and nothing for another one", async () => {
    const harness = createHarness()
    seed(harness)
    await openScope(harness, windowA, "repo")

    expect((await ask(harness, windowA, "repo"))?.map((thread) => thread.title)).toEqual(["Mine"])
    expect(await ask(harness, windowA, "other")).toEqual([])
    expect(JSON.stringify(harness.eventsFor(windowA))).not.toContain("Secret of another repository")
  })

  it("always answers with a threads event, even when it is empty", async () => {
    const harness = createHarness()
    seed(harness)

    await harness.agents.handleMessage(windowA, { type: "threads_list", repository: "other", agent: "codex" })

    expect(harness.eventsFor(windowA)).toEqual([{ type: "threads", threads: [] }])
  })

  it("follows the window's last accepted session", async () => {
    const harness = createHarness()
    seed(harness)
    await openScope(harness, windowA, "repo")
    expect((await ask(harness, windowA, "other"))).toEqual([])

    await openScope(harness, windowA, "other")

    expect((await ask(harness, windowA, "other"))?.map((thread) => thread.title)).toEqual(["Secret of another repository"])
    expect(await ask(harness, windowA, "repo")).toEqual([])
  })

  it("is set by chat_prompt as well, not by threads_list itself", async () => {
    const harness = createHarness()
    seed(harness)
    await harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "hi", session: { ...sessionFor(5), repository: "other" } })

    expect((await ask(harness, windowA, "other"))?.map((thread) => thread.title).sort()).toEqual(["Secret of another repository", "hi"])
    // Asking for a repository doesn't give the window access to it.
    expect(await ask(harness, windowB, "other")).toEqual([])
    expect(await ask(harness, windowB, "other")).toEqual([])
  })

  it("is forgotten when the window closes", async () => {
    const harness = createHarness()
    seed(harness)
    await openScope(harness, windowA, "repo")
    expect(await ask(harness, windowA, "repo")).not.toEqual([])

    harness.agents.detachWindow(windowA)

    expect(await ask(harness, windowA, "repo")).toEqual([])
  })

  it("is not set by a session that was refused", async () => {
    const harness = createHarness()
    seed(harness)
    await openScope(harness, windowB, "repo")
    // Conversation 990 already belongs to codex: a session claiming another agent is refused before it is accepted.
    await expect(
      harness.agents.handleMessage(windowA, {
        type: "chat_open",
        session: { ...session, conversationId: conversationIdFor(990), agent: "other" as never, repository: "other" },
      }),
    ).rejects.toThrow("This conversation belongs to another agent")

    expect(await ask(harness, windowA, "other")).toEqual([])
  })

  it("answers chat_delete with the window's own list, never another repository's", async () => {
    const harness = createHarness()
    seed(harness)
    await openScope(harness, windowA, "repo")
    harness.eventsFor(windowA).length = 0

    await harness.agents.handleMessage(windowA, { type: "chat_delete", conversationId: conversationIdFor(2) })

    expect(harness.eventsFor(windowA)).toEqual([
      { type: "threads", threads: [{ conversationId: conversationIdFor(1), title: "Mine", updatedAt: 2 }] },
    ])
    expect(JSON.stringify(harness.eventsFor(windowA))).not.toContain("Secret of another repository")
  })

  it("answers chat_delete from a window without a session with an empty list", async () => {
    const harness = createHarness()
    seed(harness)

    await harness.agents.handleMessage(windowA, { type: "chat_delete", conversationId: conversationIdFor(99) })

    expect(harness.eventsFor(windowA)).toEqual([{ type: "threads", threads: [] }])
  })

  it("keeps pushing the window's own list after its turns", async () => {
    const harness = createHarness()
    seed(harness)
    await openAndPrompt(harness, 3, "mine too")

    expect(lastThreads(harness.eventsFor(windowFor(3)))?.map((thread) => thread.title).sort()).toEqual(["Mine", "mine too"])
  })
})
