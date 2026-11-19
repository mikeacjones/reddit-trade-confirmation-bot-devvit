import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Starts a Docker Redis for the race scenarios when CI is set and REDIS_URL is not.
    globalSetup: ['tests/harness/globalSetup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts'],
    },
  },
})
