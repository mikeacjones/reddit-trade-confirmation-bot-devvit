import type { TriggerContext } from '@devvit/public-api'

// The rescan runs at half past to stay clear of the monthly rotation at
// midnight on the 1st, when the previous thread is being locked and the
// currentMonthlyPost pointer is mid-flip.
const SCHEDULED_JOBS = [
  { name: 'monthly-post', cron: '0 0 1 * *' },
  { name: 'rescan-monthly-post', cron: '30 * * * *' },
]

type SchedulerContext = Pick<TriggerContext, 'scheduler'>

export async function ensureJobsScheduled(ctx: SchedulerContext): Promise<string[]> {
  const existing = new Set((await ctx.scheduler.listJobs()).map(job => job.name))
  const added: string[] = []
  for (const job of SCHEDULED_JOBS) {
    if (existing.has(job.name)) continue
    await ctx.scheduler.runJob({ name: job.name, cron: job.cron })
    added.push(job.name)
  }
  return added
}
