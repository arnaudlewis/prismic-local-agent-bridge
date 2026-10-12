import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"

const pairingFileName = "pairing.json"
const maxPairingFileBytes = 64 * 1024
const maxPairedBrowsers = 20
const unusedTokenLifetimeMs = 30 * 24 * 60 * 60 * 1000
// lastUsedAt is kept in memory on every request but written at most this often.
const lastUsedPersistIntervalMs = 60 * 60 * 1000

const StoredBrowserSchema = z.object({
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  origin: z.string().max(300),
  mcpOrigin: z.string().max(300),
  createdAt: z.number(),
  lastUsedAt: z.number(),
})

const PairingFileSchema = z.object({
  version: z.literal(2),
  browsers: z.array(StoredBrowserSchema).max(maxPairedBrowsers),
})

type StoredBrowser = z.infer<typeof StoredBrowserSchema>

// What a pairing binds: the browser origin that may use the token, and the Prismic MCP origin its agents talk to.
export interface PairedBrowser {
  origin: string
  mcpOrigin: string
}

interface CreatePairingArgs {
  now?: () => number
  // Where paired browsers are remembered across restarts (as token hashes). Without it they live in memory only.
  dataDir?: string
}

export interface Pairing {
  // Called once the user approved a connection (see src/connect): returns the token the browser keeps.
  issueToken(browser: PairedBrowser): string
  // The browser a token was issued to, when the request comes from the origin it was issued for.
  validateToken(token: string, origin: string | undefined): PairedBrowser | undefined
  pairedBrowserCount(): number
}

export function forgetPairings(dataDir: string): void {
  rmSync(join(dataDir, pairingFileName), { force: true })
}

export function createPairing(args: CreatePairingArgs): Pairing {
  const { now = Date.now, dataDir } = args

  let browsers: StoredBrowser[] = []
  let lastPersistedAt = now()

  function persist(): void {
    lastPersistedAt = now()
    if (dataDir === undefined) return
    try {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 })
      const path = join(dataDir, pairingFileName)
      const temporaryPath = `${path}.${process.pid}.tmp`
      writeFileSync(temporaryPath, JSON.stringify({ version: 2, browsers }), { mode: 0o600 })
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

  function findBrowser(token: string): StoredBrowser | undefined {
    const presented = Buffer.from(hashToken(token), "hex")
    let match: StoredBrowser | undefined
    // No early exit: how long this takes must not depend on which entry matches.
    for (const browser of browsers) {
      if (timingSafeEqual(presented, Buffer.from(browser.tokenHash, "hex"))) match = browser
    }
    return match
  }

  if (dataDir !== undefined) {
    browsers = loadBrowsers(dataDir)
    if (dropExpired()) persist()
  }

  return {
    pairedBrowserCount: () => browsers.length,
    issueToken(browser) {
      const token = randomBytes(32).toString("base64url")
      while (browsers.length >= maxPairedBrowsers) {
        const oldest = browsers.reduce((least, candidate) => (candidate.lastUsedAt < least.lastUsedAt ? candidate : least))
        browsers = browsers.filter((candidate) => candidate !== oldest)
      }
      browsers.push({
        tokenHash: hashToken(token),
        origin: browser.origin,
        mcpOrigin: browser.mcpOrigin,
        createdAt: now(),
        lastUsedAt: now(),
      })
      persist()
      return token
    },
    validateToken(token, origin) {
      if (dropExpired()) persist()
      const browser = findBrowser(token)
      if (browser === undefined || origin !== browser.origin) return undefined
      browser.lastUsedAt = now()
      if (now() - lastPersistedAt >= lastUsedPersistIntervalMs) persist()
      return { origin: browser.origin, mcpOrigin: browser.mcpOrigin }
    },
  }
}

// Only a SHA-256 of each token is stored: the file alone is not enough to authenticate.
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

function loadBrowsers(dataDir: string): StoredBrowser[] {
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
    return PairingFileSchema.parse(JSON.parse(raw)).browsers
  } catch {
    console.warn("Ignoring pairing.json: unknown or corrupt format; all browsers must pair again")
    return []
  }
}
