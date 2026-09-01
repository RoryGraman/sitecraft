import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, SCHEMA_VERSION } from '@sitecraft/shared';
import type { ScriptError, SiteScript, StoredState } from '@sitecraft/shared';
import { createStateStore, migrate } from '../src/background/state';

type Changes = Record<string, chrome.storage.StorageChange>;
type Listener = (changes: Changes, areaName: string) => void;

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/** In-memory stand-in for chrome.storage.local. */
class FakeStorageArea {
  data: Record<string, unknown> = {};
  /** When > 0, get/set wait this many ms. Exposes read-modify-write races. */
  latencyMs = 0;
  setCalls = 0;
  failNextSet: Error | null = null;
  private listeners = new Set<Listener>();

  onChanged = {
    addListener: (cb: Listener): void => {
      this.listeners.add(cb);
    },
    removeListener: (cb: Listener): void => {
      this.listeners.delete(cb);
    },
    hasListener: (cb: Listener): boolean => this.listeners.has(cb),
  };

  get listenerCount(): number {
    return this.listeners.size;
  }

  private async delay(): Promise<void> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
  }

  async get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> {
    await this.delay();
    if (keys === undefined || keys === null) return clone(this.data);
    const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    const out: Record<string, unknown> = {};
    if (!Array.isArray(keys) && typeof keys === 'object') Object.assign(out, clone(keys));
    for (const k of list) if (k in this.data) out[k] = clone(this.data[k]);
    return out;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    await this.delay();
    this.setCalls += 1;
    if (this.failNextSet) {
      const err = this.failNextSet;
      this.failNextSet = null;
      throw err;
    }
    this.write(items);
  }

  async remove(keys: string | string[]): Promise<void> {
    await this.delay();
    const changes: Changes = {};
    for (const k of typeof keys === 'string' ? [keys] : keys) {
      if (k in this.data) {
        changes[k] = { oldValue: clone(this.data[k]) };
        delete this.data[k];
      }
    }
    this.emit(changes);
  }

  async clear(): Promise<void> {
    await this.delay();
    const changes: Changes = {};
    for (const [k, v] of Object.entries(this.data)) changes[k] = { oldValue: clone(v) };
    this.data = {};
    this.emit(changes);
  }

  /** Write as if another extension context did it (no store involved). */
  external(items: Record<string, unknown>): void {
    this.write(items);
  }

  /** Dispatch like Chrome does: asynchronously, after the write. */
  emit(changes: Changes, areaName = 'local'): void {
    if (Object.keys(changes).length === 0) return;
    const cbs = [...this.listeners];
    queueMicrotask(() => {
      for (const cb of cbs) cb(clone(changes), areaName);
    });
  }

  asArea(): chrome.storage.StorageArea {
    return this as unknown as chrome.storage.StorageArea;
  }

  private write(items: Record<string, unknown>): void {
    const changes: Changes = {};
    for (const [k, v] of Object.entries(items)) {
      changes[k] = { oldValue: clone(this.data[k]), newValue: clone(v) };
      this.data[k] = clone(v);
    }
    this.emit(changes);
  }
}

