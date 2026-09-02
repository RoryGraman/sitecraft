import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['shared', 'extension', 'companion', 'scripts'],
  },
});
