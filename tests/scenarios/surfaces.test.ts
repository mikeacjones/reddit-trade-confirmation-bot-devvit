import { describe, expect, vi } from 'vitest'
import { newApp, scenarioTest as test, seedSwapsWorld } from '../harness/scenario.js'

describe('registration in src/main.ts', () => {
  test('the harness sees every trigger, job and menu item the app registers', async ({ mocks }) => {
    const app = newApp(mocks)
    const { triggers, jobs, menuItems } = app.registered()
    expect(triggers.sort()).toEqual(['AppInstall', 'AppUpgrade', 'CommentSubmit', 'ModAction', 'PostSubmit'])
    expect(jobs.sort()).toEqual(['monthly-post', 'rescan-monthly-post'])
    expect(menuItems).toContain('Set user trade count')
    expect(menuItems).toContain('Approve trade confirmation')
  })
})

describe('AppInstall and ModAction triggers', () => {
  test('AppInstall schedules both jobs through the scheduler mock and caches moderators in Redis', async ({ mocks }) => {
    const app = newApp(mocks)
    seedSwapsWorld(app)

    await app.fireTrigger('AppInstall', {})

    const scheduled = mocks.scheduler.getScheduledActions().map(a => ({ type: a.request.action?.type, cron: a.request.cron }))
    expect(scheduled).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'monthly-post', cron: '0 0 1 * *' }),
      expect.objectContaining({ type: 'rescan-monthly-post', cron: '30 * * * *' }),
    ]))
    expect(JSON.parse((await app.ctx.redis.get('moderators'))!).usernames).toEqual(['mod1'])

    // A second install (AppUpgrade) does not schedule the jobs again.
    await app.fireTrigger('AppUpgrade', {})
    expect(mocks.scheduler.getScheduledActions()).toHaveLength(2)
  })

  test('a moderator-membership ModAction refreshes the moderator cache', async ({ mocks }) => {
    const app = newApp(mocks)
    seedSwapsWorld(app)
    await app.fireTrigger('AppInstall', {})

    app.reddit.addModerator('mod2')
    await app.fireTrigger('ModAction', { action: 'addmoderator', subreddit: { name: 'swaps' } })

    expect(JSON.parse((await app.ctx.redis.get('moderators'))!).usernames).toEqual(['mod1', 'mod2'])
  })
})

describe('scheduler jobs', () => {
  test('monthly-post creates, stickies and records the thread, then modmails the mods', async ({ mocks }) => {
    const app = newApp(mocks)
    seedSwapsWorld(app)
    await app.ctx.redis.set('currentMonthlyPost', 't3_monthly')

    await app.runJob('monthly-post')

    const currentId = (await app.ctx.redis.get('currentMonthlyPost'))!
    expect(currentId).not.toBe('t3_monthly')
    const created = app.reddit.posts.get(currentId)!
    expect(created).toMatchObject({ authorName: 'swapbot', stickied: true, suggestedSort: 'NEW' })
    expect(created.title).toMatch(/Confirmed Trade Thread$/)
    // The previous thread is unstickied and locked.
    expect(app.reddit.posts.get('t3_monthly')).toMatchObject({ stickied: false, locked: true })
    expect(app.reddit.modmail).toHaveLength(1)
    expect(app.reddit.modmail[0].subject).toBe('Monthly thread is up')
  })

  test('rescan-monthly-post processes a confirmation whose trigger was missed', async ({ mocks }) => {
    const app = newApp(mocks)
    const { monthlyPostId } = seedSwapsWorld(app)
    const { reddit } = app
    await app.ctx.redis.set('currentMonthlyPost', monthlyPostId)
    reddit.addComment({ id: 't1_offer', parentId: monthlyPostId, postId: monthlyPostId, authorName: 'alice', body: 'Sold a kit to u/bob' })
    reddit.addComment({ id: 't1_reply', parentId: 't1_offer', postId: monthlyPostId, authorName: 'bob', body: 'confirmed' })

    await app.runJob('rescan-monthly-post')

    expect(await app.ctx.redis.get('confirmations:alice')).toBe('1')
    expect(await app.ctx.redis.get('confirmations:bob')).toBe('1')
    expect(reddit.repliesTo('t1_reply')).toHaveLength(1)
  })
})

