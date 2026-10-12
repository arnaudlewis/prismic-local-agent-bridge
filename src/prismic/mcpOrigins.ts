const fixedMcpOrigins: Record<string, true> = {
  "https://mcp.prismic.io": true,
  "https://mcp.wroom.io": true,
}
const environmentMcpPattern = /^https:\/\/(?:[a-z0-9-]+-mcp|mcp)\.(?:dev-tools|platform|marketing-tools|devops)-wroom\.com$/
const loopbackHosts: Record<string, true> = { localhost: true, "127.0.0.1": true }

// The origin of a Prismic MCP server the daemon agrees to sign in to (production, each environment, its previews, or
// one on this computer), or undefined for anything else. The daemon sends the user's Prismic credentials there.
export function parseMcpOrigin(raw: string): string | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.username !== "" || url.password !== "") return undefined
  const { origin } = url
  if (Object.hasOwn(fixedMcpOrigins, origin) || environmentMcpPattern.test(origin)) return origin
  if (url.protocol === "http:" && Object.hasOwn(loopbackHosts, url.hostname)) return origin
  return undefined
}
