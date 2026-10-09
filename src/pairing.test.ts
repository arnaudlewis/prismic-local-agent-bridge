import { describe, expect, it, vi } from "vitest"

import { createPairing } from "./pairing.ts"

function wrongCodeFor(code: string): string {
  return code === "000000" ? "111111" : "000000"
}

describe("createPairing", () => {
  it("returns a valid token for the right code and rotates the code", () => {
    const onCodeChanged = vi.fn()
    const pairing = createPairing({ onCodeChanged })
    const oldCode = pairing.currentCode()

    const token = pairing.tryPair(oldCode)

    expect(token).toBeDefined()
    expect(pairing.isValidToken(token ?? "")).toBe(true)
    expect(pairing.isValidToken("unknown")).toBe(false)
    expect(onCodeChanged).toHaveBeenCalledTimes(1)
    expect(pairing.currentCode()).not.toBe(oldCode)
    expect(pairing.tryPair(oldCode)).toBeUndefined()
  })

  it("rotates the code after 5 wrong attempts", () => {
    const onCodeChanged = vi.fn()
    const pairing = createPairing({ onCodeChanged })
    const oldCode = pairing.currentCode()
    const wrongCode = wrongCodeFor(oldCode)

    for (let attempt = 0; attempt < 4; attempt++) {
      expect(pairing.tryPair(wrongCode)).toBeUndefined()
    }
    expect(onCodeChanged).not.toHaveBeenCalled()

    expect(pairing.tryPair(wrongCode)).toBeUndefined()
    expect(onCodeChanged).toHaveBeenCalledTimes(1)
    expect(onCodeChanged).toHaveBeenCalledWith(pairing.currentCode())
    expect(pairing.currentCode()).not.toBe(oldCode)
  })

  it("rejects codes of a different length", () => {
    const pairing = createPairing({ onCodeChanged: () => {} })
    expect(pairing.tryPair("12")).toBeUndefined()
  })

  it("enforces a doubling cooldown across code rotations", () => {
    let time = 1_000_000
    const pairing = createPairing({ onCodeChanged: () => {}, now: () => time })

    function failBatch(): void {
      const wrongCode = wrongCodeFor(pairing.currentCode())
      for (let attempt = 0; attempt < 5; attempt++) pairing.tryPair(wrongCode)
    }

    expect(pairing.cooldownRemainingMs()).toBe(0)
    failBatch()
    expect(pairing.cooldownRemainingMs()).toBe(30_000)

    expect(pairing.tryPair(pairing.currentCode())).toBeUndefined()

    time += 30_000
    expect(pairing.cooldownRemainingMs()).toBe(0)
    failBatch()
    expect(pairing.cooldownRemainingMs()).toBe(60_000)

    time += 60_000
    failBatch()
    expect(pairing.cooldownRemainingMs()).toBe(120_000)
  })

  it("caps the cooldown at 15 minutes and resets it after a successful pair", () => {
    let time = 0
    const pairing = createPairing({ onCodeChanged: () => {}, now: () => time })

    for (let batch = 0; batch < 12; batch++) {
      const wrongCode = wrongCodeFor(pairing.currentCode())
      for (let attempt = 0; attempt < 5; attempt++) pairing.tryPair(wrongCode)
      expect(pairing.cooldownRemainingMs()).toBeLessThanOrEqual(15 * 60_000)
      time += pairing.cooldownRemainingMs()
    }

    const wrongCode = wrongCodeFor(pairing.currentCode())
    for (let attempt = 0; attempt < 5; attempt++) pairing.tryPair(wrongCode)
    expect(pairing.cooldownRemainingMs()).toBe(15 * 60_000)
    time += 15 * 60_000

    expect(pairing.tryPair(pairing.currentCode())).toBeDefined()

    const afterSuccess = wrongCodeFor(pairing.currentCode())
    for (let attempt = 0; attempt < 5; attempt++) pairing.tryPair(afterSuccess)
    expect(pairing.cooldownRemainingMs()).toBe(30_000)
  })
})
