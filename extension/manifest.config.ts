import { defineManifest } from '@crxjs/vite-plugin';
import { EXTENSION_PUBLIC_KEY, HARNESS_ORIGINS } from '../shared/src/extension.ts';

// Vite loads this file in Node. The extension tsconfig has no Node types.
declare const process: { env: Record<string, string | undefined> };

// Rendered from extension/icons-src by scripts/gen-icons.mjs.
const ICONS = { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' };

/**
 * The dev harness (a web page on localhost) may drive the extension only when
 * the build opts in: `vite build --mode harness` or SITECRAFT_HARNESS=1.
 * A production build has no externally_connectable key, so no web page can
 * connect to the extension at all.
 */
export default defineManifest((env) => {
  const harness = env.mode === 'harness' || process.env.SITECRAFT_HARNESS === '1';
  return {
    manifest_version: 3,
    name: harness ? 'Sitecraft (harness build)' : 'Sitecraft',
    version: '0.1.0',
    description: 'Customize any website with plain language.',
    key: EXTENSION_PUBLIC_KEY,
    minimum_chrome_version: '120',
    permissions: ['storage', 'sidePanel', 'userScripts', 'nativeMessaging', 'scripting', 'tabs', 'activeTab'],
    host_permissions: ['<all_urls>'],
    background: { service_worker: 'src/background/index.ts', type: 'module' },
    content_scripts: [
      {
        matches: ['<all_urls>'],
        js: ['src/content/main.ts'],
        run_at: 'document_start',
        all_frames: false,
      },
    ],
    side_panel: { default_path: 'src/sidepanel/index.html' },
    action: { default_title: 'Open Sitecraft', default_icon: ICONS },
    ...(harness ? { externally_connectable: { matches: HARNESS_ORIGINS } } : {}),
    icons: ICONS,
  };
});
