import { Devvit } from '@devvit/public-api'
import {
  adjustUserTradeCount,
  onCommentSubmit,
  onMonthlyPost,
  onModAction,
  redditApiCall,
  refreshFlairTemplateCache,
  refreshModeratorCache,
  rescanCurrentMonthlyPost,
} from './handlers.js'
import { defaults } from './defaults/index.js'

Devvit.configure({ redditAPI: true, redis: true })

Devvit.addSettings([
  { name: 'monthly_post_title', type: 'string', label: 'Monthly post title (strftime)', defaultValue: defaults.monthly_post_title },
  { name: 'monthly_post', type: 'paragraph', label: 'Monthly post body', defaultValue: defaults.monthly_post },
  { name: 'trade_confirmation', type: 'paragraph', label: 'Trade confirmation reply', defaultValue: defaults.trade_confirmation },
  { name: 'already_confirmed', type: 'paragraph', label: 'Already-confirmed reply', defaultValue: defaults.already_confirmed },
  { name: 'cant_confirm_username', type: 'paragraph', label: "Can't-confirm-username reply", defaultValue: defaults.cant_confirm_username },
  { name: 'old_confirmation_thread', type: 'paragraph', label: 'Old-thread reply', defaultValue: defaults.old_confirmation_thread },
  { name: 'monthly_post_flair_id', type: 'string', label: 'Optional submission flair ID', defaultValue: '' },
])

const adjustTradeCountForm = Devvit.createForm({
  title: 'Set user trade count',
  acceptLabel: 'Set count',
  fields: [
    {
      type: 'string',
      name: 'username',
      label: 'Username',
      helpText: 'Enter the Reddit username with or without u/.',
      required: true,
    },
    {
      type: 'number',
      name: 'count',
      label: 'Trade count',
      helpText: 'Must be zero or greater.',
      required: true,
      defaultValue: 0,
    },
  ],
}, async (event, ctx) => {
  try {
    const result = await adjustUserTradeCount(
      ctx,
      String(event.values.username ?? ''),
      Number(event.values.count),
    )
    ctx.ui.showToast(`Set u/${result.username} to ${result.count} trades`)
  } catch (error) {
    console.warn(`Failed to adjust trade count: ${error instanceof Error ? error.message : String(error)}`)
    ctx.ui.showToast(error instanceof Error ? error.message : 'Failed to adjust trade count')
  }
})

Devvit.addTrigger({ event: 'CommentSubmit', onEvent: onCommentSubmit })
Devvit.addTrigger({ event: 'ModAction', onEvent: onModAction })

Devvit.addSchedulerJob({ name: 'monthly-post', onRun: onMonthlyPost })

Devvit.addTrigger({
  event: 'AppInstall',
  onEvent: async (_e, ctx) => {
    await ctx.scheduler.runJob({ name: 'monthly-post', cron: '0 0 1 * *' })
    const { name } = await redditApiCall(ctx, () => ctx.reddit.getCurrentSubreddit(), 'get current subreddit')
    await refreshModeratorCache(ctx, name)
  },
})

Devvit.addTrigger({
  event: 'AppUpgrade',
  onEvent: async (_e, ctx) => {
    const { name } = await redditApiCall(ctx, () => ctx.reddit.getCurrentSubreddit(), 'get current subreddit')
    await refreshModeratorCache(ctx, name)
  },
})

Devvit.addMenuItem({
  label: 'Trigger monthly post now',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_e, ctx) => { await ctx.scheduler.runJob({ name: 'monthly-post', runAt: new Date() }) },
})

Devvit.addMenuItem({
  label: 'Re-scan monthly post comments',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_e, ctx) => {
    const { scanned, processed } = await rescanCurrentMonthlyPost(ctx)
    ctx.ui.showToast(`Re-scan: ${scanned} comments, ${processed} newly processed`)
  },
})

Devvit.addMenuItem({
  label: 'Set user trade count',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_e, ctx) => {
    ctx.ui.showForm(adjustTradeCountForm)
  },
})

function randomHex(): string {
  return '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')
}

function pickTextColor(hex: string): 'light' | 'dark' {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return (r * 299 + g * 587 + b * 114) / 1000 > 128 ? 'dark' : 'light'
}

Devvit.addMenuItem({
  label: 'Set up default user flairs',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_e, ctx) => {
    if (await ctx.redis.get('flairs_seeded')) {
      ctx.ui.showToast('Flairs already set up')
      return
    }
    const { name } = await redditApiCall(ctx, () => ctx.reddit.getCurrentSubreddit(), 'get current subreddit')
    for (let i = 0; i < 10; i++) {
      const min = i * 100
      const max = i === 9 ? 99999 : min + 99
      const bg = randomHex()
      await redditApiCall(ctx, () => ctx.reddit.createUserFlairTemplate({
        subredditName: name,
        text: `Trades: ${min}-${max}`,
        backgroundColor: bg,
        textColor: pickTextColor(bg),
      }), `create flair template Trades: ${min}-${max}`)
    }
    await redditApiCall(ctx, () => ctx.reddit.createUserFlairTemplate({
      subredditName: name,
      text: 'Moderator | Trades: 0-99999',
      backgroundColor: '#46d160',
      textColor: 'dark',
      modOnly: true,
    }), 'create moderator flair template')
    await refreshFlairTemplateCache(ctx, name)
    await ctx.redis.set('flairs_seeded', '1')
    ctx.ui.showToast('Created 11 user flair templates')
  },
})

Devvit.addMenuItem({
  label: 'Refresh flair template cache',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_e, ctx) => {
    const { name } = await redditApiCall(ctx, () => ctx.reddit.getCurrentSubreddit(), 'get current subreddit')
    await refreshFlairTemplateCache(ctx, name)
    ctx.ui.showToast('Flair template cache refreshed')
  },
})

Devvit.addMenuItem({
  label: 'Refresh moderator cache',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_e, ctx) => {
    const { name } = await redditApiCall(ctx, () => ctx.reddit.getCurrentSubreddit(), 'get current subreddit')
    const moderators = await refreshModeratorCache(ctx, name)
    ctx.ui.showToast(`Moderator cache refreshed (${moderators.size} mods)`)
  },
})

export default Devvit
