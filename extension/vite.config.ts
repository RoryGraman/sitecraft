import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import { isHarnessBuild } from './buildFlags.ts';
import manifest from './manifest.config.ts';

// Vite loads this file in Node. The extension tsconfig has no Node types.
declare const process: { env: Record<string, string | undefined> };

export default defineConfig(({ mode }) => {
  // One switch for the harness build, shared with the manifest rule. The
  // background reads it to decide whether devReload is wired.
  const harness = isHarnessBuild(mode, process.env);
  return {
    plugins: [react(), crx({ manifest })],
    define: { __SITECRAFT_HARNESS__: JSON.stringify(harness) },
    server: { port: 5173, strictPort: true },
    build: {
      // Never empty dist. Chrome watches this folder for the unpacked
      // extension; if manifest.json vanishes mid-build, Chrome drops the
      // extension. Overwriting in place makes Chrome reload it instead.
      emptyOutDir: false,
      // The harness is a normal web page served from dist/ by scripts/serve.mjs
      // for browser-driven E2E tests. The manifest never names it, and only a
      // harness build ships it.
      rollupOptions: harness ? { input: { harness: 'harness/index.html' } } : {},
    },
  };
});
