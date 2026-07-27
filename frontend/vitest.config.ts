import { defineConfig } from 'vitest/config'
import path from 'path'

// Vitest config for the frontend's pure-logic unit tests (currently the shared
// JSON path grammar in src/lib). No DOM environment is needed — these tests do
// not render React components — so the default node environment is used. The
// '@/' alias mirrors vite.config.ts / tsconfig.json so test files can import
// modules the same way the app does.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
})
