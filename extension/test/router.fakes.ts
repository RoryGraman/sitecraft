/**
 * Shared fakes for the background tests (runs, router, css).
 * Not a test file: vitest only picks up *.test.ts.
 */

import { vi } from 'vitest';
import type { CompanionStatus, SiteScript } from '@sitecraft/shared';
import type { NativeClient } from '../src/background/native';

type Listener<T> = (arg: T) => void;

export class FakeEvent<T> {
  readonly listeners = new Set<Listener<T>>();
  addListener = (l: Listener<T>): void => {
    this.listeners.add(l);
  };
  removeListener = (l: Listener<T>): void => {
    this.listeners.delete(l);
  };
  hasListener = (l: Listener<T>): boolean => this.listeners.has(l);
  emit(value: T): void {
    for (const l of [...this.listeners]) l(value);
  }
}

/** Like FakeEvent, for listeners that take several arguments (tabs.onUpdated). */
export class FakeArgsEvent<A extends unknown[]> {
  readonly listeners = new Set<(...args: A) => void>();
  addListener = (l: (...args: A) => void): void => {
    this.listeners.add(l);
  };
  removeListener = (l: (...args: A) => void): void => {
    this.listeners.delete(l);
  };
  hasListener = (l: (...args: A) => void): boolean => this.listeners.has(l);
  emit(...args: A): void {
    for (const l of [...this.listeners]) l(...args);
  }
}

type Changes = Record<string, chrome.storage.StorageChange>;
type ChangeListener = (changes: Changes, areaName: string) => void;

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/** In-memory stand-in for chrome.storage.local. */
export class FakeStorageArea {
  data: Record<string, unknown> = {};
  private listeners = new Set<ChangeListener>();

  onChanged = {
    addListener: (cb: ChangeListener): void => {
      this.listeners.add(cb);
    },
    removeListener: (cb: ChangeListener): void => {
      this.listeners.delete(cb);
    },
    hasListener: (cb: ChangeListener): boolean => this.listeners.has(cb),
  };

  async get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> {
    if (keys === undefined || keys === null) return clone(this.data);
    const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    const out: Record<string, unknown> = {};
    if (!Array.isArray(keys) && typeof keys === 'object') Object.assign(out, clone(keys));
    for (const k of list) if (k in this.data) out[k] = clone(this.data[k]);
    return out;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    const changes: Changes = {};
    for (const [k, v] of Object.entries(items)) {
      changes[k] = { oldValue: clone(this.data[k]), newValue: clone(v) };
      this.data[k] = clone(v);
    }
    this.emit(changes);
  }

  async remove(keys: string | string[]): Promise<void> {
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
    const changes: Changes = {};
    for (const [k, v] of Object.entries(this.data)) changes[k] = { oldValue: clone(v) };
    this.data = {};
    this.emit(changes);
  }

  private emit(changes: Changes): void {
    if (Object.keys(changes).length === 0) return;
    for (const cb of [...this.listeners]) cb(changes, 'local');
  }

  asArea(): chrome.storage.StorageArea {
    return this as unknown as chrome.storage.StorageArea;
  }

  scripts(): SiteScript[] {
    return (this.data.scripts as SiteScript[] | undefined) ?? [];
  }
}

/** A chrome.runtime.Port as seen from the background side. */
export class FakePort {
  readonly onMessage = new FakeEvent<unknown>();
  readonly onDisconnect = new FakeEvent<undefined>();
  readonly posted: unknown[] = [];
  disconnected = false;
  sender: chrome.runtime.MessageSender | undefined;

  constructor(
    readonly name: string,
    sender?: chrome.runtime.MessageSender,
  ) {
    this.sender = sender;
  }

  postMessage(msg: unknown): void {
    if (this.disconnected) throw new Error('Attempting to use a disconnected port object');
    this.posted.push(msg);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  /** Simulate a message from the other end. */
  receive(msg: unknown): void {
    this.onMessage.emit(msg);
  }

  /** Simulate the other end going away. */
  drop(): void {
    this.disconnected = true;
    this.onDisconnect.emit(undefined);
  }

  asPort(): chrome.runtime.Port {
    return this as unknown as chrome.runtime.Port;
  }
}

let counter = 0;

export function resetIds(): void {
  counter = 0;
}

export function mkScript(overrides: Partial<SiteScript> = {}): SiteScript {
  counter += 1;
  const now = `2026-01-01T00:00:${String(counter).padStart(2, '0')}.000Z`;
  return {
    id: `id-${counter}`,
    name: `Script ${counter}`,
    description: 'A test script.',
    urlPattern: 'https://a.com/*',
    kind: 'js',
    priority: 3,
    code: "console.log('hi')",
    enabled: true,
    trial: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export interface FakeNative extends NativeClient {
  setStatus(s: CompanionStatus): void;
  ping: ReturnType<typeof vi.fn<NativeClient['ping']>>;
  checkAuth: ReturnType<typeof vi.fn<NativeClient['checkAuth']>>;
  run: ReturnType<typeof vi.fn<NativeClient['run']>>;
}

export function fakeNative(initial: CompanionStatus = { state: 'unknown' }): FakeNative {
  let status = initial;
  const listeners = new Set<(s: CompanionStatus) => void>();
  const native: FakeNative = {
    ping: vi.fn<NativeClient['ping']>(async () => status),
    checkAuth: vi.fn<NativeClient['checkAuth']>(async () => ({ ok: true, detail: 'Logged in.' })),
    run: vi.fn<NativeClient['run']>(async () => {
      throw new Error('run not stubbed');
    }),
    status: () => status,
    onStatus: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    disconnect: vi.fn(),
    setStatus: (s) => {
      status = s;
      for (const cb of [...listeners]) cb(s);
    },
  };
  return native;
}

/** A chrome.tabs.Tab with every required field filled in. */
export function mkTab(overrides: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab {
  return {
    id: 1,
    windowId: 1,
    index: 0,
    url: 'https://a.com/',
    title: 'A',
    active: false,
    pinned: false,
    highlighted: false,
    incognito: false,
    selected: false,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
    frozen: false,
    lastAccessed: 0,
    ...overrides,
  } as chrome.tabs.Tab;
}

/** Resolves after all currently queued microtasks and one macrotask. */
export function tick(ms = 0): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