function script(overrides: Partial<SiteScript> = {}): SiteScript {
  return {
    id: 'id-1',
    name: 'Hide sidebar',
    description: 'Hides the sidebar.',
    urlPattern: 'https://example.com/*',
    kind: 'css',
    priority: 3,
    code: '.sidebar { display: none }',
    enabled: true,
    trial: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

function error(overrides: Partial<ScriptError> = {}): ScriptError {
  return {
    scriptId: 'id-1',
    message: 'boom',
    url: 'https://example.com/a',
    at: '2026-01-03T00:00:00.000Z',
    ...overrides,
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

function setup(data: Record<string, unknown> = {}) {
  const area = new FakeStorageArea();
  area.data = clone(data);
  const store = createStateStore(area.asArea());
  return { area, store };
}

describe('migrate', () => {
  it('turns empty storage into defaults at the current schema version', () => {
    const state = migrate({});
    expect(state).toEqual<StoredState>({
      schemaVersion: SCHEMA_VERSION,
      scripts: [],
      settings: DEFAULT_SETTINGS,
      errors: {},
    });
  });

  it('fills missing script fields with defaults', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T12:00:00.000Z'));
    try {
      const state = migrate({
        schemaVersion: 1,
        scripts: [{ id: 'a', urlPattern: 'https://a.com/*', kind: 'js', code: 'x()' }],
      });
      expect(state.scripts).toEqual([
        {
          id: 'a',
          name: '',
          description: '',
          urlPattern: 'https://a.com/*',
          kind: 'js',
          priority: 3,
          code: 'x()',
          enabled: true,
          trial: false,
          createdAt: '2026-08-31T12:00:00.000Z',
          updatedAt: '2026-08-31T12:00:00.000Z',
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps valid fields as they are and strips unknown ones', () => {
    const s = script({ enabled: false, trial: true, priority: 5 });
    const state = migrate({ schemaVersion: 1, scripts: [{ ...s, extra: 'nope' }] });
    expect(state.scripts).toEqual([s]);
    expect(state.scripts[0]).not.toHaveProperty('extra');
  });

  it('drops scripts that lack a usable id, urlPattern, code or kind', () => {
    const state = migrate({
      schemaVersion: 1,
      scripts: [
        script({ id: 'ok' }),
        { ...script(), id: '' },
        { ...script(), id: 42 },
        { ...script(), urlPattern: undefined },
        { ...script(), code: '' },
        { ...script(), kind: 'html' },
        null,
        'text',
        7,
      ],
    });
    expect(state.scripts.map((s) => s.id)).toEqual(['ok']);
  });

  it('treats a non-array scripts value as no scripts', () => {
    expect(migrate({ schemaVersion: 1, scripts: { id: 'a' } }).scripts).toEqual([]);
    expect(migrate({ schemaVersion: 1, scripts: 'nope' }).scripts).toEqual([]);
  });

  it('replaces bad priorities, flags and dates', () => {
    const bad = [0, 6, 2.5, '3', null, undefined];
    const state = migrate({
      schemaVersion: 1,
      scripts: bad.map((priority, i) =>
        Object.assign(script({ id: `s${i}` }), {
          priority,
          enabled: 'yes',
          trial: 1,
          name: 12,
          description: null,
          createdAt: 'not a date',
          updatedAt: 123,
        }),
      ),
    });
    expect(state.scripts).toHaveLength(bad.length);
    for (const s of state.scripts) {
      expect(s.priority).toBe(3);
      expect(s.enabled).toBe(true);
      expect(s.trial).toBe(false);
      expect(s.name).toBe('');
      expect(s.description).toBe('');
      expect(Number.isNaN(Date.parse(s.createdAt))).toBe(false);
      expect(Number.isNaN(Date.parse(s.updatedAt))).toBe(false);
    }
  });

  it('keeps the first script when ids repeat', () => {
    const state = migrate({
      schemaVersion: 1,
      scripts: [script({ id: 'dup', name: 'first' }), script({ id: 'dup', name: 'second' })],
    });
    expect(state.scripts).toHaveLength(1);
    expect(state.scripts[0]?.name).toBe('first');
  });

  it('merges settings with defaults and repairs wrong types', () => {
    expect(migrate({ settings: { onboardingDone: true } }).settings).toEqual({
      ...DEFAULT_SETTINGS,
      onboardingDone: true,
    });
    expect(migrate({ settings: { onboardingDone: 'yes', companionHostName: '' } }).settings).toEqual(
      DEFAULT_SETTINGS,
    );
    expect(migrate({ settings: 'junk' }).settings).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps well-formed errors and drops malformed ones', () => {
    const good = error({ scriptId: 'a' });
    const state = migrate({
      schemaVersion: 1,
      scripts: [script({ id: 'a' })],
      errors: { a: good, b: { scriptId: 'b' }, c: null, d: 'x' },
    });
    expect(state.errors).toEqual({ a: good });
    expect(migrate({ errors: [] }).errors).toEqual({});
  });

  it('does not downgrade a newer schema version', () => {
    const s = script();
    const state = migrate({ schemaVersion: 7, scripts: [s] });
    expect(state.schemaVersion).toBe(7);
    expect(state.scripts).toEqual([s]);
  });

  it('bumps an old or missing version to the current one', () => {
    expect(migrate({ schemaVersion: 0 }).schemaVersion).toBe(SCHEMA_VERSION);
    expect(migrate({ schemaVersion: 'one' }).schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('does not mutate its input', () => {
    const raw = { schemaVersion: 1, scripts: [{ id: 'a', urlPattern: 'p', kind: 'css', code: 'c' }] };
    const before = clone(raw);
    migrate(raw);
    expect(raw).toEqual(before);
  });
});

describe('createStateStore', () => {
  describe('load', () => {
    it('returns defaults for empty storage and persists them', async () => {
      const { area, store } = setup();
      const state = await store.load();
      expect(state).toEqual({ schemaVersion: SCHEMA_VERSION, scripts: [], settings: DEFAULT_SETTINGS, errors: {} });
      expect(area.data).toEqual(state);
    });

    it('migrates legacy data and writes the result back', async () => {
      const { area, store } = setup({
        scripts: [{ id: 'a', urlPattern: 'https://a.com/*', kind: 'css', code: 'c' }, { id: 'bad' }],
      });
      const state = await store.load();
      expect(state.schemaVersion).toBe(SCHEMA_VERSION);
      expect(state.scripts.map((s) => s.id)).toEqual(['a']);
      expect(area.data.schemaVersion).toBe(SCHEMA_VERSION);
      expect((area.data.scripts as SiteScript[]).map((s) => s.id)).toEqual(['a']);
      expect(area.data.settings).toEqual(DEFAULT_SETTINGS);
      expect(area.data.errors).toEqual({});
    });

    it('does not write when stored data is already current', async () => {
      const { area, store } = setup({
        schemaVersion: SCHEMA_VERSION,
        scripts: [script()],
        settings: DEFAULT_SETTINGS,
        errors: {},
      });
      await store.load();
      expect(area.setCalls).toBe(0);
    });

    it('leaves data from a newer schema version untouched', async () => {
      const { area, store } = setup({ schemaVersion: 9, scripts: [{ id: 'a', urlPattern: 'p', kind: 'js', code: 'c' }] });
      const state = await store.load();
      expect(state.schemaVersion).toBe(9);
      expect(area.setCalls).toBe(0);
      expect(area.data.schemaVersion).toBe(9);
    });

    it('re-reads storage on every call', async () => {
      const { area, store } = setup();
      await store.load();
      area.external({ scripts: [script({ id: 'ext' })] });
      const state = await store.load();
      expect(state.scripts.map((s) => s.id)).toEqual(['ext']);
    });
  });

  describe('scripts', () => {
    it('works without an explicit load()', async () => {
      const { area, store } = setup();
      await store.upsertScript(script({ id: 'a' }));
      expect(await store.getScripts()).toEqual([script({ id: 'a' })]);
      expect(area.data.schemaVersion).toBe(SCHEMA_VERSION);
    });

    it('upsert appends new scripts and replaces existing ones in place', async () => {
      const { area, store } = setup();
      await store.upsertScript(script({ id: 'a' }));
      await store.upsertScript(script({ id: 'b' }));
      await store.upsertScript(script({ id: 'a', name: 'Renamed' }));
      const scripts = await store.getScripts();
      expect(scripts.map((s) => [s.id, s.name])).toEqual([
        ['a', 'Renamed'],
        ['b', 'Hide sidebar'],
      ]);
      expect(area.data.scripts).toEqual(scripts);
    });

    it('getScripts returns copies', async () => {
      const { store } = setup();
      await store.upsertScript(script({ id: 'a' }));
      const first = await store.getScripts();
      first[0]!.name = 'mutated';
      first.length = 0;
      expect(await store.getScripts()).toEqual([script({ id: 'a' })]);
    });

    it('patchScript merges fields, bumps updatedAt and returns the result', async () => {
      const { area, store } = setup();
      await store.upsertScript(script({ id: 'a', updatedAt: '2020-01-01T00:00:00.000Z' }));
      const before = Date.now();
      const patched = await store.patchScript('a', { name: 'New', priority: 1, enabled: false });
      expect(patched).toMatchObject({ id: 'a', name: 'New', priority: 1, enabled: false, trial: true });
      expect(Date.parse(patched.updatedAt)).toBeGreaterThanOrEqual(before);
      expect(patched.createdAt).toBe(script().createdAt);
      expect((area.data.scripts as SiteScript[])[0]).toEqual(patched);
    });

    it('patchScript ignores id changes and undefined values', async () => {
      const { store } = setup();
      await store.upsertScript(script({ id: 'a' }));
      const patched = await store.patchScript('a', { id: 'z', name: undefined } as Partial<SiteScript>);
      expect(patched.id).toBe('a');
      expect(patched.name).toBe('Hide sidebar');
      expect((await store.getScripts()).map((s) => s.id)).toEqual(['a']);
    });

    it('patchScript rejects for an unknown id and changes nothing', async () => {
      const { area, store } = setup();
      await store.upsertScript(script({ id: 'a' }));
      const calls = area.setCalls;
      await expect(store.patchScript('missing', { name: 'x' })).rejects.toThrow(/missing/);
      expect(area.setCalls).toBe(calls);
      expect(await store.getScripts()).toEqual([script({ id: 'a' })]);
    });

    it('deleteScript removes the script and its error', async () => {
      const { area, store } = setup();
      await store.upsertScript(script({ id: 'a' }));
      await store.upsertScript(script({ id: 'b' }));
      await store.setError(error({ scriptId: 'a' }));
      await store.setError(error({ scriptId: 'b' }));
      await store.deleteScript('a');
      const state = await store.load();
      expect(state.scripts.map((s) => s.id)).toEqual(['b']);
      expect(Object.keys(state.errors)).toEqual(['b']);
      expect(area.data.errors).toEqual(state.errors);
    });

    it('deleteScript for an unknown id is a no-op', async () => {
      const { store } = setup();
      await store.upsertScript(script({ id: 'a' }));
      await expect(store.deleteScript('nope')).resolves.toBeUndefined();
      expect(await store.getScripts()).toHaveLength(1);
    });

    it('replaceScripts swaps the whole list and drops orphaned errors', async () => {
      const { area, store } = setup();
      await store.upsertScript(script({ id: 'a' }));
      await store.setError(error({ scriptId: 'a' }));
      await store.replaceScripts([script({ id: 'b' }), script({ id: 'c' })]);
      const state = await store.load();
      expect(state.scripts.map((s) => s.id)).toEqual(['b', 'c']);
      expect(state.errors).toEqual({});
      expect(area.data.scripts).toEqual(state.scripts);
    });
  });

  describe('errors', () => {
    it('setError stores by scriptId and clearError removes it', async () => {
      const { area, store } = setup();
      await store.upsertScript(script({ id: 'a' }));
      const err = error({ scriptId: 'a' });
      await store.setError(err);
      expect((await store.load()).errors).toEqual({ a: err });
      const newer = error({ scriptId: 'a', message: 'again' });
      await store.setError(newer);
      expect(area.data.errors).toEqual({ a: newer });
      await store.clearError('a');
      expect((await store.load()).errors).toEqual({});
      await expect(store.clearError('a')).resolves.toBeUndefined();
    });
  });

  describe('settings', () => {
    it('getSettings returns defaults and patchSettings merges and persists', async () => {
      const { area, store } = setup();
      expect(await store.getSettings()).toEqual(DEFAULT_SETTINGS);
      const next = await store.patchSettings({ onboardingDone: true });
      expect(next).toEqual({ ...DEFAULT_SETTINGS, onboardingDone: true });
      expect(await store.getSettings()).toEqual(next);
      expect(area.data.settings).toEqual(next);
    });
  });

  describe('onChange', () => {
    it('fires once per successful write with the full state', async () => {
      const { store } = setup();
      await store.load();
      const cb = vi.fn<(s: StoredState) => void>();
      store.onChange(cb);
      await store.upsertScript(script({ id: 'a' }));
      await store.patchSettings({ onboardingDone: true });
      await flush();
      expect(cb).toHaveBeenCalledTimes(2);
      expect(cb.mock.calls[0]?.[0]).toEqual({
        schemaVersion: SCHEMA_VERSION,
        scripts: [script({ id: 'a' })],
        settings: DEFAULT_SETTINGS,
        errors: {},
      });
      expect(cb.mock.calls[1]?.[0].settings.onboardingDone).toBe(true);
    });

    it('fires when load() has to migrate and persist', async () => {
      const { store } = setup();
      const cb = vi.fn<(s: StoredState) => void>();
      store.onChange(cb);
      await store.load();
      await flush();
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('does not fire when a write fails', async () => {
      const { area, store } = setup();
      await store.upsertScript(script({ id: 'a' }));
      const cb = vi.fn();
      store.onChange(cb);
      area.failNextSet = new Error('disk full');
      await expect(store.patchScript('a', { name: 'x' })).rejects.toThrow('disk full');
      await flush();
      expect(cb).not.toHaveBeenCalled();
      expect((await store.getScripts())[0]?.name).toBe('Hide sidebar');
    });

    it('stops after unsubscribe', async () => {
      const { store } = setup();
      await store.load();
      const cb = vi.fn();
      const off = store.onChange(cb);
      await store.patchSettings({ onboardingDone: true });
      off();
      await store.patchSettings({ onboardingDone: false });
      await flush();
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('passes each listener its own copy', async () => {
      const { store } = setup();
      await store.load();
      const seen: StoredState[] = [];
      store.onChange((s) => {
        s.scripts.length = 0;
        s.settings.onboardingDone = true;
      });
      store.onChange((s) => seen.push(s));
      await store.upsertScript(script({ id: 'a' }));
      expect(seen[0]?.scripts).toHaveLength(1);
      expect(seen[0]?.settings.onboardingDone).toBe(false);
      expect(await store.getScripts()).toHaveLength(1);
    });

    it('keeps notifying other listeners when one throws', async () => {
      const { store } = setup();
      await store.load();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        store.onChange(() => {
          throw new Error('listener bug');
        });
        const cb = vi.fn();
        store.onChange(cb);
        await expect(store.patchSettings({ onboardingDone: true })).resolves.toBeDefined();
        expect(cb).toHaveBeenCalledTimes(1);
        expect(errorSpy).toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('fires for external changes to the same area and refreshes reads', async () => {
      const { area, store } = setup();
      await store.load();
      const cb = vi.fn<(s: StoredState) => void>();
      store.onChange(cb);
      area.external({ scripts: [{ id: 'ext', urlPattern: 'https://x.com/*', kind: 'js', code: 'go()' }] });
      await flush();
      expect(cb).toHaveBeenCalledTimes(1);
      const state = cb.mock.calls[0]?.[0];
      expect(state?.scripts.map((s) => s.id)).toEqual(['ext']);
      expect(state?.scripts[0]?.priority).toBe(3);
      expect((await store.getScripts()).map((s) => s.id)).toEqual(['ext']);
    });

    it('ignores external events for unrelated keys', async () => {
      const { area, store } = setup();
      await store.load();
      const cb = vi.fn();
      store.onChange(cb);
      area.external({ somethingElse: 1 });
      await flush();
      expect(cb).not.toHaveBeenCalled();
    });

    it('does not fire twice for its own writes even though the area echoes them', async () => {
      const { area, store } = setup();
      await store.load();
      const cb = vi.fn();
      store.onChange(cb);
      await store.upsertScript(script({ id: 'a' }));
      await flush();
      expect(area.listenerCount).toBeGreaterThan(0);
      expect(cb).toHaveBeenCalledTimes(1);
    });
  });

  describe('write serialization', () => {
    it('applies two interleaved patches without losing either', async () => {
      const { area, store } = setup();
      await store.upsertScript(script({ id: 'a' }));
      area.latencyMs = 5;
      const [p1, p2] = await Promise.all([
        store.patchScript('a', { name: 'renamed' }),
        store.patchScript('a', { priority: 5 }),
      ]);
      expect(p1.name).toBe('renamed');
      expect(p2).toMatchObject({ name: 'renamed', priority: 5 });
      const stored = (area.data.scripts as SiteScript[])[0];
      expect(stored).toMatchObject({ name: 'renamed', priority: 5 });
      expect(await store.getScripts()).toEqual([stored]);
    });

    it('keeps order across mixed operations started together', async () => {
      const { area, store } = setup();
      area.latencyMs = 2;
      await Promise.all([
        store.upsertScript(script({ id: 'a' })),
        store.upsertScript(script({ id: 'b' })),
        store.setError(error({ scriptId: 'a' })),
        store.deleteScript('a'),
        store.patchSettings({ onboardingDone: true }),
      ]);
      const state = await store.load();
      expect(state.scripts.map((s) => s.id)).toEqual(['b']);
      expect(state.errors).toEqual({});
      expect(state.settings.onboardingDone).toBe(true);
      expect(area.data).toEqual(state);
    });

    it('continues after a failed write', async () => {
      const { area, store } = setup();
      await store.upsertScript(script({ id: 'a' }));
      area.failNextSet = new Error('nope');
      const failed = store.patchScript('a', { name: 'lost' });
      const ok = store.patchScript('a', { priority: 2 });
      await expect(failed).rejects.toThrow('nope');
      await expect(ok).resolves.toMatchObject({ name: 'Hide sidebar', priority: 2 });
      expect((area.data.scripts as SiteScript[])[0]).toMatchObject({ name: 'Hide sidebar', priority: 2 });
    });
  });
});
