import { describe, expect, it } from "vitest"

import { createRateLimiter } from "./rateLimit.ts"

function setup(args: { limit: number; windowMs: number }) {
  const clock = { time: 1_000_000 }
  const limiter = createRateLimiter({ ...args, now: () => clock.time })
  return { clock, limiter }
}

describe("createRateLimiter", () => {
  it("lets exactly `limit` requests through in a window and refuses the rest", () => {
    const { limiter } = setup({ limit: 3, windowMs: 60_000 })

    expect([limiter.take(), limiter.take(), limiter.take(), limiter.take(), limiter.take()]).toEqual([
      true,
      true,
      true,
      false,
      false,
    ])
  })

  it("refuses until the window has fully elapsed, then counts from zero again", () => {
    const { clock, limiter } = setup({ limit: 2, windowMs: 60_000 })
    limiter.take()
    limiter.take()

    clock.time += 59_999
    expect(limiter.take()).toBe(false)

    clock.time += 1
    expect([limiter.take(), limiter.take(), limiter.take()]).toEqual([true, true, false])
  })

  it("keeps the window anchored at its start: refused requests don't extend it", () => {
    const { clock, limiter } = setup({ limit: 1, windowMs: 1000 })
    limiter.take()

    clock.time += 900
    expect(limiter.take()).toBe(false)
    clock.time += 100

    expect(limiter.take()).toBe(true)
  })

  it("starts a new window at the first request after a long silence, not at the old boundary", () => {
    const { clock, limiter } = setup({ limit: 1, windowMs: 1000 })
    limiter.take()

    clock.time += 10_000
    expect(limiter.take()).toBe(true)

    clock.time += 999
    expect(limiter.take()).toBe(false)
    clock.time += 1
    expect(limiter.take()).toBe(true)
  })
})
