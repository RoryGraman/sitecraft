import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_VERSION, SIDEBAR_PORT_NAME } from '@sitecraft/shared';
import type {
  ExportFile,
  ImportResult,
  OnboardingStatus,
  SidebarEnvelope,
  SidebarEvent,
  SidebarReplyEnvelope,
  SidebarRequest,
  SidebarState,
  SiteScript,
  TabInfo,
} from '@sitecraft/shared';
import { createStateStore } from '../src/background/state';
import type { StateStore } from '../src/background/state';
import type { RegisterAllResult } from '../src/background/userScripts';
import type { RunManager } from '../src/background/runs';
import {
  createRouter,
  handleScriptError,
  installScriptErrorHandler,
  isAllowedExternalOrigin,
  type Router,
  type RouterDeps,
  type TabsApi,
} from '../src/background/router';
import { FakePort, FakeStorageArea, fakeNative, mkScript, mkTab, resetIds, tick } from './router.fakes';

const g = globalThis as unknown as { chrome?: unknown };

interface Harness {
  area: FakeStorageArea;
  store: StateStore;
  native: ReturnType<typeof fakeNative>;
  runs: { start: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn>; isActive: ReturnType<typeof vi.fn> };
  tabs: { query: ReturnType<typeof vi.fn>; reload: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  registerAll: ReturnType<typeof vi.fn<(scripts: SiteScript[]) => Promise<RegisterAllResult>>>;
  userScripts: { available: boolean };
  router: Router;
  connect(kind?: 'internal' | 'external', origin?: string): FakePort;
  send<R extends SidebarRequest>(port: FakePort, req: R): Promise<unknown>;
  sendState(port: FakePort, req: SidebarRequest): Promise<SidebarState>;
  events(port: FakePort): SidebarEvent[];
}

function harness(scripts: SiteScript[] = [], tabList: chrome.tabs.Tab[] = [], opts: Pick<RouterDeps, 'devReload'> = {}): Harness {
  const area = new FakeStorageArea();
  area.data.scripts = scripts;
  const store = createStateStore(area.asArea());
  const native = fakeNative({ state: 'unknown' });
  const runs = {
    start: vi.fn(async () => ({ runId: 'run-1' })),
    cancel: vi.fn(),
    isActive: vi.fn(() => false),
  };
  const tabs = {
    query: vi.fn(async (info: chrome.tabs.QueryInfo) => {
      let list = tabList;
      if (info.active !== undefined) list = list.filter((t) => t.active === info.active);
      if (info.lastFocusedWindow) list = list.filter((t) => t.windowId === 1);
      if (info.windowId !== undefined) list = list.filter((t) => t.windowId === info.windowId);
      return list;
    }),
    reload: vi.fn(async () => undefined),
    create: vi.fn(async (props: chrome.tabs.CreateProperties) => mkTab({ id: 99, url: props.url ?? '' })),
  };
  const registerAll = vi.fn<(scripts: SiteScript[]) => Promise<RegisterAllResult>>(async () => ({
    registered: 1,
    skipped: false,
  }));
  const userScripts = { available: true };
  const router = createRouter({
    store,
    native,
    runs: runs as unknown as RunManager,
    registerAll,
    isUserScriptsAvailable: () => userScripts.available,
    tabs: tabs as unknown as TabsApi,
    ...opts,
  });
  let seq = 0;
  const connect = (kind: 'internal' | 'external' = 'internal', origin?: string): FakePort => {
    const sender: chrome.runtime.MessageSender =
      kind === 'external' ? { origin: origin ?? 'http://localhost:4173' } : { origin: 'chrome-extension://abc' };
    const port = new FakePort(SIDEBAR_PORT_NAME, sender);
    router.attachPort(port.asPort(), kind);
    return port;
  };
  const send = async (port: FakePort, req: SidebarRequest): Promise<unknown> => {
    seq += 1;
    const requestId = `req-${seq}`;
    const replyPromise = new Promise<SidebarReplyEnvelope>((resolve, reject) => {
      const check = (): void => {
        const reply = port.posted.find(
          (m): m is SidebarReplyEnvelope =>
            typeof m === 'object' && m !== null && 'requestId' in m && (m as SidebarReplyEnvelope).requestId === requestId,
        );
        if (reply) {
          resolve(reply);
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error(`no reply to ${req.type}`));
          return;
        }
        setTimeout(check, 1);
      };
      const deadline = Date.now() + 2000;
      check();
    });
    port.receive({ requestId, request: req });
    const reply = await replyPromise;
    if (!reply.ok) throw new Error(reply.error);
    return reply.result;
  };
  return {
    area,
    store,
    native,
    runs,
    tabs,
    registerAll,
    userScripts,
    router,
    connect,
    send,
    sendState: (port, req) => send(port, req) as Promise<SidebarState>,
    events: (port) =>
      port.posted
        .filter((m): m is { event: SidebarEvent } => typeof m === 'object' && m !== null && 'event' in m)
        .map((m) => m.event),
  };
}

