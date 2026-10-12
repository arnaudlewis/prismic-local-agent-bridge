import { createServer } from "node:net"
import { request as httpRequest } from "node:http"
import { afterEach, describe, expect, it, vi } from "vitest"

import { startBridgeServer } from "../../bridgeServer.ts"
import type { BridgeServer } from "../../bridgeServer.ts"
import { createPairing } from "../../pairing.ts"
import { createApiKeyVault } from "../../secrets/apiKeyVault.ts"
import type { RevocationMarker } from "../../secrets/revocationMarker.ts"
import { createFakePrismic } from "../../testing/fakePrismic.ts"
import { createMemorySecretStore } from "../../testing/memorySecretStore.ts"
import { createWindowChannels } from "../../windowChannels.ts"
import { createClaudeProvider } from "./claudeProvider.ts"
import type { KeyValidation, KeyValidator } from "./keyValidation.ts"

const origin = "http://localhost:5173"
const key = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234"
const servers: BridgeServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

interface Setup {
  port: number
  token: string
  store: ReturnType<typeof createMemorySecretStore>
  validated: string[]
  removed: string[]
  setValidation(value: KeyValidation): void
  // The next validations don't answer until the returned function is called.
  holdValidation(): (value?: KeyValidation) => void
  advance(ms: number): void
  logs: unknown[][]
}

async function setup(args: { stored?: string; env?: string; backend?: "keychain" | "file"; revocation?: RevocationMarker } = {}): Promise<Setup> {
  const port = await freePort()
  const pairing = createPairing({})
  const token = pairing.issueToken({ origin, mcpOrigin: "https://mcp.prismic.io" })
  const store = createMemorySecretStore(args.stored, args.backend)
  const vault = createApiKeyVault({ store, env: () => args.env, revocation: args.revocation })
  const validated: string[] = []
  let validation: KeyValidation = "valid"
  let time = 1_000_000
  const held: Array<(value: KeyValidation) => void> = []
  let holding = false
  const validate: KeyValidator = (candidate) => {
    validated.push(candidate)
    if (!holding) return Promise.resolve(validation)
    return new Promise<KeyValidation>((resolve) => held.push(resolve))
  }
  const provider = createClaudeProvider({ dataDir: "/tmp", vault, userClaudeHome: undefined, validateKey: validate, now: () => time })
  const removed: string[] = []
  provider.onCredentialsRemoved?.((notice) => removed.push(notice))
  const logs: unknown[][] = []
  for (const method of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((...logged: unknown[]) => void logs.push(logged))
  }
  servers.push(await startBridgeServer({
      port,
      extraOrigins: [origin],
      projectDir: "/tmp",
      providers: [provider],
      routes: [],
      pairing,
      prismicAuth: createFakePrismic().auth,
      channels: createWindowChannels(),
    }),)
  return {
    port,
    token,
    store,
    validated,
    removed,
    setValidation: (value) => void (validation = value),
    holdValidation() {
      holding = true
      return (value = "valid") => {
        holding = false
        for (const resolve of held.splice(0)) resolve(value)
      }
    },
    advance: (ms) => void (time += ms),
    logs,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

interface Reply {
  status: number
  body: string
  headers: Record<string, string | string[] | undefined>
}

function send(s: Setup, method: string, options: { body?: string; json?: unknown; token?: string | null; origin?: string | null; contentType?: string | null } = {}): Promise<Reply> {
  const payload = options.body ?? (options.json === undefined ? undefined : JSON.stringify(options.json))
  const headers: Record<string, string> = {}
  if (options.token !== null) headers.Authorization = `Bearer ${options.token ?? s.token}`
  if (options.origin !== null) headers.Origin = options.origin ?? origin
  if (payload !== undefined && options.contentType !== null) headers["Content-Type"] = options.contentType ?? "application/json"
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port: s.port, path: "/auth/claude/key", method, headers }, (response) => {
      const chunks: Buffer[] = []
      response.on("data", (chunk: Buffer) => chunks.push(chunk))
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: response.headers }))
    })
    request.on("error", reject)
    if (payload !== undefined) request.write(payload)
    request.end()
  })
}

