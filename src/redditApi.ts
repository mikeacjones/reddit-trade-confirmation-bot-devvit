import type { TriggerContext } from '@devvit/public-api'
import { errorText, expirationFromNow, sleep } from './utils.js'

const COMMENT_SUBMIT_SPACING_MS = 6500
const COMMENT_SUBMIT_SLOT_ATTEMPTS = 4
const REDDIT_WRITE_ATTEMPTS = 3
const RATE_LIMIT_FALLBACK_MS = 6000
const RATE_LIMIT_BACKOFF_PADDING_MS = 500
const MAX_RATE_LIMIT_SLEEP_MS = 20 * 1000

const REDDIT_API_BACKOFF_KEY = 'reddit:api-backoff-until'

export type RedditApiContext = Pick<TriggerContext, 'reddit' | 'redis'>

export async function trySubmitCommentWithRetry(ctx: TriggerContext, id: string, text: string): Promise<boolean> {
  return tryRedditWriteWithRetry(ctx, async () => {
    await waitForCommentSubmitSlot(ctx)
    await ctx.reddit.submitComment({ id, text })
  }, `reply to ${id}`)
}

export async function tryRedditWriteWithRetry<T>(
  ctx: RedditApiContext,
  fn: () => Promise<T>,
  description: string,
): Promise<boolean> {
  try {
    await redditApiCall(ctx, fn, description)
    return true
  } catch (error) {
    console.warn(`Reddit API write failed after retries (${description}): ${errorText(error)}`)
    return false
  }
}

async function waitForCommentSubmitSlot(ctx: TriggerContext): Promise<void> {
  for (let attempt = 0; attempt < COMMENT_SUBMIT_SLOT_ATTEMPTS; attempt++) {
    const claimed = await ctx.redis.set('reddit:comment-submit-slot', String(Date.now()), {
      nx: true,
      expiration: expirationFromNow(COMMENT_SUBMIT_SPACING_MS),
    })
    if (claimed) return
    await sleep(COMMENT_SUBMIT_SPACING_MS + jitterMs())
  }
  throw new Error('Timed out waiting for Reddit comment submit slot')
}

export async function redditApiCall<T>(
  ctx: RedditApiContext,
  fn: () => Promise<T>,
  description: string,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < REDDIT_WRITE_ATTEMPTS; attempt++) {
    try {
      await waitForRedditApiBackoff(ctx, description)
      console.debug(`Reddit API call: ${description} (attempt ${attempt + 1}/${REDDIT_WRITE_ATTEMPTS})`)
      const result = await fn()
      if (attempt > 0) console.debug(`Reddit API call succeeded after retry: ${description}`)
      return result
    } catch (error) {
      lastError = error
      const delayMs = redditRateLimitDelayMs(error)
      if (delayMs === null || attempt === REDDIT_WRITE_ATTEMPTS - 1) throw error

      await setRedditApiBackoff(ctx, delayMs)
      console.warn(
        `Reddit API rate limit during ${description}; retrying in ${delayMs}ms ` +
        `(attempt ${attempt + 1}/${REDDIT_WRITE_ATTEMPTS})`,
      )
      await waitForRedditApiBackoff(ctx, description)
    }
  }
  throw lastError
}

async function waitForRedditApiBackoff(ctx: RedditApiContext, description: string): Promise<void> {
  const value = await ctx.redis.get(REDDIT_API_BACKOFF_KEY)
  const backoffUntil = value ? parseInt(value, 10) : 0
  if (!Number.isFinite(backoffUntil)) return

  const delayMs = backoffUntil - Date.now()
  if (delayMs <= 0) return
  if (delayMs > MAX_RATE_LIMIT_SLEEP_MS) {
    throw new Error(`Reddit API backoff active for ${delayMs}ms before ${description}`)
  }

  console.debug(`Waiting ${delayMs}ms for Reddit API backoff before ${description}`)
  await sleep(delayMs)
}

async function setRedditApiBackoff(ctx: RedditApiContext, delayMs: number): Promise<void> {
  const backoffUntil = Date.now() + delayMs + RATE_LIMIT_BACKOFF_PADDING_MS
  await ctx.redis.set(REDDIT_API_BACKOFF_KEY, String(backoffUntil), {
    expiration: expirationFromNow(delayMs + RATE_LIMIT_BACKOFF_PADDING_MS),
  })
}

function redditRateLimitDelayMs(error: unknown): number | null {
  const metadataDelayMs = redditRateLimitMetadataDelayMs(error)
  if (metadataDelayMs !== null) return Math.max(metadataDelayMs, RATE_LIMIT_FALLBACK_MS)

  const text = errorText(error)
  if (!/ratelimit/i.test(text)) return null
  const retryAfter = text.match(/retry-after[:= ]+(\d+)/i)
  if (retryAfter) return Math.max(parseInt(retryAfter[1], 10) * 1000, RATE_LIMIT_FALLBACK_MS)
  const seconds = text.match(/take a break for (\d+) seconds?/i)
  if (seconds) return Math.max(parseInt(seconds[1], 10) * 1000, RATE_LIMIT_FALLBACK_MS)
  const minutes = text.match(/take a break for (\d+) minutes?/i)
  if (minutes) return parseInt(minutes[1], 10) * 60 * 1000
  return RATE_LIMIT_FALLBACK_MS
}

function redditRateLimitMetadataDelayMs(error: unknown): number | null {
  const retryAfter = metadataNumber(error, 'retry-after')
  if (retryAfter !== null) return retryAfter * 1000

  const remaining = metadataNumber(error, 'x-ratelimit-remaining')
  const reset = metadataNumber(error, 'x-ratelimit-reset')
  if (reset !== null && (remaining === null || remaining <= 0)) return reset * 1000
  return null
}

function metadataNumber(error: unknown, key: string): number | null {
  if (!error || typeof error !== 'object') return null
  const candidate = error as {
    metadata?: {
      get?: (key: string) => unknown
      internalRepr?: Map<string, unknown>
    }
    cause?: unknown
  }

  const value = metadataValue(candidate.metadata, key)
  if (value !== null) return value
  if ('cause' in candidate) return metadataNumber(candidate.cause, key)
  return null
}

function metadataValue(
  metadata: { get?: (key: string) => unknown; internalRepr?: Map<string, unknown> } | undefined,
  key: string,
): number | null {
  if (!metadata) return null
  if (metadata.get) {
    const value = parseMetadataNumber(metadata.get(key))
    if (value !== null) return value
  }
  if (metadata.internalRepr instanceof Map) {
    const value = parseMetadataNumber(metadata.internalRepr.get(key))
    if (value !== null) return value
  }
  return null
}

function parseMetadataNumber(value: unknown): number | null {
  const raw = Array.isArray(value) ? value[0] : value
  if (raw === undefined || raw === null) return null
  const parsed = parseFloat(String(raw).split(',')[0])
  return Number.isFinite(parsed) ? parsed : null
}

function jitterMs(): number {
  return Math.floor(Math.random() * 500)
}
