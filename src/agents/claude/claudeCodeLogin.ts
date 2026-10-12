import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { z } from "zod"

import type { AgentSignInResult } from "../provider.ts"
import { buildChildEnvironment } from "../../conversations/childEnv.ts"

const execFileAsync = promisify(execFile)
const checkTimeoutMs = 10_000
// The browser flow waits for the user: bounded, so a closed tab doesn't keep `claude auth login` around forever.
const signInTimeoutMs = 5 * 60_000

const AuthStatusSchema = z.object({
  loggedIn: z.boolean(),
  email: z.string().optional(),
  subscriptionType: z.string().optional(),
})

interface DescribeClaudeCodeLoginArgs {
  binaryPath: string | undefined
  // The Claude config directory the agent runs with (--use-user-claude); Claude Code's default one when undefined.
  configDir?: string
  // Aborting kills the probe: the daemon is shutting down.
  signal?: AbortSignal
}

// Who the Claude Code login of this computer is, as a line for the desktop app's menu. It asks the very binary the
// agent runs (`claude auth status`) with the environment the agent gets, so the answer is the one the agent would see.
export async function describeClaudeCodeLogin(args: DescribeClaudeCodeLoginArgs): Promise<string> {
  const { binaryPath, configDir, signal } = args
  if (binaryPath === undefined) return "Claude: Claude Code login (checked once Claude has been downloaded)"
  try {
    const stdout = await readAuthStatus({ binaryPath, env: claudeChildEnvironment(configDir), signal })
    const status = AuthStatusSchema.parse(JSON.parse(stdout))
    if (!status.loggedIn) return "Claude: Claude Code isn't signed in"
    const who = status.email ?? "signed in"
    return status.subscriptionType === undefined ? `Claude: ${who}` : `Claude: ${who} (${status.subscriptionType})`
  } catch {
    return "Claude: couldn't check the Claude Code login"
  }
}

interface SignInToClaudeCodeArgs {
  binaryPath: string | undefined
  // The Claude config directory the agent runs with (--use-user-claude); Claude Code's default one when undefined.
  configDir?: string
  // Aborting kills `claude auth login`: the daemon is shutting down.
  signal?: AbortSignal
}

// Signs the Claude Code login of this computer in when it isn't: `claude auth login --claudeai` opens the browser by
// itself and returns once the user is done there. It is the very binary and environment the agent runs with, so the
// login lands where the agent looks for it. Never reports the output of the login: it holds the authorization URL.
export async function signInToClaudeCode(args: SignInToClaudeCodeArgs): Promise<AgentSignInResult> {
  const { binaryPath, configDir, signal } = args
  if (binaryPath === undefined) return { status: "failed", reason: "Claude Code isn't downloaded yet." }
  const env = claudeChildEnvironment(configDir)
  try {
    if (await isLoggedIn({ binaryPath, env, signal })) return { status: "already_signed_in" }
    await execFileAsync(binaryPath, ["auth", "login", "--claudeai"], { env, timeout: signInTimeoutMs, signal })
    if (await isLoggedIn({ binaryPath, env, signal })) return { status: "signed_in" }
    return { status: "failed", reason: "The sign-in finished, but Claude Code still isn't signed in." }
  } catch (error) {
    if (typeof error === "object" && error !== null && "killed" in error && error.killed === true) {
      return { status: "failed", reason: "The sign-in took too long or was stopped." }
    }
    return { status: "failed", reason: "The sign-in didn't complete." }
  }
}

async function isLoggedIn(args: ReadAuthStatusArgs): Promise<boolean> {
  return AuthStatusSchema.parse(JSON.parse(await readAuthStatus(args))).loggedIn
}

function claudeChildEnvironment(configDir: string | undefined): Record<string, string> {
  return buildChildEnvironment({
    source: process.env,
    provided: [configDir === undefined ? {} : { CLAUDE_CONFIG_DIR: configDir }],
    passEnv: [],
  })
}

interface ReadAuthStatusArgs {
  binaryPath: string
  env: Record<string, string>
  signal: AbortSignal | undefined
}

async function readAuthStatus(args: ReadAuthStatusArgs): Promise<string> {
  const { binaryPath, env, signal } = args
  try {
    const { stdout } = await execFileAsync(binaryPath, ["auth", "status"], { env, timeout: checkTimeoutMs, signal })
    return stdout
  } catch (error) {
    // `claude auth status` exits with 1 when nobody is signed in, and still prints its JSON.
    if (typeof error === "object" && error !== null && "stdout" in error && typeof error.stdout === "string") {
      return error.stdout
    }
    throw error
  }
}
