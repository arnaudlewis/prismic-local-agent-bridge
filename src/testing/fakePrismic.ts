import type { PrismicRuntime } from "../conversations/context.ts"
import { createAgentMcpGrants } from "../prismic/agentMcpProxy.ts"
import { createMcpUpstream } from "../prismic/mcpUpstream.ts"
import { PrismicSignInRequiredError } from "../prismic/prismicAuth.ts"
import type { PrismicAuth } from "../prismic/prismicAuth.ts"

export interface FakePrismic {
  // What the conversation machinery receives: a fake sign-in over the real upstream helper and the real grants.
  runtime: PrismicRuntime
  auth: PrismicAuth
  // Signs in as another user (a running agent started as the previous one is restarted), or out.
  setUserId(userId: string | undefined): void
  setAccessToken(accessToken: string): void
}

// A PrismicAuth with no OAuth behind it: a status that tests change and a fixed access token. The upstream helper is the
// real one, so tests that read the editor context still go through HTTP to a stub MCP.
export function createFakePrismic(args: { accessToken?: string; userId?: string; bridgePort?: number } = {}): FakePrismic {
  let userId: string | undefined = args.userId ?? "user-1"
  let accessToken = args.accessToken ?? "fake-oauth-access-token"

  const auth: PrismicAuth = {
    status: () => (userId === undefined ? { status: "signed_out" } : { status: "signed_in", userId }),
    beginSignIn: () => Promise.resolve("http://127.0.0.1:1/authorize"),
    handleCallback: () => Promise.resolve("unknown_state"),
    accessToken() {
      return userId === undefined ? Promise.reject(new PrismicSignInRequiredError()) : Promise.resolve(accessToken)
    },
    refreshAfterUnauthorized() {
      return userId === undefined ? Promise.reject(new PrismicSignInRequiredError()) : Promise.resolve(accessToken)
    },
    signOut() {
      userId = undefined
      return Promise.resolve()
    },
    knownTokens: () => [accessToken],
  }
  return {
    runtime: {
      auth,
      upstream: createMcpUpstream({ auth }),
      grants: createAgentMcpGrants(),
      bridgePort: args.bridgePort ?? 7878,
    },
    auth,
    setUserId(next) {
      userId = next
    },
    setAccessToken(next) {
      accessToken = next
    },
  }
}
