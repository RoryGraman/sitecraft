import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config.ts';

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  server: { port: 5173, strictPort: true },
  build: {
    rollupOptions: {
      // Pages the manifest does not name. The harness is a normal web page
      // served from dist/ by scripts/serve.mjs for browser-driven E2E tests.
      input: { harness: 'harness/index.html' },
    },
  },
});
