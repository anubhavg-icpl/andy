// Vitest config for the andy TypeScript migration target.
// tests/ is shared with the legacy Python test suite, so the include
// pattern matches only TypeScript test files (*.test.ts).
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
