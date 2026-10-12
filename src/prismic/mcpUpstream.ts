import { PrismicSignInRequiredError, PrismicUnavailableError } from "./prismicAuth.ts"
import type { PrismicAuth } from "./prismicAuth.ts"

// The one place the daemon calls the Prismic MCP server with the user's access token: the agents' proxy, the
// editor-context forwarding and the per-turn context read all go through here. A 401 refreshes the token once and
// retries; a second 401 signs out, because the server no longer accepts the account.

export interface McpUpstreamRequest {
  mcpOrigin: string
  // "/mcp" or "/editor-context/windows/<id>".
  path: string
  method: "POST" | "PUT" | "DELETE"
  headers: Record<string, string>
  // Buffered, so that it can be sent again after a refresh.
  body?: Buffer
  signal: AbortSignal
}

export interface McpUpstream {
  // Throws PrismicSignInRequiredError or PrismicUnavailableError; any other response is returned as is.
  send(request: McpUpstreamRequest): Promise<Response>
}

export function createMcpUpstream(args: { auth: PrismicAuth }): McpUpstream {
  const { auth } = args

  async function attempt(request: McpUpstreamRequest, accessToken: string): Promise<Response> {
    const headers = new Headers()
    for (const [name, value] of Object.entries(request.headers)) {
      if (name.toLowerCase() !== "authorization") headers.set(name, value)
    }
    headers.set("Authorization", `Bearer ${accessToken}`)
    try {
      return await fetch(`${request.mcpOrigin}${request.path}`, {
        method: request.method,
        headers,
        body: request.body === undefined ? undefined : new Uint8Array(request.body),
        redirect: "error",
        signal: request.signal,
      })
    } catch {
      throw new PrismicUnavailableError()
    }
  }

  return {
    async send(request) {
      const accessToken = await auth.accessToken(request.mcpOrigin)
      const first = await attempt(request, accessToken)
      if (first.status !== 401) return first
      await first.body?.cancel().catch(() => {})

      const refreshed = await auth.refreshAfterUnauthorized(request.mcpOrigin, accessToken)
      const second = await attempt(request, refreshed)
      if (second.status !== 401) return second
      await second.body?.cancel().catch(() => {})
      // Only the sign-in that was refused ends: if another one took its place meanwhile, this request lost a race.
      if (await auth.signOutIfRejected(request.mcpOrigin, refreshed)) throw new PrismicSignInRequiredError()
      throw new PrismicUnavailableError()
    },
  }
}
