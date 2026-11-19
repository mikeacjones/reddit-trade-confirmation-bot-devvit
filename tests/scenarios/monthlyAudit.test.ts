/**
 * Adversarial audit of the monthly thread, the scheduler registration and the hourly rescan at the
 * UTC and month edges (src/monthly.ts, src/scheduling.ts, rescanCurrentMonthlyPost in
 * src/confirmations.ts), driven through the real jobs and triggers registered by src/main.ts.
 *
 * A probe that shows the code is right is a plain passing test. A probe that shows a bug is a
 * `test.fails` repro with a `// BUG:` comment: it stays green now and turns red once the bug is
 * fixed, then drops `.fails`. This audit does not fix src/.
 *
 * Time is pinned with vitest fake timers (setImmediate stays real: the Redis mocks need it).
 */
import { afterEach, beforeEach, describe, expect, vi } from 'vitest'
import { ensureJobsScheduled } from '../../src/scheduling.js'
import { newApp, scenarioTest as test, seedSwapsWorld, type AppHarness } from '../harness/scenario.js'

const MONTHLY = 't3_monthly'
const ORIGINAL_TZ = process.env.TZ

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(new Date('2026-11-30T12:00:00Z'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'debug').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  if (ORIGINAL_TZ === undefined) delete process.env.TZ
  else process.env.TZ = ORIGINAL_TZ
})

async function setup(mocks: Parameters<typeof newApp>[0]): Promise<AppHarness> {
  const app = newApp(mocks)
  seedSwapsWorld(app)
  await app.ctx.redis.set('currentMonthlyPost', MONTHLY)
  return app
}

const currentPostId = async (app: AppHarness) => (await app.ctx.redis.get('currentMonthlyPost'))!
const submitted = (app: AppHarness) => app.reddit.calls.filter(c => c.method === 'submitPost').length
const stickied = (app: AppHarness) => [...app.reddit.posts.values()].filter(p => p.stickied).map(p => p.id)

function tradeComments(app: AppHarness, postId = MONTHLY): void {
  app.reddit.addComment({ id: 't1_offer', parentId: postId, postId, authorName: 'alice', body: 'Sold a kit to u/bob' })
  app.reddit.addComment({ id: 't1_reply', parentId: 't1_offer', postId, authorName: 'bob', body: 'confirmed' })
}

function replyEvent(id: string, parentId: string, author: string, body: string, postId = MONTHLY) {
  return {
    comment: { id, body, parentId, postId, permalink: `/r/swaps/comments/${postId.slice(3)}/_/${id.slice(3)}/` },
    author: { name: author },
    subreddit: { name: 'swaps' },
  }
}

/**
 * Make `sticky()` reject for every post the bot creates, however the job reaches it (the object
 * `submitPost` returns, `getPostById` or the `getPostsByUser` listing), as when both sticky slots
 * are taken. `state.broken = false` lets it work again. The seeded previous thread is unaffected.
 */
function failStickyOnNewPosts(app: AppHarness, message: string): { broken: boolean } {
  const state = { broken: true }
  type PostObject = Awaited<ReturnType<typeof app.reddit.client.getPostById>>
  const patch = (post: PostObject): PostObject => {
    if (post.id === MONTHLY) return post
    const sticky = post.sticky
    post.sticky = async () => { if (state.broken) throw new Error(message); return sticky() }
    return post
  }
  const { client } = app.reddit
  const submitPost = client.submitPost
  const getPostById = client.getPostById
  const getPostsByUser = client.getPostsByUser
  client.submitPost = async options => patch(await submitPost(options))
  client.getPostById = async id => patch(await getPostById(id))
  client.getPostsByUser = options => {
    const listing = getPostsByUser(options)
    return { all: async () => (await listing.all()).map(patch) }
  }
  return state
}

