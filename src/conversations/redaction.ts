import type { BridgeEvent, HistoryEvent } from "../protocol.ts"

export const redactedMarker = "[redacted API key]"

// Anything shaped like an Anthropic API key, known to the daemon or not.
const keyShape = /sk-ant-[A-Za-z0-9_-]{20,}/g
// The start of a key that a chunk may have cut in the middle.
const partialKeyShape = /sk-ant-[A-Za-z0-9_-]*$/
const keyPrefix = "sk-ant-"
// Secrets shorter than this are not worth matching (and would redact ordinary text).
const minSecretLength = 8

// Replaces every secret the daemon knows, and every string that looks like an Anthropic API key, with a marker.
export function redactText(text: string, secrets: readonly string[]): string {
  let result = text
  for (const secret of secrets) {
    if (secret.length >= minSecretLength && result.includes(secret)) result = result.split(secret).join(redactedMarker)
  }
  return result.replace(keyShape, redactedMarker)
}

// Every string in an event, at any depth. The events are plain data: no cycles, no classes.
function redactValue<T>(value: T, secrets: readonly string[]): T {
  if (typeof value === "string") return redactText(value, secrets) as T
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets)) as T
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactValue(item, secrets)])) as T
  }
  return value
}

export function redactEvent<T extends BridgeEvent | HistoryEvent>(event: T, secrets: readonly string[]): T {
  return redactValue(event, secrets)
}

// No key is longer than this (the format check in the key route allows 400 characters after the prefix).
const maxKeyLength = 420

// How much of the end of `text` could be the beginning of a secret that the next chunk completes: it is held back
// until it is known not to be one.
function heldSuffixLength(text: string, secrets: readonly string[]): number {
  const longest = Math.min(text.length, maxKeyLength)
  for (let length = longest; length >= 1; length--) {
    const suffix = text.slice(-length)
    if (partialKeyShape.test(suffix) && suffix.startsWith(keyPrefix)) return length
    if (keyPrefix.startsWith(suffix)) return length
    if (secrets.some((secret) => secret.length >= minSecretLength && secret.length > length && secret.startsWith(suffix))) return length
  }
  return 0
}

// A piece of one assistant message, safe to send and store.
export interface MessagePiece {
  messageId: string | undefined
  text: string
}

// The text of one assistant message arrives in chunks, and a key can be split across them. This keeps, per message, the
// unfinished tail of a possible key until the next chunk of the same message says what it was (or the message is
// over), so no piece of a key is ever sent or stored. Other events in between (a tool call, a permission request)
// are none of its business: the tail stays held.
export interface MessageRedactor {
  // The text that is safe to emit now (possibly empty) for a chunk of the message `messageId`.
  push(messageId: string | undefined, text: string, secrets: readonly string[]): MessagePiece[]
  // At a genuine boundary (the turn ended or was cancelled, the agent stopped): everything still held. A tail that
  // starts like a key is redacted, whatever its length; any other tail is ordinary text and comes out as it is.
  flushAll(secrets: readonly string[]): MessagePiece[]
}

// A model that streams many messages without ever finishing a "possible key" can't grow this without bound.
const maxHeldMessages = 8

export function createMessageRedactor(): MessageRedactor {
  const held = new Map<string, MessagePiece>()

  function release(entry: MessagePiece, secrets: readonly string[]): MessagePiece[] {
    const text = redactText(entry.text, secrets)
    const looksLikeKey = text.startsWith(keyPrefix) || secrets.some((secret) => secret.length >= minSecretLength && secret.startsWith(text) && text.length >= minSecretLength)
    return [{ messageId: entry.messageId, text: looksLikeKey ? redactedMarker : text }]
  }

  return {
    push(messageId, text, secrets) {
      const slot = messageId ?? ""
      const out: MessagePiece[] = []
      const raw = (held.get(slot)?.text ?? "") + text
      held.delete(slot)
      const keep = heldSuffixLength(raw, secrets)
      const ready = redactText(raw.slice(0, raw.length - keep), secrets)
      if (keep > 0) {
        held.set(slot, { messageId, text: raw.slice(raw.length - keep) })
        while (held.size > maxHeldMessages) {
          const [oldest, entry] = held.entries().next().value as [string, MessagePiece]
          held.delete(oldest)
          out.push(...release(entry, secrets))
        }
      }
      if (ready !== "") out.push({ messageId, text: ready })
      return out
    },
    flushAll(secrets) {
      const out = [...held.values()].flatMap((entry) => release(entry, secrets))
      held.clear()
      return out
    },
  }
}