beforeEach(() => {
  resetIds();
});

afterEach(() => {
  delete g.chrome;
  vi.restoreAllMocks();
});

describe('router: state and script mutations', () => {
  it('getState returns scripts, settings, errors and companion status', async () => {
    const s = mkScript();
    const h = harness([s]);
    h.native.setStatus({ state: 'connected', companionVersion: '0.1.0' });
    const port = h.connect();
    const state = await h.sendState(port, { type: 'getState' });
    expect(state.scripts).toEqual([s]);
    expect(state.settings.onboardingDone).toBe(false);
    expect(state.errors).toEqual({});
    expect(state.companion).toEqual({ state: 'connected', companionVersion: '0.1.0' });
  });

  it('keepScript clears the trial flag and does not re-register', async () => {
    const s = mkScript({ trial: true });
    const h = harness([s]);
    const port = h.connect();
    const state = await h.sendState(port, { type: 'keepScript', id: s.id });
    expect(state.scripts[0]?.trial).toBe(false);
    expect(h.area.scripts()[0]?.trial).toBe(false);
    expect(h.registerAll).not.toHaveBeenCalled();
  });

  it('undoScript disables, re-registers and reloads the tab', async () => {
    const s = mkScript({ trial: true });
    const h = harness([s]);
    const port = h.connect();
    const state = await h.sendState(port, { type: 'undoScript', id: s.id, tabId: 12 });
    expect(state.scripts[0]?.enabled).toBe(false);
    expect(state.scripts[0]?.trial).toBe(true);
    expect(h.registerAll).toHaveBeenCalledTimes(1);
    expect(h.registerAll.mock.calls[0]?.[0][0]?.enabled).toBe(false);
    expect(h.tabs.reload).toHaveBeenCalledWith(12);
    expect(h.registerAll.mock.invocationCallOrder[0]).toBeLessThan(h.tabs.reload.mock.invocationCallOrder[0] ?? 0);
  });

  it('undoScript without a tabId does not reload', async () => {
    const s = mkScript();
    const h = harness([s]);
    const port = h.connect();
    await h.sendState(port, { type: 'undoScript', id: s.id });
    expect(h.tabs.reload).not.toHaveBeenCalled();
  });

  it('toggleScript sets enabled and re-registers', async () => {
    const s = mkScript({ enabled: false });
    const h = harness([s]);
    const port = h.connect();
    let state = await h.sendState(port, { type: 'toggleScript', id: s.id, enabled: true });
    expect(state.scripts[0]?.enabled).toBe(true);
    state = await h.sendState(port, { type: 'toggleScript', id: s.id, enabled: false });
    expect(state.scripts[0]?.enabled).toBe(false);
    expect(h.registerAll).toHaveBeenCalledTimes(2);
  });

  it('setPriority updates the priority and re-registers', async () => {
    const s = mkScript({ priority: 3 });
    const h = harness([s]);
    const port = h.connect();
    const state = await h.sendState(port, { type: 'setPriority', id: s.id, priority: 1 });
    expect(state.scripts[0]?.priority).toBe(1);
    expect(h.registerAll).toHaveBeenCalledTimes(1);
  });

  it('updateCode replaces the code and re-registers', async () => {
    const s = mkScript();
    const h = harness([s]);
    const port = h.connect();
    const state = await h.sendState(port, { type: 'updateCode', id: s.id, code: 'alert(1)' });
    expect(state.scripts[0]?.code).toBe('alert(1)');
    expect(state.scripts[0]?.updatedAt).not.toBe(s.updatedAt);
    expect(h.registerAll).toHaveBeenCalledTimes(1);
  });

  it('updateCode rejects blank code', async () => {
    const s = mkScript();
    const h = harness([s]);
    const port = h.connect();
    await expect(h.send(port, { type: 'updateCode', id: s.id, code: '   ' })).rejects.toThrow(/code/);
    expect(h.area.scripts()[0]?.code).toBe(s.code);
  });

  it('updateScript patches name, description and urlPattern', async () => {
    const s = mkScript();
    const h = harness([s]);
    const port = h.connect();
    const state = await h.sendState(port, {
      type: 'updateScript',
      id: s.id,
      patch: { name: 'New name', description: 'New description.', urlPattern: 'https://b.com/*' },
    });
    expect(state.scripts[0]).toMatchObject({ name: 'New name', description: 'New description.', urlPattern: 'https://b.com/*' });
    expect(h.registerAll).toHaveBeenCalledTimes(1);
  });

  it('updateScript rejects an invalid pattern and keeps the script unchanged', async () => {
    const s = mkScript();
    const h = harness([s]);
    const port = h.connect();
    await expect(h.send(port, { type: 'updateScript', id: s.id, patch: { urlPattern: '*://*/*' } })).rejects.toThrow(/urlPattern/);
    expect(h.area.scripts()[0]).toEqual(s);
    expect(h.registerAll).not.toHaveBeenCalled();
  });

  it('mutations on an unknown id reply with an error', async () => {
    const h = harness();
    const port = h.connect();
    await expect(h.send(port, { type: 'keepScript', id: 'nope' })).rejects.toThrow(/not found/i);
  });

  it('deleteScript removes the script and its error, then re-registers', async () => {
    const s = mkScript();
    const h = harness([s]);
    await h.store.setError({ scriptId: s.id, message: 'boom', url: 'https://a.com/', at: s.createdAt });
    const port = h.connect();
    const state = await h.sendState(port, { type: 'deleteScript', id: s.id });
    expect(state.scripts).toEqual([]);
    expect(state.errors).toEqual({});
    expect(h.registerAll).toHaveBeenCalledTimes(1);
    expect(h.registerAll.mock.calls[0]?.[0]).toEqual([]);
  });

  it('clearError removes only that error', async () => {
    const a = mkScript();
    const b = mkScript();
    const h = harness([a, b]);
    await h.store.setError({ scriptId: a.id, message: 'boom', url: 'https://a.com/', at: a.createdAt });
    await h.store.setError({ scriptId: b.id, message: 'boom', url: 'https://a.com/', at: b.createdAt });
    const port = h.connect();
    const state = await h.sendState(port, { type: 'clearError', id: a.id });
    expect(Object.keys(state.errors)).toEqual([b.id]);
  });

  it('setOnboardingDone stores the flag', async () => {
    const h = harness();
    const port = h.connect();
    const state = await h.sendState(port, { type: 'setOnboardingDone', done: true });
    expect(state.settings.onboardingDone).toBe(true);
    expect((h.area.data.settings as { onboardingDone: boolean }).onboardingDone).toBe(true);
  });
});

