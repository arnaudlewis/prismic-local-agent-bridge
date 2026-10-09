import { randomBytes, randomInt, timingSafeEqual } from "node:crypto"

const maxFailedAttempts = 5

interface CreatePairingArgs {
  onCodeChanged: (code: string) => void
}

export interface Pairing {
  currentCode(): string
  tryPair(code: string): string | undefined
  isValidToken(token: string): boolean
}

export function createPairing(args: CreatePairingArgs): Pairing {
  const { onCodeChanged } = args

  let code = generateCode()
  let failedAttempts = 0
  const tokens = new Set<string>()

  function rotateCode(): void {
    const previous = code
    while (code === previous) code = generateCode()
    failedAttempts = 0
    onCodeChanged(code)
  }

  return {
    currentCode: () => code,
    tryPair(candidate) {
      if (codesMatch(candidate, code)) {
        const token = randomBytes(32).toString("base64url")
        tokens.add(token)
        rotateCode()
        return token
      }
      failedAttempts += 1
      if (failedAttempts >= maxFailedAttempts) rotateCode()
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
