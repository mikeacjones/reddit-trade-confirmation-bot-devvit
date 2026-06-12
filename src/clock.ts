export interface Clock {
  now(): Date
}

export const systemClock: Clock = {
  now: () => new Date(),
}

export function expirationFrom(now: Date, ttlMs: number): Date {
  return new Date(now.getTime() + ttlMs)
}

