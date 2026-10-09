import { describe, expect, it, vi } from "vitest"

import { createPairing } from "./pairing.ts"

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
    const wrongCode = oldCode === "000000" ? "111111" : "000000"

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
})
