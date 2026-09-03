/**
 * Active tab tracking.
 *
 * Watches chrome.tabs and reports the active web tab of a window whenever it
 * changes: a tab switch, a navigation, a title change, or a finished load.
 * The service worker broadcasts each report as an activeTabChanged event.
 * The web-tab rule lives here; the router shares it.
 */

import type { ActiveTabReason, TabInfo } from '@sitecraft/shared';

type ActivatedListener = (info: chrome.tabs.OnActivatedInfo) => void;
type UpdatedListener = (tabId: number, change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => void;

/** The slice of chrome.tabs the watcher uses. Injected so tests need no global chrome. */
export interface TabWatchApi {
  onActivated: { addListener(l: ActivatedListener): void; removeListener(l: ActivatedListener): void };
  onUpdated: { addListener(l: UpdatedListener): void; removeListener(l: UpdatedListener): void };
  get(tabId: number): Promise<chrome.tabs.Tab>;
}

export interface ActiveTabChange {
  windowId: number;
  /** Null when the active tab is not a web page. */
  tab: TabInfo | null;
  /** 'activated' for a tab switch, 'updated' for a change on the active tab. */
  reason: Extract<ActiveTabReason, 'activated' | 'updated'>;
}

export interface TabWatcher {
  /** Removes both chrome.tabs listeners. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// web tabs
// ---------------------------------------------------------------------------

/** A tab with an id and a URL string. */
export type WebTab = chrome.tabs.Tab & { id: number; url: string };

export function protocolOf(url: string | undefined): string | null {
  if (typeof url !== 'string' || url === '') return null;
  try {
    return new URL(url).protocol;
  } catch {
    return null;
  }
}

/** Sitecraft can only read and customize http, https and file pages. */
export function isWebUrl(url: string | undefined): boolean {
  const protocol = protocolOf(url);
  return protocol === 'http:' || protocol === 'https:' || protocol === 'file:';
}

/** A tab Sitecraft can work on: has an id and a web URL. */
export function isWebTab(tab: chrome.tabs.Tab): tab is WebTab {
  return typeof tab.id === 'number' && isWebUrl(tab.url);
}

export function toTabInfo(tab: WebTab): TabInfo {
  return { tabId: tab.id, windowId: tab.windowId, url: tab.url, title: tab.title ?? '', active: tab.active };
}

/**
 * The TabInfo for a tab the panel can target, or null when the tab is not a
 * web page. A tab still loading its first page has no url yet, only
 * pendingUrl. That URL is used in its place.
 */
export function toActiveTab(tab: chrome.tabs.Tab): TabInfo | null {
  const resolved: chrome.tabs.Tab = tab.url ? tab : { ...tab, url: tab.pendingUrl };
  return isWebTab(resolved) ? toTabInfo(resolved) : null;
}

// ---------------------------------------------------------------------------
// watcher
// ---------------------------------------------------------------------------

/**
 * Reports the active tab of a window when it changes. Two sources: onActivated
 * (a tab switch) and onUpdated on the active tab (a navigation, a title change,
 * or a finished load). Other updates, such as a favicon or mute change, are
 * ignored.
 */
export function createTabWatcher(api: TabWatchApi, emit: (change: ActiveTabChange) => void): TabWatcher {
  async function reportActivated(tabId: number, windowId: number): Promise<void> {
    let tab: TabInfo | null = null;
    try {
      tab = toActiveTab(await api.get(tabId));
    } catch {
      // The tab closed before it could be read. Report no page for now.
      // Chrome fires onActivated again for the tab that takes its place.
    }
    emit({ windowId, tab, reason: 'activated' });
  }

  const onActivated: ActivatedListener = (info) => {
    reportActivated(info.tabId, info.windowId).catch((e: unknown) => {
      console.error('Sitecraft: could not report the active tab', e);
    });
  };

  const onUpdated: UpdatedListener = (_tabId, change, tab) => {
    if (!tab.active) return;
    const relevant = change.url !== undefined || change.title !== undefined || change.status === 'complete';
    if (!relevant) return;
    emit({ windowId: tab.windowId, tab: toActiveTab(tab), reason: 'updated' });
  };

  api.onActivated.addListener(onActivated);
  api.onUpdated.addListener(onUpdated);

  return {
    dispose() {
      api.onActivated.removeListener(onActivated);
      api.onUpdated.removeListener(onUpdated);
    },
  };
}
