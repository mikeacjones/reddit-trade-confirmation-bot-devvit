import { describe, expect, it, vi } from 'vitest'
import {
  ensureWorkerScheduled,
  PROCESS_CONFIRMATION_WORK_CRON,
} from '../src/scheduling.js'
import { MONTHLY_POST_CRON, MONTHLY_POST_JOB } from '../src/monthly.js'
import {
  RESCAN_CONFIRMATION_COMMENTS_CRON,
  RESCAN_CONFIRMATION_COMMENTS_JOB,
} from '../src/rescan.js'
import { PROCESS_CONFIRMATION_WORK_JOB } from '../src/workQueue.js'

function mockContext(existingJobs: Array<{ name: string }> = []) {
  const listJobs = vi.fn(async () => existingJobs)
  const runJob = vi.fn(async () => 'job-id')
  return { ctx: { scheduler: { listJobs, runJob } }, listJobs, runJob }
}

describe('ensureWorkerScheduled', () => {
  it('schedules recurring worker, monthly post, and rescan jobs when missing', async () => {
    const { ctx, runJob } = mockContext()

    await expect(ensureWorkerScheduled(ctx)).resolves.toEqual([
      PROCESS_CONFIRMATION_WORK_JOB,
      MONTHLY_POST_JOB,
      RESCAN_CONFIRMATION_COMMENTS_JOB,
    ])

    expect(runJob).toHaveBeenCalledWith({
      name: PROCESS_CONFIRMATION_WORK_JOB,
      cron: PROCESS_CONFIRMATION_WORK_CRON,
    })
    expect(runJob).toHaveBeenCalledWith({
      name: MONTHLY_POST_JOB,
      cron: MONTHLY_POST_CRON,
    })
    expect(runJob).toHaveBeenCalledWith({
      name: RESCAN_CONFIRMATION_COMMENTS_JOB,
      cron: RESCAN_CONFIRMATION_COMMENTS_CRON,
    })
  })

  it('does not schedule duplicate recurring jobs', async () => {
    const { ctx, runJob } = mockContext([
      { name: PROCESS_CONFIRMATION_WORK_JOB },
      { name: MONTHLY_POST_JOB },
      { name: RESCAN_CONFIRMATION_COMMENTS_JOB },
    ])

    await expect(ensureWorkerScheduled(ctx)).resolves.toEqual([])

    expect(runJob).not.toHaveBeenCalled()
  })
})
