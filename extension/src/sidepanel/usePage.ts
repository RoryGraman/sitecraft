import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TabInfo } from '@sitecraft/shared';
import type { Bridge } from '../lib/bridge';

/**
 * The page the panel targets.
 *
 * Extension mode: the active tab of the panel's own window. The background
 * sends activeTabChanged events and the hook keeps the ones for this window.
 *
 * External mode (the dev harness page): a tab picked from the tab list. While
 * follow is on, activeTabChanged events move the target. The harness page
 * itself is never the target.
 */
export interface PageState {
  /** The target page. Null when the active tab is not a web page. */
  tab: TabInfo | null;
  /** False until the first answer arrives. */
  ready: boolean;
  /** External mode only. The list behind the picker. */
  tabs: TabInfo[];
  /** External mode only. True while events move the target. */
  follow: boolean;
  /** External mode only. True while the tab list reloads. */
  loading: boolean;
  /** External mode only. Picks a tab and turns follow off. */
  select(tabId: number): void;
  /** External mode only. */
  setFollow(on: boolean): void;
  /**
   * Asks for the page again. Extension mode: the active tab of this window.
   * External mode: the tab list. The app calls it from Retry.
   */
  refresh(): void;
}

interface Inner {
  tab: TabInfo | null;
  ready: boolean;
  tabs: TabInfo[];
  follow: boolean;
  loading: boolean;
}

const INITIAL: Inner = { tab: null, ready: false, tabs: [], follow: true, loading: false };

interface WindowsApi {
  getCurrent?: () => Promise<{ id?: number } | undefined>;
}

/** The id of the window this panel belongs to. Undefined when unknown. */
async function currentWindowId(): Promise<number | undefined> {
  const windows = (globalThis as { chrome?: { windows?: WindowsApi } }).chrome?.windows;
  if (!windows || typeof windows.getCurrent !== 'function') return undefined;
  try {
    const win = await windows.getCurrent();
    return typeof win?.id === 'number' ? win.id : undefined;
  } catch {
    return undefined;
  }
}

/** True when the URL is on this page's own origin (the harness itself). */
function isOwnOrigin(url: string): boolean {
  try {
    return new URL(url).origin === location.origin;
  } catch {
    return false;
  }
}

/** Replace the entry with the same tab id, or append. */
function upsert(tabs: TabInfo[], tab: TabInfo): TabInfo[] {
  if (tabs.some((t) => t.tabId === tab.tabId)) return tabs.map((t) => (t.tabId === tab.tabId ? tab : t));
  return [...tabs, tab];
}

/** Pick the target after a list load: keep the current tab, else the default, else the first. */
function pickTarget(list: TabInfo[], current: TabInfo | null, def: TabInfo | null): TabInfo | null {
  const kept = current ? list.find((t) => t.tabId === current.tabId) : undefined;
  if (kept) return kept;
  const preferred = def ? list.find((t) => t.tabId === def.tabId) : undefined;
  return preferred ?? list[0] ?? null;
}

export function usePage(bridge: Bridge): PageState {
  const [inner, setInner] = useState<Inner>(INITIAL);
  const mounted = useRef(false);
  /** Extension mode: asks getActiveTab again. Set once the window id is known. */
  const askAgain = useRef<(() => void) | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Extension mode: the active tab of this window.
  useEffect(() => {
    if (bridge.mode !== 'extension') return;
    let alive = true;
    let off: (() => void) | null = null;
    void (async () => {
      const windowId = await currentWindowId();
      if (!alive) return;
      // Subscribe before asking, so no change slips through the gap. The
      // background answers getActiveTab after a tabs.query, so an event can
      // land first. An event is always fresher than the answer: when one
      // arrives while a request is in flight, that answer is dropped.
      let events = 0;
      off = bridge.onEvent((ev) => {
        if (ev.type !== 'activeTabChanged') return;
        if (windowId !== undefined && ev.windowId !== windowId) return;
        events += 1;
        setInner((s) => ({ ...s, tab: ev.tab, ready: true }));
      });
      const ask = async (): Promise<void> => {
        const seen = events;
        try {
          const tab = await bridge.request(windowId === undefined ? { type: 'getActiveTab' } : { type: 'getActiveTab', windowId });
          if (!alive || events !== seen) return;
          setInner((s) => ({ ...s, tab, ready: true }));
        } catch (e) {
          if (!alive) return;
          console.warn('Sitecraft: could not read the active tab', e);
          setInner((s) => ({ ...s, ready: true }));
        }
      };
      askAgain.current = () => void ask();
      await ask();
    })();
    return () => {
      alive = false;
      askAgain.current = null;
      off?.();
    };
  }, [bridge]);

  // External mode: the tab list and the default tab.
  const loadTabs = useCallback(
    async (alive: () => boolean) => {
      setInner((s) => ({ ...s, loading: true }));
      try {
        const [list, def] = await Promise.all([bridge.request({ type: 'listTabs' }), bridge.request({ type: 'getDefaultTab' })]);
        if (!alive()) return;
        setInner((s) => ({ ...s, tabs: list, tab: pickTarget(list, s.tab, def), ready: true, loading: false }));
      } catch (e) {
        if (!alive()) return;
        console.warn('Sitecraft: could not list tabs', e);
        setInner((s) => ({ ...s, ready: true, loading: false }));
      }
    },
    [bridge],
  );

  useEffect(() => {
    if (bridge.mode !== 'external') return;
    let alive = true;
    const off = bridge.onEvent((ev) => {
      if (ev.type !== 'activeTabChanged' || ev.tab === null) return;
      const tab = ev.tab;
      if (isOwnOrigin(tab.url)) return;
      setInner((s) => {
        const tabs = upsert(s.tabs, tab);
        // Only a tab switch moves the target. A URL or title change on the
        // active tab of some other window must not steal it. A change on the
        // target itself refreshes the strip.
        const moves = s.follow && ev.reason === 'activated';
        const same = s.tab !== null && s.tab.tabId === tab.tabId;
        return moves || same ? { ...s, tab, tabs, ready: true } : { ...s, tabs };
      });
    });
    void loadTabs(() => alive);
    return () => {
      alive = false;
      off();
    };
  }, [bridge, loadTabs]);

  const select = useCallback(
    (tabId: number) => {
      if (bridge.mode !== 'external') return;
      setInner((s) => {
        const found = s.tabs.find((t) => t.tabId === tabId);
        return { ...s, follow: false, tab: found ?? s.tab };
      });
    },
    [bridge],
  );

  const setFollow = useCallback(
    (on: boolean) => {
      if (bridge.mode !== 'external') return;
      setInner((s) => (s.follow === on ? s : { ...s, follow: on }));
    },
    [bridge],
  );

  const refresh = useCallback(() => {
    if (bridge.mode === 'extension') {
      askAgain.current?.();
      return;
    }
    void loadTabs(() => mounted.current);
  }, [bridge, loadTabs]);

  return useMemo(() => ({ ...inner, select, setFollow, refresh }), [inner, select, setFollow, refresh]);
}
