import { PROCESS_CONFIRMATION_WORK_JOB } from './workQueue.js'
import { MONTHLY_POST_CRON, MONTHLY_POST_JOB } from './monthly.js'
import {
  RESCAN_CONFIRMATION_COMMENTS_CRON,
  RESCAN_CONFIRMATION_COMMENTS_JOB,
} from './rescan.js'

export const PROCESS_CONFIRMATION_WORK_CRON = '*/2 * * * * *'

const RECURRING_JOBS = [
  { name: PROCESS_CONFIRMATION_WORK_JOB, cron: PROCESS_CONFIRMATION_WORK_CRON },
  { name: MONTHLY_POST_JOB, cron: MONTHLY_POST_CRON },
  { name: RESCAN_CONFIRMATION_COMMENTS_JOB, cron: RESCAN_CONFIRMATION_COMMENTS_CRON },
]

interface ScheduledJobSummary {
  name: string
}

interface SchedulerContext {
  scheduler: {
    listJobs(): Promise<ScheduledJobSummary[]>
    runJob(job: { name: string; cron: string }): Promise<string>
  }
}

export async function ensureWorkerScheduled(ctx: SchedulerContext): Promise<string[]> {
  const existing = new Set((await ctx.scheduler.listJobs()).map(job => job.name))
  const scheduled: string[] = []
  for (const job of RECURRING_JOBS) {
    if (existing.has(job.name)) continue
    await ctx.scheduler.runJob(job)
    scheduled.push(job.name)
  }
  return scheduled
}
