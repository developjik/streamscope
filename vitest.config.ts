import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Bind to 127.0.0.1 explicitly: some sandboxes resolve `localhost` to IPv6
  // only and Vitest's dev server fails with ENOTFOUND at startup.
  server: { host: '127.0.0.1' },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
