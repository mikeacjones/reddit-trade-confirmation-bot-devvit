import { createDevvitTest } from '@devvit/test/server/vitest'
import { startApp, type AppHarness } from './app.js'
import { FakeReddit } from './redditFake.js'

export { FakeReddit } from './redditFake.js'
export type { AppHarness } from './app.js'

/** The Devvit test runner every scenario uses: a per-test Devvit global with Redis, settings and scheduler mocks. */
export const scenarioTest = createDevvitTest({ subredditName: 'swaps' })

/**
 * Standard scenario world: subreddit "swaps", bot account "swapbot" that owns the monthly thread
 * t3_monthly (already the current thread), moderators "mod1", the default trade-count flair
 * templates, and no trades yet.
 */
export function seedSwapsWorld(app: AppHarness): { monthlyPostId: string } {
  const { reddit } = app
  reddit.addModerator('mod1')
  for (let i = 0; i < 10; i++) {
    const min = i * 100
    const max = i === 9 ? 99999 : min + 99
    reddit.addFlairTemplate(`Trades: ${min}-${max}`, { id: `tpl-${min}` })
  }
  reddit.addFlairTemplate('Moderator | Trades: 0-99999', { id: 'tpl-mod', modOnly: true })
  const monthly = reddit.addPost({ id: 't3_monthly', title: 'Confirmed Trade Thread', stickied: true })
  return { monthlyPostId: monthly.id }
}

export function newApp(mocks: Parameters<typeof startApp>[0]['mocks'], reddit?: FakeReddit): AppHarness {
  return startApp({ mocks, subredditName: 'swaps', reddit: reddit ?? new FakeReddit({ subredditName: 'swaps' }) })
}
