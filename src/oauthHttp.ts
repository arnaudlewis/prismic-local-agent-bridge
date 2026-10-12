// The HTTP pieces shared by every OAuth client in the daemon (Codex's ChatGPT sign-in, Prismic's MCP sign-in).

export const defaultRequestTimeoutMs = 15_000

interface PostFormOptions {
  timeoutMs?: number
  redirect?: RequestRedirect
}

export function postForm(url: string, fields: Record<string, string>, options: PostFormOptions = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(options.timeoutMs ?? defaultRequestTimeoutMs),
    redirect: options.redirect,
  })
}

export async function readErrorCode(response: Response): Promise<string | undefined> {
  const body: unknown = await response.json().catch(() => undefined)
  if (typeof body !== "object" || body === null || !("error" in body)) return undefined
  const error = body.error
  if (typeof error === "string") return error
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return error.code
  return undefined
}

interface ClassifyRefreshFailureArgs {
  status: number
  errorCode: string | undefined
}

export function classifyRefreshFailure(args: ClassifyRefreshFailureArgs): "terminal" | "invalid_client" | "transient" {
  switch (args.errorCode) {
    case "invalid_grant":
    case "invalid_refresh_token":
    case "token_expired":
    case "refresh_token_expired":
    case "refresh_token_invalidated":
    case "refresh_token_reused":
      return "terminal"
    case "invalid_client":
      return "invalid_client"
    default:
      return "transient"
  }
}
