export interface RateLimiter {
  // Whether one more request fits in the current window; counts it when it does.
  take(): boolean
}

// A fixed window, shared by all callers.
export function createRateLimiter(args: { limit: number; windowMs: number; now?: () => number }): RateLimiter {
  const { limit, windowMs, now = Date.now } = args
  let windowStart = now()
  let count = 0

  return {
    take() {
      if (now() - windowStart >= windowMs) {
        windowStart = now()
        count = 0
      }
      if (count >= limit) return false
      count += 1
      return true
    },
  }
}
