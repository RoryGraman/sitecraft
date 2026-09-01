import { defineManifest } from '@crxjs/vite-plugin';
import { EXTENSION_PUBLIC_KEY, HARNESS_ORIGINS } from '../shared/src/extension.ts';

export default defineManifest({
  manifest_version: 3,
  name: 'Sitecraft',
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
      js: ['src/content/index.ts'],
      run_at: 'document_start',
      all_frames: false,
    },
  ],
  side_panel: { default_path: 'src/sidepanel/index.html' },
  action: { default_title: 'Open Sitecraft' },
  externally_connectable: { matches: HARNESS_ORIGINS },
  icons: { 16: 'icons/16.png', 48: 'icons/48.png', 128: 'icons/128.png' },
});
