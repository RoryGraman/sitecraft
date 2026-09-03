import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INSPECT_MAX_CHARS, SNAPSHOT_MAX_CHARS } from '@sitecraft/shared';
import type { AgentRequest, AgentScriptOutput, PageContext, SidebarEvent, SiteScript } from '@sitecraft/shared';
import { createStateStore } from '../src/background/state';
import type { StateStore } from '../src/background/state';
import type { RunHooks } from '../src/background/native';
import type { RegisterAllResult } from '../src/background/userScripts';
import {
  createRunManager,
  inspectInTab,
  syncUserScripts,
  syncUserScriptsIfEmpty,
  takeSnapshotFromTab,
} from '../src/background/runs';
import { FakeStorageArea, fakeNative, mkScript, resetIds, tick } from './router.fakes';

const PAGE: PageContext = { url: 'https://a.com/watch?v=1', title: 'A', snapshot: '<html></html>' };

const OUTPUT: AgentScriptOutput = {
  name: 'Hide promo',
  description: 'Hides the promo banner.',
  kind: 'css',
  urlPattern: 'https://a.com/*',
  priority: 2,
  code: '#promo{display:none}',
};

const g = globalThis as unknown as { chrome?: unknown };

interface Harness {
  store: StateStore;
  area: FakeStorageArea;
  native: ReturnType<typeof fakeNative>;
  events: SidebarEvent[];
  takeSnapshot: ReturnType<typeof vi.fn<(tabId: number) => Promise<PageContext>>>;
  reloadTab: ReturnType<typeof vi.fn<(tabId: number) => Promise<void>>>;
  registerAll: ReturnType<typeof vi.fn<(scripts: SiteScript[]) => Promise<RegisterAllResult>>>;
  inspect: ReturnType<typeof vi.fn<(tabId: number, selector: string) => Promise<string>>>;
  manager: ReturnType<typeof createRunManager>;
  done(runId: string): Promise<Extract<SidebarEvent, { type: 'runDone' }>>;
}

function harness(scripts: SiteScript[] = []): Harness {
  const area = new FakeStorageArea();
  area.data.scripts = scripts;
  const store = createStateStore(area.asArea());
  const native = fakeNative({ state: 'connected' });
  const events: SidebarEvent[] = [];
  const waiters = new Map<string, (ev: Extract<SidebarEvent, { type: 'runDone' }>) => void>();
  const takeSnapshot = vi.fn<(tabId: number) => Promise<PageContext>>(async () => PAGE);
  const reloadTab = vi.fn<(tabId: number) => Promise<void>>(async () => undefined);
  const registerAll = vi.fn<(scripts: SiteScript[]) => Promise<RegisterAllResult>>(async () => ({
    registered: 1,
    skipped: false,
  }));
  const inspect = vi.fn<(tabId: number, selector: string) => Promise<string>>(async () => '<div></div>');
  const manager = createRunManager({
    store,
    native,
    takeSnapshot,
    reloadTab,
    registerAll,
    inspect,
    emit: (ev) => {
      events.push(ev);
      if (ev.type === 'runDone') waiters.get(ev.runId)?.(ev);
    },
  });
  return {
    store,
    area,
    native,
    events,
    takeSnapshot,
    reloadTab,
    registerAll,
    inspect,
    manager,
    done: (runId) => {
      const already = events.find(
        (e): e is Extract<SidebarEvent, { type: 'runDone' }> => e.type === 'runDone' && e.runId === runId,
      );
      if (already) return Promise.resolve(already);
      return new Promise((resolve) => waiters.set(runId, resolve));
    },
  };
}

beforeEach(() => {
  resetIds();
});

afterEach(() => {
  delete g.chrome;
  vi.restoreAllMocks();
});

