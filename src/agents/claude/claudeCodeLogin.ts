import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { z } from "zod"

import { buildChildEnvironment } from "../../conversations/childEnv.ts"

const execFileAsync = promisify(execFile)
const checkTimeoutMs = 10_000

const AuthStatusSchema = z.object({
  loggedIn: z.boolean(),
  email: z.string().optional(),
  subscriptionType: z.string().optional(),
})

// Who the Claude Code login of this computer is, as a line for the desktop app's menu. It asks the very binary the
// agent runs (`claude auth status`) with the environment the agent gets, so the answer is the one the agent would see.
export async function describeClaudeCodeLogin(args: { binaryPath: string | undefined }): Promise<string> {
  if (args.binaryPath === undefined) return "Claude: Claude Code login (checked once Claude has been downloaded)"
  try {
    const { stdout } = await execFileAsync(args.binaryPath, ["auth", "status"], {
      env: buildChildEnvironment({ source: process.env, provided: [], passEnv: [] }),
      timeout: checkTimeoutMs,
    })
    const status = AuthStatusSchema.parse(JSON.parse(stdout))
    if (!status.loggedIn) return "Claude: Claude Code isn't signed in"
    const who = status.email ?? "signed in"
    return status.subscriptionType === undefined ? `Claude: ${who}` : `Claude: ${who} (${status.subscriptionType})`
  } catch {
    return "Claude: couldn't check the Claude Code login"
  }
}
