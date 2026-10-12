// What an agent child inherits from the daemon: an explicit allowlist, never the daemon's whole environment. The
// daemon runs next to cloud credentials (AWS_*, GITHUB_TOKEN, ...), another agent's key (OPENAI_*, ANTHROPIC_*) and
// backend switches; an agent that can be prompt-injected must not find any of them. A provider adds its own variables
// and credentials on top; the user opts in to more with --pass-env.
const baseNames = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "TERM",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  // Windows.
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "COMSPEC",
  "PATHEXT",
  "WINDIR",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  // XDG base directories.
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  // Proxies and TLS trust: without them the agent can't reach its API from behind a corporate proxy.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
] as const

export const passEnvNamePattern = /^[A-Z_][A-Z0-9_]*$/

export const baseEnvNames: readonly string[] = baseNames

function isBaseName(name: string): boolean {
  if (baseNames.includes(name as (typeof baseNames)[number])) return true
  return /^LC_[A-Z_]+$/.test(name)
}

interface ChildEnvironmentArgs {
  // The daemon's environment.
  source: Record<string, string | undefined>
  // The provider's own variables and the credentials: always passed, and they win.
  provided: Record<string, string | undefined>[]
  // --pass-env: variables the user chose to hand to the agents.
  passEnv: readonly string[]
  // Windows variable names are case-insensitive (Path, PATH).
  caseInsensitive?: boolean
}

export function buildChildEnvironment(args: ChildEnvironmentArgs): Record<string, string> {
  const fold = (name: string) => (args.caseInsensitive === true ? name.toUpperCase() : name)
  const passed = new Set(args.passEnv.map(fold))
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(args.source)) {
    if (value === undefined) continue
    if (isBaseName(fold(name)) || passed.has(fold(name))) env[name] = value
  }
  for (const provided of args.provided) {
    for (const [name, value] of Object.entries(provided)) {
      if (value !== undefined) env[name] = value
    }
  }
  return env
}
