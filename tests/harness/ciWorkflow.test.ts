/**
 * The race scenarios (tests/scenarios/confirmationRaces.test.ts) skip themselves unless REDIS_URL is
 * set, so the CI job that runs `npm test` must provide a real Redis, or they never run in CI.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(new URL('../../.github/workflows/devvit-test.yml', import.meta.url), 'utf8')

describe('devvit-test workflow', () => {
  // GAP: devvit-test.yml has no redis service or REDIS_URL, so the race scenarios skip in CI; tracked by swap-bot-05u (pipelines may not edit .github/**)
  it.fails('starts a redis service container for the race scenarios', () => {
    expect(workflow).toMatch(/^\s+services:\s*$/m)
    expect(workflow).toMatch(/^\s+redis:\s*$/m)
    expect(workflow).toMatch(/image:\s*redis/)
  })

  it.fails('sets REDIS_URL so the race scenarios run against it', () => {
    expect(workflow).toMatch(/REDIS_URL:\s*redis:\/\/(localhost|127\.0\.0\.1):6379/)
  })
})
