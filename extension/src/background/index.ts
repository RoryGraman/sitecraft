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
import { createRunManager, reloadTab, syncUserScripts, syncUserScriptsIfEmpty, takeSnapshotFromTab } from './runs';
import { createStateStore } from './state';
import { createTabWatcher } from './tabs';
import { isUserScriptsAvailable, registerAll } from './userScripts';

const store = createStateStore();
// Each ping tells the companion which build is loaded and whether user
// scripts are allowed. The companion records it for the setup wizard.
const native = createNativeClient(undefined, undefined, () => ({
  version: chrome.runtime.getManifest().version,
  userScriptsEnabled: isUserScriptsAvailable(),
}));

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

/** Ping the companion so it records that this build is loaded. Failing is normal before setup. */
function announce(): void {
  void native.ping();
}

// Registered user scripts are cleared on extension update. Re-register, and
// announce this build to the companion.
chrome.runtime.onInstalled.addListener(() => {
  resync('install');
  announce();
});
chrome.runtime.onStartup.addListener(() => {
  resync('startup');
  announce();
});

// The worker also restarts when the user turns on "Allow User Scripts", which
// fires neither event above. Re-register then, if Chrome holds no scripts, so
// a suppressed script starts working without re-running setup. Announce too,
// so the setup wizard sees the switch is now on.
syncUserScriptsIfEmpty(store, registerAll)
  .then((res) => {
    if (res) announce();
  })
  .catch((e: unknown) => console.warn('Sitecraft: user script re-check on worker start failed', e));

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((e: unknown) => {
  console.error('Sitecraft: could not set the side panel behavior', e);
});

// Content script messages. takeSnapshot and inspect go the other way (tabs.sendMessage).
installCssFallback(store);
installScriptErrorHandler(store);
