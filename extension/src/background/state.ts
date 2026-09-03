/**
 * Storage state for the background service worker.
 *
 * All customization data lives in chrome.storage.local under four keys:
 * schemaVersion, scripts, settings, errors. `migrate` turns whatever is in
 * storage into a well-formed StoredState. `createStateStore` wraps a
 * StorageArea with a serialized write queue and change notifications.
 */

import {
  DEFAULT_PRIORITY,
  DEFAULT_SETTINGS,
  PRIORITIES,
  SCHEMA_VERSION,
  isRecord,
} from '@sitecraft/shared';
import type {
  Priority,
  ScriptError,
  ScriptKind,
  Settings,
  SiteScript,
  StoredState,
} from '@sitecraft/shared';
import { nowIso } from '../lib/ids';

export interface StateStore {
  /** Reads storage, applies migrations, fills defaults. Persists the result when it changed. */
  load(): Promise<StoredState>;
  getScripts(): Promise<SiteScript[]>;
  upsertScript(s: SiteScript): Promise<void>;
  /** Sets updatedAt. Throws if no script has this id. */
  patchScript(id: string, patch: Partial<SiteScript>): Promise<SiteScript>;
  deleteScript(id: string): Promise<void>;
  replaceScripts(scripts: SiteScript[]): Promise<void>;
  setError(err: ScriptError): Promise<void>;
  clearError(scriptId: string): Promise<void>;
  getSettings(): Promise<Settings>;
  patchSettings(p: Partial<Settings>): Promise<Settings>;
  /** Fires after every successful write and on external changes to the area. */
  onChange(cb: (state: StoredState) => void): () => void;
}

type StateKey = keyof StoredState;

const STATE_KEYS: readonly StateKey[] = ['schemaVersion', 'scripts', 'settings', 'errors'];

// ---------------------------------------------------------------------------
// migrate (pure)
// ---------------------------------------------------------------------------

/**
 * Normalizes raw storage contents into a StoredState.
 * Empty storage becomes defaults at SCHEMA_VERSION. Invalid scripts are
 * dropped, missing fields are filled. A newer schemaVersion is kept as is.
 */
