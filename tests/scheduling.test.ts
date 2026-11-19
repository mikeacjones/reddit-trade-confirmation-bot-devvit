import { describe, expect, it, vi } from 'vitest'
import { ensureJobsScheduled } from '../src/scheduling'

function mockContext(existingJobs: Array<{ name: string, cron?: string }> = []) {
  const runJob = vi.fn(async () => 'job-id')
  const listJobs = vi.fn(async () => existingJobs)
  return { ctx: { scheduler: { runJob, listJobs } } as any, runJob, listJobs }
}

describe('ensureJobsScheduled', () => {
  it('schedules the monthly post and hourly rescan when nothing is scheduled', async () => {
    const { ctx, runJob } = mockContext()

    const added = await ensureJobsScheduled(ctx)

    expect(added).toEqual(['monthly-post', 'rescan-monthly-post'])
    expect(runJob).toHaveBeenCalledWith({ name: 'monthly-post', cron: '0 0 1 * *' })
    expect(runJob).toHaveBeenCalledWith({ name: 'rescan-monthly-post', cron: '30 * * * *' })
  })

  it('does not duplicate jobs that are already scheduled', async () => {
    const { ctx, runJob } = mockContext([
      { name: 'monthly-post', cron: '0 0 1 * *' },
      { name: 'rescan-monthly-post', cron: '30 * * * *' },
    ])

    const added = await ensureJobsScheduled(ctx)

    expect(added).toEqual([])
    expect(runJob).not.toHaveBeenCalled()
  })

  it('adds only the missing job on an existing install', async () => {
    const { ctx, runJob } = mockContext([{ name: 'monthly-post', cron: '0 0 1 * *' }])

    const added = await ensureJobsScheduled(ctx)

    expect(added).toEqual(['rescan-monthly-post'])
    expect(runJob).toHaveBeenCalledOnce()
    expect(runJob).toHaveBeenCalledWith({ name: 'rescan-monthly-post', cron: '30 * * * *' })
  })

  it('does not treat a one-off run of the same job as the recurring one', async () => {
    const { ctx, runJob } = mockContext([{ name: 'monthly-post' }, { name: 'rescan-monthly-post', cron: '30 * * * *' }])

    const added = await ensureJobsScheduled(ctx)

    expect(added).toEqual(['monthly-post'])
    expect(runJob).toHaveBeenCalledWith({ name: 'monthly-post', cron: '0 0 1 * *' })
  })

  it('cancels all but the lowest-id copy of a recurring job registered twice, and leaves one-offs alone', async () => {
    const jobs = [
      { id: 'b', name: 'monthly-post', cron: '0 0 1 * *' },
      { id: 'a', name: 'monthly-post', cron: '0 0 1 * *' },
      { id: 'o', name: 'monthly-post' },
      { id: 'c', name: 'rescan-monthly-post', cron: '30 * * * *' },
    ]
    const runJob = vi.fn(async () => 'job-id')
    const cancelJob = vi.fn(async () => undefined)
    // The first listing misses the rescan job; the listing after registering shows the duplicate monthly job.
    const listJobs = vi.fn()
      .mockResolvedValueOnce([jobs[0], jobs[2]])
      .mockResolvedValue(jobs)

    await ensureJobsScheduled({ scheduler: { runJob, listJobs, cancelJob } } as any)

    expect(cancelJob).toHaveBeenCalledTimes(1)
    expect(cancelJob).toHaveBeenCalledWith('b')
  })
})
