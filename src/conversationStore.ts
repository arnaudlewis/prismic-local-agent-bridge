import {
  chmodSync,
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

import { HistoryEventSchema, conversationIdPattern } from "./protocol.ts"

const maxFileAgeMs = 30 * 24 * 60 * 60 * 1000

const maxStoredFileBytes = 4 * 1024 * 1024

const StoredConversationSchema = z.object({
  version: z.literal(1),
  conversationId: z.string().max(36),
  repository: z.string().max(200),
  acpSessionId: z.string().max(1000).optional(),
  pinnedDocumentId: z.string().max(300).optional(),
  updatedAt: z.number(),
  events: z.array(HistoryEventSchema).max(5000),
})

export type StoredConversation = z.infer<typeof StoredConversationSchema>

export interface ConversationStore {
  load(conversationId: string): StoredConversation | undefined
  save(conversation: StoredConversation): void
  remove(conversationId: string): void
  pruneOldFiles(now: number): void
}

export function createConversationStore(args: { dataDir: string }): ConversationStore {
  const dir = join(args.dataDir, "conversations")

  function ensureDir(): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
  }

  function pathFor(conversationId: string): string {
    if (!conversationIdPattern.test(conversationId)) throw new Error("Invalid conversation id")
    return join(dir, `${conversationId}.json`)
  }

  return {
    load(conversationId) {
      const path = pathFor(conversationId)
      let raw: string
      try {
        // Only a plain, reasonably small file is read: no symlink, FIFO or oversized file gets parsed.
        const info = lstatSync(path)
        if (!info.isFile() || info.size > maxStoredFileBytes) {
          console.warn(`Ignoring conversation ${conversationId}: not a regular file or too large`)
          return undefined
        }
        raw = readFileSync(path, "utf8")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          console.warn(`Ignoring unreadable conversation ${conversationId}`)
        }
        return undefined
      }
      try {
        const stored = StoredConversationSchema.parse(JSON.parse(raw))
        if (stored.conversationId !== conversationId) throw new Error("conversation id mismatch")
        return stored
      } catch {
        console.warn(`Ignoring corrupt conversation file ${conversationId}.json; starting a fresh conversation`)
        return undefined
      }
    },
    save(conversation) {
      ensureDir()
      const path = pathFor(conversation.conversationId)
      const temporaryPath = `${path}.${process.pid}.tmp`
      writeFileSync(temporaryPath, JSON.stringify(conversation), { mode: 0o600 })
      renameSync(temporaryPath, path)
    },
    remove(conversationId) {
      rmSync(pathFor(conversationId), { force: true })
    },
    pruneOldFiles(now) {
      let names: string[]
      try {
        names = readdirSync(dir)
      } catch {
        return
      }
      for (const name of names) {
        const path = join(dir, name)
        try {
          if (now - statSync(path).mtimeMs > maxFileAgeMs) rmSync(path, { force: true })
        } catch (error) {
          console.warn(`Could not prune ${name}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    },
  }
}
