// Which browser origins may pair with the daemon. A deployed Page Builder is served from `https://<repository>.<domain>`
// for the domain of its environment (the same three-label rule the editor uses to find its repository).
const editorOriginPattern =
  /^https:\/\/([a-z0-9][a-z0-9-]{0,62})\.(prismic\.io|wroom\.io|(?:dev-tools|platform|marketing-tools|devops)-wroom\.com)$/

// Labels under those domains that are websites of their own, not repositories. A denylist of known names: an
// unlisted non-repository label still needs the user's consent, and its token only works from its own origin.
const reservedLabels: Record<string, true> = {
  www: true,
  docs: true,
  community: true,
  blog: true,
  status: true,
  mcp: true,
  api: true,
  auth: true,
  dashboard: true,
  cdn: true,
  "user-guides": true,
  internal: true,
}

// `extraOrigins` (the --origin option and the localhost default) match exactly.
export function isAllowedEditorOrigin(origin: string, extraOrigins: readonly string[]): boolean {
  if (extraOrigins.includes(origin)) return true
  return repositoryOf(origin) !== undefined
}

// The repository a deployed editor origin stands for, or undefined when the origin is not one.
export function repositoryOf(origin: string): string | undefined {
  const label = editorOriginPattern.exec(origin)?.[1]
  if (label === undefined || Object.hasOwn(reservedLabels, label)) return undefined
  return label
}
