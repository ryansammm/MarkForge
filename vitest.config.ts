import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Default test config.
//
// R2 credentials are nullified here (empty string below is falsy, which makes
// r2ConfigFromEnv()/createBucket() pick the filesystem/memory backends). The
// default `npm test` / `pnpm verify` must NEVER open a live R2 connection:
// it can hang (the S3 SDK has no timeout in this codebase) and it would write
// to a production bucket. Live-R2 testing is opt-in via vitest.r2.config.ts.
//
// testTimeout guards every suite so a stuck test fails instead of hanging the
// whole `verify` pipeline indefinitely.
export default defineConfig({
  resolve: {
    // Mirror tsconfig.json "paths": { "@/*": ["./*"] } — suites import Next
    // route/middleware modules that use the alias.
    alias: [{ find: '@', replacement: fileURLToPath(new URL('.', import.meta.url)) }],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/r2-write.test.ts'],
    testTimeout: 60000,
    hookTimeout: 30000,
    env: {
      R2_ACCOUNT_ID: '',
      R2_ACCESS_KEY_ID: '',
      R2_SECRET_ACCESS_KEY: '',
      R2_BUCKET: '',
      R2_TEST_BUCKET: '',
    },
  },
})
