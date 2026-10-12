import { createHash } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"
import { z } from "zod"

import type { ProviderRoute } from "../agents/provider.ts"
import { HttpError, readFormBody, readJsonBody, sendJson } from "../httpUtils.ts"
import type { Pairing } from "../pairing.ts"
import { isAllowedEditorOrigin, repositoryOf } from "../prismic/editorOrigins.ts"
import { parseMcpOrigin } from "../prismic/mcpOrigins.ts"
import type { PrismicAuth } from "../prismic/prismicAuth.ts"
import type { RateLimiter } from "../rateLimit.ts"
import type { PendingConnections } from "./pendingConnections.ts"
import {
  canceledPage,
  connectedPage,
  consentPage,
  errorPage,
  expiredMessage,
  sendPage,
  signInFailedPage,
} from "./pages.ts"

export const connectRateLimit = { limit: 20, windowMs: 60_000 }

const challengePattern = /^[A-Za-z0-9_-]{43}$/

const ClaimBodySchema = z.object({ secret: z.string().regex(challengePattern) })

interface ConnectRoutesArgs {
  pending: PendingConnections
  pairing: Pairing
  prismicAuth: PrismicAuth
  extraOrigins: readonly string[]
  port: number
  projectDir: string
  limiter: RateLimiter
}

