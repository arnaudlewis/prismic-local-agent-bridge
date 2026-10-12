import { randomBytes } from "node:crypto"

// The connection attempts that are waiting for the user: opened by the popup (/connect), approved or denied on the
// consent page, and collected by the Page Builder with its secret (POST /pair/claim).

export type AttemptState = "awaiting_consent" | "signing_in" | "approved" | "denied"

export interface Attempt {
  // Also the CSRF nonce of the consent form: it is only ever written into that page.
  id: string
  origin: string
  mcpOrigin: string
  // base64url(sha256(secret)): the secret itself stays in the browser that opened the popup.
  challenge: string
  state: AttemptState
  createdAt: number
}

export interface PendingConnections {
  // The same challenge opened again (a reload of the popup) returns the attempt it opened. "conflict" when the
  // challenge is already used for another origin or MCP.
  open(args: { origin: string; mcpOrigin: string; challenge: string }): Attempt | "conflict"
  byId(id: string): Attempt | undefined
  byChallenge(challenge: string): Attempt | undefined
  setSigningIn(id: string): void
  approve(id: string): void
  deny(id: string): void
  remove(challenge: string): void
}

export const attemptTtlMs = 10 * 60 * 1000
export const maxPendingAttempts = 32

export function createPendingConnections(args: { now?: () => number } = {}): PendingConnections {
  const { now = Date.now } = args
  // Insertion order is age order: the first entry is the oldest.
  const attempts = new Map<string, Attempt>()

  function purgeExpired(): void {
    for (const [challenge, attempt] of attempts) {
      if (now() - attempt.createdAt > attemptTtlMs) attempts.delete(challenge)
    }
  }

  function byId(id: string): Attempt | undefined {
    purgeExpired()
    for (const attempt of attempts.values()) {
      if (attempt.id === id) return attempt
    }
    return undefined
  }

  function setState(id: string, state: AttemptState): void {
    const attempt = byId(id)
    if (attempt === undefined) return
    // An answer is final: a late sign-in result can't undo a denial.
    if (attempt.state === "approved" || attempt.state === "denied") return
    attempt.state = state
  }

  return {
    open({ origin, mcpOrigin, challenge }) {
      purgeExpired()
      const existing = attempts.get(challenge)
      if (existing !== undefined) {
        return existing.origin === origin && existing.mcpOrigin === mcpOrigin ? existing : "conflict"
      }
      while (attempts.size >= maxPendingAttempts) {
        const oldest = attempts.keys().next().value
        if (oldest === undefined) break
        attempts.delete(oldest)
      }
      const attempt: Attempt = {
        id: randomBytes(32).toString("base64url"),
        origin,
        mcpOrigin,
        challenge,
        state: "awaiting_consent",
        createdAt: now(),
      }
      attempts.set(challenge, attempt)
      return attempt
    },
    byId,
    byChallenge(challenge) {
      purgeExpired()
      return attempts.get(challenge)
    },
    setSigningIn: (id) => setState(id, "signing_in"),
    approve: (id) => setState(id, "approved"),
    deny: (id) => setState(id, "denied"),
    remove(challenge) {
      attempts.delete(challenge)
    },
  }
}
