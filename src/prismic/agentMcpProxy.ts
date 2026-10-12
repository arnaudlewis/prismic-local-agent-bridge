import { createHash, randomBytes } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"

import type { ProviderRoute } from "../agents/provider.ts"
import { HttpError, getBearerToken, readRawBody } from "../httpUtils.ts"
import { windowIdPattern } from "../protocol.ts"
import type { WindowChannels } from "../windowChannels.ts"
import type { McpUpstream } from "./mcpUpstream.ts"
import { PrismicSignInRequiredError } from "./prismicAuth.ts"

// The agents never see a Prismic token. Each agent process is given the URL of this proxy and a random token of its
// own (a grant); the proxy swaps it for the OAuth access token. So a token refresh never restarts an agent, and the
// refresh token never leaves the daemon.

export interface AgentMcpGrant {
  mcpOrigin: string
  // The window channel the agent process serves: where its notices go.
  windowKey: string
}

export interface AgentMcpGrants {
  issue(grant: AgentMcpGrant): string
  revoke(token: string): void
  resolve(token: string): AgentMcpGrant | undefined
  // The tokens of the live grants, for redaction.
  tokens(): string[]
}

export function createAgentMcpGrants(): AgentMcpGrants {
  // Keyed by a hash of the token: a lookup never compares the secret itself.
  const grants = new Map<string, AgentMcpGrant & { token: string }>()
  const hash = (token: string) => createHash("sha256").update(token).digest("hex")

  return {
    issue(grant) {
      const token = randomBytes(32).toString("base64url")
      grants.set(hash(token), { ...grant, token })
      return token
    },
    revoke(token) {
      grants.delete(hash(token))
    },
    resolve(token) {
      const grant = grants.get(hash(token))
      return grant === undefined ? undefined : { mcpOrigin: grant.mcpOrigin, windowKey: grant.windowKey }
    },
    tokens: () => [...grants.values()].map((grant) => grant.token),
  }
}

export const agentMcpPath = "/agent-mcp"

const maxRequestBytes = 1024 * 1024
const defaultMaxResponseBytes = 8 * 1024 * 1024
const defaultTimeoutMs = 120_000
const noticeThrottleMs = 10_000
const signInNotice = "Sign in to Prismic again from the agent panel."
const forwardedHeaders = ["content-type", "accept", "mcp-protocol-version", "mcp-session-id"]

interface AgentMcpRoutesArgs {
  grants: AgentMcpGrants
  upstream: McpUpstream
  channels: WindowChannels
  now?: () => number
  // Only tests change these.
  timeoutMs?: number
  maxResponseBytes?: number
}

export function agentMcpRoutes(args: AgentMcpRoutesArgs): ProviderRoute[] {
  const { grants, upstream, channels, now = Date.now } = args
  const timeoutMs = args.timeoutMs ?? defaultTimeoutMs
  const maxResponseBytes = args.maxResponseBytes ?? defaultMaxResponseBytes
  const lastNoticeAt = new Map<string, number>()

  function notifySignInRequired(windowKey: string): void {
    const last = lastNoticeAt.get(windowKey)
    if (last !== undefined && now() - last < noticeThrottleMs) return
    lastNoticeAt.set(windowKey, now())
    channels.send(windowKey, { type: "notice", tone: "error", text: signInNotice })
  }

  function upstreamHeaders(req: IncomingMessage): Record<string, string> {
    const headers: Record<string, string> = {}
    for (const name of forwardedHeaders) {
      const value = req.headers[name]
      if (typeof value === "string") headers[name] = value
    }
    const windowId = req.headers["x-prismic-window-id"]
    if (typeof windowId === "string" && windowIdPattern.test(windowId)) headers["x-prismic-window-id"] = windowId
    return headers
  }

  async function forward(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // An agent is a local process: a request that carries an Origin came from a web page.
    if (req.headers.origin !== undefined) throw new HttpError(403, "forbidden_origin")
    // No WWW-Authenticate: an agent must never start an OAuth flow of its own.
    const token = getBearerToken(req)
    const grant = token === undefined ? undefined : grants.resolve(token)
    if (grant === undefined) throw new HttpError(401, "unauthorized")

    const body = await readRawBody(req, maxRequestBytes)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    res.on("close", () => controller.abort())
    try {
      let response: Response
      try {
        response = await upstream.send({
          mcpOrigin: grant.mcpOrigin,
          path: "/mcp",
          method: "POST",
          headers: upstreamHeaders(req),
          body,
          signal: controller.signal,
        })
      } catch (error) {
        if (error instanceof PrismicSignInRequiredError) {
          notifySignInRequired(grant.windowKey)
          throw new HttpError(502, "prismic_sign_in_required")
        }
        throw new HttpError(502, "upstream_unavailable")
      }
      await pipeResponse(response, res, controller)
    } finally {
      clearTimeout(timer)
    }
  }

  async function pipeResponse(response: Response, res: ServerResponse, controller: AbortController): Promise<void> {
    const contentType = response.headers.get("content-type")
    res.writeHead(response.status, contentType === null ? {} : { "Content-Type": contentType })
    if (response.body === null) {
      res.end()
      return
    }
    let size = 0
    try {
      for await (const chunk of response.body) {
        size += chunk.length
        if (size > maxResponseBytes) {
          controller.abort()
          res.destroy()
          return
        }
        res.write(chunk)
      }
      res.end()
    } catch {
      // The upstream broke or timed out after the status was sent: the client can only see a cut stream.
      res.destroy()
    }
  }

  return [
    {
      method: "POST",
      path: agentMcpPath,
      auth: "none",
      originExempt: true,
      handle: ({ req, res }) => forward(req, res),
    },
    ...(["GET", "PUT", "DELETE"] as const).map(
      (method): ProviderRoute => ({
        method,
        path: agentMcpPath,
        auth: "none",
        originExempt: true,
        handle: ({ res }) => {
          res.setHeader("Allow", "POST")
          throw new HttpError(405, "method_not_allowed")
        },
      }),
    ),
  ]
}
