import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Unit tests are included by default (fast, fully parallel, no DB)
    include: ['tests/**/*.test.ts'],
    // Integration tests share an in-memory PGlite instance per file; each file
    // takes a fresh module registry so they are isolated from each other, but
    // running many files concurrently on Windows exhausts the wasm heap.
    // --fileParallelism=false via CLI (or override below) serialises them.
    poolOptions: {
      forks: {
        // Serialise integration test files so each PGlite instance is fully
        // booted and torn down before the next one starts.
        singleFork: false,
      },
    },
    // Give integration hooks plenty of time to boot Fastify + migrate PGlite.
    hookTimeout: 120_000,
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