describe('router: export and import', () => {
  it('exportScripts returns a pretty ExportFile json', async () => {
    const s = mkScript();
    const h = harness([s]);
    const port = h.connect();
    const json = (await h.send(port, { type: 'exportScripts' })) as string;
    const file = JSON.parse(json) as ExportFile;
    expect(file.format).toBe('sitecraft-scripts');
    expect(file.version).toBe(SCHEMA_VERSION);
    expect(Date.parse(file.exportedAt)).not.toBeNaN();
    expect(file.scripts).toEqual([s]);
    expect(json).toContain('\n');
  });

  it('importScripts merges by id, counts skipped entries and re-registers', async () => {
    const existing = mkScript({ code: 'old()' });
    const untouched = mkScript();
    const h = harness([existing, untouched]);
    const incoming = mkScript({ id: existing.id, code: 'new()' });
    const fresh = mkScript();
    const file: ExportFile = {
      format: 'sitecraft-scripts',
      version: SCHEMA_VERSION,
      exportedAt: '2026-01-01T00:00:00.000Z',
      scripts: [incoming, fresh, { ...mkScript(), urlPattern: '<all_urls>' }],
    };
    const port = h.connect();
    const result = (await h.send(port, { type: 'importScripts', json: JSON.stringify(file) })) as ImportResult;
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.errors).toHaveLength(1);
    const saved = h.area.scripts();
    expect(saved.map((s) => s.id).sort()).toEqual([existing.id, untouched.id, fresh.id].sort());
    expect(saved.find((s) => s.id === existing.id)?.code).toBe('new()');
    expect(h.registerAll).toHaveBeenCalledTimes(1);
  });

  it('importScripts rejects a file that is not an export', async () => {
    const h = harness();
    const port = h.connect();
    await expect(h.send(port, { type: 'importScripts', json: '{"nope":1}' })).rejects.toThrow(/format/);
    await expect(h.send(port, { type: 'importScripts', json: 'not json' })).rejects.toThrow(/JSON/);
    expect(h.registerAll).not.toHaveBeenCalled();
  });

  it('export then import round-trips', async () => {
    const s = mkScript({ kind: 'css', code: 'a{}' });
    const h = harness([s]);
    const port = h.connect();
    const json = (await h.send(port, { type: 'exportScripts' })) as string;
    await h.store.deleteScript(s.id);
    expect(h.area.scripts()).toEqual([]);
    const result = (await h.send(port, { type: 'importScripts', json })) as ImportResult;
    expect(result).toEqual({ imported: 1, skipped: 0, errors: [] });
    expect(h.area.scripts()).toEqual([s]);
  });
});

