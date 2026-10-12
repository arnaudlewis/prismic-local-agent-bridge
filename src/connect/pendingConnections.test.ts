import { describe, expect, it } from "vitest"

import { attemptTtlMs, createPendingConnections, maxPendingAttempts } from "./pendingConnections.ts"

const origin = "https://foo.prismic.io"
const mcpOrigin = "https://mcp.prismic.io"

function setup() {
  const clock = { time: 1_000_000 }
  const pending = createPendingConnections({ now: () => clock.time })
  let counter = 0
  // A distinct, well-formed challenge per call.
  const challenge = () => String((counter += 1)).padStart(43, "c")
  function open(challengeValue = challenge()) {
    const attempt = pending.open({ origin, mcpOrigin, challenge: challengeValue })
    if (attempt === "conflict") throw new Error("unexpected conflict")
    return attempt
  }
  return { clock, pending, challenge, open }
}

describe("open", () => {
  it("starts an attempt that awaits the user's consent, with an unguessable id of its own", () => {
    const { open } = setup()

    const first = open()
    const second = open()

    expect(first.state).toBe("awaiting_consent")
    expect(first.id).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(first.id).not.toBe(second.id)
    expect(first.id).not.toBe(first.challenge)
  })

  it("returns the same attempt when the same challenge is opened again for the same origin and MCP (popup reload)", () => {
    const { pending, challenge } = setup()
    const value = challenge()
    const first = pending.open({ origin, mcpOrigin, challenge: value })

    const again = pending.open({ origin, mcpOrigin, challenge: value })

    expect(again).toBe(first)
  })

  it("refuses a challenge that is already used for another origin or another MCP, and leaves the attempt alone", () => {
    const { pending, challenge } = setup()
    const value = challenge()
    const first = pending.open({ origin, mcpOrigin, challenge: value })

    expect(pending.open({ origin: "https://bar.prismic.io", mcpOrigin, challenge: value })).toBe("conflict")
    expect(pending.open({ origin, mcpOrigin: "https://mcp.wroom.io", challenge: value })).toBe("conflict")

    expect(pending.byChallenge(value)).toBe(first)
    expect(first).toMatchObject({ origin, mcpOrigin })
  })
})

describe("lookup", () => {
  it("finds an attempt by its id and by its challenge, and nothing for an unknown one", () => {
    const { pending, open } = setup()
    const attempt = open()

    expect(pending.byId(attempt.id)).toBe(attempt)
    expect(pending.byChallenge(attempt.challenge)).toBe(attempt)
    expect(pending.byId(attempt.challenge)).toBeUndefined()
    expect(pending.byChallenge(attempt.id)).toBeUndefined()
  })
})

describe("expiry", () => {
  it("keeps an attempt for exactly its lifetime and drops it right after", () => {
    const { clock, pending, open } = setup()
    const attempt = open()

    clock.time += attemptTtlMs
    expect(pending.byId(attempt.id)).toBe(attempt)

    clock.time += 1
    expect(pending.byId(attempt.id)).toBeUndefined()
    expect(pending.byChallenge(attempt.challenge)).toBeUndefined()
  })

  it("opens a fresh attempt, with a new id, when the challenge of an expired one is opened again", () => {
    const { clock, pending, open } = setup()
    const expired = open()
    clock.time += attemptTtlMs + 1

    const fresh = open(expired.challenge)

    expect(fresh.id).not.toBe(expired.id)
    expect(fresh.state).toBe("awaiting_consent")
    expect(pending.byId(expired.id)).toBeUndefined()
  })
})

describe("capacity", () => {
  it("evicts the oldest attempt when one more than the cap is opened, and only that one", () => {
    const { pending, open } = setup()
    const attempts = Array.from({ length: maxPendingAttempts }, () => open())

    const extra = open()

    expect(pending.byId(attempts[0]?.id ?? "")).toBeUndefined()
    for (const attempt of attempts.slice(1)) expect(pending.byId(attempt.id)).toBe(attempt)
    expect(pending.byId(extra.id)).toBe(extra)
  })

  it("doesn't evict anything when a popup reload opens a challenge that is already pending at the cap", () => {
    const { pending, open } = setup()
    const attempts = Array.from({ length: maxPendingAttempts }, () => open())

    const again = pending.open({ origin, mcpOrigin, challenge: attempts[maxPendingAttempts - 1]?.challenge ?? "" })

    expect(again).toBe(attempts[maxPendingAttempts - 1])
    expect(pending.byId(attempts[0]?.id ?? "")).toBe(attempts[0])
  })
})

describe("answers", () => {
  it("moves from consent to signing in to approved", () => {
    const { pending, open } = setup()
    const attempt = open()

    pending.setSigningIn(attempt.id)
    expect(pending.byId(attempt.id)?.state).toBe("signing_in")

    pending.approve(attempt.id)
    expect(pending.byId(attempt.id)?.state).toBe("approved")
  })

  it("keeps an approval: a late denial can't undo it", () => {
    const { pending, open } = setup()
    const attempt = open()
    pending.approve(attempt.id)

    pending.deny(attempt.id)
    pending.setSigningIn(attempt.id)

    expect(pending.byId(attempt.id)?.state).toBe("approved")
  })

  it("keeps a denial: a late sign-in can't turn it into an approval", () => {
    const { pending, open } = setup()
    const attempt = open()
    pending.setSigningIn(attempt.id)
    pending.deny(attempt.id)

    pending.approve(attempt.id)
    pending.setSigningIn(attempt.id)

    expect(pending.byId(attempt.id)?.state).toBe("denied")
  })
})
