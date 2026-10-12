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

// The text of one assistant message arrives in chunks, and a key can be split across them. This keeps the unfinished
// tail of a possible key until the next chunk says what it was, so no piece of a key is ever sent or stored.
export interface MessageRedactor {
  // The text that is safe to emit now (possibly empty), for a chunk of the message `messageId`.
  push(messageId: string | undefined, text: string, secrets: readonly string[]): { messageId: string | undefined; text: string }[]
  // What is still held, once the message is over (a possible key that wasn't one, or one that never finished).
  flush(secrets: readonly string[]): { messageId: string | undefined; text: string }[]
}

export function createMessageRedactor(): MessageRedactor {
  let pending = ""
  let pendingMessageId: string | undefined

  function release(secrets: readonly string[]): { messageId: string | undefined; text: string }[] {
    if (pending === "") return []
    const messageId = pendingMessageId
    // A key prefix that never became a key and is long enough to say something about it: not worth the risk.
    const text = /^sk-ant-[A-Za-z0-9_-]{8,}$/.test(pending) ? redactedMarker : redactText(pending, secrets)
    pending = ""
    return [{ messageId, text }]
  }

  return {
    push(messageId, text, secrets) {
      const out = messageId === pendingMessageId ? [] : release(secrets)
      pendingMessageId = messageId
      // The unfinished end is held raw: redacting a half-arrived key would swallow it and leak the rest.
      const raw = pending + text
      const held = heldSuffixLength(raw, secrets)
      pending = raw.slice(raw.length - held)
      const ready = redactText(raw.slice(0, raw.length - held), secrets)
      if (ready !== "") out.push({ messageId, text: ready })
      return out
    },
    flush: release,
  }
}
