import { describe, expect, it } from 'vitest'

describe('app entrypoint', () => {
  it('loads without throwing during Devvit registration', async () => {
    await expect(import('../src/main')).resolves.toBeDefined()
  })
})
