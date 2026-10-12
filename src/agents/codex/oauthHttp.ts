import { spawn } from "node:child_process"
import { z } from "zod"

import { errorMessage } from "../../errors.ts"
import { discoveryEndpoint, requestTimeoutMs, resource } from "./oauth.ts"

const ModelsResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      slug: z.string().optional(),
      visibility: z.string().optional(),
    }),
  ),
})

export async function revokeRefreshToken(args: { clientId: string; refreshToken: string }): Promise<void> {
  try {
    const discovery = await fetch(discoveryEndpoint, { signal: AbortSignal.timeout(requestTimeoutMs) })
    const metadata = z.object({ revocation_endpoint: z.string().optional() }).parse(await discovery.json())
    if (metadata.revocation_endpoint === undefined) {
      console.warn("ChatGPT sign-out: no revocation endpoint advertised")
      return
    }
    const response = await postForm(metadata.revocation_endpoint, {
      token: args.refreshToken,
      token_type_hint: "refresh_token",
      client_id: args.clientId,
    })
    if (!response.ok) console.warn(`ChatGPT sign-out: token revocation returned ${response.status}`)
  } catch (error) {
    console.warn(`ChatGPT sign-out: token revocation failed: ${errorMessage(error)}`)
  }
}

export async function logAvailableModels(accessToken: string | undefined): Promise<void> {
  if (accessToken === undefined) return
  try {
    const response = await fetch(`${resource}/models`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(requestTimeoutMs),
    })
    if (!response.ok) {
      console.warn(`Could not list ChatGPT plan models (status ${response.status})`)
      return
    }
    const models = ModelsResponseSchema.parse(await response.json()).data
    const listed = models
      .filter((model) => model.visibility === undefined || model.visibility === "list")
      .map((model) => (model.slug === undefined ? model.id : `${model.id} (${model.slug})`))
    console.info(`Models available on your ChatGPT plan: ${listed.join(", ")}`)
  } catch (error) {
    console.warn(`Could not list ChatGPT plan models: ${errorMessage(error)}`)
  }
}

export function postForm(url: string, fields: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(requestTimeoutMs),
  })
}

export async function readErrorCode(response: Response): Promise<string | undefined> {
  const body: unknown = await response.json().catch(() => undefined)
  if (typeof body !== "object" || body === null) return undefined
  const error = (body as { error?: unknown }).error
  if (typeof error === "string") return error
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === "string") return code
  }
  return undefined
}

export function openBrowser(url: string): void {
  const command = browserCommand(url)
  if (command === undefined) return
  const child = spawn(command.file, command.args, { detached: true, stdio: "ignore" })
  child.on("error", (error) => console.warn(`Could not open the browser: ${error.message}`))
  child.unref()
}

function browserCommand(url: string): { file: string; args: string[] } | undefined {
  switch (process.platform) {
    case "darwin":
      return { file: "open", args: [url] }
    case "linux":
      return { file: "xdg-open", args: [url] }
    case "win32":
      return { file: "cmd", args: ["/c", "start", '""', url] }
    default:
      return undefined
  }
}
