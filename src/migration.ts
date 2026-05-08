import { parseTradeCount } from './rules.js'
import { redditApiCall, type RedditApiContext } from './redditApi.js'
import { errorText, expirationFromNow } from './utils.js'

const FLAIR_IMPORT_CLAIM_TTL_MS = 10 * 60 * 1000
const FLAIR_IMPORT_PAGE_SIZE = 1000

export interface FlairCountImportResult {
  subredditName: string
  alreadyRunning: boolean
  pages: number
  scanned: number
  imported: number
  skippedExisting: number
  skippedUnparseable: number
}

export async function importExistingFlairCounts(ctx: RedditApiContext): Promise<FlairCountImportResult> {
  const { name: subredditName } = await redditApiCall(ctx, () => ctx.reddit.getCurrentSubreddit(), 'get current subreddit')
  const claimKey = `flairImport:${subredditName.toLowerCase()}:claim`
  const claimed = await ctx.redis.set(claimKey, String(Date.now()), {
    nx: true,
    expiration: expirationFromNow(FLAIR_IMPORT_CLAIM_TTL_MS),
  })

  if (!claimed) {
    console.debug(`Skipping flair import for r/${subredditName}: claim already held`)
    return emptyResult(subredditName, true)
  }

  try {
    const result = await importExistingFlairCountsOnce(ctx, subredditName)
    await ctx.redis.set(`flairImport:${subredditName.toLowerCase()}:lastRun`, JSON.stringify({
      ...result,
      completedAt: new Date().toISOString(),
    }))
    console.log(
      `Imported flair counts for r/${subredditName}: ` +
      `${result.imported} imported, ${result.skippedExisting} existing Redis counts kept, ` +
      `${result.skippedUnparseable} skipped, ${result.scanned} scanned`,
    )
    return result
  } finally {
    await ctx.redis.del(claimKey).catch(error => {
      console.warn(`Failed to release ${claimKey}: ${errorText(error)}`)
    })
  }
}

async function importExistingFlairCountsOnce(
  ctx: RedditApiContext,
  subredditName: string,
): Promise<FlairCountImportResult> {
  const sub = await redditApiCall(ctx, () => ctx.reddit.getSubredditByName(subredditName), `get subreddit ${subredditName}`)
  const result = emptyResult(subredditName, false)
  let after: string | undefined

  do {
    const page = await redditApiCall(ctx, () =>
      sub.getUserFlair({ after, limit: FLAIR_IMPORT_PAGE_SIZE }),
    `get flair import page ${result.pages + 1} for r/${subredditName}`)
    result.pages++

    for (const user of page.users) {
      result.scanned++
      const username = user.user?.trim()
      const count = user.flairText ? parseTradeCount(user.flairText) : null
      if (!username || count === null) {
        result.skippedUnparseable++
        continue
      }

      const countKey = `confirmations:${username.toLowerCase()}`
      if (await ctx.redis.get(countKey) !== undefined) {
        result.skippedExisting++
        continue
      }

      await ctx.redis.set(countKey, String(count))
      result.imported++
    }

    after = page.next || undefined
  } while (after)

  return result
}

function emptyResult(subredditName: string, alreadyRunning: boolean): FlairCountImportResult {
  return {
    subredditName,
    alreadyRunning,
    pages: 0,
    scanned: 0,
    imported: 0,
    skippedExisting: 0,
    skippedUnparseable: 0,
  }
}
