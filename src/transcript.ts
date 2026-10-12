import type { HistoryEvent } from "./protocol.ts"

export const maxTranscriptEvents = 3000
export const maxTranscriptBytes = 2 * 1024 * 1024
// A single event can't take a meaningful part of the log, and what is stored must stay loadable.
export const maxEventTextLength = 100_000
export const maxEventIdLength = 1000
export const maxPermissionOptions = 20
const truncationMarker = "…[truncated]"

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

  function append(rawEvent: HistoryEvent): void {
    const event = boundEvent(rawEvent)
    const last = events.at(-1)
    if (event.type === "agent_message_chunk" && last?.type === "agent_message_chunk" && last.messageId === event.messageId) {
      // Once truncated, the rest of the message is dropped: nothing more can be added.
      if (!last.text.endsWith(truncationMarker) || last.text.length < maxEventTextLength) {
        replaceLast({ ...last, text: truncateText(last.text + event.text) })
      }
    } else {
      push(event)
    }
    if (event.type === "permission_request") unresolved.add(event.requestId)
    if (event.type === "permission_resolved") unresolved.delete(event.requestId)
    enforceLimits()
  }

  function push(event: HistoryEvent): void {
    const size = byteSize(event)
    events.push(event)
    sizes.push(size)
    totalBytes += size
  }

  function replaceLast(event: HistoryEvent): void {
    const size = byteSize(event)
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

function byteSize(event: HistoryEvent): number {
  return Buffer.byteLength(JSON.stringify(event))
}

function truncateText(text: string, maxLength = maxEventTextLength): string {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength - truncationMarker.length) + truncationMarker
}

function boundId(id: string): string {
  return id.slice(0, maxEventIdLength)
}

// Keeps every field within the bounds the stored-conversation schema enforces on load.
function boundEvent(event: HistoryEvent): HistoryEvent {
  switch (event.type) {
    case "user_message":
    case "notice":
      return { ...event, text: truncateText(event.text) }
    case "agent_message_chunk":
      return {
        ...event,
        text: truncateText(event.text),
        ...(event.messageId === undefined ? {} : { messageId: boundId(event.messageId) }),
      }
    case "tool_call":
      return { ...event, toolCallId: boundId(event.toolCallId), title: truncateText(event.title) }
    case "tool_call_update":
      return {
        ...event,
        toolCallId: boundId(event.toolCallId),
        ...(event.title === undefined ? {} : { title: truncateText(event.title) }),
      }
    case "permission_request":
      return {
        ...event,
        title: truncateText(event.title),
        options: event.options.slice(0, maxPermissionOptions).map((option) => ({
          optionId: boundId(option.optionId),
          name: boundId(option.name),
          kind: boundId(option.kind),
        })),
      }
    case "permission_resolved":
      return event.optionId === undefined ? event : { ...event, optionId: boundId(event.optionId) }
    case "turn_end":
      return { ...event, stopReason: boundId(event.stopReason) }
    case "editor_context":
      return { ...event, toolCallId: boundId(event.toolCallId) }
  }
}
