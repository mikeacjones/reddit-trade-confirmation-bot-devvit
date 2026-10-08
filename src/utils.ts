export function expirationFromNow(ms: number): Date {
  return new Date(Date.now() + ms)
}

export function errorText(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error)
  const parts: string[] = []
  if ('message' in error) parts.push(String(error.message))
  if ('details' in error) parts.push(String(error.details))
  if ('cause' in error) parts.push(errorText(error.cause))
  return parts.join(' ')
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
