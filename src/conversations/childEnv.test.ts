import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { createClaudeProvider } from "../agents/claude/claudeProvider.ts"
import { createCodexProvider } from "../agents/codex/codexProvider.ts"
import { createApiKeyVault } from "../secrets/apiKeyVault.ts"
import { createMemorySecretStore } from "../testing/memorySecretStore.ts"
import { conversationId, createHarness, fakeAgentBin, liveAgentText, windowId } from "../testing/harness.ts"
import type { Session } from "../protocol.ts"
import { baseEnvNames, buildChildEnvironment, passEnvNamePattern } from "./childEnv.ts"

const secret = "never-printed-value"

describe("buildChildEnvironment", () => {
  const build = (source: Record<string, string | undefined>, extra: Partial<Parameters<typeof buildChildEnvironment>[0]> = {}) =>
    buildChildEnvironment({ source, provided: [], passEnv: [], ...extra })

  it.each(baseEnvNames.map((name) => [name]))("passes the base variable %s", (name) => {
    expect(Object.keys(build({ [name]: "x" }))).toEqual([name])
  })

  it.each([["LC_ALL"], ["LC_CTYPE"], ["LC_MESSAGES"], ["LC_TIME"]])("passes the locale variable %s", (name) => {
    expect(Object.keys(build({ [name]: "x" }))).toEqual([name])
  })

  it.each([
    ["AWS_SECRET_ACCESS_KEY"],
    ["AWS_PROFILE"],
    ["GOOGLE_APPLICATION_CREDENTIALS"],
    ["GITHUB_TOKEN"],
    ["GH_TOKEN"],
    ["OPENAI_API_KEY"],
    ["ANTHROPIC_API_KEY"],
    ["ANTHROPIC_AUTH_TOKEN"],
    ["ANTHROPIC_BASE_URL"],
    ["CLAUDE_CODE_OAUTH_TOKEN"],
    ["CLAUDE_CODE_USE_BEDROCK"],
    ["CLAUDE_CODE_EXECUTABLE"],
    ["CLAUDE_CONFIG_DIR"],
    ["CODEX_HOME"],
    ["CODEX_API_KEY"],
    ["NODE_OPTIONS"],
    ["SSH_AUTH_SOCK"],
    ["NPM_TOKEN"],
    ["DATABASE_URL"],
    ["LD_PRELOAD"],
    ["DYLD_INSERT_LIBRARIES"],
    ["LCX_NOT_A_LOCALE"],
    ["lc_all"],
    ["path"],
  ])("does not pass %s", (name) => {
    expect(build({ [name]: secret })).toEqual({})
  })

  it("passes the names the user chose with --pass-env, and only those", () => {
    const env = build({ GITHUB_TOKEN: secret, AWS_PROFILE: secret, PATH: "/bin" }, { passEnv: ["GITHUB_TOKEN"] })

    expect(Object.keys(env).sort()).toEqual(["GITHUB_TOKEN", "PATH"])
  })

  it("adds what the provider provides, which wins over the daemon's own value", () => {
    const env = build(
      { HOME: "/home/me", CODEX_HOME: "/elsewhere" },
      { provided: [{ CODEX_HOME: "/isolated", NO_BROWSER: "1" }, { ACCESS_TOKEN: "token" }] },
    )

    expect(env).toEqual({ HOME: "/home/me", CODEX_HOME: "/isolated", NO_BROWSER: "1", ACCESS_TOKEN: "token" })
  })

  it("lets the credentials override a variable the user passed", () => {
    const env = build({ ANTHROPIC_API_KEY: "daemon" }, { passEnv: ["ANTHROPIC_API_KEY"], provided: [{ ANTHROPIC_API_KEY: "vault" }] })

    expect(env).toEqual({ ANTHROPIC_API_KEY: "vault" })
  })

  it("skips undefined values", () => {
    expect(build({ PATH: undefined, HOME: "/h" }, { provided: [{ X: undefined }] })).toEqual({ HOME: "/h" })
  })

  it("matches Windows names case-insensitively only when asked", () => {
    expect(build({ Path: "C:\\bin", GitHub_Token: "x" }, { passEnv: ["GITHUB_TOKEN"] })).toEqual({})
    expect(build({ Path: "C:\\bin", GitHub_Token: "x", Aws_Profile: "p" }, { passEnv: ["GITHUB_TOKEN"], caseInsensitive: true })).toEqual({
      Path: "C:\\bin",
      GitHub_Token: "x",
    })
  })

  describe("--pass-env names", () => {
    it.each(["GITHUB_TOKEN", "_X", "A1_B2", "AWS_PROFILE"])("accepts %s", (name) => {
      expect(passEnvNamePattern.test(name)).toBe(true)
    })

    it.each(["github_token", "1ABC", "A-B", "A B", "A=B", "", "A\nB", "$(whoami)"])("rejects %j", (name) => {
      expect(passEnvNamePattern.test(name)).toBe(false)
    })
  })
})

