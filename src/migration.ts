import { parseTradeCount } from './rules.js'
import { redditApiCall, type RedditApiContext } from './redditApi.js'

export async function seedTradeCountFromFlair(
  ctx: RedditApiContext,
  subredditName: string,
  username: string,
  flairCountLabel: string,
): Promise<void> {
  const countKey = `confirmations:${username.toLowerCase()}`
  if (await ctx.redis.get(countKey) !== undefined) return

  const sub = await redditApiCall(ctx, () => ctx.reddit.getSubredditByName(subredditName), `get subreddit ${subredditName}`)
  const page = await redditApiCall(ctx, () =>
    sub.getUserFlair({ usernames: [username] }),
  `get flair for u/${username} in r/${subredditName}`)
  const flairText = page.users.find(user => user.user?.toLowerCase() === username.toLowerCase())?.flairText
  const count = parseTradeCount(flairText, flairCountLabel)
  if (count === null) {
    console.debug(`Not seeding ${countKey}: flair "${flairText}" has no parseable count`)
    return
  }

  const created = await ctx.redis.set(countKey, String(count), { nx: true })
  if (created) console.debug(`Seeded ${countKey}=${count} from flair "${flairText ?? ''}"`)
}
