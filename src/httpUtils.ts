import type { IncomingMessage, ServerResponse } from "node:http"

import { isAllowedEditorOrigin } from "./prismic/editorOrigins.ts"

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

export function getAllowedOrigin(req: IncomingMessage, extraOrigins: readonly string[]): string | undefined {
  const origin = req.headers.origin
  if (origin === undefined) return undefined
  return isAllowedEditorOrigin(origin, extraOrigins) ? origin : undefined
}

export function applyCors(res: ServerResponse, origin: string | undefined): void {
  if (origin === undefined) return
  res.setHeader("Access-Control-Allow-Origin", origin)
  res.setHeader("Vary", "Origin")
}

export async function readRawBody(req: IncomingMessage, maxBytes = 1_048_576): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new HttpError(413, "payload_too_large")
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

export async function readJsonBody(req: IncomingMessage, maxBytes = 1_048_576): Promise<unknown> {
  const raw = await readRawBody(req, maxBytes)
  try {
    return JSON.parse(raw.toString("utf8"))
  } catch {
    throw new HttpError(400, "invalid_json")
  }
}

// An application/x-www-form-urlencoded body, for the HTML forms the daemon serves itself.
export async function readFormBody(req: IncomingMessage, maxBytes = 4096): Promise<URLSearchParams> {
  return new URLSearchParams((await readRawBody(req, maxBytes)).toString("utf8"))
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

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}