describe('router: tabs', () => {
  const tabs = [
    mkTab({ id: 1, windowId: 1, url: 'chrome://extensions/', active: true, lastAccessed: 500 }),
    mkTab({ id: 2, windowId: 1, url: 'https://a.com/', active: false, lastAccessed: 300 }),
    mkTab({ id: 3, windowId: 2, url: 'http://localhost:4173/harness/index.html', active: true, lastAccessed: 400 }),
    mkTab({ id: 4, windowId: 2, url: 'http://localhost:4174/', active: false, lastAccessed: 350 }),
    mkTab({ id: 5, windowId: 2, url: 'file:///tmp/x.html', active: false, lastAccessed: 100 }),
    mkTab({ id: 6, windowId: 2, url: 'about:blank', active: false, lastAccessed: 600 }),
    mkTab({ id: 7, windowId: 2, url: undefined, active: false, lastAccessed: 700 }),
  ];

  it('listTabs returns http, https and file tabs as TabInfo', async () => {
    const h = harness([], tabs);
    const port = h.connect();
    const list = (await h.send(port, { type: 'listTabs' })) as TabInfo[];
    expect(list.map((t) => t.tabId)).toEqual([2, 3, 4, 5]);
    expect(list[0]).toEqual({ tabId: 2, windowId: 1, url: 'https://a.com/', title: 'A', active: false });
  });

  it('getDefaultTab on an internal port prefers the active tab of the focused window', async () => {
    const list = [
      mkTab({ id: 1, windowId: 1, url: 'https://a.com/', active: true, lastAccessed: 1 }),
      mkTab({ id: 2, windowId: 1, url: 'https://b.com/', active: false, lastAccessed: 999 }),
    ];
    const h = harness([], list);
    const port = h.connect('internal');
    const def = (await h.send(port, { type: 'getDefaultTab' })) as TabInfo | null;
    expect(def?.tabId).toBe(1);
  });

  it('getDefaultTab on an internal port falls back to the most recent web tab when the active tab is not a web page', async () => {
    const h = harness([], tabs);
    const port = h.connect('internal');
    const def = (await h.send(port, { type: 'getDefaultTab' })) as TabInfo | null;
    expect(def?.tabId).toBe(3);
  });

  it('getDefaultTab on an external port skips the harness origin and picks the most recently accessed web tab', async () => {
    const h = harness([], tabs);
    const port = h.connect('external', 'http://localhost:4173');
    const def = (await h.send(port, { type: 'getDefaultTab' })) as TabInfo | null;
    expect(def?.tabId).toBe(4);
  });

  it('getDefaultTab returns null when there is no web tab', async () => {
    const h = harness([], [mkTab({ id: 1, url: 'chrome://newtab/', active: true })]);
    const port = h.connect('internal');
    expect(await h.send(port, { type: 'getDefaultTab' })).toBeNull();
  });

  it('getActiveTab with a windowId returns the active web tab of that window', async () => {
    const list = [
      mkTab({ id: 1, windowId: 1, url: 'https://a.com/', title: 'A', active: true }),
      mkTab({ id: 2, windowId: 2, url: 'https://b.com/', title: 'B', active: true }),
      mkTab({ id: 3, windowId: 2, url: 'https://c.com/', title: 'C', active: false }),
    ];
    const h = harness([], list);
    const port = h.connect('internal');
    const active = (await h.send(port, { type: 'getActiveTab', windowId: 2 })) as TabInfo | null;
    expect(active).toEqual({ tabId: 2, windowId: 2, url: 'https://b.com/', title: 'B', active: true });
    expect(h.tabs.query).toHaveBeenCalledWith({ active: true, windowId: 2 });
  });

  it('getActiveTab without a windowId uses the last focused window', async () => {
    const list = [
      mkTab({ id: 1, windowId: 1, url: 'https://a.com/', active: true }),
      mkTab({ id: 2, windowId: 2, url: 'https://b.com/', active: true }),
    ];
    const h = harness([], list);
    const port = h.connect('external');
    const active = (await h.send(port, { type: 'getActiveTab' })) as TabInfo | null;
    expect(active?.tabId).toBe(1);
    expect(h.tabs.query).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true });
  });

  it('getActiveTab returns null when the active tab is not a web page', async () => {
    const list = [
      mkTab({ id: 1, windowId: 1, url: 'chrome://newtab/', active: true }),
      mkTab({ id: 2, windowId: 1, url: 'https://a.com/', active: false }),
    ];
    const h = harness([], list);
    const port = h.connect('internal');
    expect(await h.send(port, { type: 'getActiveTab', windowId: 1 })).toBeNull();
    expect(await h.send(port, { type: 'getActiveTab' })).toBeNull();
  });

  it('getActiveTab returns null when the window has no active tab', async () => {
    const h = harness([], [mkTab({ id: 1, windowId: 1, url: 'https://a.com/', active: true })]);
    const port = h.connect('internal');
    expect(await h.send(port, { type: 'getActiveTab', windowId: 9 })).toBeNull();
  });

  it('getActiveTab falls back to pendingUrl while the first page loads', async () => {
    const h = harness([], [mkTab({ id: 1, windowId: 1, url: '', pendingUrl: 'https://b.com/', active: true })]);
    const port = h.connect('internal');
    const active = (await h.send(port, { type: 'getActiveTab', windowId: 1 })) as TabInfo | null;
    expect(active?.url).toBe('https://b.com/');
  });

  it('reloadTab reloads and returns the state', async () => {
    const h = harness();
    const port = h.connect();
    const state = await h.sendState(port, { type: 'reloadTab', tabId: 8 });
    expect(h.tabs.reload).toHaveBeenCalledWith(8);
    expect(state.scripts).toEqual([]);
  });

  it('openUrl creates a tab', async () => {
    const h = harness();
    const port = h.connect();
    await h.sendState(port, { type: 'openUrl', url: 'chrome://extensions/?id=abc' });
    expect(h.tabs.create).toHaveBeenCalledWith({ url: 'chrome://extensions/?id=abc' });
  });
});