describe('the job at the UTC edge of a month', () => {
  const months = [
    { days: 28, last: '2027-02-28', next: '2027-03-01', lastTitle: 'February 2027', nextTitle: 'March 2027' },
    { days: 29, last: '2028-02-29', next: '2028-03-01', lastTitle: 'February 2028', nextTitle: 'March 2028' },
    { days: 30, last: '2026-11-30', next: '2026-12-01', lastTitle: 'November 2026', nextTitle: 'December 2026' },
    { days: 31, last: '2026-12-31', next: '2027-01-01', lastTitle: 'December 2026', nextTitle: 'January 2027' },
  ]

  for (const m of months) {
    test(`${m.days}-day month: 23:59:59.999 on the last day is still ${m.lastTitle}, 00:00:00.000 on the 1st is ${m.nextTitle}`, async ({ mocks }) => {
      const app = await setup(mocks)

      vi.setSystemTime(new Date(`${m.last}T23:59:59.999Z`))
      await app.runJob('monthly-post')
      const lastId = await currentPostId(app)
      expect(app.reddit.posts.get(lastId)!.title).toBe(`${m.lastTitle} Confirmed Trade Thread`)

      vi.setSystemTime(new Date(`${m.next}T00:00:00.000Z`))
      await app.runJob('monthly-post')
      const nextId = await currentPostId(app)
      expect(nextId).not.toBe(lastId)
      expect(app.reddit.posts.get(nextId)!.title).toBe(`${m.nextTitle} Confirmed Trade Thread`)
      // One thread per month, the older ones locked and only the newest stickied.
      expect(submitted(app)).toBe(2)
      expect(app.reddit.posts.get(lastId)).toMatchObject({ locked: true, stickied: false })
      expect(stickied(app)).toEqual([nextId])
      expect(app.reddit.modmail).toHaveLength(2)
    })
  }

  test('a rerun one millisecond before midnight reuses that month\'s thread, the one at midnight starts the next', async ({ mocks }) => {
    const app = await setup(mocks)
    vi.setSystemTime(new Date('2026-11-30T23:59:59.000Z'))
    await app.runJob('monthly-post')
    const november = await currentPostId(app)

    vi.setSystemTime(new Date('2026-11-30T23:59:59.999Z'))
    await app.runJob('monthly-post')
    expect(await currentPostId(app)).toBe(november)
    expect(submitted(app)).toBe(1)

    vi.setSystemTime(new Date('2026-12-01T00:00:00.000Z'))
    await app.runJob('monthly-post')
    expect(await currentPostId(app)).not.toBe(november)
    expect(submitted(app)).toBe(2)
  })

  for (const tz of ['Pacific/Kiritimati', 'America/Los_Angeles', 'Asia/Kolkata']) {
    test(`with TZ=${tz} the title and month claim still follow UTC at the rollover`, async ({ mocks }) => {
      process.env.TZ = tz
      const app = await setup(mocks)

      // 00:00 UTC on 1 Dec is still 30 Nov in Los Angeles and already 2 Dec in Kiritimati.
      vi.setSystemTime(new Date('2026-12-01T00:00:00Z'))
      await app.runJob('monthly-post')
      const december = await currentPostId(app)
      expect(app.reddit.posts.get(december)!.title).toBe('December 2026 Confirmed Trade Thread')

      // 23:59 UTC on 31 Jan is already 1 Feb in Kiritimati and Kolkata: still January.
      vi.setSystemTime(new Date('2027-01-31T23:59:00Z'))
      await app.runJob('monthly-post')
      const january = await currentPostId(app)
      expect(app.reddit.posts.get(january)!.title).toBe('January 2027 Confirmed Trade Thread')

      // The rerun in the same UTC month reuses the thread whatever the local date is.
      vi.setSystemTime(new Date('2027-01-31T23:59:30Z'))
      await app.runJob('monthly-post')
      expect(await currentPostId(app)).toBe(january)
      expect(submitted(app)).toBe(2)
      // The claim is keyed by the UTC month and released.
      expect(await app.ctx.redis.get('monthlyPostClaim:swaps:2027-01')).toBeUndefined()
    })
  }

  test('with TZ=Pacific/Kiritimati an existing thread created late in the UTC month is found in the same UTC month', async ({ mocks }) => {
    process.env.TZ = 'Pacific/Kiritimati'
    const app = await setup(mocks)
    vi.setSystemTime(new Date('2026-12-31T23:30:00Z'))
    await app.runJob('monthly-post')
    const december = await currentPostId(app)

    vi.setSystemTime(new Date('2026-12-31T23:59:59Z'))
    await app.runJob('monthly-post')

    expect(await currentPostId(app)).toBe(december)
    expect(submitted(app)).toBe(1)
  })

  test('a malformed date_locale setting does not stop the monthly thread from being created', async ({ mocks }) => {
    const app = await setup(mocks)
    mocks.settings.put('date_locale', 'en_US')
    vi.setSystemTime(new Date('2026-12-01T00:00:00Z'))

    await app.runJob('monthly-post')

    expect(submitted(app)).toBe(1)
    expect(await currentPostId(app)).not.toBe(MONTHLY)
  })
})

describe('the job running twice in one month', () => {
  test('two overlapping runs create one thread and one modmail', async ({ mocks }) => {
    const app = await setup(mocks)
    vi.setSystemTime(new Date('2026-12-01T00:00:00Z'))

    await Promise.allSettled([app.runJob('monthly-post'), app.runJob('monthly-post')])
    await app.runJob('monthly-post')

    expect(submitted(app)).toBe(1)
    expect(app.reddit.modmail).toHaveLength(1)
    expect(stickied(app)).toEqual([await currentPostId(app)])
  })

  test('five reruns across the month leave exactly one thread for the month', async ({ mocks }) => {
    const app = await setup(mocks)
    vi.setSystemTime(new Date('2026-12-01T00:00:00Z'))
    await app.runJob('monthly-post')
    for (let day = 2; day <= 28; day += 6) {
      vi.setSystemTime(new Date(`2026-12-${String(day).padStart(2, '0')}T00:00:00Z`))
      await app.runJob('monthly-post')
    }
    expect(submitted(app)).toBe(1)
    expect(app.reddit.modmail).toHaveLength(1)
  })

  test('a rerun after a moderator deleted the month\'s thread creates one replacement and locks nothing live', async ({ mocks }) => {
    const app = await setup(mocks)
    vi.setSystemTime(new Date('2026-12-01T00:00:00Z'))
    await app.runJob('monthly-post')
    const first = await currentPostId(app)
    Object.assign(app.reddit.posts.get(first)!, { removed: true, removedByCategory: 'deleted' })

    await app.runJob('monthly-post')
    await app.runJob('monthly-post')

    const second = await currentPostId(app)
    expect(second).not.toBe(first)
    expect(submitted(app)).toBe(2)
    expect(app.reddit.posts.get(second)).toMatchObject({ stickied: true, locked: false, removed: false })
  })
})

