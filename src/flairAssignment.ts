import { redditApiCall, type RedditApiContext } from './redditApi.js'
import { errorText } from './utils.js'

interface UserFlairAssignment {
  subredditName: string
  username: string
  text: string
  flairTemplateId?: string
  cssClass?: string
}

interface FlairCsvResult {
  ok?: boolean
  status?: string
  errors?: {
    css?: string
    row?: string
    user?: string
  }
  warnings?: {
    text?: string
  }
}

/**
 * Thrown when the flaircsv fallback already changed the user's flair text but the template retry
 * then failed. The flair is no longer what it was before the call, so callers must not undo the
 * state that the new text reflects. The message is the underlying error's.
 */
export class FlairTextWrittenError extends Error {
  constructor(cause: unknown) {
    super(errorText(cause), { cause })
    this.name = 'FlairTextWrittenError'
  }
}

export async function setUserFlairWithFallback(
  ctx: RedditApiContext,
  options: UserFlairAssignment,
  description: string,
): Promise<void> {
  try {
    await redditApiCall(ctx, () => ctx.reddit.setUserFlair(options), description)
    return
  } catch (error) {
    if (!isNotFoundError(error)) throw error

    console.warn(
      `Reddit API returned 404 during ${description}; falling back to flaircsv for u/${options.username}`,
    )
  }

  await redditApiCall(ctx, async () => {
    const results = await ctx.reddit.setUserFlairBatch(options.subredditName, [{
      username: options.username,
      text: options.text,
      cssClass: options.cssClass,
    }])
    assertFlairCsvResult(results[0], options.username)
  }, `${description} via flaircsv`)

  try {
    await redditApiCall(
      ctx,
      () => ctx.reddit.setUserFlair(options),
      `${description} after flaircsv fallback`,
    )
  } catch (error) {
    if (!isNotFoundError(error)) throw new FlairTextWrittenError(error)

    console.warn(
      `Reddit API still returned 404 during ${description} after flaircsv fallback; ` +
      `leaving text-only flair for u/${options.username}`,
    )
  }
}

function assertFlairCsvResult(result: FlairCsvResult | undefined, username: string): void {
  if (!result) throw new Error(`No flaircsv result returned for u/${username}`)

  const errors = result.errors
  const errorMessages = [
    errors?.user ? `user: ${errors.user}` : '',
    errors?.css ? `css: ${errors.css}` : '',
    errors?.row ? `row: ${errors.row}` : '',
  ].filter(Boolean)

  if (result.ok === false || errorMessages.length > 0) {
    throw new Error(`flaircsv failed for u/${username}: ${errorMessages.join('; ') || result.status || 'unknown error'}`)
  }

  if (result.warnings?.text) {
    console.warn(`flaircsv warning for u/${username}: ${result.warnings.text}`)
  }
}

function isNotFoundError(error: unknown): boolean {
  const text = errorText(error)
  return /\b404\b/.test(text) || /not found/i.test(text)
}
