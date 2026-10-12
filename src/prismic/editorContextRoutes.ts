import type { IncomingMessage, ServerResponse } from "node:http"

import type { ProviderRoute } from "../agents/provider.ts"
import { HttpError, readRawBody } from "../httpUtils.ts"
import type { PairedBrowser } from "../pairing.ts"
import { windowIdPattern } from "../protocol.ts"
import type { McpUpstream } from "./mcpUpstream.ts"
import { PrismicSignInRequiredError } from "./prismicAuth.ts"
import type { PrismicAuth } from "./prismicAuth.ts"

// The Page Builder publishes what the user is looking at (the open document and what's selected) here, and the daemon
// forwards it to the MCP server with its own OAuth token: the browser never sends a Prismic credential.

const maxSnapshotBytes = 2 * 1024 * 1024
const defaultTimeoutMs = 10_000

const windowPathPattern = new RegExp(`^/editor-context/windows/(${windowIdPattern.source.slice(1, -1)})$`, "i")

interface EditorContextRoutesArgs {
  prismicAuth: PrismicAuth
  upstream: McpUpstream
  // Only tests change it.
  timeoutMs?: number
}

export function editorContextRoutes(args: EditorContextRoutesArgs): ProviderRoute[] {
  const { prismicAuth, upstream } = args
  const timeoutMs = args.timeoutMs ?? defaultTimeoutMs

  // The browser says which Prismic user it is signed in as: a daemon signed in as someone else must not publish that
  // browser's context under its own account. A consistency check against two accounts on one machine, not a security
  // boundary (a paired page could lie).
  function checkIdentity(req: IncomingMessage, paired: PairedBrowser): void {
    const status = prismicAuth.status(paired.mcpOrigin)
    if (status.status === "signed_out") throw new HttpError(409, "prismic_sign_in_required")
    const claimed = req.headers["x-prismic-user-id"]
    if (claimed !== status.userId) throw new HttpError(409, "identity_mismatch")
  }

  async function snapshotBody(req: IncomingMessage): Promise<Buffer> {
    const raw = await readRawBody(req, maxSnapshotBytes)
    let parsed: unknown
    try {
      parsed = JSON.parse(raw.toString("utf8"))
    } catch {
      throw new HttpError(400, "invalid_request")
    }
    // The MCP server validates the shape; only an obviously wrong body is refused here.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new HttpError(400, "invalid_request")
    return raw
  }

  async function forward(
    method: "PUT" | "DELETE",
    context: { req: IncomingMessage; res: ServerResponse; url: URL; paired: PairedBrowser | undefined },
  ): Promise<void> {
    const { req, res, url, paired } = context
    const windowId = windowPathPattern.exec(url.pathname)?.[1]
    if (paired === undefined || windowId === undefined) throw new HttpError(404, "not_found")
    checkIdentity(req, paired)
    const body = method === "PUT" ? await snapshotBody(req) : undefined

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await upstream.send({
        mcpOrigin: paired.mcpOrigin,
        path: `/editor-context/windows/${windowId}`,
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body,
        signal: controller.signal,
      })
    } catch (error) {
      if (error instanceof PrismicSignInRequiredError) throw new HttpError(409, "prismic_sign_in_required")
      throw new HttpError(502, "upstream_unavailable")
    } finally {
      clearTimeout(timer)
    }
    await response.body?.cancel().catch(() => {})

    if (response.status === 204) {
      res.writeHead(204)
      res.end()
      return
    }
    if (response.status === 413) throw new HttpError(413, "payload_too_large")
    if (response.status === 400) throw new HttpError(400, "invalid_request")
    throw new HttpError(502, "upstream_unavailable")
  }

  return (["PUT", "DELETE"] as const).map(
    (method): ProviderRoute => ({
      method,
      path: "/editor-context/windows/:windowId",
      pathPattern: windowPathPattern,
      auth: "bearer",
      handle: (context) => forward(method, context),
    }),
  )
}
