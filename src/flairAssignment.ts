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

/** The template and text that now match a user's count after the template cache was refreshed. */
export interface RefreshedFlairTemplate {
  flairTemplateId: string
  text: string
}

/**
 * Writes the flair with its template. A 404 can mean the cached template id was deleted on Reddit, so
 * when `refreshTemplate` is given it is called once, before anything is written, to re-read the
 * templates and return the one that now matches the count. If that is a different template, the
 * write is retried with it. When no template matches, the id is unchanged, the retry also 404s or
 * the refresh itself fails, the write falls back to text-only flaircsv. There is at most one refresh
 * per call, and none after the flaircsv fallback has written anything.
 */
export async function setUserFlairWithFallback(
  ctx: RedditApiContext,
  initial: UserFlairAssignment,
  description: string,
  refreshTemplate?: () => Promise<RefreshedFlairTemplate | null>,
): Promise<void> {
  let options = initial
  try {
    await redditApiCall(ctx, () => ctx.reddit.setUserFlair(options), description)
    return
  } catch (error) {
    if (!isNotFoundError(error)) throw error

    console.warn(
      `Reddit API returned 404 during ${description}; falling back to flaircsv for u/${options.username}`,
    )
  }

  if (refreshTemplate && options.flairTemplateId) {
    const refreshed = await refreshTemplate().catch(error => {
      console.warn(`Failed to refresh flair templates after a 404 during ${description}: ${errorText(error)}`)
      return null
    })
    if (refreshed && refreshed.flairTemplateId !== options.flairTemplateId) {
      options = { ...options, text: refreshed.text, flairTemplateId: refreshed.flairTemplateId }
      try {
        await redditApiCall(ctx, () => ctx.reddit.setUserFlair(options), `${description} with the refreshed template`)
        return
      } catch (error) {
        if (!isNotFoundError(error)) throw error
        console.warn(`Refreshed flair template ${options.flairTemplateId} also returned 404 during ${description}`)
      }
    }
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
