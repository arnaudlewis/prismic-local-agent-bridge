import type { HistoryEvent } from "./protocol.ts"

export const maxTranscriptEvents = 3000
export const maxTranscriptBytes = 2 * 1024 * 1024

interface TranscriptLimits {
  maxEvents: number
  maxBytes: number
}

interface CreateTranscriptArgs {
  events?: HistoryEvent[]
  limits?: TranscriptLimits
}

export interface Transcript {
  events(): HistoryEvent[]
  append(event: HistoryEvent): void
  clear(): void
  unresolvedPermissionIds(): string[]
}

export function createTranscript(args: CreateTranscriptArgs = {}): Transcript {
  const limits = args.limits ?? { maxEvents: maxTranscriptEvents, maxBytes: maxTranscriptBytes }
  let events: HistoryEvent[] = []
  let sizes: number[] = []
  let totalBytes = 0
  const unresolved = new Set<string>()

  function append(event: HistoryEvent): void {
    const last = events.at(-1)
    if (event.type === "agent_message_chunk" && last?.type === "agent_message_chunk" && last.messageId === event.messageId) {
      const merged: HistoryEvent = { ...last, text: last.text + event.text }
      replaceLast(merged)
    } else {
      push(event)
    }
    if (event.type === "permission_request") unresolved.add(event.requestId)
    if (event.type === "permission_resolved") unresolved.delete(event.requestId)
    enforceLimits()
  }

  function push(event: HistoryEvent): void {
    const size = JSON.stringify(event).length
    events.push(event)
    sizes.push(size)
    totalBytes += size
  }

  function replaceLast(event: HistoryEvent): void {
    const size = JSON.stringify(event).length
    totalBytes += size - (sizes.at(-1) ?? 0)
    events[events.length - 1] = event
    sizes[sizes.length - 1] = size
  }

  function isPinned(event: HistoryEvent): boolean {
    return event.type === "permission_request" && unresolved.has(event.requestId)
  }

  // Drops the oldest whole events, but never a permission request the agent is still waiting on, nor the latest event.
  function enforceLimits(): void {
    if (events.length <= limits.maxEvents && totalBytes <= limits.maxBytes) return
    const keptEvents: HistoryEvent[] = []
    const keptSizes: number[] = []
    let remainingEvents = events.length
    let remainingBytes = totalBytes
    events.forEach((event, index) => {
      const size = sizes[index] ?? 0
      const overLimit = remainingEvents > limits.maxEvents || remainingBytes > limits.maxBytes
      const isLatest = index === events.length - 1
      if (overLimit && !isLatest && !isPinned(event)) {
        remainingEvents -= 1
        remainingBytes -= size
        return
      }
      keptEvents.push(event)
      keptSizes.push(size)
    })
    events = keptEvents
    sizes = keptSizes
    totalBytes = remainingBytes
  }

  for (const event of args.events ?? []) append(event)

  return {
    events: () => [...events],
    append,
    clear() {
      events = []
      sizes = []
      totalBytes = 0
      unresolved.clear()
    },
    unresolvedPermissionIds: () => [...unresolved],
  }
}
