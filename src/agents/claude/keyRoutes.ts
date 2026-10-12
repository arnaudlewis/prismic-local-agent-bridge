import { HttpError, readJsonBody } from "../../httpUtils.ts"
import { KeyManagedByEnvironmentError } from "../../secrets/apiKeyVault.ts"
import type { ApiKeyVault } from "../../secrets/apiKeyVault.ts"
import type { ProviderRoute } from "../provider.ts"
import { apiKeyFormat } from "./keyValidation.ts"
import type { KeyValidator } from "./keyValidation.ts"
import { z } from "zod"

const maxBodyBytes = 4 * 1024
const maxAttempts = 5
const attemptWindowMs = 60_000

const KeyBodySchema = z.object({ key: z.string() })

interface KeyRoutesArgs {
  vault: ApiKeyVault
  validate: KeyValidator
  onRemoved: () => void
  now: () => number
}

// PUT and DELETE /auth/claude/key. The key travels in the PUT body only: it is never echoed, logged, or returned.
export function createKeyRoutes(args: KeyRoutesArgs): ProviderRoute[] {
  const { vault, validate, onRemoved, now } = args
  // Every PUT counts, valid or not: the daemon must not become an oracle for guessing keys against Anthropic.
  let attempts: number[] = []

  function checkRate(res: Parameters<ProviderRoute["handle"]>[0]["res"]): void {
    const cutoff = now() - attemptWindowMs
    attempts = attempts.filter((at) => at > cutoff)
    if (attempts.length >= maxAttempts) {
      const retryAfterMs = (attempts[0] ?? now()) + attemptWindowMs - now()
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))))
      throw new HttpError(429, "too_many_attempts")
    }
    attempts.push(now())
  }

  return [
    {
      method: "PUT",
      path: "/auth/claude/key",
      auth: "bearer",
      async handle({ req, res }) {
        checkRate(res)
        if (!isJsonContentType(req.headers["content-type"])) {
          throw new HttpError(415, "unsupported_media_type")
        }
        const body = KeyBodySchema.safeParse(await readJsonBody(req, maxBodyBytes))
        if (!body.success || !apiKeyFormat.test(body.data.key)) throw new HttpError(400, "invalid_format")
        const { key } = body.data
        if (vault.storage() === "env") throw new HttpError(409, "managed_by_environment")

        // Admitted: from here on a DELETE (or another PUT) that arrives while Anthropic is being asked wins.
        const epoch = vault.beginMutation()
        const validation = await validate(key)
        if (validation === "invalid") throw new HttpError(400, "invalid_key")
        if (validation === "unavailable") throw new HttpError(502, "validation_unavailable")

        let stored: boolean
        try {
          stored = await vault.setIfCurrent(key, epoch)
        } catch (error) {
          if (error instanceof KeyManagedByEnvironmentError) throw new HttpError(409, "managed_by_environment")
          // The store's own error text could carry detail about the key: say only that it failed.
          console.error("Could not store the Anthropic API key")
          throw new HttpError(500, "storage_failed")
        }
        if (!stored) throw new HttpError(409, "superseded")
        res.writeHead(204)
        res.end()
      },
    },
    {
      method: "DELETE",
      path: "/auth/claude/key",
      auth: "bearer",
      async handle({ res }) {
        try {
          await vault.remove()
        } catch (error) {
          if (error instanceof KeyManagedByEnvironmentError) throw new HttpError(409, "managed_by_environment")
          console.error("Could not delete the Anthropic API key")
          throw new HttpError(500, "storage_failed")
        }
        onRemoved()
        res.writeHead(204)
        res.end()
      },
    },
  ]
}

// The media type is application/json, with at most a charset parameter: not "application/jsonp", not a suffix type.
function isJsonContentType(header: string | undefined): boolean {
  return /^application\/json(?:\s*;\s*charset=("?)utf-8\1)?\s*$/i.test(header ?? "")
}