const pollution: Record<string, string> = {
  AWS_SECRET_ACCESS_KEY: secret,
  AWS_PROFILE: secret,
  GOOGLE_APPLICATION_CREDENTIALS: secret,
  GITHUB_TOKEN: secret,
  OPENAI_API_KEY: secret,
  ANTHROPIC_API_KEY: secret,
  ANTHROPIC_AUTH_TOKEN: secret,
  ANTHROPIC_BASE_URL: secret,
  CLAUDE_CODE_OAUTH_TOKEN: secret,
  CLAUDE_CODE_USE_BEDROCK: "1",
  CLAUDE_CODE_EXECUTABLE: secret,
  CODEX_API_KEY: secret,
  NODE_OPTIONS: "--max-old-space-size=1",
  SSH_AUTH_SOCK: secret,
  DATABASE_URL: secret,
}

const legitimate: Record<string, string> = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/someone",
  USER: "someone",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  TERM: "xterm",
  TMPDIR: "/tmp",
  XDG_CONFIG_HOME: "/home/someone/.config",
  HTTPS_PROXY: "http://proxy.example:3128",
  no_proxy: "localhost",
  SSL_CERT_FILE: "/etc/ssl/cert.pem",
  NODE_EXTRA_CA_CERTS: "/etc/ssl/extra.pem",
}

const claudeKey = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234"
const session: Session = {
  agent: "codex",
  conversationId,
  mcpServerUrl: "http://localhost:3030/mcp",
  prismicToken: "token",
  repository: "repo",
}

// Runs a conversation against the fake agent standing in for the real adapter, with the daemon's environment replaced
// by a controlled, polluted one, and returns the names (never the values) the agent child was started with.
async function childEnvironmentNames(args: {
  agent: "codex" | "claude"
  passEnv?: string[]
  userHome?: string
}): Promise<string[]> {
  const dataDir = mkdtempSync(join(tmpdir(), "bridge-spawn-env-"))
  const saved = process.env
  process.env = { ...legitimate, ...pollution } as NodeJS.ProcessEnv
  try {
    const provider =
      args.agent === "codex"
        ? createCodexProvider({
            dataDir,
            auth: { getAccessToken: () => Promise.resolve({ accessToken: "access", expiresAt: 9_999_999_999_999 }), getStatus: () => ({ status: "signed_in", planUsage: true }) } as never,
            userCodexHome: args.userHome,
            agentMode: "read-only",
            model: undefined,
            refreshMarginMs: 1000,
            agentBin: fakeAgentBin,
          })
        : createClaudeProvider({
            dataDir,
            vault: createApiKeyVault({ store: createMemorySecretStore(claudeKey), env: () => undefined }),
            userClaudeHome: args.userHome,
            agentBin: fakeAgentBin,
          })
    // The fake agent can't be told Claude's modes through the environment here (it is what is being measured).
    const harness = createHarness({ dataDir, providers: [{ ...provider, initialConfig: undefined }], passEnv: args.passEnv ?? [] })
    const agentSession = { ...session, agent: args.agent }
    await harness.agents.handleMessage(windowId, { type: "chat_open", session: agentSession })
    await harness.agents.handleMessage(windowId, { type: "chat_prompt", text: "dump-env-names", session: agentSession })
    const text = liveAgentText(harness.events)
    harness.agents.stopAll()
    return (/envnames:(\S*)/.exec(text)?.[1] ?? "").split(",").filter(Boolean)
  } finally {
    process.env = saved
  }
}

