import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { z } from "zod"

import { AgentIdSchema, HistoryEventSchema, conversationIdPattern } from "./protocol.ts"
import type { AgentId, ThreadSummary } from "./protocol.ts"
import { deriveTitle } from "./threadTitle.ts"

const maxFileAgeMs = 30 * 24 * 60 * 60 * 1000
const maxStoredFileBytes = 4 * 1024 * 1024
const indexFileName = "index.json"
const maxIndexFileBytes = 256 * 1024
const maxIndexEntries = 500
// Rebuilding the index parses transcripts: it looks at no more files than this.
const maxFilesScannedForIndex = 200
const maxListedThreads = 50

// Files and index entries written before there was more than one agent have no `agent`: they are Codex's.
const legacyAgent = "codex"

const StoredConversationSchema = z.object({
  version: z.literal(1),
  conversationId: z.string().max(36),
  agent: AgentIdSchema.default(legacyAgent),
  repository: z.string().max(200),
  acpSessionId: z.string().max(1000).optional(),
  pinnedDocumentId: z.string().max(300).optional(),
  title: z.string().max(200).optional(),
  updatedAt: z.number(),
  events: z.array(HistoryEventSchema).max(5000),
})

export type StoredConversation = z.infer<typeof StoredConversationSchema>

const IndexEntrySchema = z.object({
  conversationId: z.string().regex(conversationIdPattern),
  agent: AgentIdSchema.default(legacyAgent),
  repository: z.string().max(200),
  title: z.string().max(200),
  updatedAt: z.number(),
})

const IndexFileSchema = z.object({
  version: z.literal(1),
  entries: z.array(IndexEntrySchema).max(maxIndexEntries),
})

type IndexEntry = z.infer<typeof IndexEntrySchema>

export interface ConversationStore {
  load(conversationId: string): StoredConversation | undefined
  save(conversation: StoredConversation): void
  remove(conversationId: string): void
  // Threads of one repository and agent, newest first, from the index (no transcript is parsed).
  listThreads(repository: string, agent: AgentId): ThreadSummary[]
  // The repository and agent of an indexed thread, if the daemon knows it.
  threadOf(conversationId: string): { repository: string; agent: AgentId } | undefined
  pruneOldFiles(now: number): void
}

