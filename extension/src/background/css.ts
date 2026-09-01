/**
 * CSS for a URL, plus the insertCSS fallback.
 *
 * The content script injects CSS through a <style> element at document_start.
 * Pages with a strict style-src CSP block that element. The content script then
 * sends { type: 'cssBlocked' } and the background inserts the same CSS with
 * chrome.scripting.insertCSS, which is not subject to the page CSP.
 */

import { buildCssBundle, matchesPattern, type ContentMessage, type SiteScript } from '@sitecraft/shared';
import type { StateStore } from './state';

/** Concatenated CSS of every enabled css script whose pattern matches `url`. Empty when none. */
export function cssForUrl(scripts: SiteScript[], url: string): string {
  const matching = scripts.filter((s) => s.kind === 'css' && s.enabled && matchesPattern(s.urlPattern, url));
  return buildCssBundle(matching);
}

export type InsertCss = (tabId: number, css: string) => Promise<void>;

export interface CssFallbackOptions {
  /** Defaults to chrome.scripting.insertCSS on the tab's top frame. */
  insertCSS?: InsertCss;
  /** Defaults to chrome.runtime.onMessage. */
  onMessage?: typeof chrome.runtime.onMessage;
}

function defaultInsertCss(tabId: number, css: string): Promise<void> {
  return chrome.scripting.insertCSS({ target: { tabId }, css });
}

function isCssBlocked(msg: unknown): msg is Extract<ContentMessage, { type: 'cssBlocked' }> {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'cssBlocked' &&
    typeof (msg as { url?: unknown }).url === 'string'
  );
}

/**
 * Inserts the CSS for `url` into `tabId`. Returns true when something was inserted.
 * Rejects when insertCSS fails.
 */
export async function handleCssBlocked(
  tabId: number,
  url: string,
  store: Pick<StateStore, 'getScripts'>,
  insertCSS: InsertCss = defaultInsertCss,
): Promise<boolean> {
  const css = cssForUrl(await store.getScripts(), url);
  if (css === '') return false;
  await insertCSS(tabId, css);
  return true;
}

/**
 * Listens for cssBlocked messages from the content script and inserts the CSS
 * through the scripting API. Returns a function that removes the listener.
 */
export function installCssFallback(store: Pick<StateStore, 'getScripts'>, opts: CssFallbackOptions = {}): () => void {
  const insertCSS = opts.insertCSS ?? defaultInsertCss;
  const event = opts.onMessage ?? chrome.runtime.onMessage;

  const listener = (msg: unknown, sender: chrome.runtime.MessageSender): undefined => {
    if (!isCssBlocked(msg)) return undefined;
    const tabId = sender.tab?.id;
    if (typeof tabId !== 'number') return undefined;
    // The tab URL reported by Chrome is trusted; the message URL is not.
    const url = sender.tab?.url ?? msg.url;
    handleCssBlocked(tabId, url, store, insertCSS).catch((err: unknown) => {
      console.warn('Sitecraft: insertCSS fallback failed', err);
    });
    return undefined;
  };

  event.addListener(listener);
  return () => {
    event.removeListener(listener);
  };
}
