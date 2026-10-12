import { createHash } from "node:crypto"
import { createServer } from "node:http"
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http"

// A stand-in for the Prismic MCP server and its OAuth endpoints, on a loopback port. It verifies what the daemon sends
// (PKCE, bearer tokens) the way the real one does, and lets a test break each step. It records every request.

export interface OAuthStubRequest {
  method: string
  path: string
  query: URLSearchParams
  headers: IncomingHttpHeaders
  body: string
}

export type TokenBehavior = "success" | "invalid_grant" | "invalid_client" | "server_error"

export interface OAuthStub {
  // `http://127.0.0.1:<port>`: what the daemon is told is the MCP origin.
  origin: string
  requests: OAuthStubRequest[]
  requestsTo(path: string): OAuthStubRequest[]
  // The user /whoami answers with.
  userId: string
  // What /token does for the authorization_code and the refresh_token grants.
  tokenBehavior: TokenBehavior
  // Undefined: no expires_in in the token response.
  expiresIn: number | undefined
  // Delay of every /token answer, for single-flight tests.
  tokenDelayMs: number
  // Metadata whose endpoints are on another origin.
  foreignEndpoints: boolean
  // What /editor-context/windows/* answers with once the bearer is accepted.
  editorContextStatus: number
  // Every access token issued so far is refused from now on (a server that expired them).
  expireAccessTokens(): void
  close(): Promise<void>
}

export async function startOAuthStub(): Promise<OAuthStub> {
  let counter = 0
  let clients = 0
  const validAccessTokens = new Set<string>()
  const validRefreshTokens = new Set<string>()
  // code -> the PKCE challenge it was issued for
  const codes = new Map<string, string>()

  const server = createServer((request, response) => {
    void handle(request, response)
  })

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    const url = new URL(request.url ?? "/", stub.origin)
    const body = Buffer.concat(chunks).toString("utf8")
    const recorded: OAuthStubRequest = {
      method: request.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      headers: request.headers,
      body,
    }
    stub.requests.push(recorded)

    const json = (status: number, payload: unknown, headers: Record<string, string> = {}) =>
      response.writeHead(status, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(payload))
    const hasValidBearer = () => {
      const match = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")
      return match?.[1] !== undefined && validAccessTokens.has(match[1])
    }

    switch (`${recorded.method} ${url.pathname}`) {
      case "GET /.well-known/oauth-authorization-server": {
        const base = stub.foreignEndpoints ? "https://elsewhere.example" : stub.origin
        json(200, {
          issuer: stub.origin,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          revocation_endpoint: `${base}/revoke`,
        })
        return
      }
      case "POST /register":
        clients += 1
        json(201, { client_id: `client-${clients}` })
        return
      case "GET /authorize": {
        const redirectUri = url.searchParams.get("redirect_uri")
        const challenge = url.searchParams.get("code_challenge")
        if (redirectUri === null || challenge === null) {
          json(400, { error: "invalid_request" })
          return
        }
        counter += 1
        const code = `code-${counter}`
        codes.set(code, challenge)
        const location = new URL(redirectUri)
        location.searchParams.set("code", code)
        location.searchParams.set("state", url.searchParams.get("state") ?? "")
        response.writeHead(302, { Location: location.href }).end()
        return
      }
      case "POST /token": {
        if (stub.tokenDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, stub.tokenDelayMs))
        const form = new URLSearchParams(body)
        if (stub.tokenBehavior === "server_error") {
          json(500, { error: "server_error" })
          return
        }
        if (stub.tokenBehavior === "invalid_client") {
          json(401, { error: "invalid_client" })
          return
        }
        if (stub.tokenBehavior === "invalid_grant") {
          json(400, { error: "invalid_grant" })
          return
        }
        if (form.get("grant_type") === "authorization_code") {
          const challenge = codes.get(form.get("code") ?? "")
          codes.delete(form.get("code") ?? "")
          const verifier = form.get("code_verifier") ?? ""
          if (challenge === undefined || createHash("sha256").update(verifier).digest("base64url") !== challenge) {
            json(400, { error: "invalid_grant" })
            return
          }
        } else if (!validRefreshTokens.has(form.get("refresh_token") ?? "")) {
          json(400, { error: "invalid_grant" })
          return
        }
        counter += 1
        const accessToken = `access-${counter}`
        const refreshToken = `refresh-${counter}`
        validAccessTokens.add(accessToken)
        validRefreshTokens.add(refreshToken)
        json(200, {
          access_token: accessToken,
          refresh_token: refreshToken,
          token_type: "Bearer",
          ...(stub.expiresIn === undefined ? {} : { expires_in: stub.expiresIn }),
        })
        return
      }
      case "POST /revoke":
        validRefreshTokens.delete(new URLSearchParams(body).get("token") ?? "")
        response.writeHead(200).end()
        return
      case "GET /whoami":
        if (!hasValidBearer()) {
          json(401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" })
          return
        }
        json(200, { userId: stub.userId })
        return
      case "POST /mcp": {
        if (!hasValidBearer()) {
          json(401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" })
          return
        }
        const rpc: unknown = JSON.parse(body === "" ? "{}" : body)
        const id = typeof rpc === "object" && rpc !== null && "id" in rpc ? rpc.id : null
        json(200, { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "{}" }] } })
        return
      }
    }

    if (url.pathname.startsWith("/editor-context/windows/") && (recorded.method === "PUT" || recorded.method === "DELETE")) {
      if (!hasValidBearer()) {
        json(401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" })
        return
      }
      response.writeHead(stub.editorContextStatus).end()
      return
    }
    json(404, { error: "not_found" })
  }

  const port = await new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      resolve(typeof address === "object" && address !== null ? address.port : 0)
    }),
  )

  const stub: OAuthStub = {
    origin: `http://127.0.0.1:${port}`,
    requests: [],
    requestsTo: (path) => stub.requests.filter((request) => request.path === path),
    userId: "user-1",
    tokenBehavior: "success",
    expiresIn: 3600,
    tokenDelayMs: 0,
    foreignEndpoints: false,
    editorContextStatus: 204,
    expireAccessTokens: () => validAccessTokens.clear(),
    async close() {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
  return stub
}