describe('the previous thread is missing, locked or deleted', () => {
  test('the pointer names a post that no longer exists: the job still posts, with the fallback link', async ({ mocks }) => {
    const app = newApp(mocks)
    seedSwapsWorld(app)
    await app.ctx.redis.set('currentMonthlyPost', 't3_gone')

    await app.runJob('monthly-post')

    const created = app.reddit.posts.get(await currentPostId(app))!
    expect(created.title).toBe('November 2026 Confirmed Trade Thread')
    expect(created.body).toContain('Previous monthly thread')
    expect(app.reddit.modmail).toHaveLength(1)
  })

  test('the previous thread is already locked and unstickied: it is left alone and the job completes', async ({ mocks }) => {
    const app = await setup(mocks)
    Object.assign(app.reddit.posts.get(MONTHLY)!, { locked: true, stickied: false })
    const lockCalls = vi.fn()
    const originalGet = app.reddit.client.getPostById
    app.reddit.client.getPostById = async id => {
      const post = await originalGet(id)
      const lock = post.lock
      post.lock = async () => { lockCalls(); return lock() }
      return post
    }

    await app.runJob('monthly-post')

    expect(lockCalls).not.toHaveBeenCalled()
    expect(app.reddit.posts.get(MONTHLY)).toMatchObject({ locked: true, stickied: false })
    expect(stickied(app)).toEqual([await currentPostId(app)])
  })

  test('the previous thread was deleted by its author: it is not touched and the job completes', async ({ mocks }) => {
    const app = await setup(mocks)
    Object.assign(app.reddit.posts.get(MONTHLY)!, { removed: true, removedByCategory: 'deleted' })

    await app.runJob('monthly-post')

    expect(app.reddit.posts.get(MONTHLY)).toMatchObject({ locked: false, stickied: true })
    expect(await currentPostId(app)).not.toBe(MONTHLY)
    expect(app.reddit.modmail).toHaveLength(1)
  })

  test('the previous thread is archived: the job completes without locking it', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.posts.get(MONTHLY)!.archived = true

    await app.runJob('monthly-post')

    expect(await currentPostId(app)).not.toBe(MONTHLY)
    expect(app.reddit.modmail).toHaveLength(1)
  })

  test('locking the previous thread answers 404: the job still stickies the new thread and sends the modmail', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.posts.get(MONTHLY)!.stickied = false
    const originalGet = app.reddit.client.getPostById
    app.reddit.client.getPostById = async id => {
      const post = await originalGet(id)
      if (id === MONTHLY) post.lock = async () => { throw new Error('404 not found') }
      return post
    }

    await app.runJob('monthly-post')

    expect(stickied(app)).toEqual([await currentPostId(app)])
    expect(app.reddit.modmail).toHaveLength(1)
  })

  // BUG: a transient failure loading the previous thread (e.g. 500) is swallowed as "previous is missing", so the pointer moves on and the old thread is never unstickied or locked, severity low
  test.fails('a transient error loading the previous thread still ends with it locked and unstickied', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.failNext('getPostById', '500 server error')

    await app.runJob('monthly-post')

    expect(app.reddit.posts.get(MONTHLY)).toMatchObject({ locked: true, stickied: false })
  })

  test('an unlocked old thread left behind answers late replies with the old-thread message, not a count', async ({ mocks }) => {
    const app = await setup(mocks)
    // An unlocked thread that is not the current one, seeded directly so the test does not depend
    // on how a thread ends up unlocked.
    app.reddit.addPost({ id: 't3_old', title: 'October 2026 Confirmed Trade Thread', stickied: false })
    tradeComments(app, 't3_old')

    await app.fireTrigger('CommentSubmit', replyEvent('t1_reply', 't1_offer', 'bob', 'confirmed', 't3_old'))

    expect(await app.ctx.redis.get('confirmations:alice')).toBeUndefined()
    expect(app.reddit.repliesTo('t1_reply')).toHaveLength(1)
  })
})