async function status(s: Setup): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${s.port}/status`, { headers: { Authorization: `Bearer ${s.token}`, Origin: origin } })
  return ((await response.json()) as { agents: { claude: unknown } }).agents.claude
}

describe("PUT /auth/claude/key", () => {
  it("validates the key, stores it and answers 204", async () => {
    const s = await setup()

    const reply = await send(s, "PUT", { json: { key } })

    expect(reply.status).toBe(204)
    expect(reply.body).toBe("")
    expect(s.validated).toEqual([key])
    expect(s.store.value()).toBe(key)
  })

  it("replaces a key that is already stored", async () => {
    const s = await setup({ stored: "sk-ant-api03-OLDOLDOLDOLDOLDOLDOLDOLD0000" })

    expect((await send(s, "PUT", { json: { key } })).status).toBe(204)

    expect(s.store.value()).toBe(key)
  })

  it.each([
    ["not a key", { key: "hello" }],
    ["too short", { key: "sk-ant-short" }],
    ["wrong prefix", { key: "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234" }],
    ["bad characters", { key: "sk-ant-api03-ABCDEFGHIJKLMNOP QRSTUVWXYZ" }],
    ["a newline in it", { key: "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ\n" }],
    ["too long", { key: `sk-ant-${"a".repeat(401)}` }],
    ["no key field", { notKey: key }],
    ["a number", { key: 42 }],
    ["an array", [key]],
  ])("answers 400 invalid_format for %s, without echoing it or asking Anthropic", async (_name, json) => {
    const s = await setup()

    const reply = await send(s, "PUT", { json })

    expect(reply.status).toBe(400)
    expect(JSON.parse(reply.body)).toEqual({ error: "invalid_format" })
    expect(s.validated).toEqual([])
    expect(s.store.value()).toBeUndefined()
  })

  it("answers 400 invalid_format for a body that isn't JSON", async () => {
    const s = await setup()

    const reply = await send(s, "PUT", { body: "not json" })

    expect([400]).toContain(reply.status)
    expect(s.store.value()).toBeUndefined()
  })

  it("answers 400 invalid_key when Anthropic refuses the key, and stores nothing", async () => {
    const s = await setup()
    s.setValidation("invalid")

    const reply = await send(s, "PUT", { json: { key } })

    expect(reply.status).toBe(400)
    expect(JSON.parse(reply.body)).toEqual({ error: "invalid_key" })
    expect(reply.body).not.toContain(key)
    expect(s.store.value()).toBeUndefined()
  })

  it("answers 502 validation_unavailable when Anthropic can't be asked, and stores nothing", async () => {
    const s = await setup()
    s.setValidation("unavailable")

    const reply = await send(s, "PUT", { json: { key } })

    expect(reply.status).toBe(502)
    expect(JSON.parse(reply.body)).toEqual({ error: "validation_unavailable" })
    expect(s.store.value()).toBeUndefined()
  })

  it("keeps the old key when the new one is refused", async () => {
    const s = await setup({ stored: "sk-ant-api03-OLDOLDOLDOLDOLDOLDOLDOLD0000" })
    s.setValidation("invalid")

    await send(s, "PUT", { json: { key } })

    expect(s.store.value()).toBe("sk-ant-api03-OLDOLDOLDOLDOLDOLDOLDOLD0000")
  })

  it("accepts only JSON", async () => {
    const s = await setup()

    expect((await send(s, "PUT", { body: JSON.stringify({ key }), contentType: "text/plain" })).status).toBe(415)
    expect((await send(s, "PUT", { body: JSON.stringify({ key }), contentType: null })).status).toBe(415)
    expect(s.validated).toEqual([])
  })

  it.each(["application/jsonp", "application/json-patch+json", "application/vnd.x+json", "text/application/json", "application/json; boundary=x", "application/json, text/plain"])(
    "refuses %s as the media type",
    async (contentType) => {
      const s = await setup()

      expect((await send(s, "PUT", { body: JSON.stringify({ key }), contentType })).status).toBe(415)
      expect(s.validated).toEqual([])
    },
  )

  it.each(["application/json", "Application/JSON", "application/json; charset=utf-8", "application/json;charset=UTF-8", 'application/json; charset="utf-8"'])(
    "accepts the JSON media type as %s",
    async (contentType) => {
      const s = await setup()

      expect((await send(s, "PUT", { body: JSON.stringify({ key }), contentType })).status).toBe(204)
    },
  )

  it("refuses a body over 4 KiB", async () => {
    const s = await setup()

    const reply = await send(s, "PUT", { json: { key, padding: "x".repeat(5000) } })

    expect(reply.status).toBe(413)
    expect(s.validated).toEqual([])
  })

  it("is read-only when the key comes from the environment", async () => {
    const s = await setup({ env: "sk-ant-api03-FROMTHEENVIRONMENT9999" })

    const reply = await send(s, "PUT", { json: { key } })

    expect(reply.status).toBe(409)
    expect(JSON.parse(reply.body)).toEqual({ error: "managed_by_environment" })
    expect(s.validated).toEqual([])
    expect(s.store.value()).toBeUndefined()
  })

  it("needs a paired browser's token", async () => {
    const s = await setup()

    expect((await send(s, "PUT", { json: { key }, token: null })).status).toBe(401)
    expect((await send(s, "PUT", { json: { key }, token: "nope" })).status).toBe(401)
    expect(s.validated).toEqual([])
  })

  it("needs an allowed origin", async () => {
    const s = await setup()

    expect((await send(s, "PUT", { json: { key }, origin: "https://evil.example" })).status).toBe(403)
    expect(s.validated).toEqual([])
  })

  it("limits attempts to 5 a minute, whatever they were, then lets them through again", async () => {
    const s = await setup()
    s.setValidation("invalid")

    for (let attempt = 0; attempt < 5; attempt++) expect((await send(s, "PUT", { json: { key } })).status).toBe(400)
    const limited = await send(s, "PUT", { json: { key } })

    expect(limited.status).toBe(429)
    expect(JSON.parse(limited.body)).toEqual({ error: "too_many_attempts" })
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0)
    expect(s.validated).toHaveLength(5)

    s.advance(61_000)
    s.setValidation("valid")
    expect((await send(s, "PUT", { json: { key } })).status).toBe(204)
  })

  it("counts malformed attempts too, so format errors can't be used to probe either", async () => {
    const s = await setup()

    for (let attempt = 0; attempt < 5; attempt++) await send(s, "PUT", { json: { key: "bad" } })

    expect((await send(s, "PUT", { json: { key } })).status).toBe(429)
  })

  it("never logs the key", async () => {
    const s = await setup()
    s.setValidation("invalid")
    await send(s, "PUT", { json: { key } })
    s.setValidation("unavailable")
    await send(s, "PUT", { json: { key } })
    s.setValidation("valid")
    await send(s, "PUT", { json: { key } })

    expect(JSON.stringify(s.logs)).not.toContain(key)
  })

  it("does not tell the key apart from a failure of the store", async () => {
    const s = await setup()
    s.store.set = () => Promise.reject(new Error(`keychain exploded with ${key}`))

    const reply = await send(s, "PUT", { json: { key } })

    expect(reply.status).toBe(500)
    expect(JSON.parse(reply.body)).toEqual({ error: "storage_failed" })
    expect(JSON.stringify([reply, s.logs])).not.toContain(key)
  })
})

describe("DELETE /auth/claude/key", () => {
  it("removes the key, tells the agents' owner, and answers 204", async () => {
    const s = await setup({ stored: key })

    const reply = await send(s, "DELETE")

    expect(reply.status).toBe(204)
    expect(s.store.value()).toBeUndefined()
    expect(s.removed).toEqual(["Add your Anthropic API key to use Claude."])
  })

  it("is idempotent: 204 when there is no key", async () => {
    const s = await setup()

    expect((await send(s, "DELETE")).status).toBe(204)
    expect((await send(s, "DELETE")).status).toBe(204)
  })

  it("is read-only when the key comes from the environment", async () => {
    const s = await setup({ env: "sk-ant-api03-FROMTHEENVIRONMENT9999" })

    const reply = await send(s, "DELETE")

    expect(reply.status).toBe(409)
    expect(JSON.parse(reply.body)).toEqual({ error: "managed_by_environment" })
    expect(s.removed).toEqual([])
  })

  it("needs a token and an allowed origin", async () => {
    const s = await setup({ stored: key })

    expect((await send(s, "DELETE", { token: null })).status).toBe(401)
    expect((await send(s, "DELETE", { origin: "https://evil.example" })).status).toBe(403)
    // An allowed editor origin the token was not issued to.
    expect((await send(s, "DELETE", { origin: "https://foo.prismic.io" })).status).toBe(401)
    expect(s.store.value()).toBe(key)
  })

  it("is not rate limited like PUT", async () => {
    const s = await setup()

    for (let attempt = 0; attempt < 8; attempt++) expect((await send(s, "DELETE")).status).toBe(204)
  })
})

describe("GET /status for claude", () => {
  it("follows the key: missing, then configured with a hint, then missing again", async () => {
    const s = await setup()
    expect(await status(s)).toEqual({ account: { kind: "apiKey", status: "missing", storage: "keychain" } })

    await send(s, "PUT", { json: { key } })
    const configured = await status(s)
    expect(configured).toEqual({ account: { kind: "apiKey", status: "configured", keyHint: "…1234", storage: "keychain" } })
    expect(JSON.stringify(configured)).not.toContain(key)

    await send(s, "DELETE")
    expect(await status(s)).toEqual({ account: { kind: "apiKey", status: "missing", storage: "keychain" } })
  })

  it("says where the key is kept: file fallback and environment", async () => {
    expect(await status(await setup({ backend: "file" }))).toMatchObject({ account: { storage: "file" } })
    expect(await status(await setup({ env: "sk-ant-api03-FROMTHEENVIRONMENT9999" }))).toEqual({
      account: { kind: "apiKey", status: "configured", keyHint: "…9999", storage: "env" },
    })
  })

  it("answers the preflight for PUT and DELETE from an allowed origin", async () => {
    const s = await setup()

    const response = await fetch(`http://127.0.0.1:${s.port}/auth/claude/key`, {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "PUT" },
    })

    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST, PUT, DELETE, OPTIONS")
    expect(response.headers.get("access-control-allow-origin")).toBe(origin)
  })
})