describe("the complete environment of an agent child", () => {
  const legitimateNames = Object.keys(legitimate).sort()

  it.each([
    [
      "codex, isolated",
      { agent: "codex" as const },
      ["ACCESS_TOKEN", "CODEX_HOME", "INITIAL_AGENT_MODE", "MODEL_PROVIDER", "NO_BROWSER"],
    ],
    [
      "codex, with the user's Codex home",
      { agent: "codex" as const, userHome: "/tmp" },
      ["ACCESS_TOKEN", "CODEX_CONFIG", "CODEX_HOME", "INITIAL_AGENT_MODE", "MODEL_PROVIDER", "NO_BROWSER"],
    ],
    [
      "claude, isolated",
      { agent: "claude" as const },
      ["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "DISABLE_AUTOUPDATER", "NO_BROWSER"],
    ],
    [
      "claude, with the user's config dir",
      { agent: "claude" as const, userHome: "/tmp" },
      ["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "DISABLE_AUTOUPDATER", "NO_BROWSER"],
    ],
  ])("%s has exactly the allowlisted variables and the provider's own", async (_name, args, providerNames) => {
    const names = await childEnvironmentNames(args)

    expect(names).toEqual([...legitimateNames, ...providerNames].sort())
  })

  it.each([
    ["codex", "codex" as const],
    ["claude", "claude" as const],
  ])("does not leak the daemon's cloud, cross-provider or backend variables to %s", async (_name, agent) => {
    const names = await childEnvironmentNames({ agent })

    for (const polluted of Object.keys(pollution)) {
      // The one exception: the Claude child gets the key from the vault, under the same name as the daemon's own.
      if (agent === "claude" && polluted === "ANTHROPIC_API_KEY") continue
      expect(names, polluted).not.toContain(polluted)
    }
  })

  it("passes the names the user chose to both providers", async () => {
    for (const agent of ["codex", "claude"] as const) {
      const names = await childEnvironmentNames({ agent, passEnv: ["GITHUB_TOKEN", "AWS_PROFILE"] })

      expect(names).toContain("GITHUB_TOKEN")
      expect(names).toContain("AWS_PROFILE")
      expect(names).not.toContain("AWS_SECRET_ACCESS_KEY")
      expect(names).not.toContain("OPENAI_API_KEY")
    }
  })

  it("gives the Claude child the vault's key, not the daemon's own ANTHROPIC_API_KEY", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bridge-spawn-key-"))
    const saved = process.env
    process.env = { ...legitimate, ANTHROPIC_API_KEY: "sk-ant-api03-FROMTHEDAEMONSENVIRONMENT0000" } as NodeJS.ProcessEnv
    try {
      const provider = createClaudeProvider({
        dataDir,
        vault: createApiKeyVault({ store: createMemorySecretStore(claudeKey), env: () => undefined }),
        userClaudeHome: undefined,
        agentBin: fakeAgentBin,
      })
      const harness = createHarness({ dataDir, providers: [{ ...provider, initialConfig: undefined }], passEnv: [] })
      const claudeSession = { ...session, agent: "claude" as const }
      await harness.agents.handleMessage(windowId, { type: "chat_open", session: claudeSession })
      await harness.agents.handleMessage(windowId, { type: "chat_prompt", text: "env-tail ANTHROPIC_API_KEY", session: claudeSession })

      expect(liveAgentText(harness.events)).toContain(`envtail:ANTHROPIC_API_KEY=${claudeKey.slice(-4)}`)
      harness.agents.stopAll()
    } finally {
      process.env = saved
    }
  })

  it("never puts the secrets of the polluted environment into the names it reports", async () => {
    const names = await childEnvironmentNames({ agent: "codex" })

    expect(names.join(",")).not.toContain(secret)
  })
})