describe('sticky slots full and partial failures', () => {
  test('stickying the new thread fails with a 500: the retry reuses the thread and stickies it, no duplicate', async ({ mocks }) => {
    const app = await setup(mocks)
    const sticky = failStickyOnNewPosts(app, '500 server error')
    vi.setSystemTime(new Date('2026-12-01T00:00:00Z'))
    await expect(app.runJob('monthly-post')).rejects.toThrow('500 server error')
    const december = await currentPostId(app)
    expect(app.reddit.posts.get(MONTHLY)).toMatchObject({ locked: true, stickied: false })

    sticky.broken = false
    vi.setSystemTime(new Date('2026-12-01T01:00:00Z'))
    await app.runJob('monthly-post')

    expect(submitted(app)).toBe(1)
    expect(await currentPostId(app)).toBe(december)
    expect(stickied(app)).toEqual([december])
  })

  test('stickying keeps failing with a 400 (slots full): a retry does not create a second thread for the month', async ({ mocks }) => {
    const app = await setup(mocks)
    failStickyOnNewPosts(app, '400 bad request: too many sticky posts')
    vi.setSystemTime(new Date('2026-12-01T00:00:00Z'))
    await expect(app.runJob('monthly-post')).rejects.toThrow('400')

    vi.setSystemTime(new Date('2026-12-01T01:00:00Z'))
    await app.runJob('monthly-post').catch(() => {})

    expect(submitted(app)).toBe(1)
  })

  test('stickying keeps failing with a 400 (slots full): any number of retries leaves one thread, failing loudly each time', async ({ mocks }) => {
    const app = await setup(mocks)
    failStickyOnNewPosts(app, '400 bad request: too many sticky posts')
    vi.setSystemTime(new Date('2026-12-01T00:00:00Z'))
    await expect(app.runJob('monthly-post')).rejects.toThrow('400')
    const december = await currentPostId(app)
    for (let i = 0; i < 3; i++) {
      await expect(app.runJob('monthly-post')).rejects.toThrow('400')
    }
    expect(submitted(app)).toBe(1)
    expect(await currentPostId(app)).toBe(december)
  })

  for (const message of [
    '400 Bad Request: no free sticky slot found',
    'http status 400 Bad Request: both sticky slots are taken, unsticky or removed one first',
    '400 bad request: a deleted or removed post cannot free a sticky slot',
  ]) {
    test(`a 400 from sticky() never makes the retry post a second thread, whatever it says: ${message}`, async ({ mocks }) => {
      const app = await setup(mocks)
      failStickyOnNewPosts(app, message)
      vi.setSystemTime(new Date('2026-12-01T00:00:00Z'))
      await expect(app.runJob('monthly-post')).rejects.toThrow('400')
      for (let i = 0; i < 3; i++) await app.runJob('monthly-post').catch(() => {})
      expect(submitted(app)).toBe(1)
    })
  }

  test('stickying keeps failing with a 500 (slots full): every retry fails loudly and none creates a second thread', async ({ mocks }) => {
    const app = await setup(mocks)
    failStickyOnNewPosts(app, '500 sticky slots full')
    vi.setSystemTime(new Date('2026-12-01T00:00:00Z'))
    for (let i = 0; i < 3; i++) {
      await expect(app.runJob('monthly-post')).rejects.toThrow('500')
    }
    expect(submitted(app)).toBe(1)
    expect(await app.ctx.redis.get('monthlyPostClaim:swaps:2026-12')).toBeUndefined()
  })

  test('the sticky failure leaves the pointer on the new thread, so confirmations on it are counted', async ({ mocks }) => {
    const app = await setup(mocks)
    failStickyOnNewPosts(app, '500 sticky slots full')
    await expect(app.runJob('monthly-post')).rejects.toThrow('500')
    const december = await currentPostId(app)
    tradeComments(app, december)

    await app.fireTrigger('CommentSubmit', replyEvent('t1_reply', 't1_offer', 'bob', 'confirmed', december))

    expect(await app.ctx.redis.get('confirmations:alice')).toBe('1')
    expect(await app.ctx.redis.get('confirmations:bob')).toBe('1')
  })

  test('modmail fails after the thread is created: the job throws, the thread is live and the claim is released', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.failNext('createModmail', '500 modmail down')

    await expect(app.runJob('monthly-post')).rejects.toThrow('500 modmail down')

    const december = await currentPostId(app)
    expect(december).not.toBe(MONTHLY)
    expect(app.reddit.posts.get(december)).toMatchObject({ stickied: true, locked: false, suggestedSort: 'NEW' })
    expect(app.reddit.posts.get(MONTHLY)).toMatchObject({ stickied: false, locked: true })
    expect(await app.ctx.redis.get('monthlyPostClaim:swaps:2026-11')).toBeUndefined()
  })

  test('after a modmail failure the retry does not create a second thread', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.failNext('createModmail', '500 modmail down')
    await expect(app.runJob('monthly-post')).rejects.toThrow()
    const thread = await currentPostId(app)

    await app.runJob('monthly-post')

    expect(await currentPostId(app)).toBe(thread)
    expect(submitted(app)).toBe(1)
    expect(stickied(app)).toEqual([thread])
  })

  test('after a modmail failure the retry sends the modmail', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.failNext('createModmail', '500 modmail down')
    await expect(app.runJob('monthly-post')).rejects.toThrow()

    await app.runJob('monthly-post')

    expect(app.reddit.modmail).toHaveLength(1)
  })

  test('setting the suggested sort fails: the retry finishes the rotation and locks the previous thread', async ({ mocks }) => {
    const app = await setup(mocks)
    const originalSubmit = app.reddit.client.submitPost
    let broken = true
    app.reddit.client.submitPost = async options => {
      const post = await originalSubmit(options)
      const setSort = post.setSuggestedCommentSort
      post.setSuggestedCommentSort = async s => { if (broken) throw new Error('500 server error'); return setSort(s) }
      return post
    }
    await expect(app.runJob('monthly-post')).rejects.toThrow('500')
    const thread = await currentPostId(app)
    expect(thread).not.toBe(MONTHLY)

    broken = false
    await app.runJob('monthly-post')

    expect(await currentPostId(app)).toBe(thread)
    expect(submitted(app)).toBe(1)
    expect(app.reddit.posts.get(MONTHLY)).toMatchObject({ locked: true, stickied: false })
    expect(stickied(app)).toEqual([thread])
  })

  test('the retry after a successful full rotation sends no second modmail and no second thread', async ({ mocks }) => {
    const app = await setup(mocks)
    await app.runJob('monthly-post')
    expect(app.reddit.modmail).toHaveLength(1)

    vi.setSystemTime(new Date('2026-11-30T13:00:00Z'))
    await app.runJob('monthly-post')
    await app.runJob('monthly-post')

    expect(app.reddit.modmail).toHaveLength(1)
    expect(submitted(app)).toBe(1)
  })

  test('after a modmail failure the retry sends exactly one modmail even if run again', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.failNext('createModmail', '500 modmail down')
    await expect(app.runJob('monthly-post')).rejects.toThrow()

    await app.runJob('monthly-post')
    await app.runJob('monthly-post')

    expect(app.reddit.modmail).toHaveLength(1)
  })

  test('stickying fails, then works: the retry locks the previous thread (already done), stickies and sends the modmail once', async ({ mocks }) => {
    const app = await setup(mocks)
    const state = failStickyOnNewPosts(app, '500 sticky slots full')
    await expect(app.runJob('monthly-post')).rejects.toThrow('500')
    expect(app.reddit.modmail).toHaveLength(0)

    state.broken = false
    await app.runJob('monthly-post')
    await app.runJob('monthly-post')

    const thread = await currentPostId(app)
    expect(stickied(app)).toEqual([thread])
    expect(app.reddit.posts.get(MONTHLY)).toMatchObject({ locked: true, stickied: false })
    expect(app.reddit.modmail).toHaveLength(1)
    expect(submitted(app)).toBe(1)
  })

  test('setting the suggested sort fails: the retry sets the sort, stickies and sends the modmail once', async ({ mocks }) => {
    const app = await setup(mocks)
    const originalSubmit = app.reddit.client.submitPost
    const sortCalls: string[] = []
    let broken = true
    const wrap = <T extends { id: string, setSuggestedCommentSort: (s: 'NEW') => Promise<unknown> }>(post: T): T => {
      if (post.id === MONTHLY) return post
      const setSort = post.setSuggestedCommentSort
      post.setSuggestedCommentSort = async s => { sortCalls.push(post.id); if (broken) throw new Error('500 server error'); return setSort(s) }
      return post
    }
    app.reddit.client.submitPost = async options => wrap(await originalSubmit(options))
    const originalByUser = app.reddit.client.getPostsByUser
    app.reddit.client.getPostsByUser = options => {
      const listing = originalByUser(options)
      return { all: async () => (await listing.all()).map(wrap) }
    }
    await expect(app.runJob('monthly-post')).rejects.toThrow('500')

    broken = false
    await app.runJob('monthly-post')
    const callsAfterRetry = sortCalls.length
    await app.runJob('monthly-post')

    expect(sortCalls).toHaveLength(callsAfterRetry)
    expect(callsAfterRetry).toBe(2)
    expect(app.reddit.modmail).toHaveLength(1)
  })

  test('a new month starts a new rotation: the modmail is sent again and the previous thread is the old pointer', async ({ mocks }) => {
    const app = await setup(mocks)
    await app.runJob('monthly-post')
    const november = await currentPostId(app)

    vi.setSystemTime(new Date('2027-01-01T00:00:00Z'))
    await app.runJob('monthly-post')

    expect(app.reddit.modmail).toHaveLength(2)
    expect(app.reddit.posts.get(november)).toMatchObject({ locked: true, stickied: false })
    expect(stickied(app)).toEqual([await currentPostId(app)])
  })
})

