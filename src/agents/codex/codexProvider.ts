import { sendHtml, sendJson } from "../../httpUtils.ts"
import { errorMessage } from "../../errors.ts"
import { AgentAuthError } from "../provider.ts"
import type { AgentProvider, ProviderRoute } from "../provider.ts"
import type { AgentRuntime } from "../agentRuntime.ts"
import { ChatGptAuthError } from "./chatgptAuth.ts"
import type { ChatGptAuth, ChatGptAuthErrorCode } from "./chatgptAuth.ts"
import { blockedCommands, hiddenCommands, nativeCommandName } from "./commands.ts"
import { buildCodexConfigEnv, isolatedCodexHomePath, resolveCodexAcpBin, writeCodexHome } from "./codexConfig.ts"
import type { AgentMode } from "./modes.ts"
import { identifyToolCall, readToolResult } from "./toolCalls.ts"

const authErrorNotices: Record<ChatGptAuthErrorCode, string> = {
  signed_out: "Sign in with ChatGPT to use the local agent.",
  plan_usage_disabled:
    "ChatGPT plan use isn't enabled for Prismic Local Agent. Use Continue with ChatGPT again to enable it.",
  refresh_failed: "Couldn't refresh the ChatGPT session. Try again in a moment.",
}

export interface CodexProviderArgs {
  dataDir: string
  auth: ChatGptAuth
  // Set with --use-user-codex: run against this existing Codex home instead of an isolated one.
  userCodexHome: string | undefined
  agentMode: AgentMode
  model: string | undefined
  // The ChatGPT access token is refreshed when it has less validity left than this.
  refreshMarginMs: number
  // Overrides the codex-acp entry point; only tests pass it.
  agentBin?: string
  // Downloads the Codex binary on first use; absent when node_modules has it.
  runtime?: AgentRuntime
}

// Codex over ACP (codex-acp), billed on the user's ChatGPT plan through "Sign in with ChatGPT".
export function createCodexProvider(args: CodexProviderArgs): AgentProvider {
  const { dataDir, auth, userCodexHome, agentMode, model, refreshMarginMs, agentBin, runtime } = args

  return {
    id: "codex",
    label: "Codex",
    blockedCommands,
    hiddenCommands,
    protectedConfigIds: ["mode"],
    runtime,
    sessionRestartedNotice:
      "Started a new agent session after renewing the ChatGPT token; earlier messages aren't in the agent's memory.",

    async authenticate() {
      try {
        const token = await auth.getAccessToken(refreshMarginMs)
        return { fingerprint: String(token.expiresAt), env: { ACCESS_TOKEN: token.accessToken } }
      } catch (error) {
        if (error instanceof ChatGptAuthError) throw new AgentAuthError(authErrorNotices[error.code])
        throw error
      }
    },

    spawnSpec() {
      const codexEnv: Record<string, string> =
        userCodexHome === undefined
          ? { CODEX_HOME: writeCodexHome({ dataDir, model }) }
          : { CODEX_HOME: userCodexHome, CODEX_CONFIG: buildCodexConfigEnv({ model }) }
      return {
        command: process.execPath,
        args: [agentBin ?? resolveCodexAcpBin()],
        env: {
          ...codexEnv,
          ...runtime?.env(),
          MODEL_PROVIDER: "openai_chatgpt_plan",
          INITIAL_AGENT_MODE: agentMode,
          NO_BROWSER: "1",
        },
      }
    },

    nativeCommandName,
    identifyToolCall,
    readToolResult,

    describePromptError(error) {
      const details = [errorMessage(error)]
      const data: unknown = (error as { data?: unknown } | null)?.data
      if (data !== undefined) details.push(JSON.stringify(data))
      if (details.join(" ").includes("subscription_sharing_usage_limit_exceeded")) {
        return "ChatGPT plan usage limit reached. Manage usage: https://chatgpt.com/settings/usage"
      }
      return undefined
    },

    getStatus() {
      return {
        agentMode,
        ...(model === undefined ? {} : { model }),
        account: { kind: "chatgpt", ...auth.getStatus() },
      }
    },

    async accountSummary() {
      const status = auth.getStatus()
      if (status.status !== "signed_in") return "Codex: not signed in"
      return `Codex: ${status.email ?? "signed in with ChatGPT"}`
    },

    bannerLines() {
      return [
        `Agent mode: ${agentMode}${model === undefined ? "" : `, model: ${model}`}`,
        userCodexHome === undefined
          ? `Codex home: ${isolatedCodexHomePath(dataDir)} (isolated)`
          : `Codex home: ${userCodexHome} (user)`,
        `ChatGPT: ${auth.getStatus().status}`,
      ]
    },

    routes() {
      const routes: ProviderRoute[] = [
        {
          method: "GET",
          path: "/auth/callback",
          auth: "none",
          originExempt: true,
          async handle({ res, url }) {
            const result = await auth.handleCallback(url)
            sendHtml(res, result.ok ? 200 : 400, result.ok ? "Signed in" : "Sign-in failed", result.message)
          },
        },
        {
          method: "POST",
          path: "/auth/chatgpt/start",
          auth: "bearer",
          handle({ res }) {
            sendJson(res, 200, { authorizationUrl: auth.startSignIn() })
          },
        },
        {
          method: "POST",
          path: "/auth/chatgpt/sign-out",
          auth: "bearer",
          async handle({ res }) {
            await auth.signOut()
            res.writeHead(204)
            res.end()
          },
        },
      ]
      return routes
    },
  }
}
