import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import { isHarnessBuild } from './buildFlags.ts';
import manifest from './manifest.config.ts';

// Vite loads this file in Node. The extension tsconfig has no Node types.
declare const process: { env: Record<string, string | undefined> };

export default defineConfig(({ mode }) => ({
  plugins: [react(), crx({ manifest })],
  // One switch for the harness build, shared with the manifest rule. The
  // background reads it to decide whether devReload is wired.
  define: { __SITECRAFT_HARNESS__: JSON.stringify(isHarnessBuild(mode, process.env)) },
  server: { port: 5173, strictPort: true },
  build: {
    rollupOptions: {
      // Pages the manifest does not name. The harness is a normal web page
      // served from dist/ by scripts/serve.mjs for browser-driven E2E tests.
      input: { harness: 'harness/index.html' },
    },
  },
}));
