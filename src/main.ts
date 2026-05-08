import { Devvit } from '@devvit/public-api'
import { onCommentSubmit, onMonthlyPost, onLockSubmissions, rescanCurrentMonthlyPost } from './handlers.js'
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

Devvit.addTrigger({ event: 'CommentSubmit', onEvent: onCommentSubmit })

Devvit.addSchedulerJob({ name: 'monthly-post', onRun: onMonthlyPost })
Devvit.addSchedulerJob({ name: 'lock-submissions', onRun: onLockSubmissions })

Devvit.addTrigger({
  event: 'AppInstall',
  onEvent: async (_e, ctx) => {
    await ctx.scheduler.runJob({ name: 'monthly-post', cron: '0 0 1 * *' })
    await ctx.scheduler.runJob({ name: 'lock-submissions', cron: '0 0 5 * *' })
  },
})

Devvit.addMenuItem({
  label: 'Trigger monthly post now',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_e, ctx) => { await ctx.scheduler.runJob({ name: 'monthly-post', runAt: new Date() }) },
})

Devvit.addMenuItem({
  label: 'Lock old threads now',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_e, ctx) => { await ctx.scheduler.runJob({ name: 'lock-submissions', runAt: new Date() }) },
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
    const { name } = await ctx.reddit.getCurrentSubreddit()
    for (let i = 0; i < 10; i++) {
      const min = i * 100
      const max = i === 9 ? 99999 : min + 99
      const bg = randomHex()
      await ctx.reddit.createUserFlairTemplate({
        subredditName: name,
        text: `Trades: ${min}-${max}`,
        backgroundColor: bg,
        textColor: pickTextColor(bg),
      })
    }
    await ctx.reddit.createUserFlairTemplate({
      subredditName: name,
      text: 'Moderator | Trades: 0-99999',
      backgroundColor: '#46d160',
      textColor: 'dark',
      modOnly: true,
    })
    await ctx.redis.set('flairs_seeded', '1')
    ctx.ui.showToast('Created 11 user flair templates')
  },
})

export default Devvit
