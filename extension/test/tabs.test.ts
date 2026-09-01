import { describe, expect, it, vi } from 'vitest';
import { createTabWatcher, toActiveTab, type ActiveTabChange, type TabWatchApi } from '../src/background/tabs';
import { FakeArgsEvent, FakeEvent, mkTab, tick } from './router.fakes';

type UpdatedArgs = [number, chrome.tabs.OnUpdatedInfo, chrome.tabs.Tab];

/** A watcher over fake tab events. `known` is what tabs.get can return. */
function setup(known: chrome.tabs.Tab[] = []) {
  const onActivated = new FakeEvent<chrome.tabs.OnActivatedInfo>();
  const onUpdated = new FakeArgsEvent<UpdatedArgs>();
  const get = vi.fn(async (tabId: number): Promise<chrome.tabs.Tab> => {
    const found = known.find((t) => t.id === tabId);
    if (!found) throw new Error(`No tab with id: ${tabId}.`);
    return found;
  });
  const api: TabWatchApi = { onActivated, onUpdated, get };
  const changes: ActiveTabChange[] = [];
  const watcher = createTabWatcher(api, (change) => {
    changes.push(change);
  });
  return { onActivated, onUpdated, get, changes, watcher };
}

describe('toActiveTab', () => {
  it('maps a web tab to TabInfo', () => {
    const tab = mkTab({ id: 4, windowId: 2, url: 'https://a.com/x', title: 'A', active: true });
    expect(toActiveTab(tab)).toEqual({ tabId: 4, windowId: 2, url: 'https://a.com/x', title: 'A', active: true });
  });

  it('accepts http and file URLs', () => {
    expect(toActiveTab(mkTab({ url: 'http://localhost:4173/' }))?.url).toBe('http://localhost:4173/');
    expect(toActiveTab(mkTab({ url: 'file:///tmp/x.html' }))?.url).toBe('file:///tmp/x.html');
  });

  it('returns null for tabs that are not web pages', () => {
    expect(toActiveTab(mkTab({ url: 'chrome://extensions/' }))).toBeNull();
    expect(toActiveTab(mkTab({ url: 'about:blank' }))).toBeNull();
    expect(toActiveTab(mkTab({ url: 'chrome-extension://abc/panel.html' }))).toBeNull();
    expect(toActiveTab(mkTab({ url: undefined }))).toBeNull();
    expect(toActiveTab(mkTab({ url: 'not a url' }))).toBeNull();
  });

  it('returns null for a tab without an id', () => {
    expect(toActiveTab(mkTab({ id: undefined, url: 'https://a.com/' }))).toBeNull();
  });

  it('falls back to pendingUrl while the first page loads', () => {
    expect(toActiveTab(mkTab({ url: '', pendingUrl: 'https://b.com/' }))?.url).toBe('https://b.com/');
    expect(toActiveTab(mkTab({ url: undefined, pendingUrl: 'https://b.com/' }))?.url).toBe('https://b.com/');
    expect(toActiveTab(mkTab({ url: undefined, pendingUrl: 'chrome://newtab/' }))).toBeNull();
  });

  it('prefers url over pendingUrl', () => {
    expect(toActiveTab(mkTab({ url: 'https://a.com/', pendingUrl: 'https://b.com/' }))?.url).toBe('https://a.com/');
  });

  it('uses an empty title when the tab has none', () => {
    expect(toActiveTab(mkTab({ title: undefined }))?.title).toBe('');
  });
});