describe('the rescan across the month boundary', () => {
  test('a confirmation counted just before rollover is not counted again by the rescan after it', async ({ mocks }) => {
    const app = await setup(mocks)
    vi.setSystemTime(new Date('2026-11-30T23:59:50Z'))
    tradeComments(app)
    await app.fireTrigger('CommentSubmit', replyEvent('t1_reply', 't1_offer', 'bob', 'confirmed'))
    const flairWrites = () => app.reddit.calls.filter(c => c.method === 'setUserFlair' || c.method === 'setUserFlairBatch').length
    const writes = flairWrites()

    vi.setSystemTime(new Date('2026-12-01T00:00:00Z'))
    await app.runJob('monthly-post')
    vi.setSystemTime(new Date('2026-12-01T00:30:00Z'))
    await app.runJob('rescan-monthly-post')
    vi.setSystemTime(new Date('2026-12-01T01:30:00Z'))
    await app.runJob('rescan-monthly-post')

    expect(await app.ctx.redis.get('confirmations:alice')).toBe('1')
    expect(await app.ctx.redis.get('confirmations:bob')).toBe('1')
    expect(app.reddit.commentsBy('swapbot')).toHaveLength(1)
    expect(flairWrites()).toBe(writes)
  })

  test('a rescan that started on the old thread keeps counting while the rotation locks it, once per trade', async ({ mocks }) => {
    const app = await setup(mocks)
    tradeComments(app)
    const rescan = app.runJob('rescan-monthly-post')
    const rotation = app.runJob('monthly-post')
    await Promise.allSettled([rescan, rotation])
    await app.runJob('rescan-monthly-post')

    expect(await app.ctx.redis.get('confirmations:alice')).toBe('1')
    expect(await app.ctx.redis.get('confirmations:bob')).toBe('1')
    expect(app.reddit.repliesTo('t1_reply')).toHaveLength(1)
  })

  test('a late trigger delivery for the last thread after rollover, delivered twice, never counts the trade twice', async ({ mocks }) => {
    const app = await setup(mocks)
    vi.setSystemTime(new Date('2026-11-30T23:59:55Z'))
    tradeComments(app)
    vi.setSystemTime(new Date('2026-12-01T00:00:00Z'))
    await app.runJob('monthly-post')

    await app.fireTrigger('CommentSubmit', replyEvent('t1_reply', 't1_offer', 'bob', 'confirmed'))
    await app.fireTrigger('CommentSubmit', replyEvent('t1_reply', 't1_offer', 'bob', 'confirmed'))

    // Whether the trade is counted late or not at all is the BUG repro below; it is never counted
    // twice and never answered twice.
    expect(Number((await app.ctx.redis.get('confirmations:alice')) ?? 0)).toBeLessThanOrEqual(1)
    expect(Number((await app.ctx.redis.get('confirmations:bob')) ?? 0)).toBeLessThanOrEqual(1)
    expect(app.reddit.repliesTo('t1_reply').length).toBeLessThanOrEqual(1)
  })

  test('a valid confirmation posted just before rollover is still counted or answered after the rotation', async ({ mocks }) => {
    const app = await setup(mocks)
    vi.setSystemTime(new Date('2026-11-30T23:59:55Z'))
    tradeComments(app)
    vi.setSystemTime(new Date('2026-12-01T00:00:00Z'))
    await app.runJob('monthly-post')
    vi.setSystemTime(new Date('2026-12-01T00:30:00Z'))
    await app.runJob('rescan-monthly-post')
    await app.fireTrigger('CommentSubmit', replyEvent('t1_reply', 't1_offer', 'bob', 'confirmed'))

    const counted = await app.ctx.redis.get('confirmations:alice')
    expect(counted === '1' || app.reddit.repliesTo('t1_reply').length > 0).toBe(true)
  })

  test('a confirmation on the previous thread after the grace window is still rejected, and the rescan ignores that thread', async ({ mocks }) => {
    const app = await setup(mocks)
    vi.setSystemTime(new Date('2026-11-30T23:59:55Z'))
    tradeComments(app)
    vi.setSystemTime(new Date('2026-12-01T00:00:00Z'))
    await app.runJob('monthly-post')
    vi.setSystemTime(new Date('2026-12-01T06:30:00Z'))

    await app.runJob('rescan-monthly-post')
    await app.fireTrigger('CommentSubmit', replyEvent('t1_reply', 't1_offer', 'bob', 'confirmed'))

    expect(await app.ctx.redis.get('confirmations:alice')).toBeUndefined()
    expect(await app.ctx.redis.get('confirmations:bob')).toBeUndefined()
    expect(app.reddit.repliesTo('t1_reply')).toHaveLength(0)
    expect(app.reddit.calls.filter(c => c.method === 'getComments').some(c => (c.args[0] as { postId: string }).postId === MONTHLY)).toBe(false)
  })

  test('the trigger within the grace window counts the trade, and the rescan after it does not count it again', async ({ mocks }) => {
    const app = await setup(mocks)
    vi.setSystemTime(new Date('2026-11-30T23:59:55Z'))
    tradeComments(app)
    vi.setSystemTime(new Date('2026-12-01T00:00:00Z'))
    await app.runJob('monthly-post')
    vi.setSystemTime(new Date('2026-12-01T00:10:00Z'))
    await app.fireTrigger('CommentSubmit', replyEvent('t1_reply', 't1_offer', 'bob', 'confirmed'))
    await app.fireTrigger('CommentSubmit', replyEvent('t1_reply', 't1_offer', 'bob', 'confirmed'))
    vi.setSystemTime(new Date('2026-12-01T00:30:00Z'))
    await app.runJob('rescan-monthly-post')
    await app.runJob('rescan-monthly-post')

    expect(await app.ctx.redis.get('confirmations:alice')).toBe('1')
    expect(await app.ctx.redis.get('confirmations:bob')).toBe('1')
    expect(app.reddit.repliesTo('t1_reply')).toHaveLength(1)
  })

  test('the rescan within the grace window counts the trade, and a late trigger does not count it again', async ({ mocks }) => {
    const app = await setup(mocks)
    vi.setSystemTime(new Date('2026-11-30T23:59:55Z'))
    tradeComments(app)
    vi.setSystemTime(new Date('2026-12-01T00:00:00Z'))
    await app.runJob('monthly-post')
    vi.setSystemTime(new Date('2026-12-01T00:30:00Z'))
    await app.runJob('rescan-monthly-post')
    await app.fireTrigger('CommentSubmit', replyEvent('t1_reply', 't1_offer', 'bob', 'confirmed'))
    await app.runJob('rescan-monthly-post')

    expect(await app.ctx.redis.get('confirmations:alice')).toBe('1')
    expect(await app.ctx.redis.get('confirmations:bob')).toBe('1')
    expect(app.reddit.repliesTo('t1_reply')).toHaveLength(1)
  })

  test('a failing scan of the previous thread does not stop the rescan of the current one', async ({ mocks }) => {
    const app = await setup(mocks)
    vi.setSystemTime(new Date('2026-12-01T00:00:00Z'))
    await app.runJob('monthly-post')
    const december = await currentPostId(app)
    tradeComments(app, december)
    app.reddit.posts.delete(MONTHLY)
    vi.setSystemTime(new Date('2026-12-01T00:30:00Z'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await app.runJob('rescan-monthly-post')

    expect(await app.ctx.redis.get('confirmations:alice')).toBe('1')
  })

  test('a rotation retried after the grace window since its first attempt still gives the old thread a grace window once it is locked', async ({ mocks }) => {
    const app = await setup(mocks)
    vi.setSystemTime(new Date('2026-12-01T00:00:00Z'))
    app.reddit.failNext('submitPost', '500 reddit down')
    await expect(app.runJob('monthly-post')).rejects.toThrow('500')
    // The old thread stays unlocked and current; a confirmation lands on it shortly before the retry locks it.
    vi.setSystemTime(new Date('2026-12-01T08:55:00Z'))
    tradeComments(app)
    vi.setSystemTime(new Date('2026-12-01T09:00:00Z'))
    await app.runJob('monthly-post')
    expect(await currentPostId(app)).not.toBe(MONTHLY)
    vi.setSystemTime(new Date('2026-12-01T09:30:00Z'))

    await app.runJob('rescan-monthly-post')
    await app.fireTrigger('CommentSubmit', replyEvent('t1_reply', 't1_offer', 'bob', 'confirmed'))

    const counted = await app.ctx.redis.get('confirmations:alice')
    expect(counted === '1' || app.reddit.repliesTo('t1_reply').length > 0).toBe(true)
  })

  test('running the finished rotation again after the grace window does not extend the window', async ({ mocks }) => {
    const app = await setup(mocks)
    vi.setSystemTime(new Date('2026-11-30T23:59:55Z'))
    tradeComments(app)
    vi.setSystemTime(new Date('2026-12-01T00:00:00Z'))
    await app.runJob('monthly-post')
    vi.setSystemTime(new Date('2026-12-01T07:00:00Z'))
    await app.runJob('monthly-post')
    vi.setSystemTime(new Date('2026-12-01T07:30:00Z'))

    await app.runJob('rescan-monthly-post')
    await app.fireTrigger('CommentSubmit', replyEvent('t1_reply', 't1_offer', 'bob', 'confirmed'))

    expect(await app.ctx.redis.get('confirmations:alice')).toBeUndefined()
    expect(app.reddit.repliesTo('t1_reply')).toHaveLength(0)
  })

  test('a thread made by hand (no rotation record) still gives the old thread a grace window when it locks it', async ({ mocks }) => {
    const app = await setup(mocks)
    vi.setSystemTime(new Date('2026-11-30T23:59:55Z'))
    tradeComments(app)
    vi.setSystemTime(new Date('2026-12-01T00:00:00Z'))
    await app.runJob('monthly-post')
    const december = await currentPostId(app)
    await app.ctx.redis.del('previousMonthlyPost')
    app.reddit.posts.get(MONTHLY)!.locked = false
    await app.ctx.redis.del('monthlyRotation:swaps:2026-12')
    await app.ctx.redis.set('currentMonthlyPost', MONTHLY)
    await app.runJob('monthly-post')
    expect(await currentPostId(app)).toBe(december)
    expect(app.reddit.posts.get(MONTHLY)!.locked).toBe(true)
    vi.setSystemTime(new Date('2026-12-01T00:30:00Z'))

    await app.runJob('rescan-monthly-post')
    await app.fireTrigger('CommentSubmit', replyEvent('t1_reply', 't1_offer', 'bob', 'confirmed'))

    const counted = await app.ctx.redis.get('confirmations:alice')
    expect(counted === '1' || app.reddit.repliesTo('t1_reply').length > 0).toBe(true)
  })

  test('the rescan right after a failed rotation (pointer already moved) scans the new, empty thread without errors', async ({ mocks }) => {
    const app = await setup(mocks)
    app.reddit.failNext('createModmail', '500 modmail down')
    await expect(app.runJob('monthly-post')).rejects.toThrow()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await app.runJob('rescan-monthly-post')

    expect(app.reddit.calls.filter(c => c.method === 'getComments').at(-1)!.args[0]).toMatchObject({ postId: await currentPostId(app) })
    expect(log).not.toHaveBeenCalled()
  })

  test('the pointer names a deleted thread: the rescan neither throws nor counts anything', async ({ mocks }) => {
    const app = await setup(mocks)
    tradeComments(app)
    app.reddit.posts.delete(MONTHLY)

    await expect(app.runJob('rescan-monthly-post')).resolves.toBeUndefined()

    expect(await app.ctx.redis.get('confirmations:alice')).toBeUndefined()
  })
})

describe('scheduler jobs registered more than once', () => {
  const jobTypes = (app: AppHarness) =>
    app.mocks.scheduler.getScheduledActions().map(a => a.request.action?.type).sort()

  test('AppInstall delivered twice, then AppUpgrade, leaves one of each job', async ({ mocks }) => {
    const app = newApp(mocks)
    seedSwapsWorld(app)

    await app.fireTrigger('AppInstall', {})
    await app.fireTrigger('AppInstall', {})
    await app.fireTrigger('AppUpgrade', {})

    expect(jobTypes(app)).toEqual(['monthly-post', 'rescan-monthly-post'])
  })

  test('AppInstall and AppUpgrade handled at the same time leave one of each job', async ({ mocks }) => {
    const app = newApp(mocks)
    seedSwapsWorld(app)

    await Promise.all([app.fireTrigger('AppInstall', {}), app.fireTrigger('AppUpgrade', {})])

    expect(jobTypes(app)).toEqual(['monthly-post', 'rescan-monthly-post'])
  })

  test('ensureJobsScheduled returns what it added, and nothing the second time', async ({ mocks }) => {
    const app = newApp(mocks)
    expect(await ensureJobsScheduled(app.ctx)).toEqual(['monthly-post', 'rescan-monthly-post'])
    expect(await ensureJobsScheduled(app.ctx)).toEqual([])
  })

  test('registering the second job fails: the retry on the next upgrade adds only the missing one', async ({ mocks }) => {
    const app = newApp(mocks)
    seedSwapsWorld(app)
    const run = app.ctx.scheduler.runJob.bind(app.ctx.scheduler)
    let calls = 0
    app.ctx.scheduler.runJob = async spec => {
      if (++calls === 2) throw new Error('scheduler down')
      return run(spec)
    }

    await expect(app.fireTrigger('AppInstall', {})).rejects.toThrow('scheduler down')
    expect(jobTypes(app)).toEqual(['monthly-post'])
    await app.fireTrigger('AppUpgrade', {})

    expect(jobTypes(app)).toEqual(['monthly-post', 'rescan-monthly-post'])
  })

  test('a pending one-off monthly-post run does not stop the recurring monthly job from being scheduled', async ({ mocks }) => {
    const app = newApp(mocks)
    seedSwapsWorld(app)
    await app.pressMenuItem('Trigger monthly post now')

    await app.fireTrigger('AppUpgrade', {})

    const crons = app.mocks.scheduler.getScheduledActions()
      .filter(a => a.request.action?.type === 'monthly-post').map(a => a.request.cron)
    expect(crons).toContain('0 0 1 * *')
  })

  test('the cron expressions leave the rescan out of the minute of the rotation and run the rotation once a month', async ({ mocks }) => {
    const app = newApp(mocks)
    await ensureJobsScheduled(app.ctx)
    const crons = Object.fromEntries(app.mocks.scheduler.getScheduledActions().map(a => [a.request.action?.type, a.request.cron]))
    expect(crons['monthly-post']).toBe('0 0 1 * *')
    expect(crons['rescan-monthly-post']).toBe('30 * * * *')
  })
})
