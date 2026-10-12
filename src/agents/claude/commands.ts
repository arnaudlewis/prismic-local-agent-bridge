// Claude Code slash commands that must not be reachable from the browser: they change the account, the settings or
// the permission policy for good, schedule autonomous work, or start work outside the local sandbox. A prompt that
// starts with one is not forwarded and the command is dropped from the list offered to the browser.
export const blockedCommands = [
  // The account.
  "login",
  "logout",
  "upgrade",
  "privacy-settings",
  "design-consent",
  "design-revoke",
  // Settings and the permission policy, which outlive the conversation.
  "config",
  "permissions",
  "allowed-tools",
  "update-config",
  "fewer-permission-prompts",
  "auto-mode-setup",
  "hooks",
  "sandbox",
  "statusline",
  "add-dir",
  // Code that gets installed, other tools' settings, subagent definitions.
  "plugin",
  "plugins",
  "marketplace",
  "reload-plugins",
  "import",
  "agents",
  "install-github-app",
  "terminal-setup",
  // Autonomous, recurring or remote work that bypasses the turn the user started.
  "goal",
  "loop",
  "schedule",
  "__remote-workflow",
  "workflow-launch-exec",
  // The conversation itself belongs to the bridge, which stores and resumes it.
  "clear",
  "resume",
  "rewind",
  "export",
] as const

// The browser has a control for these (model, effort and fast mode are config options), so they are not offered;
// typed, they are still forwarded.
export const hiddenCommands = ["model", "effort", "fast"] as const

// Claude Code treats a message as a command only when it starts with "/" (no leading whitespace, and "/ name" isn't
// one) followed by the name up to the first whitespace. Verified against claude-agent-acp 0.89.1 with local-only
// commands: "/context" and "/context\n" run, " /context", "\n/context", "/ context" and "/\tcontext" go to the model.
export function nativeCommandName(text: string): string | undefined {
  const match = /^\/(\S+)/.exec(text)
  return match?.[1]?.toLowerCase()
}

// Every name the text could run under a more lenient parser (leading whitespace and invisible characters, space
// after the slash, other case). A newer Claude Code might read more than the one verified above: over-blocking is the
// safe side of a difference.
export function commandNameCandidates(text: string): string[] {
  const names = new Set<string>()
  const exact = nativeCommandName(text)
  if (exact !== undefined) names.add(exact)
  const stripped = text.replace(/^[\s\u200b-\u200d\u2060\ufeff]+/, "")
  const lenient = /^\/[\s\u200b-\u200d\u2060\ufeff]*(\S+)/.exec(stripped)?.[1]?.toLowerCase()
  if (lenient !== undefined) names.add(lenient)
  return [...names]
}