describe('createRunManager: success path', () => {
  it('creates a trial script, registers it and reloads the tab', async () => {
    const h = harness();
    h.native.run.mockResolvedValueOnce(OUTPUT);

    const { runId } = await h.manager.start({ tabId: 5, text: 'Hide the promo banner' });
    expect(typeof runId).toBe('string');
    expect(runId.length).toBeGreaterThan(0);

    const ev = await h.done(runId);
    expect(ev.outcome.ok).toBe(true);
    if (!ev.outcome.ok) return;
    expect(ev.outcome.isUpdate).toBe(false);
    const saved = ev.outcome.script;
    expect(saved).toMatchObject({ ...OUTPUT, enabled: true, trial: true });
    expect(saved.id.length).toBeGreaterThan(0);
    expect(Date.parse(saved.createdAt)).not.toBeNaN();
    expect(saved.updatedAt).toBe(saved.createdAt);

    expect(h.area.scripts()).toHaveLength(1);
    expect(h.area.scripts()[0]?.id).toBe(saved.id);

    expect(h.takeSnapshot).toHaveBeenCalledWith(5);
    expect(h.registerAll).toHaveBeenCalledTimes(1);
    expect(h.registerAll.mock.calls[0]?.[0].map((s) => s.id)).toEqual([saved.id]);
    expect(h.reloadTab).toHaveBeenCalledWith(5);
    // register happens before reload
    expect(h.registerAll.mock.invocationCallOrder[0]).toBeLessThan(h.reloadTab.mock.invocationCallOrder[0] ?? 0);
  });

  it('sends the page, the request and the matching existing scripts to the companion', async () => {
    const same = mkScript({ urlPattern: 'https://a.com/*' });
    const disabledSame = mkScript({ urlPattern: '*://*.a.com/*', enabled: false });
    const other = mkScript({ urlPattern: 'https://b.com/*' });
    const h = harness([same, disabledSame, other]);
    h.native.run.mockResolvedValueOnce(OUTPUT);

    const { runId } = await h.manager.start({ tabId: 5, text: 'Do it' });
    await h.done(runId);

    const payload = h.native.run.mock.calls[0]?.[0] as AgentRequest;
    expect(payload.request).toBe('Do it');
    expect(payload.page).toEqual(PAGE);
    expect(payload.existingScripts.map((s) => s.id).sort()).toEqual([same.id, disabledSame.id].sort());
    expect(payload.targetScript).toBeUndefined();
    expect(payload.model).toBeUndefined();
    const opts = h.native.run.mock.calls[0]?.[2];
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
  });

  it('drops an empty model instead of forwarding it', async () => {
    const h = harness();
    h.native.run.mockResolvedValueOnce(OUTPUT);
    const { runId } = await h.manager.start({ tabId: 5, text: 'Do it', model: '' });
    await h.done(runId);
    expect((h.native.run.mock.calls[0]?.[0] as AgentRequest).model).toBeUndefined();
  });

  it('forwards the picked model to the companion payload', async () => {
    const h = harness();
    h.native.run.mockResolvedValueOnce(OUTPUT);
    const { runId } = await h.manager.start({ tabId: 5, text: 'Do it', model: 'claude-sonnet-5' });
    await h.done(runId);
    const payload = h.native.run.mock.calls[0]?.[0] as AgentRequest;
    expect(payload.model).toBe('claude-sonnet-5');
  });

  it('emits progress events for its own steps and for companion progress', async () => {
    const h = harness();
    h.native.run.mockImplementationOnce(async (_p, hooks: RunHooks) => {
      hooks.onProgress('Looking at the page');
      return OUTPUT;
    });
    const { runId } = await h.manager.start({ tabId: 5, text: 'x' });
    await h.done(runId);
    const progress = h.events.filter(
      (e): e is Extract<SidebarEvent, { type: 'runProgress' }> => e.type === 'runProgress' && e.runId === runId,
    );
    expect(progress.length).toBeGreaterThanOrEqual(2);
    expect(progress.some((p) => p.status === 'Looking at the page')).toBe(true);
    // runDone is the last event for this run
    const last = h.events.filter((e) => e.type !== 'stateChanged').at(-1);
    expect(last?.type).toBe('runDone');
  });

  it('relays inspect calls to the run tab', async () => {
    const h = harness();
    h.native.run.mockImplementationOnce(async (_p, hooks: RunHooks) => {
      const html = await hooks.inspect('#promo');
      expect(html).toBe('<div></div>');
      return OUTPUT;
    });
    const { runId } = await h.manager.start({ tabId: 5, text: 'x' });
    const ev = await h.done(runId);
    expect(ev.outcome.ok).toBe(true);
    expect(h.inspect).toHaveBeenCalledWith(5, '#promo');
  });

  it('still reports success when the reload fails', async () => {
    const h = harness();
    h.native.run.mockResolvedValueOnce(OUTPUT);
    h.reloadTab.mockRejectedValueOnce(new Error('No tab with id: 5.'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { runId } = await h.manager.start({ tabId: 5, text: 'x' });
    const ev = await h.done(runId);
    expect(ev.outcome.ok).toBe(true);
    expect(h.area.scripts()).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
  });

  it('replies to the start request before the run emits anything', async () => {
    const h = harness();
    h.takeSnapshot.mockRejectedValueOnce(new Error('boom'));
    const { runId } = await h.manager.start({ tabId: 5, text: 'x' });
    expect(h.events.filter((e) => e.type === 'runDone')).toHaveLength(0);
    const ev = await h.done(runId);
    expect(ev.outcome.ok).toBe(false);
  });
});

describe('createRunManager: failure paths', () => {
  it('saves nothing when the companion fails', async () => {
    const h = harness();
    h.native.run.mockRejectedValueOnce(new Error('Claude is not logged in.'));
    const { runId } = await h.manager.start({ tabId: 5, text: 'x' });
    const ev = await h.done(runId);
    expect(ev.outcome).toEqual({ ok: false, error: 'Claude is not logged in.' });
    expect(h.area.scripts()).toHaveLength(0);
    expect(h.registerAll).not.toHaveBeenCalled();
    expect(h.reloadTab).not.toHaveBeenCalled();
  });

  it('saves nothing when the output does not validate', async () => {
    const h = harness();
    h.native.run.mockResolvedValueOnce({ ...OUTPUT, urlPattern: '<all_urls>' });
    const { runId } = await h.manager.start({ tabId: 5, text: 'x' });
    const ev = await h.done(runId);
    expect(ev.outcome.ok).toBe(false);
    if (ev.outcome.ok) return;
    expect(ev.outcome.error).toContain('urlPattern');
    expect(h.area.scripts()).toHaveLength(0);
    expect(h.registerAll).not.toHaveBeenCalled();
  });

  it('saves nothing when the pattern does not match the page (prompt injection guard)', async () => {
    const h = harness();
    h.native.run.mockResolvedValueOnce({ ...OUTPUT, urlPattern: 'https://evil.example/*' });
    const { runId } = await h.manager.start({ tabId: 5, text: 'x' });
    const ev = await h.done(runId);
    expect(ev.outcome.ok).toBe(false);
    if (ev.outcome.ok) return;
    expect(ev.outcome.error).toContain('different site');
    expect(ev.outcome.error).toContain('https://evil.example/*');
    expect(h.area.scripts()).toHaveLength(0);
    expect(h.registerAll).not.toHaveBeenCalled();
    expect(h.reloadTab).not.toHaveBeenCalled();
  });

  it('reports a snapshot failure', async () => {
    const h = harness();
    h.takeSnapshot.mockRejectedValueOnce(new Error('Cannot access a chrome:// URL'));
    const { runId } = await h.manager.start({ tabId: 5, text: 'x' });
    const ev = await h.done(runId);
    expect(ev.outcome).toEqual({ ok: false, error: 'Cannot access a chrome:// URL' });
    expect(h.native.run).not.toHaveBeenCalled();
  });

  it('rejects an empty request without starting a run', async () => {
    const h = harness();
    await expect(h.manager.start({ tabId: 5, text: '   ' })).rejects.toThrow(/empty/i);
    expect(h.takeSnapshot).not.toHaveBeenCalled();
  });

  it('reports a missing target script', async () => {
    const h = harness();
    const { runId } = await h.manager.start({ tabId: 5, text: 'x', targetScriptId: 'nope' });
    const ev = await h.done(runId);
    expect(ev.outcome.ok).toBe(false);
    if (ev.outcome.ok) return;
    expect(ev.outcome.error).toMatch(/not found/i);
    expect(h.native.run).not.toHaveBeenCalled();
  });

  it('reports a registration failure for the new script and keeps it in the manager with an error', async () => {
    const h = harness();
    h.native.run.mockResolvedValueOnce({ ...OUTPUT, kind: 'js', code: 'x()' });
    h.registerAll.mockImplementationOnce(async (scripts, onBundleError?: (ids: string[], m: string) => void) => {
      onBundleError?.(
        scripts.map((s) => s.id),
        'Invalid match pattern',
      );
      return { registered: 0, skipped: false };
    });
    const { runId } = await h.manager.start({ tabId: 5, text: 'x' });
    const ev = await h.done(runId);
    expect(ev.outcome.ok).toBe(false);
    if (ev.outcome.ok) return;
    expect(ev.outcome.error).toContain('Invalid match pattern');
    const saved = h.area.scripts();
    expect(saved).toHaveLength(1);
    const errors = h.area.data.errors as Record<string, { message: string }>;
    expect(errors[saved[0]?.id ?? '']?.message).toContain('Invalid match pattern');
    expect(h.reloadTab).not.toHaveBeenCalled();
  });

  it('reports when user scripts are unavailable for a js script', async () => {
    const h = harness();
    h.native.run.mockResolvedValueOnce({ ...OUTPUT, kind: 'js', code: 'x()' });
    h.registerAll.mockResolvedValueOnce({ registered: 0, skipped: true });
    const { runId } = await h.manager.start({ tabId: 5, text: 'x' });
    const ev = await h.done(runId);
    expect(ev.outcome.ok).toBe(false);
    if (ev.outcome.ok) return;
    expect(ev.outcome.error).toMatch(/user scripts/i);
  });

  it('does not mind user scripts being unavailable for a css script', async () => {
    const h = harness();
    h.native.run.mockResolvedValueOnce(OUTPUT);
    h.registerAll.mockResolvedValueOnce({ registered: 0, skipped: true });
    const { runId } = await h.manager.start({ tabId: 5, text: 'x' });
    const ev = await h.done(runId);
    expect(ev.outcome.ok).toBe(true);
    expect(h.reloadTab).toHaveBeenCalledWith(5);
  });
});

describe('createRunManager: update path', () => {
  it('keeps the id, applies the new fields and sets trial true', async () => {
    const existing = mkScript({
      urlPattern: 'https://a.com/*',
      kind: 'css',
      code: 'old{}',
      trial: false,
      enabled: false,
      createdAt: '2025-05-05T00:00:00.000Z',
      updatedAt: '2025-05-05T00:00:00.000Z',
    });
    const h = harness([existing]);
    h.native.run.mockResolvedValueOnce({ ...OUTPUT, code: 'new{}', priority: 4 });

    const { runId } = await h.manager.start({ tabId: 5, text: 'Also hide it on the home page', targetScriptId: existing.id });
    const ev = await h.done(runId);
    expect(ev.outcome.ok).toBe(true);
    if (!ev.outcome.ok) return;
    expect(ev.outcome.isUpdate).toBe(true);
    const saved = ev.outcome.script;
    expect(saved.id).toBe(existing.id);
    expect(saved.code).toBe('new{}');
    expect(saved.priority).toBe(4);
    expect(saved.name).toBe(OUTPUT.name);
    expect(saved.trial).toBe(true);
    expect(saved.enabled).toBe(true);
    expect(saved.createdAt).toBe(existing.createdAt);
    expect(saved.updatedAt).not.toBe(existing.updatedAt);

    expect(h.area.scripts()).toHaveLength(1);
    expect(h.area.scripts()[0]).toEqual(saved);

    const payload = h.native.run.mock.calls[0]?.[0] as AgentRequest;
    expect(payload.targetScript?.id).toBe(existing.id);
    expect(payload.existingScripts.map((s) => s.id)).toEqual([existing.id]);
  });

  it('saves nothing on failure even when a target is set', async () => {
    const existing = mkScript({ kind: 'css', code: 'old{}' });
    const h = harness([existing]);
    h.native.run.mockRejectedValueOnce(new Error('nope'));
    const { runId } = await h.manager.start({ tabId: 5, text: 'x', targetScriptId: existing.id });
    const ev = await h.done(runId);
    expect(ev.outcome.ok).toBe(false);
    expect(h.area.scripts()[0]).toEqual(existing);
  });
});

describe('createRunManager: cancel', () => {
  it('aborts the companion run and reports a cancelled outcome', async () => {
    const h = harness();
    h.native.run.mockImplementationOnce(
      (_p, _hooks, opts) =>
        new Promise<AgentScriptOutput>((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        }),
    );
    const { runId } = await h.manager.start({ tabId: 5, text: 'x' });
    await tick();
    expect(h.manager.isActive(runId)).toBe(true);
    h.manager.cancel(runId);
    const ev = await h.done(runId);
    expect(ev.outcome).toEqual({ ok: false, error: 'Run cancelled.' });
    expect(h.manager.isActive(runId)).toBe(false);
    expect(h.area.scripts()).toHaveLength(0);
  });

  it('does not save a result that arrives after cancel', async () => {
    const h = harness();
    let finish: (o: AgentScriptOutput) => void = () => undefined;
    h.native.run.mockImplementationOnce(
      () =>
        new Promise<AgentScriptOutput>((resolve) => {
          finish = resolve;
        }),
    );
    const { runId } = await h.manager.start({ tabId: 5, text: 'x' });
    await tick();
    h.manager.cancel(runId);
    finish(OUTPUT);
    const ev = await h.done(runId);
    expect(ev.outcome.ok).toBe(false);
    expect(h.area.scripts()).toHaveLength(0);
  });

  it('ignores cancel for an unknown run', () => {
    const h = harness();
    expect(() => h.manager.cancel('nope')).not.toThrow();
  });
});

describe('syncUserScripts', () => {
  it('registers the stored scripts and records bundle errors', async () => {
    const js = mkScript({ kind: 'js' });
    const area = new FakeStorageArea();
    area.data.scripts = [js];
    const store = createStateStore(area.asArea());
    const register = vi.fn(async (_s: SiteScript[], onBundleError?: (ids: string[], m: string) => void) => {
      onBundleError?.([js.id], 'bad pattern');
      return { registered: 0, skipped: false };
    });
    const result = await syncUserScripts(store, register);
    expect(result).toEqual({ registered: 0, skipped: false, failed: { [js.id]: 'bad pattern' } });
    expect(register.mock.calls[0]?.[0].map((s) => s.id)).toEqual([js.id]);
    await tick();
    const errors = area.data.errors as Record<string, { message: string; url: string }>;
    expect(errors[js.id]?.message).toContain('bad pattern');
    expect(errors[js.id]?.url).toBe(js.urlPattern);
  });
});

describe('takeSnapshotFromTab', () => {
  function installTabs(opts: { url?: string; reply?: unknown; sendThrows?: boolean; execResult?: unknown }) {
    const sendMessage = vi.fn(async () => {
      if (opts.sendThrows) throw new Error('Could not establish connection. Receiving end does not exist.');
      return opts.reply;
    });
    const executeScript = vi.fn<(injection: unknown) => Promise<unknown[]>>(async () => [{ result: opts.execResult, frameId: 0, documentId: 'd' }]);
    g.chrome = {
      tabs: {
        get: vi.fn(async () => ({ id: 4, url: opts.url ?? 'https://a.com/x', title: 'Title' })),
        sendMessage,
      },
      scripting: { executeScript },
    };
    return { sendMessage, executeScript };
  }

  it('asks the content script first', async () => {
    const { sendMessage, executeScript } = installTabs({ reply: '<html>cs</html>' });
    const page = await takeSnapshotFromTab(4);
    expect(page).toEqual({ url: 'https://a.com/x', title: 'Title', snapshot: '<html>cs</html>' });
    expect(sendMessage).toHaveBeenCalledWith(4, { type: 'takeSnapshot', maxChars: SNAPSHOT_MAX_CHARS });
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('falls back to executeScript when the content script is missing', async () => {
    const { executeScript } = installTabs({ sendThrows: true, execResult: '<html>exec</html>' });
    const page = await takeSnapshotFromTab(4);
    expect(page.snapshot).toBe('<html>exec</html>');
    const injection = executeScript.mock.calls[0]?.[0] as unknown as { target: { tabId: number }; func: unknown; args: unknown[] };
    expect(injection.target.tabId).toBe(4);
    expect(typeof injection.func).toBe('function');
    expect(injection.args[0]).toBe(SNAPSHOT_MAX_CHARS);
  });

  it('falls back when the content script replies with something else', async () => {
    const { executeScript } = installTabs({ reply: undefined, execResult: '<html>exec</html>' });
    const page = await takeSnapshotFromTab(4);
    expect(page.snapshot).toBe('<html>exec</html>');
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported pages before touching the tab', async () => {
    const { sendMessage, executeScript } = installTabs({ url: 'chrome://extensions/' });
    await expect(takeSnapshotFromTab(4)).rejects.toThrow(/http/);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('rejects when both paths return nothing', async () => {
    installTabs({ sendThrows: true, execResult: undefined });
    await expect(takeSnapshotFromTab(4)).rejects.toThrow(/read the page/i);
  });
});

describe('inspectInTab', () => {
  function installTabs(opts: { reply?: unknown; sendThrows?: boolean; execResult?: unknown }) {
    const sendMessage = vi.fn(async () => {
      if (opts.sendThrows) throw new Error('no receiver');
      return opts.reply;
    });
    const executeScript = vi.fn<(injection: unknown) => Promise<unknown[]>>(async () => [{ result: opts.execResult, frameId: 0, documentId: 'd' }]);
    g.chrome = { tabs: { sendMessage }, scripting: { executeScript } };
    return { sendMessage, executeScript };
  }

  it('returns the match count and the first match html from the content script', async () => {
    const { sendMessage } = installTabs({ reply: { ok: true, html: '<div id="p"></div>', count: 3 } });
    const text = await inspectInTab(4, '#p');
    expect(sendMessage).toHaveBeenCalledWith(4, { type: 'inspect', selector: '#p', maxChars: INSPECT_MAX_CHARS });
    expect(text).toContain('3');
    expect(text).toContain('<div id="p"></div>');
  });

  it('says so when nothing matches', async () => {
    installTabs({ reply: { ok: true, html: '', count: 0 } });
    const text = await inspectInTab(4, '#p');
    expect(text).toMatch(/no element/i);
    expect(text).toContain('#p');
  });

  it('throws the selector error', async () => {
    installTabs({ reply: { ok: false, error: 'Invalid selector "#["' } });
    await expect(inspectInTab(4, '#[')).rejects.toThrow('Invalid selector');
  });

  it('falls back to executeScript when the content script is missing', async () => {
    const { executeScript } = installTabs({ sendThrows: true, execResult: { ok: true, html: '<b></b>', count: 1 } });
    const text = await inspectInTab(4, 'b');
    expect(text).toContain('<b></b>');
    const injection = executeScript.mock.calls[0]?.[0] as unknown as { args: unknown[] };
    expect(injection.args).toEqual(['b', INSPECT_MAX_CHARS]);
  });
});

describe('syncUserScriptsIfEmpty', () => {
  function fixture(scripts: SiteScript[]) {
    const area = new FakeStorageArea();
    area.data.scripts = scripts;
    const store = createStateStore(area.asArea());
    const register = vi.fn<(s: SiteScript[]) => Promise<RegisterAllResult>>(async () => ({ registered: 1, skipped: false }));
    return { store, register };
  }

  it('registers stored scripts when Chrome holds none', async () => {
    const script = mkScript({ urlPattern: 'https://www.youtube.com/*', kind: 'js' });
    const { store, register } = fixture([script]);
    const probe = { isAvailable: () => true, getScripts: async () => [] };
    const res = await syncUserScriptsIfEmpty(store, register, probe);
    expect(res).not.toBeNull();
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0]?.[0].map((s) => s.id)).toEqual([script.id]);
  });

  it('does nothing when Chrome already holds registrations', async () => {
    const { store, register } = fixture([mkScript({ kind: 'js' })]);
    const probe = { isAvailable: () => true, getScripts: async () => [{ id: 'bundle-1' }] };
    expect(await syncUserScriptsIfEmpty(store, register, probe)).toBeNull();
    expect(register).not.toHaveBeenCalled();
  });

  it('does nothing when user scripts are unavailable', async () => {
    const { store, register } = fixture([mkScript({ kind: 'js' })]);
    const probe = { isAvailable: () => false, getScripts: async () => [] };
    expect(await syncUserScriptsIfEmpty(store, register, probe)).toBeNull();
    expect(register).not.toHaveBeenCalled();
  });

  it('does nothing when getScripts throws', async () => {
    const { store, register } = fixture([mkScript({ kind: 'js' })]);
    const probe = {
      isAvailable: () => true,
      getScripts: async () => {
        throw new Error('boom');
      },
    };
    expect(await syncUserScriptsIfEmpty(store, register, probe)).toBeNull();
    expect(register).not.toHaveBeenCalled();
  });
});
