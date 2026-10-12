// Account-global commands, or ones that start turns outside the bridge's sandbox and approval policy.
export const blockedCommands = ["logout", "review", "review-branch", "review-commit", "goal"] as const

// Not offered in the command list because the browser has a dedicated control, but still forwarded when typed.
// /plan is the collaboration_mode toggle.
export const hiddenCommands = ["plan"] as const

// Mirrors codex-acp 2.1.1 CodexCommands.parseCommand on the first text block, step for step: trim, require a leading
// "/", trim again, split the first token on whitespace, lowercase it. Any difference is a way around the blocklist
// ("/ logout", "/\u00a0review", " /goal"), so keep this identical, whitespace definition included.
export function parseSlashCommand(text: string): string | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith("/")) return undefined
  const commandText = trimmed.slice(1).trim()
  if (commandText.length === 0) return undefined
  const [name] = commandText.split(/\s+/)
  if (!name) return undefined
  return name.toLowerCase()
}

// codex-acp leaves "$skill" to the model, so that is the only slash form that is not a native command.
export function nativeCommandName(text: string): string | undefined {
  const name = parseSlashCommand(text)
  return name !== undefined && !name.startsWith("$") ? name : undefined
}