describe('router: active tabs on attach', () => {
  const list = [
    mkTab({ id: 1, windowId: 1, url: 'https://a.com/', title: 'A', active: true }),
    mkTab({ id: 2, windowId: 1, url: 'https://b.com/', title: 'B', active: false }),
    mkTab({ id: 3, windowId: 2, url: 'chrome://newtab/', active: true }),
  ];

  it('sends the active tab of every window to an internal port when it attaches', async () => {
    const h = harness([], list);
    const port = h.connect('internal');
    await tick();
    expect(h.tabs.query).toHaveBeenCalledWith({ active: true });
    expect(h.events(port)).toEqual([
      {
        type: 'activeTabChanged',
        windowId: 1,
        tab: { tabId: 1, windowId: 1, url: 'https://a.com/', title: 'A', active: true },
        reason: 'sync',
      },
      { type: 'activeTabChanged', windowId: 2, tab: null, reason: 'sync' },
    ]);
  });

  it('sends nothing on attach to an external port', async () => {
    const h = harness([], list);
    const port = h.connect('external');
    await tick();
    expect(h.events(port)).toEqual([]);
  });

  it('sends nothing when the port dropped before the tabs were read', async () => {
    const h = harness([], list);
    const port = h.connect('internal');
    port.drop();
    await tick();
    expect(port.posted).toEqual([]);
  });

  it('keeps serving the port when tabs.query fails', async () => {
    const h = harness([mkScript()], list);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h.tabs.query.mockRejectedValueOnce(new Error('boom'));
    const port = h.connect('internal');
    await tick();
    expect(h.events(port)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    const state = await h.sendState(port, { type: 'getState' });
    expect(state.scripts).toHaveLength(1);
  });
});

describe('router: devReload', () => {
  it('calls the hook and returns the state when the build provides one', async () => {
    const devReload = vi.fn();
    const h = harness([mkScript()], [], { devReload });
    const port = h.connect('external');
    const state = await h.sendState(port, { type: 'devReload' });
    expect(devReload).toHaveBeenCalledTimes(1);
    expect(state.scripts).toHaveLength(1);
  });

  it('is rejected when the build has no hook', async () => {
    const h = harness();
    const port = h.connect('external');
    await expect(h.send(port, { type: 'devReload' })).rejects.toThrow('Not available in this build.');
  });
});

describe('router: runs and companion', () => {
  it('runRequest starts a run and cancelRun cancels it', async () => {
    const h = harness();
    const port = h.connect();
    const started = await h.send(port, { type: 'runRequest', tabId: 3, text: 'Hide it', targetScriptId: 'x' });
    expect(started).toEqual({ runId: 'run-1' });
    expect(h.runs.start).toHaveBeenCalledWith({ tabId: 3, text: 'Hide it', targetScriptId: 'x' });
    await h.sendState(port, { type: 'cancelRun', runId: 'run-1' });
    expect(h.runs.cancel).toHaveBeenCalledWith('run-1');
  });

  it('checkCompanion pings', async () => {
    const h = harness();
    h.native.setStatus({ state: 'not-installed', detail: 'nope' });
    const port = h.connect();
    const status = await h.send(port, { type: 'checkCompanion' });
    expect(h.native.ping).toHaveBeenCalledTimes(1);
    expect(status).toEqual({ state: 'not-installed', detail: 'nope' });
  });

  it('checkOnboarding skips the login check when the companion is not connected', async () => {
    const h = harness();
    h.userScripts.available = false;
    h.native.setStatus({ state: 'not-installed' });
    const port = h.connect();
    const status = (await h.send(port, { type: 'checkOnboarding' })) as OnboardingStatus;
    expect(status.userScriptsEnabled).toBe(false);
    expect(status.companion.state).toBe('not-installed');
    expect(status.claudeLogin.state).toBe('unknown');
    expect(h.native.checkAuth).not.toHaveBeenCalled();
  });

  it('checkOnboarding checks the login when the companion is connected', async () => {
    const h = harness();
    h.native.setStatus({ state: 'connected' });
    const port = h.connect();
    const status = (await h.send(port, { type: 'checkOnboarding' })) as OnboardingStatus;
    expect(status.userScriptsEnabled).toBe(true);
    expect(status.companion.state).toBe('connected');
    expect(status.claudeLogin).toEqual({ state: 'ok', detail: 'Logged in.' });
    expect(h.native.checkAuth).toHaveBeenCalledTimes(1);
  });

  it('checkOnboarding reports a failed login', async () => {
    const h = harness();
    h.native.setStatus({ state: 'connected' });
    h.native.checkAuth.mockResolvedValueOnce({ ok: false, detail: 'Not logged in.' });
    const port = h.connect();
    const status = (await h.send(port, { type: 'checkOnboarding' })) as OnboardingStatus;
    expect(status.claudeLogin).toEqual({ state: 'error', detail: 'Not logged in.' });
  });

  it('checkOnboarding shares one login check between overlapping calls', async () => {
    const h = harness();
    h.native.setStatus({ state: 'connected' });
    let release: (v: { ok: boolean; detail: string }) => void = () => undefined;
    h.native.checkAuth.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const port = h.connect();
    const p1 = h.send(port, { type: 'checkOnboarding' });
    const p2 = h.send(port, { type: 'checkOnboarding' });
    await tick(5);
    expect(h.native.checkAuth).toHaveBeenCalledTimes(1);
    release({ ok: true, detail: 'ok' });
    const [a, b] = (await Promise.all([p1, p2])) as OnboardingStatus[];
    expect(a?.claudeLogin.state).toBe('ok');
    expect(b?.claudeLogin.state).toBe('ok');
  });

  it('checkOnboarding reuses a recent successful login check', async () => {
    const h = harness();
    h.native.setStatus({ state: 'connected' });
    const port = h.connect();
    await h.send(port, { type: 'checkOnboarding' });
    await h.send(port, { type: 'checkOnboarding' });
    expect(h.native.checkAuth).toHaveBeenCalledTimes(1);
  });
});

describe('router: events and ports', () => {
  it('broadcasts stateChanged to every attached port when the store changes', async () => {
    const h = harness();
    const a = h.connect();
    const b = h.connect('external');
    await h.store.upsertScript(mkScript());
    await tick();
    const evA = h.events(a);
    const evB = h.events(b);
    expect(evA.at(-1)?.type).toBe('stateChanged');
    expect(evB.at(-1)?.type).toBe('stateChanged');
    const ev = evA.at(-1) as Extract<SidebarEvent, { type: 'stateChanged' }>;
    expect(ev.state.scripts).toHaveLength(1);
    expect(ev.state.companion).toEqual({ state: 'unknown' });
  });

  it('broadcasts companionStatus when the native client reports a change', async () => {
    const h = harness();
    const port = h.connect();
    h.native.setStatus({ state: 'connected', companionVersion: '1' });
    expect(h.events(port).at(-1)).toEqual({ type: 'companionStatus', status: { state: 'connected', companionVersion: '1' } });
  });

  it('stops posting to a port after it disconnects', async () => {
    const h = harness();
    const port = h.connect();
    port.drop();
    expect(h.router.portCount()).toBe(0);
    await h.store.upsertScript(mkScript());
    await tick();
    expect(h.events(port)).toEqual([]);
  });

  it('broadcast delivers an event to all ports', () => {
    const h = harness();
    const a = h.connect();
    const b = h.connect();
    h.router.broadcast({ type: 'runProgress', runId: 'r', status: 'Working' });
    expect(h.events(a)).toEqual([{ type: 'runProgress', runId: 'r', status: 'Working' }]);
    expect(h.events(b)).toEqual([{ type: 'runProgress', runId: 'r', status: 'Working' }]);
  });

  it('ignores messages that are not request envelopes', async () => {
    const h = harness();
    const port = h.connect();
    port.receive('hello');
    port.receive({ foo: 1 });
    port.receive({ requestId: 'x' });
    await tick();
    expect(port.posted).toEqual([]);
  });

  it('replies with an error for an unknown request type', async () => {
    const h = harness();
    const port = h.connect();
    await expect(h.send(port, { type: 'bogus' } as unknown as SidebarRequest)).rejects.toThrow(/unknown request/i);
  });

  it('dispose detaches ports and listeners', async () => {
    const h = harness();
    const port = h.connect();
    h.router.dispose();
    expect(h.router.portCount()).toBe(0);
    await h.store.upsertScript(mkScript());
    h.native.setStatus({ state: 'connected' });
    await tick();
    expect(port.posted).toEqual([]);
  });

  it('reply envelopes carry the requestId and an ok flag', async () => {
    const h = harness();
    const port = h.connect();
    port.receive({ requestId: 'abc', request: { type: 'getState' } });
    await tick();
    const replies = port.posted.filter((m): m is SidebarEnvelope => typeof m === 'object' && m !== null && 'requestId' in m);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ requestId: 'abc', ok: true });
  });
});

