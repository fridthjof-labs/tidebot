function messageIncludesRateLimit(message: string): boolean {
  const normalized = message.toLowerCase()
  return (
    normalized.includes('rate limit') ||
    normalized.includes('api rate limit exceeded')
  )
}

export function isRateLimitError(error: unknown): boolean {
  if (error instanceof AggregateError) {
    return error.errors.some((entry) => isRateLimitError(entry))
  }

  if (error instanceof Error) {
    if (messageIncludesRateLimit(error.message)) {
      return true
    }
    if ('status' in error && (error.status === 403 || error.status === 429)) {
      return messageIncludesRateLimit(error.message)
    }
  }

  return false
}