// A PUT whose body is still on its way: the request has been received (the handler is running) and waits for the rest.
async function startSlowPut(s: Setup, body: unknown): Promise<{ finish(): Promise<Reply> }> {
  const payload = JSON.stringify(body)
  const cut = Math.floor(payload.length / 2)
  const request = httpRequest({
    host: "127.0.0.1",
    port: s.port,
    path: "/auth/claude/key",
    method: "PUT",
    headers: { Authorization: `Bearer ${s.token}`, Origin: origin, "Content-Type": "application/json" },
  })
  const reply = new Promise<Reply>((resolve, reject) => {
    request.on("response", (response) => {
      const chunks: Buffer[] = []
      response.on("data", (chunk: Buffer) => chunks.push(chunk))
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: response.headers }))
    })
    request.on("error", reject)
  })
  request.write(payload.slice(0, cut))
  // Long enough for the server to have received the headers and be waiting for the rest.
  await new Promise((resolve) => setTimeout(resolve, 150))
  return {
    finish() {
      request.end(payload.slice(cut))
      return reply
    },
  }
}


describe("a revocation that can't be recorded", () => {
  const failing: RevocationMarker = {
    isSet: () => false,
    record() {
      throw new Error("disk full: sk-ant-api03-MUSTNOTAPPEARANYWHERE0000")
    },
    clear() {},
  }

  it("fails the DELETE with a fixed 500, not a silent success, and the key stays", async () => {
    const s = await setup({ stored: key, revocation: failing })

    const reply = await send(s, "DELETE")

    expect(reply.status).toBe(500)
    expect(JSON.parse(reply.body)).toEqual({ error: "storage_failed" })
    expect(s.store.value()).toBe(key)
    expect(JSON.stringify(s.logs)).not.toContain("MUSTNOTAPPEAR")
  })

  it("fails the PUT with a fixed 500 and stores nothing", async () => {
    const s = await setup({ revocation: failing })

    const reply = await send(s, "PUT", { json: { key } })

    expect(reply.status).toBe(500)
    expect(JSON.parse(reply.body)).toEqual({ error: "storage_failed" })
    expect(s.store.value()).toBeUndefined()
  })
})

