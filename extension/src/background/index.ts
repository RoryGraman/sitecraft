/**
 * Background service worker entry. Wires the modules together; the logic lives
 * in state.ts, native.ts, userScripts.ts, runs.ts, router.ts, tabs.ts and
 * css.ts. Every chrome.* listener is registered synchronously at the top
 * level, as MV3 requires.
 */

import { SIDEBAR_PORT_NAME, type SidebarEvent } from '@sitecraft/shared';
import { installCssFallback } from './css';
import { createNativeClient } from './native';
import { createRouter, installScriptErrorHandler, isAllowedExternalOrigin, type RouterDeps } from './router';
import { createRunManager, reloadTab, syncUserScripts, takeSnapshotFromTab } from './runs';
import { createStateStore } from './state';
import { createTabWatcher } from './tabs';
import { isUserScriptsAvailable, registerAll } from './userScripts';

const store = createStateStore();
const native = createNativeClient();

// The run manager emits through the router, which is created after it.
let broadcast: (ev: SidebarEvent) => void = () => undefined;
const runs = createRunManager({
  store,
  native,
  takeSnapshot: takeSnapshotFromTab,
  reloadTab,
  registerAll,
  emit: (ev) => broadcast(ev),
});
const routerDeps: RouterDeps = { store, native, runs, registerAll, isUserScriptsAvailable };
// Only harness builds can reload the extension from the panel. The flag comes
// from vite.config.ts and follows the same rule as the manifest.
if (__SITECRAFT_HARNESS__) routerDeps.devReload = () => chrome.runtime.reload();
const router = createRouter(routerDeps);
broadcast = router.broadcast;

// The side panel follows the active tab of its window.
createTabWatcher(chrome.tabs, (change) => {
  router.broadcast({ type: 'activeTabChanged', ...change });
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== SIDEBAR_PORT_NAME) return;
  router.attachPort(port, 'internal');
});

chrome.runtime.onConnectExternal.addListener((port) => {
  if (port.name !== SIDEBAR_PORT_NAME || !isAllowedExternalOrigin(port.sender?.origin)) {
    port.disconnect();
    return;
  }
  router.attachPort(port, 'external');
});

function resync(reason: string): void {
  syncUserScripts(store, registerAll).catch((e: unknown) => {
    console.error(`Sitecraft: user script registration failed on ${reason}`, e);
  });
}

// Registered user scripts are cleared on extension update. Re-register.
chrome.runtime.onInstalled.addListener(() => resync('install'));
chrome.runtime.onStartup.addListener(() => resync('startup'));

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((e: unknown) => {
  console.error('Sitecraft: could not set the side panel behavior', e);
});

// Content script messages. takeSnapshot and inspect go the other way (tabs.sendMessage).
installCssFallback(store);
installScriptErrorHandler(store);
