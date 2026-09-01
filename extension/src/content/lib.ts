/**
 * Content script logic. Pure functions plus small installers, kept apart from
 * the entry (index.ts) so tests can import them without side effects.
 *
 * Responsibilities:
 *  - At document_start: read saved scripts, build the CSS bundle for this URL,
 *    insert it as <style id="sitecraft-css">, and report to the background
 *    when the page CSP blocked it (so the background can use insertCSS).
 *  - Keep the style text in sync with chrome.storage changes.
 *  - Relay MAIN-world script errors (window.postMessage) to the background.
 *  - Answer takeSnapshot and inspect requests from the background.
 */

import {
  buildCssBundle,
  matchesPattern,
  type ContentMessage,
  type ScriptErrorPost,
  type SiteScript,
} from '@sitecraft/shared';
import { elementOuterHtml, snapshotDom, type ElementOuterHtmlResult } from '../lib/domSnapshot';

export const STYLE_ELEMENT_ID = 'sitecraft-css';

/** Requests the background sends to this content script over chrome.tabs.sendMessage. */
export type ContentRequest =
  | { type: 'takeSnapshot'; maxChars?: number }
  | { type: 'inspect'; selector: string; maxChars?: number };

/** Reply for a takeSnapshot request. */
export type TakeSnapshotResponse = string;
/** Reply for an inspect request. */
export type InspectResponse = ElementOuterHtmlResult;

export type SendMessage = (message: ContentMessage) => void;

// Minimal structural views of the chrome APIs this script uses, so tests can
// pass small fakes and the real `chrome` object still fits.

export interface StorageChangeLike {
  newValue?: unknown;
  oldValue?: unknown;
}

export interface StorageLike {
  local: { get(keys: string[]): Promise<Record<string, unknown>> };
  onChanged: {
    addListener(cb: (changes: Record<string, StorageChangeLike>, areaName: string) => void): void;
  };
}

export type MessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response?: unknown) => void,
) => boolean | undefined | void;

export interface RuntimeLike {
  sendMessage(message: ContentMessage): Promise<unknown> | void;
  onMessage: { addListener(cb: MessageListener): void };
}

export interface ChromeLike {
  storage: StorageLike;
  runtime: RuntimeLike;
}

export interface ContentDeps {
  doc?: Document;
  win?: Window;
  chrome?: ChromeLike;
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

/**
 * CSS bundle for `url` from a raw `scripts` value read from storage.
 * Same rule as background/css.ts cssForUrl: enabled css scripts whose pattern
 * matches, ordered by priority (1 first). Re-implemented here to keep the
 * content bundle small. Malformed entries are skipped.
 */
export function computeCss(scripts: unknown, url: string): string {
  if (!Array.isArray(scripts)) return '';
  const matching = scripts.filter(
    (s): s is SiteScript => isSiteScriptLike(s) && s.enabled && s.kind === 'css' && matchesPattern(s.urlPattern, url),
  );
  return buildCssBundle(matching);
}

/**
 * Insert, update or remove the <style id="sitecraft-css"> element so that it
 * holds exactly `css`. Returns the element, or null when css is empty.
 * Uses head when present, else documentElement (head is missing at document_start).
 */
export function applyCss(doc: Document, css: string): HTMLStyleElement | null {
  const existing = doc.getElementById(STYLE_ELEMENT_ID);
  if (css === '') {
    existing?.remove();
    return null;
  }
  if (isStyleElement(existing)) {
    if (existing.textContent !== css) existing.textContent = css;
    return existing;
  }
  existing?.remove();
  const style = doc.createElement('style');
  style.id = STYLE_ELEMENT_ID;
  style.textContent = css;
  const parent = doc.head ?? doc.documentElement;
  if (!parent) return null;
  parent.appendChild(style);
  return style;
}

/**
 * True when the page CSP (or anything else) kept the inserted style from
 * producing a stylesheet: no sheet, or a sheet with zero rules while the css
 * text is non-empty. Comment-only css also reads as blocked; the background
 * fallback is harmless in that case.
 */
export function isCssBlocked(style: HTMLStyleElement, css: string): boolean {
  if (css.trim() === '') return false;
  try {
    const sheet = style.sheet;
    if (sheet == null) return true;
    return sheet.cssRules.length === 0;
  } catch {
    return true;
  }
}

/** Ids of the enabled JS scripts that run on `url`. Only these may report errors. */
export function computeJsIds(scripts: unknown, url: string): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(scripts)) return ids;
  for (const s of scripts) {
    if (isSiteScriptLike(s) && s.enabled && s.kind === 'js' && matchesPattern(s.urlPattern, url)) ids.add(s.id);
  }
  return ids;
}

