import { describe, expect, it, vi } from 'vitest'
import { ensureJobsScheduled } from '../src/scheduling'

function mockContext(existingJobs: Array<{ name: string }> = []) {
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
      { name: 'monthly-post' },
      { name: 'rescan-monthly-post' },
    ])

    const added = await ensureJobsScheduled(ctx)

    expect(added).toEqual([])
    expect(runJob).not.toHaveBeenCalled()
  })

  it('adds only the missing job on an existing install', async () => {
    const { ctx, runJob } = mockContext([{ name: 'monthly-post' }])

    const added = await ensureJobsScheduled(ctx)

    expect(added).toEqual(['rescan-monthly-post'])
    expect(runJob).toHaveBeenCalledOnce()
    expect(runJob).toHaveBeenCalledWith({ name: 'rescan-monthly-post', cron: '30 * * * *' })
  })
})
