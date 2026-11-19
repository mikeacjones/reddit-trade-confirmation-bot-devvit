import type { TriggerContext } from '@devvit/public-api'

// The rescan runs at half past to stay clear of the monthly rotation at
// midnight on the 1st, when the previous thread is being locked and the
// currentMonthlyPost pointer is mid-flip.
const SCHEDULED_JOBS = [
  { name: 'monthly-post', cron: '0 0 1 * *' },
  { name: 'rescan-monthly-post', cron: '30 * * * *' },
]

type SchedulerContext = Pick<TriggerContext, 'scheduler'>
type ListedJob = Awaited<ReturnType<SchedulerContext['scheduler']['listJobs']>>[number]

// A recurring job is identified by its name and its cron. A one-off run of the same job (the
// "Trigger monthly post now" menu item) has the name but no cron, so it is not the recurring job.
function isRecurring(job: ListedJob, spec: { name: string, cron: string }): boolean {
  return job.name === spec.name && 'cron' in job && job.cron === spec.cron
}

export async function ensureJobsScheduled(ctx: SchedulerContext): Promise<string[]> {
  const existing = await ctx.scheduler.listJobs()
  const added: string[] = []
  for (const job of SCHEDULED_JOBS) {
    if (existing.some(listed => isRecurring(listed, job))) continue
    await ctx.scheduler.runJob({ name: job.name, cron: job.cron })
    added.push(job.name)
  }
  if (added.length > 0) await cancelDuplicates(ctx)
  return added
}

// Listing and then registering is not atomic, so two handlers running at once (AppInstall and
// AppUpgrade) can both see a job missing and both register it. After registering, every handler
// lists again and cancels all but the job with the lowest id of each recurring spec. The handlers
// all keep the same survivor, so concurrent callers converge on exactly one of each job.
async function cancelDuplicates(ctx: SchedulerContext): Promise<void> {
  const listed = await ctx.scheduler.listJobs()
  for (const spec of SCHEDULED_JOBS) {
    const copies = listed.filter(job => isRecurring(job, spec)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    for (const duplicate of copies.slice(1)) await ctx.scheduler.cancelJob(duplicate.id)
  }
}
