import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:workers': fileURLToPath(
        new URL('./test/shims/cloudflare-workers.ts', import.meta.url),
      ),
    },
  },
  test: {
    testTimeout: 10_000,
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'lcov'],
      // Gated where a bug would be a wrong decision — the merge gate, the
      // config layering, the rules. The adapter layer around Octokit and the
      // runtime entry points are deliberately not gated: covering them means
      // asserting that mocks were called, which passes without proving
      // anything. They are exercised through test/routing.test.ts instead.
      thresholds: {
        'src/core/config/**': { lines: 90, functions: 95, branches: 80 },
        'src/core/lib/**': { lines: 85, functions: 90, branches: 74 },
      },
    },
  },
})
