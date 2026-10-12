// What the daemon accepts as an Anthropic API key before it spends a request on it.
export const apiKeyFormat = /^sk-ant-[A-Za-z0-9_-]{20,400}$/

export type KeyValidation = "valid" | "invalid" | "unavailable"

export type KeyValidator = (key: string) => Promise<KeyValidation>

const modelsUrl = "https://api.anthropic.com/v1/models"
const validationTimeoutMs = 5000

// A cheap authenticated request (the list of models): 200 means the key works, 401 and 403 mean Anthropic refused
// it. Anything else (a rate limit, a 5xx, no network) says nothing about the key. No redirect is followed, so the
// key is only ever sent to api.anthropic.com. Nothing about the response, and never the key, is logged.
export async function validateKeyWithAnthropic(key: string): Promise<KeyValidation> {
  try {
    const response = await fetch(modelsUrl, {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      redirect: "manual",
      signal: AbortSignal.timeout(validationTimeoutMs),
    })
    await response.body?.cancel()
    if (response.status === 200) return "valid"
    if (response.status === 401 || response.status === 403) return "invalid"
    return "unavailable"
  } catch {
    return "unavailable"
  }
}
