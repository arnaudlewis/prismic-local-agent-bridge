import type { ChatGptStatus } from "./protocol.ts"

// Which accounts the daemon is signed in to: what the desktop app's menu decides its sign-in and sign-out entries from.
export interface SignedInAccounts {
  prismic: boolean
  chatgpt: boolean
}

// The Prismic user ids once each: the daemon is signed in per environment, and the same user is usually signed in to
// several of them.
export function distinctUsers(users: readonly string[]): string[] {
  return [...new Set(users)]
}

export function describePrismic(users: readonly string[]): string {
  const distinct = distinctUsers(users)
  return distinct.length === 0 ? "Prismic: not signed in" : `Prismic: signed in as ${distinct.join(", ")}`
}

// A ChatGPT sign-in that is still going on counts as signed out: the menu then offers to start it again.
export function signedInAccounts(args: { prismicUsers: readonly string[]; chatgpt: ChatGptStatus["status"] }): SignedInAccounts {
  return { prismic: args.prismicUsers.length > 0, chatgpt: args.chatgpt === "signed_in" }
}
