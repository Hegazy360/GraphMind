import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Each suite boots a real GraphMind server, a mock provider, a viewer
    // socket and (twice) the real `graphmind record` CLI in a child process.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Servers bind real ports and the CLI opens the same SQLite file: run the
    // files one at a time so ports and databases never collide.
    fileParallelism: false,
    retry: 0,
  },
});
