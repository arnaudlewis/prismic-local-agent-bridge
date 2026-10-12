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
  // Proxies (the ones that can carry credentials are handled apart, see proxyUrlNamePattern) and TLS trust: without them the agent can't reach its API from behind a corporate proxy.
  "NO_PROXY",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
] as const

export const passEnvNamePattern = /^[A-Z_][A-Z0-9_]*$/

export const baseEnvNames: readonly string[] = baseNames

// Variables whose value is a proxy URL, in any letter case. A URL can carry credentials (user:password@host): those
// are the daemon's own, not the agent's, so such a value is only handed over when the user names the variable.
const proxyUrlNamePattern = /^(?:http|https|all)_proxy$/i

// Any "@" counts, wherever it is: parsers disagree about where the authority ends, and a proxy URL without
// credentials has no reason to contain one.
function hasCredentials(value: string): boolean {
  return value.includes("@")
}

// The proxy variables that hold credentials and were not passed, as the upper-case names --pass-env takes.
export function withheldProxyNames(args: { source: Record<string, string | undefined>; passEnv: readonly string[] }): string[] {
  const passed = new Set(args.passEnv.map((name) => name.toUpperCase()))
  const names = new Set<string>()
  for (const [name, value] of Object.entries(args.source)) {
    if (value === undefined || !proxyUrlNamePattern.test(name) || !hasCredentials(value)) continue
    if (!passed.has(name.toUpperCase())) names.add(name.toUpperCase())
  }
  return [...names].sort()
}

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
  const passedUpper = new Set(args.passEnv.map((name) => name.toUpperCase()))
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(args.source)) {
    if (value === undefined) continue
    if (proxyUrlNamePattern.test(name)) {
      // --pass-env names are upper case: HTTPS_PROXY also allows https_proxy.
      if (!hasCredentials(value) || passedUpper.has(name.toUpperCase())) env[name] = value
      continue
    }
    if (isBaseName(fold(name)) || passed.has(fold(name))) env[name] = value
  }
  for (const provided of args.provided) {
    for (const [name, value] of Object.entries(provided)) {
      if (value !== undefined) env[name] = value
    }
  }
  return env
}
