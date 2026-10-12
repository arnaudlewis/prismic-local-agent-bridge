import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Duplex } from "node:stream"
import { WebSocketServer } from "ws"

import type { AgentProvider, ProviderRoute } from "./agents/provider.ts"
import {
  HttpError,
  applyCors,
  getAllowedOrigin,
  getBearerToken,
  isAllowedHost,
  sendJson,
} from "./httpUtils.ts"
import type { PairedBrowser, Pairing } from "./pairing.ts"
import type { PrismicAuth } from "./prismic/prismicAuth.ts"
import { channelKey } from "./channelKey.ts"
import { AgentIdSchema, bridgeInfo, windowIdPattern } from "./protocol.ts"
import type { StatusResponse } from "./protocol.ts"
import type { WindowChannels } from "./windowChannels.ts"

const windowPathPattern = new RegExp(`^/windows/(${windowIdPattern.source.slice(1, -1)})$`, "i")

const maxWebSocketPayloadBytes = 256 * 1024

interface StartBridgeServerArgs {
  port: number
  // Browser origins allowed on top of the deployed editors' (see src/prismic/editorOrigins.ts).
  extraOrigins: string[]
  projectDir: string
  // The agents of this daemon: their status and their own HTTP routes (sign-in flows) are served here.
  providers: AgentProvider[]
  // The routes that are not an agent's: the connect popup, the editor context, the agents' MCP proxy.
  routes: ProviderRoute[]
  pairing: Pairing
  prismicAuth: PrismicAuth
  channels: WindowChannels
}

export interface BridgeServer {
  close(): Promise<void>
}

export async function startBridgeServer(args: StartBridgeServerArgs): Promise<BridgeServer> {
  const { port, extraOrigins, projectDir, providers, routes, pairing, prismicAuth, channels } = args
  const customRoutes = [...routes, ...providers.flatMap((provider) => provider.routes?.() ?? [])]

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isAllowedHost(req, port)) throw new HttpError(403, "Forbidden host")

    const url = parseOriginFormUrl(req.url, port)
    if (url === undefined) throw new HttpError(400, "bad_request")
    const method = req.method ?? "GET"
    const customRoute = customRoutes.find((candidate) => candidate.method === method && matchesPath(candidate, url.pathname))

    const allowedOrigin = getAllowedOrigin(req, extraOrigins)
    if (req.headers.origin !== undefined && allowedOrigin === undefined && customRoute?.originExempt !== true) {
      throw new HttpError(403, "Forbidden origin")
    }
    // Pages meant to be navigated to (the popup) are never readable by another origin's script.
    if (customRoute?.noCors !== true) applyCors(res, allowedOrigin)

    if (method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Prismic-User-Id",
        "Access-Control-Allow-Private-Network": "true",
        "Access-Control-Max-Age": "600",
      })
      res.end()
      return
    }

    if (method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, bridgeInfo)
      return
    }

    if (customRoute !== undefined) {
      const paired = customRoute.auth === "bearer" ? requireToken(req, pairing) : undefined
      await customRoute.handle({ req, res, url, paired })
      return
    }

    if (method === "GET" && url.pathname === "/status") {
      const paired = requireToken(req, pairing)
      const agents: StatusResponse["agents"] = {}
      for (const provider of providers) agents[provider.id] = await provider.getStatus()
      const status: StatusResponse = { projectDir, agents, prismic: prismicAuth.status(paired.mcpOrigin) }
      sendJson(res, 200, status)
      return
    }

    if (method === "POST" && url.pathname === "/prismic/sign-out") {
      const paired = requireToken(req, pairing)
      await prismicAuth.signOut(paired.mcpOrigin)
      res.writeHead(204)
      res.end()
      return
    }

    throw new HttpError(404, "not_found")
  }

  const server = createServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message })
        return
      }
      console.error(`Request failed: ${error instanceof Error ? error.message : String(error)}`)
      sendJson(res, 500, { error: "internal_error" })
    })
  })

  const wss = new WebSocketServer({ noServer: true, maxPayload: maxWebSocketPayloadBytes })

  function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`)
    socket.destroy()
  }

  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => socket.destroy())
    if (!isAllowedHost(req, port)) return rejectUpgrade(socket, 403, "Forbidden")
    const origin = getAllowedOrigin(req, extraOrigins)
    if (origin === undefined) return rejectUpgrade(socket, 403, "Forbidden")

    const url = parseOriginFormUrl(req.url, port)
    if (url === undefined) return rejectUpgrade(socket, 400, "Bad Request")
    const windowId = windowPathPattern.exec(url.pathname)?.[1]
    if (windowId === undefined) return rejectUpgrade(socket, 404, "Not Found")

    // The agent this socket is for; a browser from before several agents existed doesn't send one: Codex.
    const requestedAgent = url.searchParams.get("agent") ?? "codex"
    const agent = AgentIdSchema.safeParse(requestedAgent)
    if (!agent.success) return rejectUpgrade(socket, 400, "Bad Request")

    const token = url.searchParams.get("token")
    wss.handleUpgrade(req, socket, head, (ws) => {
      // First, before anything else: a socket without an error listener turns a malformed frame (even one sent while
      // it is closing) into an uncaught exception that takes the daemon down.
      ws.on("error", () => console.warn("A WebSocket client sent an invalid frame"))
      const paired = token === null ? undefined : pairing.validateToken(token, origin)
      if (token === null || paired === undefined) {
        ws.close(4401, "unauthorized")
        return
      }
      // Authorization is re-checked on every message and periodically: a pairing that expired or was evicted after
      // the upgrade must not keep a socket usable.
      channels.attach(channelKey(windowId, agent.data), ws, {
        isAuthorized: () => pairing.validateToken(token, origin) !== undefined,
        mcpOrigin: paired.mcpOrigin,
        origin,
      })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })

  return {
    close() {
      return new Promise((resolve) => {
        for (const client of wss.clients) client.terminate()
        wss.close()
        server.close(() => resolve())
        server.closeAllConnections()
      })
    },
  }
}

function matchesPath(candidate: ProviderRoute, pathname: string): boolean {
  return candidate.pathPattern === undefined ? candidate.path === pathname : candidate.pathPattern.test(pathname)
}

function parseOriginFormUrl(target: string | undefined, port: number): URL | undefined {
  if (target === undefined || !target.startsWith("/") || target.startsWith("//")) return undefined
  try {
    return new URL(target, `http://127.0.0.1:${port}`)
  } catch {
    return undefined
  }
}

function requireToken(req: IncomingMessage, pairing: Pairing): PairedBrowser {
  const token = getBearerToken(req)
  const paired = token === undefined ? undefined : pairing.validateToken(token, req.headers.origin)
  if (paired === undefined) throw new HttpError(401, "unauthorized")
  return paired
}
