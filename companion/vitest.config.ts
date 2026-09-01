import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'companion',
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