describe('createTabWatcher: onActivated', () => {
  it('reads the tab and emits it for the window', async () => {
    const tab = mkTab({ id: 7, windowId: 3, url: 'https://a.com/', title: 'A', active: true });
    const { onActivated, get, changes } = setup([tab]);
    onActivated.emit({ tabId: 7, windowId: 3 });
    await tick();
    expect(get).toHaveBeenCalledWith(7);
    expect(changes).toEqual([
      { windowId: 3, tab: { tabId: 7, windowId: 3, url: 'https://a.com/', title: 'A', active: true }, reason: 'activated' },
    ]);
  });

  it('emits null for a chrome:// tab', async () => {
    const { onActivated, changes } = setup([mkTab({ id: 1, windowId: 1, url: 'chrome://extensions/', active: true })]);
    onActivated.emit({ tabId: 1, windowId: 1 });
    await tick();
    expect(changes).toEqual([{ windowId: 1, tab: null, reason: 'activated' }]);
  });

  it('emits null when the tab closed before it could be read', async () => {
    const { onActivated, get, changes } = setup([]);
    onActivated.emit({ tabId: 42, windowId: 5 });
    await tick();
    expect(get).toHaveBeenCalledWith(42);
    expect(changes).toEqual([{ windowId: 5, tab: null, reason: 'activated' }]);
  });

  it('uses pendingUrl when the tab has no url yet', async () => {
    const loading = mkTab({ id: 2, windowId: 1, url: '', pendingUrl: 'https://b.com/', active: true });
    const { onActivated, changes } = setup([loading]);
    onActivated.emit({ tabId: 2, windowId: 1 });
    await tick();
    expect(changes).toHaveLength(1);
    expect(changes[0]?.tab?.url).toBe('https://b.com/');
  });

  it('emits one change per activation, in order', async () => {
    const a = mkTab({ id: 1, windowId: 1, url: 'https://a.com/', active: true });
    const b = mkTab({ id: 2, windowId: 1, url: 'https://b.com/', active: true });
    const { onActivated, changes } = setup([a, b]);
    onActivated.emit({ tabId: 1, windowId: 1 });
    onActivated.emit({ tabId: 2, windowId: 1 });
    await tick();
    expect(changes.map((c) => c.tab?.tabId)).toEqual([1, 2]);
  });
});

describe('createTabWatcher: onUpdated', () => {
  const active = mkTab({ id: 1, windowId: 2, url: 'https://a.com/page', title: 'Page', active: true });
  const expected = { tabId: 1, windowId: 2, url: 'https://a.com/page', title: 'Page', active: true };

  it('ignores updates on inactive tabs', () => {
    const { onUpdated, changes } = setup();
    onUpdated.emit(1, { url: 'https://a.com/page' }, mkTab({ ...active, active: false }));
    onUpdated.emit(1, { status: 'complete' }, mkTab({ ...active, active: false }));
    expect(changes).toEqual([]);
  });

  it('ignores the loading status', () => {
    const { onUpdated, changes } = setup();
    onUpdated.emit(1, { status: 'loading' }, active);
    expect(changes).toEqual([]);
  });

  it('ignores updates with no url, title, or finished load', () => {
    const { onUpdated, changes } = setup();
    onUpdated.emit(1, { favIconUrl: 'https://a.com/favicon.ico' }, active);
    onUpdated.emit(1, { audible: true }, active);
    onUpdated.emit(1, {}, active);
    expect(changes).toEqual([]);
  });

  it('emits when the url of the active tab changes', () => {
    const { onUpdated, changes } = setup();
    onUpdated.emit(1, { url: 'https://a.com/page' }, active);
    expect(changes).toEqual([{ windowId: 2, tab: expected, reason: 'updated' }]);
  });

  it('emits when the title changes', () => {
    const { onUpdated, changes } = setup();
    onUpdated.emit(1, { title: 'Page' }, active);
    expect(changes).toEqual([{ windowId: 2, tab: expected, reason: 'updated' }]);
  });

  it('emits when the load completes', () => {
    const { onUpdated, changes } = setup();
    onUpdated.emit(1, { status: 'complete' }, active);
    expect(changes).toEqual([{ windowId: 2, tab: expected, reason: 'updated' }]);
  });

  it('emits null when the active tab navigates away from the web', () => {
    const { onUpdated, changes } = setup();
    onUpdated.emit(1, { url: 'chrome://newtab/' }, mkTab({ ...active, url: 'chrome://newtab/' }));
    expect(changes).toEqual([{ windowId: 2, tab: null, reason: 'updated' }]);
  });

  it('does not read the tab again', () => {
    const { onUpdated, get } = setup();
    onUpdated.emit(1, { status: 'complete' }, active);
    expect(get).not.toHaveBeenCalled();
  });
});

describe('createTabWatcher: dispose', () => {
  it('registers both listeners and removes them on dispose', async () => {
    const tab = mkTab({ id: 1, windowId: 1, url: 'https://a.com/', active: true });
    const { onActivated, onUpdated, watcher, changes } = setup([tab]);
    expect(onActivated.listeners.size).toBe(1);
    expect(onUpdated.listeners.size).toBe(1);
    watcher.dispose();
    expect(onActivated.listeners.size).toBe(0);
    expect(onUpdated.listeners.size).toBe(0);
    onActivated.emit({ tabId: 1, windowId: 1 });
    onUpdated.emit(1, { status: 'complete' }, tab);
    await tick();
    expect(changes).toEqual([]);
  });

  it('dispose can be called twice', () => {
    const { watcher, onActivated } = setup();
    watcher.dispose();
    watcher.dispose();
    expect(onActivated.listeners.size).toBe(0);
  });
});
