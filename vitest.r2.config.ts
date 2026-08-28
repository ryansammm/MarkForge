import { defineConfig } from 'vitest/config'

// Opt-in config for the real-R2 write test. Only run this when you explicitly
// want to exercise R2 against a scratch bucket (R2_TEST_BUCKET), e.g. locally
// or via the scheduled CI job. Do NOT use for the default verify pipeline.
export default defineConfig({
  test: {
    include: ['tests/r2-write.test.ts'],
    testTimeout: 120000,
    hookTimeout: 60000,
  },
})