export interface InstallCssOptions {
  /** Called with the current JS script ids for this URL, on load and on every change. */
  onJsIds?(ids: Set<string>): void;
}

/**
 * Read the saved scripts, apply the CSS for `url`, report CSP blocking, and
 * keep the style in sync with later storage changes. Never rejects.
 */
export async function installCss(
  doc: Document,
  url: string,
  storage: StorageLike,
  send: SendMessage,
  options: InstallCssOptions = {},
): Promise<void> {
  let sawChange = false;

  const update = (raw: unknown): void => {
    options.onJsIds?.(computeJsIds(raw, url));
    const css = computeCss(raw, url);
    const style = applyCss(doc, css);
    if (style && isCssBlocked(style, css)) send({ type: 'cssBlocked', url });
  };

  try {
    storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      if (!Object.prototype.hasOwnProperty.call(changes, 'scripts')) return;
      sawChange = true;
      try {
        update(changes['scripts']?.newValue);
      } catch (e) {
        console.warn('Sitecraft: could not update page styles.', e);
      }
    });
  } catch (e) {
    console.warn('Sitecraft: could not watch storage changes.', e);
  }

  let data: Record<string, unknown>;
  try {
    data = await storage.local.get(['scripts']);
  } catch (e) {
    console.warn('Sitecraft: could not read saved scripts.', e);
    return;
  }
  // A change that arrived while the read was in flight is newer. Keep it.
  if (sawChange) return;
  try {
    update(data['scripts']);
  } catch (e) {
    console.warn('Sitecraft: could not apply page styles.', e);
  }
}

// ---------------------------------------------------------------------------
// Error relay (MAIN world -> content script -> background)
// ---------------------------------------------------------------------------

/** Most error reports one page load may forward. Page scripts share this window. */
export const MAX_ERROR_REPORTS_PER_PAGE = 25;

/**
 * Forward script-error posts from the JS bundle running in the MAIN world.
 * The page's own scripts share that window and can post the same shape, so a
 * report is forwarded only when `isKnownScript` accepts its id (an enabled JS
 * script that runs on this URL) and the per-page cap is not reached.
 * Returns a function that removes the listener.
 */
export function installErrorRelay(win: Window, send: SendMessage, isKnownScript: (id: string) => boolean = () => true): () => void {
  let forwarded = 0;
  const onMessage = (event: MessageEvent): void => {
    if (event.source !== win) return;
    const data: unknown = event.data;
    if (!isScriptErrorPost(data)) return;
    if (!isKnownScript(data.scriptId)) return;
    if (forwarded >= MAX_ERROR_REPORTS_PER_PAGE) return;
    forwarded += 1;
    send({
      type: 'scriptError',
      scriptId: data.scriptId,
      message: typeof data.message === 'string' ? data.message : String(data.message),
      url: win.location.href,
    });
  };
  win.addEventListener('message', onMessage);
  return () => win.removeEventListener('message', onMessage);
}

// ---------------------------------------------------------------------------
// Requests from the background
// ---------------------------------------------------------------------------

/**
 * Compute the reply for a background request, or undefined when the message
 * is not one of ours (another listener may own it).
 */
