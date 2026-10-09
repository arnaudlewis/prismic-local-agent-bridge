import { randomBytes, randomInt, timingSafeEqual } from "node:crypto"

const maxFailedAttempts = 5
const initialCooldownMs = 30_000
const maxCooldownMs = 15 * 60_000

interface CreatePairingArgs {
  onCodeChanged: (code: string) => void
  now?: () => number
}

export interface Pairing {
  currentCode(): string
  tryPair(code: string): string | undefined
  isValidToken(token: string): boolean
  cooldownRemainingMs(): number
}

export function createPairing(args: CreatePairingArgs): Pairing {
  const { onCodeChanged, now = Date.now } = args

  let code = generateCode()
  let failedAttempts = 0
  // Cooldown outlives code rotation: rotating alone would give an attacker unlimited guesses.
  let nextCooldownMs = initialCooldownMs
  let cooldownUntil = 0
  const tokens = new Set<string>()

  function rotateCode(): void {
    const previous = code
    while (code === previous) code = generateCode()
    failedAttempts = 0
    onCodeChanged(code)
  }

  function cooldownRemainingMs(): number {
    return Math.max(0, cooldownUntil - now())
  }

  return {
    currentCode: () => code,
    cooldownRemainingMs,
    tryPair(candidate) {
      if (cooldownRemainingMs() > 0) return undefined
      if (codesMatch(candidate, code)) {
        const token = randomBytes(32).toString("base64url")
        tokens.add(token)
        nextCooldownMs = initialCooldownMs
        rotateCode()
        return token
      }
      failedAttempts += 1
      if (failedAttempts >= maxFailedAttempts) {
        cooldownUntil = now() + nextCooldownMs
        nextCooldownMs = Math.min(nextCooldownMs * 2, maxCooldownMs)
        rotateCode()
      }
      return undefined
    },
    isValidToken: (token) => tokens.has(token),
  }
}

function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0")
}

function codesMatch(candidate: string, expected: string): boolean {
  const candidateBuffer = Buffer.from(candidate)
  const expectedBuffer = Buffer.from(expected)
  if (candidateBuffer.length !== expectedBuffer.length) return false
  return timingSafeEqual(candidateBuffer, expectedBuffer)
}
