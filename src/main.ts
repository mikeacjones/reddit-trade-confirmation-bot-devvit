import { Devvit } from '@devvit/public-api'
import { onCommentSubmit } from './events.js'
import { MONTHLY_POST_JOB, onMonthlyPost } from './monthly.js'
import {
  adjustUserTradesForm,
  onAdjustUserTradesFormSubmit,
  onManualConfirmationMenuAction,
  onQueueStatusMenuAction,
  onRetryFailedWorkMenuAction,
  onRescanMonthlyPostMenuAction,
  onSetCurrentConfirmationPostMenuAction,
  showAdjustUserTradesForm,
  showSetUserTradesForm,
} from './modActions.js'
import { enqueueCurrentMonthlyPostComments, RESCAN_CONFIRMATION_COMMENTS_JOB } from './rescan.js'
import { ensureWorkerScheduled } from './scheduling.js'
import { appSettings } from './settings.js'
import { PROCESS_CONFIRMATION_WORK_JOB } from './workQueue.js'
import { processConfirmationWork } from './worker.js'

Devvit.configure({ redditAPI: true, redis: true })

Devvit.addSettings(appSettings)

const adjustUserTradesFormKey = Devvit.createForm(adjustUserTradesForm, async (event, ctx) => {
  await onAdjustUserTradesFormSubmit(event, ctx)
})

Devvit.addTrigger({ event: 'CommentSubmit', onEvent: onCommentSubmit })

Devvit.addMenuItem({
  label: 'Trigger monthly post now',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, ctx) => {
    await ctx.scheduler.runJob({ name: MONTHLY_POST_JOB, runAt: new Date() })
  },
})

Devvit.addMenuItem({
  label: 'Set current confirmation post',
  location: 'post',
  forUserType: 'moderator',
  onPress: async (event, ctx) => {
    await onSetCurrentConfirmationPostMenuAction(event, ctx)
  },
})

Devvit.addMenuItem({
  label: 'Manually approve confirmation',
  location: 'comment',
  forUserType: 'moderator',
  onPress: async (event, ctx) => {
    await onManualConfirmationMenuAction(event, ctx)
  },
})

Devvit.addMenuItem({
  label: 'Adjust user trades',
  location: 'comment',
  forUserType: 'moderator',
  onPress: async (event, ctx) => {
    await showAdjustUserTradesForm(event, ctx, adjustUserTradesFormKey)
  },
})

Devvit.addMenuItem({
  label: 'Set user trades',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, ctx) => {
    await showSetUserTradesForm(ctx, adjustUserTradesFormKey)
  },
})

Devvit.addMenuItem({
  label: 'Retry failed work',
  location: 'comment',
  forUserType: 'moderator',
  onPress: async (event, ctx) => {
    await onRetryFailedWorkMenuAction(event, ctx)
  },
})

Devvit.addMenuItem({
  label: 'Show work queue',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, ctx) => {
    await onQueueStatusMenuAction(ctx)
  },
})

Devvit.addMenuItem({
  label: 'Re-scan monthly post comments',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, ctx) => {
    await onRescanMonthlyPostMenuAction(ctx)
  },
})

Devvit.addTrigger({
  event: 'AppInstall',
  onEvent: async (_event, ctx) => {
    await ensureWorkerScheduled(ctx)
  },
})

Devvit.addTrigger({
  event: 'AppUpgrade',
  onEvent: async (_event, ctx) => {
    await ensureWorkerScheduled(ctx)
  },
})

Devvit.addSchedulerJob({
  name: MONTHLY_POST_JOB,
  onRun: onMonthlyPost,
})

Devvit.addSchedulerJob({
  name: PROCESS_CONFIRMATION_WORK_JOB,
  onRun: async (_event, ctx) => {
    await processConfirmationWork(ctx)
  },
})

Devvit.addSchedulerJob({
  name: RESCAN_CONFIRMATION_COMMENTS_JOB,
  onRun: async (_event, ctx) => {
    await enqueueCurrentMonthlyPostComments(ctx)
  },
})

export default Devvit