export function migrate(raw: Record<string, unknown>): StoredState {
  const now = nowIso();
  const storedVersion = typeof raw.schemaVersion === 'number' && Number.isFinite(raw.schemaVersion) ? raw.schemaVersion : 0;
  return {
    schemaVersion: storedVersion > SCHEMA_VERSION ? storedVersion : SCHEMA_VERSION,
    scripts: normalizeScripts(raw.scripts, now),
    settings: normalizeSettings(raw.settings),
    errors: normalizeErrors(raw.errors),
  };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isKind(v: unknown): v is ScriptKind {
  return v === 'css' || v === 'js';
}

function isPriority(v: unknown): v is Priority {
  return (PRIORITIES as readonly unknown[]).includes(v);
}

function isIsoDate(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

function normalizeScript(value: unknown, now: string): SiteScript | null {
  if (!isRecord(value)) return null;
  const { id, urlPattern, code, kind } = value;
  if (!isNonEmptyString(id) || !isNonEmptyString(urlPattern) || !isNonEmptyString(code) || !isKind(kind)) {
    return null;
  }
  return {
    id,
    name: typeof value.name === 'string' ? value.name : '',
    description: typeof value.description === 'string' ? value.description : '',
    urlPattern,
    kind,
    priority: isPriority(value.priority) ? value.priority : DEFAULT_PRIORITY,
    code,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
    trial: typeof value.trial === 'boolean' ? value.trial : false,
    createdAt: isIsoDate(value.createdAt) ? value.createdAt : now,
    updatedAt: isIsoDate(value.updatedAt) ? value.updatedAt : now,
  };
}

function normalizeScripts(value: unknown, now: string): SiteScript[] {
  if (!Array.isArray(value)) return [];
  const out: SiteScript[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const script = normalizeScript(item, now);
    if (!script || seen.has(script.id)) continue;
    seen.add(script.id);
    out.push(script);
  }
  return out;
}

function normalizeSettings(value: unknown): Settings {
  const v = isRecord(value) ? value : {};
  return {
    onboardingDone: typeof v.onboardingDone === 'boolean' ? v.onboardingDone : DEFAULT_SETTINGS.onboardingDone,
  };
}

function normalizeError(value: unknown): ScriptError | null {
  if (!isRecord(value)) return null;
  const { scriptId, message, url, at } = value;
  if (!isNonEmptyString(scriptId) || typeof message !== 'string' || typeof url !== 'string' || !isIsoDate(at)) {
    return null;
  }
  return { scriptId, message, url, at };
}

function normalizeErrors(value: unknown): Record<string, ScriptError> {
  if (!isRecord(value)) return {};
  const out: Record<string, ScriptError> = {};
  for (const [key, item] of Object.entries(value)) {
    const err = normalizeError(item);
    if (err) out[key] = err;
  }
  return out;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Structural equality for JSON-like values. Key order does not matter. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = Object.keys(ra);
  if (keys.length !== Object.keys(rb).length) return false;
  return keys.every((k) => Object.prototype.hasOwnProperty.call(rb, k) && deepEqual(ra[k], rb[k]));
}

/** Copy deep enough that callers cannot mutate the store's cache. */
function snapshot(state: StoredState): StoredState {
  const errors: Record<string, ScriptError> = {};
  for (const [k, v] of Object.entries(state.errors)) errors[k] = { ...v };
  return {
    schemaVersion: state.schemaVersion,
    scripts: state.scripts.map((s) => ({ ...s })),
    settings: { ...state.settings },
    errors,
  };
}

function pickRaw(raw: Record<string, unknown>): Record<StateKey, unknown> {
  return {
    schemaVersion: raw.schemaVersion,
    scripts: raw.scripts,
    settings: raw.settings,
    errors: raw.errors,
  };
}

function withoutErrorsFor(errors: Record<string, ScriptError>, keep: (scriptId: string) => boolean) {
  const out: Record<string, ScriptError> = {};
  for (const [k, v] of Object.entries(errors)) if (keep(k)) out[k] = v;
  return out;
}

const noop = (): void => {};

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

interface WriteResult<T> {
  next: StoredState;
  keys: readonly StateKey[];
  result: T;
}

export function createStateStore(area: chrome.storage.StorageArea = chrome.storage.local): StateStore {
  let cache: StoredState | null = null;
  let chain: Promise<void> = Promise.resolve();
  const listeners = new Set<(state: StoredState) => void>();

  /** Runs tasks one at a time, in call order. A failing task does not break the queue. */
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(task);
    chain = run.then(noop, noop);
    return run;
  }

  function notify(): void {
    if (!cache || listeners.size === 0) return;
    for (const cb of [...listeners]) {
      try {
        cb(snapshot(cache));
      } catch (err) {
        console.error('sitecraft: state listener failed', err);
      }
    }
  }

  async function readRaw(): Promise<Record<string, unknown>> {
    const items = await area.get([...STATE_KEYS]);
    return isRecord(items) ? items : {};
  }

  /** Must run inside the queue. Reads, migrates, persists when needed. */
  async function loadInner(notifyOnPersist: boolean): Promise<StoredState> {
    const raw = await readRaw();
    const state = migrate(raw);
    const persist = state.schemaVersion === SCHEMA_VERSION && !deepEqual(pickRaw(raw), state);
    if (persist) await area.set({ ...state });
    cache = state;
    if (persist && notifyOnPersist) notify();
    return state;
  }

  /** Must run inside the queue. */
  function ensure(notifyOnPersist = true): Promise<StoredState> {
    return cache ? Promise.resolve(cache) : loadInner(notifyOnPersist);
  }

  function read<T>(pick: (state: StoredState) => T): Promise<T> {
    return enqueue(async () => pick(snapshot(await ensure())));
  }

  function write<T>(fn: (state: StoredState) => WriteResult<T>): Promise<T> {
    return enqueue(async () => {
      const current = await ensure(false);
      const { next, keys, result } = fn(current);
      const items: Partial<Record<StateKey, unknown>> = {};
      for (const k of keys) items[k] = next[k];
      await area.set(items);
      cache = next;
      notify();
      return result;
    });
  }

  function refreshFromArea(): Promise<void> {
    return enqueue(async () => {
      if (!cache) return; // nothing loaded yet; the first read will see the new data
      const fresh = migrate(await readRaw());
      if (deepEqual(fresh, cache)) return; // an echo of our own write
      cache = fresh;
      notify();
    });
  }

  const areaEvents = (area as Partial<chrome.storage.StorageArea>).onChanged;
  if (areaEvents && typeof areaEvents.addListener === 'function') {
    areaEvents.addListener((changes) => {
      if (!STATE_KEYS.some((k) => k in changes)) return;
      refreshFromArea().catch((err) => {
        console.error('sitecraft: failed to refresh state after storage change', err);
      });
    });
  }

  return {
    load() {
      return enqueue(async () => snapshot(await loadInner(true)));
    },

    getScripts() {
      return read((s) => s.scripts);
    },

    upsertScript(script) {
      return write((state) => {
        const copy = { ...script };
        const exists = state.scripts.some((s) => s.id === copy.id);
        const scripts = exists ? state.scripts.map((s) => (s.id === copy.id ? copy : s)) : [...state.scripts, copy];
        return { next: { ...state, scripts }, keys: ['scripts'], result: undefined };
      });
    },

    patchScript(id, patch) {
      return write((state) => {
        const existing = state.scripts.find((s) => s.id === id);
        if (!existing) throw new Error(`Script not found: ${id}`);
        const clean: Partial<SiteScript> = {};
        for (const [k, v] of Object.entries(patch)) {
          if (v !== undefined && k !== 'id') (clean as Record<string, unknown>)[k] = v;
        }
        const updated: SiteScript = { ...existing, ...clean, id: existing.id, updatedAt: nowIso() };
        const scripts = state.scripts.map((s) => (s.id === id ? updated : s));
        return { next: { ...state, scripts }, keys: ['scripts'], result: { ...updated } };
      });
    },

    deleteScript(id) {
      return write((state) => {
        const scripts = state.scripts.filter((s) => s.id !== id);
        const errors = withoutErrorsFor(state.errors, (k) => k !== id);
        return { next: { ...state, scripts, errors }, keys: ['scripts', 'errors'], result: undefined };
      });
    },

    replaceScripts(list) {
      return write((state) => {
        const scripts = list.map((s) => ({ ...s }));
        const ids = new Set(scripts.map((s) => s.id));
        const errors = withoutErrorsFor(state.errors, (k) => ids.has(k));
        return { next: { ...state, scripts, errors }, keys: ['scripts', 'errors'], result: undefined };
      });
    },

    setError(err) {
      return write((state) => {
        const errors = { ...state.errors, [err.scriptId]: { ...err } };
        return { next: { ...state, errors }, keys: ['errors'], result: undefined };
      });
    },

    clearError(scriptId) {
      return write((state) => {
        const errors = withoutErrorsFor(state.errors, (k) => k !== scriptId);
        return { next: { ...state, errors }, keys: ['errors'], result: undefined };
      });
    },

    getSettings() {
      return read((s) => s.settings);
    },

    patchSettings(patch) {
      return write((state) => {
        const settings: Settings = { ...state.settings, ...patch };
        return { next: { ...state, settings }, keys: ['settings'], result: { ...settings } };
      });
    },

    onChange(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}