export function createConversationStore(args: { dataDir: string }): ConversationStore {
  const dir = join(args.dataDir, "conversations")
  const indexPath = join(dir, indexFileName)
  let index: Map<string, IndexEntry> | undefined

  function ensureDir(): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
  }

  function pathFor(conversationId: string): string {
    if (!conversationIdPattern.test(conversationId)) throw new Error("Invalid conversation id")
    return join(dir, `${conversationId}.json`)
  }

  function writeAtomically(path: string, content: string): void {
    ensureDir()
    const temporaryPath = `${path}.${process.pid}.tmp`
    writeFileSync(temporaryPath, content, { mode: 0o600 })
    renameSync(temporaryPath, path)
  }

  // Only a plain, reasonably small file is read: no symlink, FIFO or oversized file gets parsed.
  function readSmallFile(path: string, maxBytes: number, label: string): string | undefined {
    try {
      const info = lstatSync(path)
      if (!info.isFile() || info.size > maxBytes) {
        console.warn(`Ignoring ${label}: not a regular file or too large`)
        return undefined
      }
      return readFileSync(path, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`Ignoring unreadable ${label}`)
      return undefined
    }
  }

  function load(conversationId: string): StoredConversation | undefined {
    const raw = readSmallFile(pathFor(conversationId), maxStoredFileBytes, `conversation ${conversationId}`)
    if (raw === undefined) return undefined
    try {
      const stored = StoredConversationSchema.parse(JSON.parse(raw))
      if (stored.conversationId !== conversationId) throw new Error("conversation id mismatch")
      return stored
    } catch {
      console.warn(`Ignoring corrupt conversation file ${conversationId}.json; starting a fresh conversation`)
      return undefined
    }
  }

  function persistIndex(): void {
    if (index === undefined) return
    try {
      writeAtomically(indexPath, JSON.stringify({ version: 1, entries: [...index.values()] }))
    } catch (error) {
      console.warn(`Could not save the thread index: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function readIndexFile(): Map<string, IndexEntry> | undefined {
    const raw = readSmallFile(indexPath, maxIndexFileBytes, "thread index")
    if (raw === undefined) return undefined
    try {
      const parsed = IndexFileSchema.parse(JSON.parse(raw))
      return new Map(parsed.entries.map((entry) => [entry.conversationId, entry]))
    } catch {
      console.warn("Ignoring corrupt thread index; rebuilding it")
      return undefined
    }
  }

  // Bounded: at most 200 files, each loaded with the usual size and schema limits. Conversations saved before
  // titles existed get theirs from their first user message.
  function rebuildIndex(): Map<string, IndexEntry> {
    const rebuilt = new Map<string, IndexEntry>()
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      return rebuilt
    }
    const ids = names
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .filter((id) => conversationIdPattern.test(id))
      .slice(0, maxFilesScannedForIndex)
    for (const id of ids) {
      const stored = load(id)
      if (stored === undefined) continue
      const entry = entryFor(stored)
      if (entry !== undefined) rebuilt.set(id, entry)
    }
    return rebuilt
  }

  function ensureIndex(): Map<string, IndexEntry> {
    if (index !== undefined) return index
    const fromFile = readIndexFile()
    if (fromFile !== undefined) {
      index = fromFile
      return index
    }
    index = rebuildIndex()
    capEntries()
    if (index.size > 0 || existsSync(indexPath)) persistIndex()
    return index
  }

  function capEntries(): void {
    if (index === undefined || index.size <= maxIndexEntries) return
    const newestFirst = [...index.values()].sort((a, b) => b.updatedAt - a.updatedAt)
    index = new Map(newestFirst.slice(0, maxIndexEntries).map((entry) => [entry.conversationId, entry]))
  }

  function entryFor(conversation: StoredConversation): IndexEntry | undefined {
    const firstUserMessage = conversation.events.find((event) => event.type === "user_message")
    const title = conversation.title ?? (firstUserMessage?.type === "user_message" ? deriveTitle(firstUserMessage.text) : undefined)
    // Without a user message there is nothing to resume: empty chats are never listed.
    if (title === undefined) return undefined
    return {
      conversationId: conversation.conversationId,
      agent: conversation.agent,
      repository: conversation.repository,
      title,
      updatedAt: conversation.updatedAt,
    }
  }

  function updateIndex(conversation: StoredConversation): void {
    const entries = ensureIndex()
    const entry = entryFor(conversation)
    if (entry === undefined) return
    const existing = entries.get(entry.conversationId)
    if (
      existing?.title === entry.title &&
      existing.agent === entry.agent &&
      existing.repository === entry.repository &&
      existing.updatedAt === entry.updatedAt
    ) {
      return
    }
    entries.set(entry.conversationId, entry)
    capEntries()
    persistIndex()
  }

  return {
    load,
    save(conversation) {
      writeAtomically(pathFor(conversation.conversationId), JSON.stringify(conversation))
      updateIndex(conversation)
    },
    remove(conversationId) {
      rmSync(pathFor(conversationId), { force: true })
      const entries = ensureIndex()
      if (entries.delete(conversationId)) persistIndex()
    },
    listThreads(repository, agent) {
      const entries = ensureIndex()
      const newestFirst = [...entries.values()]
        .filter((entry) => entry.repository === repository && entry.agent === agent)
        .sort((a, b) => b.updatedAt - a.updatedAt)
      const threads: ThreadSummary[] = []
      let dropped = false
      for (const entry of newestFirst) {
        if (threads.length >= maxListedThreads) break
        // A file removed behind our back leaves a dangling entry: drop it.
        if (!existsSync(pathFor(entry.conversationId))) {
          entries.delete(entry.conversationId)
          dropped = true
          continue
        }
        threads.push({ conversationId: entry.conversationId, title: entry.title, updatedAt: entry.updatedAt })
      }
      if (dropped) persistIndex()
      return threads
    },
    threadOf(conversationId) {
      const entry = ensureIndex().get(conversationId)
      return entry === undefined ? undefined : { repository: entry.repository, agent: entry.agent }
    },
    pruneOldFiles(now) {
      let names: string[]
      try {
        names = readdirSync(dir)
      } catch {
        return
      }
      for (const name of names) {
        if (name === indexFileName) continue
        const path = join(dir, name)
        try {
          if (now - statSync(path).mtimeMs > maxFileAgeMs) rmSync(path, { force: true })
        } catch (error) {
          console.warn(`Could not prune ${name}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      const entries = ensureIndex()
      let dropped = false
      for (const id of [...entries.keys()]) {
        if (!existsSync(pathFor(id))) {
          entries.delete(id)
          dropped = true
        }
      }
      if (dropped) persistIndex()
    },
  }
}