// The popup pairing flow:
//   1. The Page Builder makes a secret, keeps it, and opens GET /connect with a hash of it (the challenge).
//   2. The consent page (served here) asks the user, and chains to the Prismic sign-in when there isn't one.
//   3. The Page Builder polls POST /pair/claim with the secret until the attempt is approved and receives its token.
// The token never appears in a URL, and nothing relies on window.opener or postMessage.
export function connectRoutes(args: ConnectRoutesArgs): ProviderRoute[] {
  const { pending, pairing, prismicAuth, extraOrigins, port, projectDir, limiter } = args
  const ownOrigins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`]

  function showConnect(url: URL, res: ServerResponse): void {
    if (!limiter.take()) {
      sendPage(res, 429, errorPage("Too many requests", "Too many requests. Try again in a minute."))
      return
    }
    const origin = url.searchParams.get("origin") ?? ""
    const mcpOrigin = parseMcpOrigin(url.searchParams.get("mcp") ?? "")
    const challenge = url.searchParams.get("challenge") ?? ""
    if (!isAllowedEditorOrigin(origin, extraOrigins)) {
      sendPage(res, 400, errorPage("Can't connect", "This web page isn't one the local agent connects to."))
      return
    }
    if (mcpOrigin === undefined || !challengePattern.test(challenge)) {
      sendPage(res, 400, errorPage("Can't connect", "The connection request is invalid. Start again from the Page Builder."))
      return
    }
    const attempt = pending.open({ origin, mcpOrigin, challenge })
    if (attempt === "conflict") {
      sendPage(res, 400, errorPage("Can't connect", "The connection request is invalid. Start again from the Page Builder."))
      return
    }
    if (attempt.state === "approved") {
      sendPage(res, 200, connectedPage())
      return
    }
    if (attempt.state === "denied") {
      sendPage(res, 200, canceledPage())
      return
    }
    sendPage(
      res,
      200,
      consentPage({
        attemptId: attempt.id,
        origin,
        repository: repositoryOf(origin),
        projectDir,
        signedIn: prismicAuth.status(mcpOrigin).status === "signed_in",
      }),
    )
  }

  // The consent form is the only caller: it posts from this very origin, never from a web page.
  function isOwnFormPost(req: IncomingMessage): boolean {
    const origin = req.headers.origin
    if (origin === undefined || !ownOrigins.includes(origin)) return false
    const site = req.headers["sec-fetch-site"]
    return site === undefined || site === "same-origin"
  }

  async function decide(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isOwnFormPost(req)) {
      sendPage(res, 403, errorPage("Can't connect", "This request didn't come from the consent page."))
      return
    }
    const form = await readFormBody(req)
    const attempt = pending.byId(form.get("attempt") ?? "")
    if (attempt === undefined) {
      sendPage(res, 400, errorPage("Request expired", expiredMessage))
      return
    }
    const decision = form.get("decision")
    if (decision !== "allow" && decision !== "deny") {
      sendPage(res, 400, errorPage("Can't connect", "The connection request is invalid. Start again from the Page Builder."))
      return
    }
    if (decision === "deny") {
      // An approval is final: say so rather than showing a cancellation that didn't happen.
      if (attempt.state === "approved") {
        sendPage(res, 200, connectedPage())
        return
      }
      pending.deny(attempt.id)
      sendPage(res, 200, canceledPage())
      return
    }
    if (attempt.state === "approved") {
      sendPage(res, 200, connectedPage())
      return
    }
    if (attempt.state === "denied") {
      sendPage(res, 200, canceledPage())
      return
    }
    if (prismicAuth.status(attempt.mcpOrigin).status === "signed_in") {
      pending.approve(attempt.id)
      sendPage(res, 200, connectedPage())
      return
    }
    pending.setSigningIn(attempt.id)
    let authorizeUrl: string
    try {
      authorizeUrl = await prismicAuth.beginSignIn({
        mcpOrigin: attempt.mcpOrigin,
        onSignedIn: () => pending.approve(attempt.id),
        onFailed: () => pending.deny(attempt.id),
      })
    } catch {
      pending.deny(attempt.id)
      sendPage(res, 502, errorPage("Couldn't reach Prismic", "Close this window and try again from the Page Builder."))
      return
    }
    res.writeHead(302, { Location: authorizeUrl, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" })
    res.end()
  }

  async function oauthCallback(url: URL, res: ServerResponse): Promise<void> {
    const state = url.searchParams.get("state")
    if (state === null) {
      sendPage(res, 400, errorPage("Request expired", expiredMessage))
      return
    }
    const outcome = await prismicAuth.handleCallback({
      state,
      code: url.searchParams.get("code") ?? undefined,
      error: url.searchParams.get("error") ?? undefined,
    })
    if (outcome === "signed_in") sendPage(res, 200, connectedPage())
    else if (outcome === "failed") sendPage(res, 200, signInFailedPage())
    else sendPage(res, 400, errorPage("Request expired", expiredMessage))
  }

  async function claim(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = ClaimBodySchema.safeParse(await readJsonBody(req, 1024))
    if (!body.success) throw new HttpError(400, "invalid_request")
    // The CORS layer let this Origin through (an editor origin); it must also be the one the attempt was opened for.
    const origin = req.headers.origin
    if (origin === undefined) throw new HttpError(403, "forbidden_origin")

    const challenge = createHash("sha256").update(body.data.secret).digest("base64url")
    const attempt = pending.byChallenge(challenge)
    if (attempt === undefined) {
      sendJson(res, 200, { status: "expired" })
      return
    }
    if (attempt.origin !== origin) throw new HttpError(403, "forbidden_origin")
    if (attempt.state === "approved") {
      const token = pairing.issueToken({ origin: attempt.origin, mcpOrigin: attempt.mcpOrigin })
      pending.remove(challenge)
      sendJson(res, 200, { status: "approved", token })
      return
    }
    if (attempt.state === "denied") {
      pending.remove(challenge)
      sendJson(res, 200, { status: "denied" })
      return
    }
    sendJson(res, 200, { status: "pending" })
  }

  return [
    {
      method: "GET",
      path: "/connect",
      auth: "none",
      originExempt: true,
      noCors: true,
      handle: ({ url, res }) => showConnect(url, res),
    },
    {
      method: "POST",
      path: "/connect/decision",
      auth: "none",
      originExempt: true,
      noCors: true,
      handle: ({ req, res }) => decide(req, res),
    },
    {
      method: "GET",
      path: "/oauth/prismic/callback",
      auth: "none",
      originExempt: true,
      noCors: true,
      handle: ({ url, res }) => oauthCallback(url, res),
    },
    {
      method: "POST",
      path: "/pair/claim",
      auth: "none",
      handle: ({ req, res }) => claim(req, res),
    },
  ]
}
