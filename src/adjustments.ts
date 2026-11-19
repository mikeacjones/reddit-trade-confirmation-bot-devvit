import {
  findFlairTemplate,
  formatFlairFromTemplate,
} from './rules.js'
import { loadFlairTemplates, refreshFlairTemplateCache } from './flairCache.js'
import { FlairTextWrittenError, setUserFlairWithFallback } from './flairAssignment.js'
import { getLanguageSettings } from './language.js'
import { isUserModerator } from './moderators.js'
import { redditApiCall, type RedditApiContext } from './redditApi.js'
import { withUserFlairLock } from './userFlairState.js'
import { errorText, parseStoredCount } from './utils.js'

const REDDIT_USERNAME_PATTERN = /^[A-Za-z0-9_-]{3,20}$/

export async function adjustUserTradeCount(
  ctx: RedditApiContext,
  rawUsername: string,
  count: number,
): Promise<{ username: string; count: number; oldFlair: string | null; newFlair: string }> {
  const username = normalizeUsername(rawUsername)
  if (!username) throw new Error('Username is required')
  if (!REDDIT_USERNAME_PATTERN.test(username)) {
    throw new Error('Username must be 3-20 characters and contain only letters, numbers, underscores, or hyphens')
  }
  if (!Number.isInteger(count) || count < 0) throw new Error('Trade count must be a non-negative whole number')

  const { name: subredditName } = await redditApiCall(ctx, () => ctx.reddit.getCurrentSubreddit(), 'get current subreddit')
  const { flairCountLabel } = await getLanguageSettings(ctx)
  const isMod = await isUserModerator(ctx, subredditName, username)
  let flairTemplates = await loadFlairTemplates(ctx, subredditName)
  let tpl = findFlairTemplate(flairTemplates, count, isMod)
  if (!tpl) {
    flairTemplates = await refreshFlairTemplateCache(ctx, subredditName)
    tpl = findFlairTemplate(flairTemplates, count, isMod)
  }
  if (!tpl) throw new Error(`No ${isMod ? 'moderator' : 'user'} flair template found for trade count ${count}`)

  const newFlair = formatFlairFromTemplate(tpl.template, count, flairCountLabel)
  const countKey = `confirmations:${username.toLowerCase()}`

  // The count and the flair are written under the same per-user lock a confirmation takes for its
  // flair write, so a confirmation's flair step sees either the whole manual set or none of it.
  const oldFlair = await withUserFlairLock(ctx, subredditName, username, async () => {
    const previousCount = await swapCount(ctx, countKey, String(count))
    const oldCount = parseStoredCount(previousCount) ?? 0
    const oldTpl = findFlairTemplate(flairTemplates, oldCount, isMod)
    const previousFlair = oldTpl
      ? formatFlairFromTemplate(oldTpl.template, oldCount, flairCountLabel)
      : null

    try {
      await setUserFlairWithFallback(
        ctx,
        { subredditName, username, text: newFlair, flairTemplateId: tpl.id },
        `set manual flair for u/${username}`,
      )
    } catch (error) {
      // The flair text already shows the new count, so undoing the count would split them.
      if (!(error instanceof FlairTextWrittenError)) {
        // A failing restore must not hide the flair error the caller needs to see.
        await restoreCountIfUnchanged(ctx, countKey, String(count), previousCount).catch(restoreError => {
          console.warn(`Failed to restore ${countKey} after a failed flair write: ${errorText(restoreError)}`)
        })
      }
      throw error
    }
    return previousFlair
  })

  console.log(`Adjusted trade count for u/${username} in r/${subredditName}: ${oldFlair ?? 'none'} -> ${newFlair}`)
  return { username, count, oldFlair, newFlair }
}

/**
 * Writes `next` and returns the value it overwrote, as one WATCH/MULTI/EXEC step. A confirmation
 * commits on the same key without the flair lock, so a separate read then write could overwrite a
 * trade committed in between and later "restore" the stale read; here the overwritten value is by
 * construction the one the rollback target must be.
 */
async function swapCount(ctx: RedditApiContext, countKey: string, next: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const txn = await ctx.redis.watch(countKey)
    let previous: string | undefined
    let results: unknown[]
    try {
      previous = await ctx.redis.get(countKey)
      await txn.multi()
      await txn.set(countKey, next)
      results = await txn.exec()
    } catch (error) {
      await txn.unwatch().catch(() => undefined)
      throw error
    }
    if (results.length > 0 && results[0] !== false && results[0] !== null) return previous
  }
  throw new Error(`Failed to atomically set ${countKey}`)
}

/**
 * Puts the previous count back only while the key still holds the value this adjustment wrote. A
 * confirmation commits through WATCH/MULTI/EXEC on the same key without taking the flair lock, so
 * the count may have moved on (a committed trade) and must then be left alone. WATCH makes the
 * compare and the restore one step: a commit landing in between aborts EXEC and the loop re-reads.
 */
async function restoreCountIfUnchanged(
  ctx: RedditApiContext,
  countKey: string,
  written: string,
  previous: string | undefined,
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const txn = await ctx.redis.watch(countKey)
    let results: unknown[]
    try {
      if (await ctx.redis.get(countKey) !== written) {
        await txn.unwatch()
        return
      }
      await txn.multi()
      if (previous === undefined) await txn.del(countKey)
      else await txn.set(countKey, previous)
      results = await txn.exec()
    } catch (error) {
      await txn.unwatch().catch(() => undefined)
      throw error
    }
    if (results.length > 0 && results[0] !== false && results[0] !== null) return
  }
  console.warn(`Could not restore ${countKey} after a failed flair write: it kept changing`)
}

function normalizeUsername(username: string): string {
  return username.trim().replace(/^\/?u\//i, '').replace(/^@/, '')
}