export function handleContentRequest(doc: Document, message: unknown): TakeSnapshotResponse | InspectResponse | undefined {
  if (!isRecord(message)) return undefined;
  const maxChars = typeof message['maxChars'] === 'number' && message['maxChars'] > 0 ? message['maxChars'] : undefined;

  if (message['type'] === 'takeSnapshot') {
    return snapshotDom(doc, { maxChars });
  }
  if (message['type'] === 'inspect') {
    const selector = typeof message['selector'] === 'string' ? message['selector'] : '';
    try {
      return elementOuterHtml(doc, selector, maxChars);
    } catch (e) {
      return { ok: false, error: `Inspect failed: ${errorText(e)}` };
    }
  }
  return undefined;
}

/**
 * Answer takeSnapshot and inspect requests. Replies are synchronous, so the
 * listener never returns true.
 */
export function installMessageHandlers(doc: Document, onMessage: RuntimeLike['onMessage']): void {
  onMessage.addListener((message, _sender, sendResponse) => {
    let reply: TakeSnapshotResponse | InspectResponse | undefined;
    try {
      reply = handleContentRequest(doc, message);
    } catch (e) {
      // The sender sees the port close without a reply and falls back.
      console.warn('Sitecraft: request failed.', e);
      return false;
    }
    if (reply === undefined) return false;
    sendResponse(reply);
    return false;
  });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/**
 * A sender that never throws. The background may not be listening yet (or the
 * extension may have been reloaded); either way this page must keep working.
 */
export function createSender(runtime: Pick<RuntimeLike, 'sendMessage'>): SendMessage {
  return (message) => {
    try {
      const result = runtime.sendMessage(message);
      if (isPromiseLike(result)) result.then(undefined, () => undefined);
    } catch {
      // Extension context gone. Nothing to do from the page.
    }
  };
}

/** Entry used by index.ts. Installs everything; resolves once the CSS step is done. */
export async function start(deps: ContentDeps = {}): Promise<void> {
  const doc = deps.doc ?? document;
  const win = deps.win ?? window;
  const api = deps.chrome ?? globalChrome();
  if (!api) {
    console.warn('Sitecraft: chrome APIs are not available in this page.');
    return;
  }

  const send = createSender(api.runtime);
  // Filled by installCss from storage: the JS scripts that run on this page.
  let knownJsIds = new Set<string>();

  try {
    installErrorRelay(win, send, (id) => knownJsIds.has(id));
  } catch (e) {
    console.warn('Sitecraft: could not install the error relay.', e);
  }
  try {
    installMessageHandlers(doc, api.runtime.onMessage);
  } catch (e) {
    console.warn('Sitecraft: could not install message handlers.', e);
  }

  await installCss(doc, win.location.href, api.storage, send, {
    onJsIds: (ids) => {
      knownJsIds = ids;
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function globalChrome(): ChromeLike | undefined {
  const candidate = (globalThis as { chrome?: unknown }).chrome;
  if (!isRecord(candidate)) return undefined;
  if (!isRecord(candidate['storage']) || !isRecord(candidate['runtime'])) return undefined;
  return candidate as unknown as ChromeLike;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSiteScriptLike(value: unknown): value is SiteScript {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['name'] === 'string' &&
    typeof value['urlPattern'] === 'string' &&
    typeof value['code'] === 'string' &&
    typeof value['enabled'] === 'boolean' &&
    typeof value['priority'] === 'number' &&
    typeof value['createdAt'] === 'string'
  );
}

function isScriptErrorPost(value: unknown): value is ScriptErrorPost {
  return (
    isRecord(value) &&
    value['source'] === 'sitecraft' &&
    value['type'] === 'script-error' &&
    typeof value['scriptId'] === 'string'
  );
}

function isStyleElement(el: Element | null): el is HTMLStyleElement {
  return el !== null && el.tagName === 'STYLE';
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return isRecord(value) && typeof (value as { then?: unknown }).then === 'function';
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