describe('menu items and forms', () => {
  test('"Set user trade count" opens the form and submitting it sets the count and flair', async ({ mocks }) => {
    const app = newApp(mocks)
    seedSwapsWorld(app)

    const opened = await app.pressMenuItem('Set user trade count')
    expect(opened.forms).toHaveLength(1)
    expect(opened.forms[0].title).toBe('Set user trade count')

    const submitted = await app.submitForm(opened.forms[0].id, { username: 'u/alice', count: 120 })

    expect(submitted.toasts).toEqual(['Set u/alice to 120 trades'])
    expect(await app.ctx.redis.get('confirmations:alice')).toBe('120')
    expect(app.reddit.flairOf('alice')).toEqual({ text: 'Trades: 120', flairTemplateId: 'tpl-100' })
  })

  test('the form reports bad input as a toast and changes nothing', async ({ mocks }) => {
    const app = newApp(mocks)
    seedSwapsWorld(app)
    const { forms } = await app.pressMenuItem('Set user trade count')

    const submitted = await app.submitForm(forms[0].id, { username: 'alice', count: -1 })

    expect(submitted.toasts).toEqual(['Trade count must be a non-negative whole number'])
    expect(await app.ctx.redis.get('confirmations:alice')).toBeUndefined()
  })

  test('"Adjust comment author\'s flair" opens the form prefilled from Redis', async ({ mocks }) => {
    const app = newApp(mocks)
    const { monthlyPostId } = seedSwapsWorld(app)
    app.reddit.addComment({ id: 't1_offer', parentId: monthlyPostId, postId: monthlyPostId, authorName: 'alice', body: 'hi' })
    await app.ctx.redis.set('confirmations:alice', '7')

    const { forms } = await app.pressMenuItem("Adjust comment author's flair", { location: 'comment', targetId: 't1_offer' })

    expect(forms).toHaveLength(1)
    expect(forms[0].fields.map(f => f.defaultValue)).toEqual(['alice', 7])
  })

  test('"Approve trade confirmation" approves a reply the trigger rejected', async ({ mocks }) => {
    const app = newApp(mocks)
    const { monthlyPostId } = seedSwapsWorld(app)
    const { reddit } = app
    await app.ctx.redis.set('currentMonthlyPost', monthlyPostId)
    reddit.addComment({ id: 't1_offer', parentId: monthlyPostId, postId: monthlyPostId, authorName: 'alice', body: 'Sold a kit' })
    reddit.addComment({ id: 't1_reply', parentId: 't1_offer', postId: monthlyPostId, authorName: 'bob', body: 'confirmed' })

    const { toasts } = await app.pressMenuItem('Approve trade confirmation', { location: 'comment', targetId: 't1_reply' })

    expect(toasts).toEqual(['Approved confirmation for u/alice and u/bob'])
    expect(await app.ctx.redis.get('confirmations:alice')).toBe('1')
    expect(await app.ctx.redis.get('confirmations:bob')).toBe('1')
  })

  test('"Set up default user flairs" creates the templates once', async ({ mocks }) => {
    const app = newApp(mocks)
    app.reddit.addModerator('mod1')

    const first = await app.pressMenuItem('Set up default user flairs')
    const second = await app.pressMenuItem('Set up default user flairs')

    expect(first.toasts).toEqual(['Created 11 user flair templates'])
    expect(second.toasts).toEqual(['Flairs already set up'])
    expect(app.reddit.flairTemplates).toHaveLength(11)
  })
})

describe('PostSubmit trigger', () => {
  const event = {
    post: { id: 't3_new', title: 'WTS: kit', selftext: 'body', permalink: '/r/swaps/comments/new/', url: '', createdAt: 1_700_000_000_000 },
    author: { name: 'alice', id: 't2_alice' },
    subreddit: { name: 'swaps', id: 't5_swaps' },
  }

  test('does nothing, and makes no network call, when no Discord webhook is configured', async ({ mocks }) => {
    const app = newApp(mocks)
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    try {
      await app.fireTrigger('PostSubmit', event)
    } finally {
      vi.unstubAllGlobals()
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('posts to the configured webhook (fetch stubbed; no real Discord call)', async ({ mocks }) => {
    const app = newApp(mocks)
    mocks.settings.put('mod_new_post_discord_webhook', 'https://discord.com/api/webhooks/123/abc')
    app.reddit.addUser('alice')
    await app.ctx.redis.set('confirmations:alice', '4')
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ attachments: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    try {
      await app.fireTrigger('PostSubmit', event)
    } finally {
      vi.unstubAllGlobals()
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, { body: string }]
    expect(url).toContain('https://discord.com/api/webhooks/123/abc')
    expect(init.body).toContain('WTS: kit')
    expect(init.body).toContain('**4** confirmed trades')
  })
})
