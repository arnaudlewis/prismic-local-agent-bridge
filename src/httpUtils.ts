import type { IncomingMessage, ServerResponse } from "node:http"

export class HttpError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export function isAllowedHost(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`
}

export function getAllowedOrigin(req: IncomingMessage, allowedOrigins: string[]): string | undefined {
  const origin = req.headers.origin
  if (origin === undefined) return undefined
  return allowedOrigins.includes(origin) ? origin : undefined
}

export function applyCors(res: ServerResponse, origin: string | undefined): void {
  if (origin === undefined) return
  res.setHeader("Access-Control-Allow-Origin", origin)
  res.setHeader("Vary", "Origin")
}

export async function readJsonBody(req: IncomingMessage, maxBytes = 1_048_576): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new HttpError(413, "payload_too_large")
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    throw new HttpError(400, "invalid_json")
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(body))
}

export function sendHtml(res: ServerResponse, status: number, title: string, message: string): void {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" })
  res.end(html)
}

export function getBearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization
  if (header === undefined) return undefined
  const match = /^Bearer (.+)$/i.exec(header)
  return match?.[1]
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}