describe("credential mutations that overlap", () => {
  const first = "sk-ant-api03-FIRSTFIRSTFIRSTFIRSTFIRST1111"
  const second = "sk-ant-api03-SECONDSECONDSECONDSECOND2222"

  async function put(s: Setup, body: unknown): Promise<Reply> {
    return send(s, "PUT", { json: body })
  }

  async function waitForValidations(s: Setup, count: number): Promise<void> {
    await vi.waitFor(() => expect(s.validated).toHaveLength(count))
  }

  it("answers 409 superseded and stores nothing when a DELETE completed while Anthropic was being asked", async () => {
    const s = await setup({ stored: "sk-ant-api03-OLDOLDOLDOLDOLDOLDOLDOLD0000" })
    const release = s.holdValidation()
    const pending = put(s, { key })
    await waitForValidations(s, 1)

    expect((await send(s, "DELETE")).status).toBe(204)
    expect(s.store.value()).toBeUndefined()
    release("valid")
    const reply = await pending

    expect(reply.status).toBe(409)
    expect(JSON.parse(reply.body)).toEqual({ error: "superseded" })
    expect(s.store.value()).toBeUndefined()
    expect(await status(s)).toMatchObject({ account: { status: "missing" } })
  })

  describe("while a PUT is still streaming its body", () => {
    it("is superseded by a DELETE that completes first: nothing is stored, and Anthropic is never asked", async () => {
      const s = await setup({ stored: "sk-ant-api03-OLDOLDOLDOLDOLDOLDOLDOLD0000" })
      const slow = await startSlowPut(s, { key })

      expect((await send(s, "DELETE")).status).toBe(204)
      const reply = await slow.finish()

      expect(reply.status).toBe(409)
      expect(JSON.parse(reply.body)).toEqual({ error: "superseded" })
      expect(s.validated).toEqual([])
      expect(s.store.value()).toBeUndefined()
      expect(await status(s)).toMatchObject({ account: { status: "missing" } })
    })

    it("is superseded by a newer PUT that completes first: the newer key stays", async () => {
      const s = await setup()
      const slow = await startSlowPut(s, { key: first })

      expect((await put(s, { key: second })).status).toBe(204)
      const reply = await slow.finish()

      expect(reply.status).toBe(409)
      expect(JSON.parse(reply.body)).toEqual({ error: "superseded" })
      expect(s.validated).toEqual([second])
      expect(s.store.value()).toBe(second)
    })

    it("still stores the key when nothing else happened in the meantime", async () => {
      const s = await setup()
      const slow = await startSlowPut(s, { key })

      expect((await slow.finish()).status).toBe(204)

      expect(s.store.value()).toBe(key)
    })

    it("does not let a request that is refused before its body (wrong media type, rate limit) supersede anything", async () => {
      const s = await setup()
      const slow = await startSlowPut(s, { key })

      expect((await send(s, "PUT", { body: "x", contentType: "text/plain" })).status).toBe(415)

      expect((await slow.finish()).status).toBe(204)
    })
  })

  it("lets the last PUT win: the earlier one that answers later is superseded", async () => {
    const s = await setup()
    const release = s.holdValidation()
    const earlier = put(s, { key: first })
    await waitForValidations(s, 1)
    const later = put(s, { key: second })
    await waitForValidations(s, 2)

    release("valid")
    const replies = await Promise.all([earlier, later])

    expect(replies.map((reply) => reply.status).sort()).toEqual([204, 409])
    expect(s.store.value()).toBe(second)
    expect(replies[0].status).toBe(409)
  })

  it("lets a PUT that was admitted after a DELETE store its key", async () => {
    const s = await setup({ stored: first })
    const release = s.holdValidation()
    const pending = put(s, { key: second })
    await waitForValidations(s, 1)

    release("valid")
    expect((await pending).status).toBe(204)
    await send(s, "DELETE")
    expect((await put(s, { key })).status).toBe(204)

    expect(s.store.value()).toBe(key)
  })

  it("does not let a rejected or unreachable validation supersede anything stored", async () => {
    const s = await setup({ stored: first })
    s.setValidation("unavailable")

    expect((await put(s, { key: second })).status).toBe(502)

    expect(s.store.value()).toBe(first)
  })

  it("keeps the vault empty however many PUTs were in flight when the DELETE came", async () => {
    const s = await setup()
    const release = s.holdValidation()
    const pending = [put(s, { key: first }), put(s, { key: second }), put(s, { key })]
    await waitForValidations(s, 3)

    await send(s, "DELETE")
    release("valid")
    const replies = await Promise.all(pending)

    expect(replies.map((reply) => reply.status)).toEqual([409, 409, 409])
    expect(s.store.value()).toBeUndefined()
  })
})
