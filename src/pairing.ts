import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto"
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"

const maxFailedAttempts = 5
const initialCooldownMs = 30_000
const maxCooldownMs = 15 * 60_000

const pairingFileName = "pairing.json"
const maxPairingFileBytes = 64 * 1024
const maxPairedBrowsers = 20
const unusedTokenLifetimeMs = 30 * 24 * 60 * 60 * 1000
// lastUsedAt is kept in memory on every request but written at most this often.
const lastUsedPersistIntervalMs = 60 * 60 * 1000

const PairedBrowserSchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.number(),
  lastUsedAt: z.number(),
})

const PairingFileSchema = z.object({
  version: z.literal(1),
  tokens: z.array(PairedBrowserSchema).max(maxPairedBrowsers),
})

type PairedBrowser = z.infer<typeof PairedBrowserSchema>

interface CreatePairingArgs {
  onCodeChanged: (code: string) => void
  now?: () => number
  // Where paired browsers are remembered across restarts (as token hashes). Without it they live in memory only.
  dataDir?: string
}

export interface Pairing {
  currentCode(): string
  tryPair(code: string): string | undefined
  isValidToken(token: string): boolean
  cooldownRemainingMs(): number
  pairedBrowserCount(): number
}

export function forgetPairings(dataDir: string): void {
  rmSync(join(dataDir, pairingFileName), { force: true })
}

export function createPairing(args: CreatePairingArgs): Pairing {
  const { onCodeChanged, now = Date.now, dataDir } = args

  let code = generateCode()
  let failedAttempts = 0
  // Cooldown outlives code rotation: rotating alone would give an attacker unlimited guesses.
  let nextCooldownMs = initialCooldownMs
  let cooldownUntil = 0
  let browsers: PairedBrowser[] = []
  let lastPersistedAt = now()

  function rotateCode(): void {
    const previous = code
    while (code === previous) code = generateCode()
    failedAttempts = 0
    onCodeChanged(code)
  }

  function cooldownRemainingMs(): number {
    return Math.max(0, cooldownUntil - now())
  }

  function persist(): void {
    lastPersistedAt = now()
    if (dataDir === undefined) return
    try {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 })
      const path = join(dataDir, pairingFileName)
      const temporaryPath = `${path}.${process.pid}.tmp`
      writeFileSync(temporaryPath, JSON.stringify({ version: 1, tokens: browsers }), { mode: 0o600 })
      renameSync(temporaryPath, path)
    } catch (error) {
      console.warn(`Could not save paired browsers: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function dropExpired(): boolean {
    const kept = browsers.filter((browser) => now() - browser.lastUsedAt <= unusedTokenLifetimeMs)
    const changed = kept.length !== browsers.length
    browsers = kept
    return changed
  }

  function addBrowser(token: string): void {
    while (browsers.length >= maxPairedBrowsers) {
      const oldest = browsers.reduce((least, browser) => (browser.lastUsedAt < least.lastUsedAt ? browser : least))
      browsers = browsers.filter((browser) => browser !== oldest)
    }
    browsers.push({ hash: hashToken(token), createdAt: now(), lastUsedAt: now() })
    persist()
  }

  function findBrowser(token: string): PairedBrowser | undefined {
    const presented = Buffer.from(hashToken(token), "hex")
    let match: PairedBrowser | undefined
    // No early exit: how long this takes must not depend on which entry matches.
    for (const browser of browsers) {
      if (timingSafeEqual(presented, Buffer.from(browser.hash, "hex"))) match = browser
    }
    return match
  }

  if (dataDir !== undefined) {
    browsers = loadBrowsers(dataDir)
    if (dropExpired()) persist()
  }

  return {
    currentCode: () => code,
    cooldownRemainingMs,
    pairedBrowserCount: () => browsers.length,
    tryPair(candidate) {
      if (cooldownRemainingMs() > 0) return undefined
      if (codesMatch(candidate, code)) {
        const token = randomBytes(32).toString("base64url")
        addBrowser(token)
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
    isValidToken(token) {
      if (dropExpired()) persist()
      const browser = findBrowser(token)
      if (browser === undefined) return false
      browser.lastUsedAt = now()
      if (now() - lastPersistedAt >= lastUsedPersistIntervalMs) persist()
      return true
    },
  }
}

// Only a SHA-256 of each token is stored: the file alone is not enough to authenticate.
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

function loadBrowsers(dataDir: string): PairedBrowser[] {
  const path = join(dataDir, pairingFileName)
  let raw: string
  try {
    const info = lstatSync(path)
    if (!info.isFile() || info.size > maxPairingFileBytes) {
      console.warn("Ignoring pairing.json: not a regular file or too large; all browsers must pair again")
      return []
    }
    raw = readFileSync(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("Ignoring unreadable pairing.json; all browsers must pair again")
    }
    return []
  }
  try {
    return PairingFileSchema.parse(JSON.parse(raw)).tokens
  } catch {
    console.warn("Ignoring corrupt pairing.json; all browsers must pair again")
    return []
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