describe('isAllowedExternalOrigin', () => {
  it('accepts localhost and 127.0.0.1 over http on any port', () => {
    expect(isAllowedExternalOrigin('http://localhost:4173')).toBe(true);
    expect(isAllowedExternalOrigin('http://localhost')).toBe(true);
    expect(isAllowedExternalOrigin('http://127.0.0.1:5173')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isAllowedExternalOrigin(undefined)).toBe(false);
    expect(isAllowedExternalOrigin('')).toBe(false);
    expect(isAllowedExternalOrigin('https://localhost:4173')).toBe(false);
    expect(isAllowedExternalOrigin('http://localhost.evil.com')).toBe(false);
    expect(isAllowedExternalOrigin('http://localhostevil.com:4173')).toBe(false);
    expect(isAllowedExternalOrigin('http://example.com')).toBe(false);
    expect(isAllowedExternalOrigin('null')).toBe(false);
  });
});

describe('script errors from the content script', () => {
  it('handleScriptError stores the error for a known script', async () => {
    const s = mkScript();
    const area = new FakeStorageArea();
    area.data.scripts = [s];
    const store = createStateStore(area.asArea());
    const stored = await handleScriptError(
      { type: 'scriptError', scriptId: s.id, message: 'x is not defined', url: 'https://a.com/' },
      store,
    );
    expect(stored).toBe(true);
    const errors = area.data.errors as Record<string, { message: string; url: string; at: string }>;
    expect(errors[s.id]?.message).toBe('x is not defined');
    expect(errors[s.id]?.url).toBe('https://a.com/');
    expect(Date.parse(errors[s.id]?.at ?? '')).not.toBeNaN();
  });

  it('handleScriptError ignores unknown ids and malformed messages', async () => {
    const area = new FakeStorageArea();
    area.data.scripts = [mkScript()];
    const store = createStateStore(area.asArea());
    expect(await handleScriptError({ type: 'scriptError', scriptId: 'nope', message: 'm', url: 'u' }, store)).toBe(false);
    expect(await handleScriptError({ type: 'scriptError' }, store)).toBe(false);
    expect(await handleScriptError({ type: 'cssBlocked', url: 'u' }, store)).toBe(false);
    expect(await handleScriptError(null, store)).toBe(false);
    expect(area.data.errors ?? {}).toEqual({});
  });

  it('installScriptErrorHandler listens on chrome.runtime.onMessage', async () => {
    type Listener = (msg: unknown, sender: chrome.runtime.MessageSender, sendResponse: () => void) => void;
    const listeners = new Set<Listener>();
    g.chrome = {
      runtime: {
        onMessage: {
          addListener: (l: Listener) => {
            listeners.add(l);
          },
          removeListener: (l: Listener) => {
            listeners.delete(l);
          },
        },
      },
    };
    const s = mkScript();
    const area = new FakeStorageArea();
    area.data.scripts = [s];
    const store = createStateStore(area.asArea());
    const off = installScriptErrorHandler(store);
    expect(listeners.size).toBe(1);
    for (const l of [...listeners]) {
      l({ type: 'scriptError', scriptId: s.id, message: 'boom', url: 'https://a.com/' }, {}, () => undefined);
    }
    await tick();
    const errors = area.data.errors as Record<string, { message: string }>;
    expect(errors[s.id]?.message).toBe('boom');
    off();
    expect(listeners.size).toBe(0);
  });
});
