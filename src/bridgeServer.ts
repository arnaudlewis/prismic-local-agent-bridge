import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Duplex } from "node:stream"
import { WebSocketServer } from "ws"
import { z } from "zod"

import type { AgentProvider } from "./agents/provider.ts"
import {
  HttpError,
  applyCors,
  getAllowedOrigin,
  getBearerToken,
  isAllowedHost,
  readJsonBody,
  sendJson,
} from "./httpUtils.ts"
import type { Pairing } from "./pairing.ts"
import { channelKey } from "./channelKey.ts"
import { AgentIdSchema, bridgeInfo, windowIdPattern } from "./protocol.ts"
import type { StatusResponse } from "./protocol.ts"
import type { WindowChannels } from "./windowChannels.ts"

const windowPathPattern = new RegExp(`^/windows/(${windowIdPattern.source.slice(1, -1)})$`, "i")

const maxWebSocketPayloadBytes = 256 * 1024

const PairBodySchema = z.object({ code: z.string() })

interface StartBridgeServerArgs {
  port: number
  allowedOrigins: string[]
  projectDir: string
  // The agents of this daemon: their status and their own HTTP routes (sign-in flows) are served here.
  providers: AgentProvider[]
  pairing: Pairing
  channels: WindowChannels
}

export interface BridgeServer {
  close(): Promise<void>
}

export async function startBridgeServer(args: StartBridgeServerArgs): Promise<BridgeServer> {
  const { port, allowedOrigins, projectDir, providers, pairing, channels } = args
  const providerRoutes = providers.flatMap((provider) => provider.routes?.() ?? [])

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isAllowedHost(req, port)) throw new HttpError(403, "Forbidden host")

    const url = parseOriginFormUrl(req.url, port)
    if (url === undefined) throw new HttpError(400, "bad_request")
    const method = req.method ?? "GET"
    const providerRoute = providerRoutes.find((route) => route.method === method && route.path === url.pathname)

    const allowedOrigin = getAllowedOrigin(req, allowedOrigins)
    if (req.headers.origin !== undefined && allowedOrigin === undefined && providerRoute?.originExempt !== true) {
      throw new HttpError(403, "Forbidden origin")
    }
    applyCors(res, allowedOrigin)

    if (method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
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

    if (method === "POST" && url.pathname === "/pair") {
      const retryAfterMs = pairing.cooldownRemainingMs()
      if (retryAfterMs > 0) {
        res.setHeader("Retry-After", String(Math.ceil(retryAfterMs / 1000)))
        throw new HttpError(429, "too_many_attempts")
      }
      const body = PairBodySchema.safeParse(await readJsonBody(req))
      if (!body.success) throw new HttpError(400, "invalid_request")
      const token = pairing.tryPair(body.data.code)
      if (token === undefined) throw new HttpError(401, "invalid_code")
      sendJson(res, 200, { token })
      return
    }

    if (providerRoute !== undefined) {
      if (providerRoute.auth === "bearer") requireToken(req, pairing)
      await providerRoute.handle({ req, res, url })
      return
    }

    if (method === "GET" && url.pathname === "/status") {
      requireToken(req, pairing)
      const agents: StatusResponse["agents"] = {}
      for (const provider of providers) agents[provider.id] = await provider.getStatus()
      const status: StatusResponse = { projectDir, agents }
      sendJson(res, 200, status)
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
    if (getAllowedOrigin(req, allowedOrigins) === undefined) return rejectUpgrade(socket, 403, "Forbidden")

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
      if (token === null || !pairing.isValidToken(token)) {
        ws.close(4401, "unauthorized")
        return
      }
      // Authorization is re-checked on every message and periodically: a pairing that expired or was evicted after
      // the upgrade must not keep a socket usable.
      channels.attach(channelKey(windowId, agent.data), ws, () => pairing.isValidToken(token))
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

function parseOriginFormUrl(target: string | undefined, port: number): URL | undefined {
  if (target === undefined || !target.startsWith("/") || target.startsWith("//")) return undefined
  try {
    return new URL(target, `http://127.0.0.1:${port}`)
  } catch {
    return undefined
  }
}

function requireToken(req: IncomingMessage, pairing: Pairing): void {
  const token = getBearerToken(req)
  if (token === undefined || !pairing.isValidToken(token)) throw new HttpError(401, "unauthorized")
}
