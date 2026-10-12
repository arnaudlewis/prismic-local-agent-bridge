import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"

import { errorMessage } from "../../errors.ts"
import { planUsageScope } from "./oauth.ts"

export const CredentialsSchema = z.object({
  email: z.string().optional(),
  subject: z.string(),
  clientId: z.string(),
  idToken: z.string(),
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
  expiresAt: z.number().optional(),
  scopes: z.array(z.string()),
  savedAt: z.number(),
})

export type Credentials = z.infer<typeof CredentialsSchema>

const HostSchema = z.object({ extAgentHostId: z.string().min(1) })

export function hasPlanUsageScope(credentials: Credentials | undefined): boolean {
  return credentials?.scopes.includes(planUsageScope) ?? false
}

export function loadCredentials(path: string): Credentials | undefined {
  if (!existsSync(path)) return undefined
  try {
    return CredentialsSchema.parse(JSON.parse(readFileSync(path, "utf8")))
  } catch (error) {
    console.warn(`Ignoring unreadable ${path}: ${errorMessage(error)}`)
    return undefined
  }
}

export function loadHostId(dataDir: string): string {
  const path = join(dataDir, "host.json")
  if (existsSync(path)) {
    try {
      return HostSchema.parse(JSON.parse(readFileSync(path, "utf8"))).extAgentHostId
    } catch (error) {
      console.warn(`Regenerating unreadable ${path}: ${errorMessage(error)}`)
    }
  }
  const extAgentHostId = `urn:uuid:${randomUUID()}`
  writeFileSync(path, JSON.stringify({ extAgentHostId }), { mode: 0o600 })
  return extAgentHostId
}
