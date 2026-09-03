import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXTENSION_ID,
  SIDEBAR_PORT_NAME,
  type SidebarEnvelope,
  type SidebarEvent,
  type SidebarRequestEnvelope,
  type SidebarState,
} from '@sitecraft/shared';
import { createBridge, NOT_REACHABLE_MESSAGE } from '../src/lib/bridge';

type Listener<T> = (arg: T) => void;

class FakeEvent<T> {
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

class FakePort {
  readonly onMessage = new FakeEvent<unknown>();
  readonly onDisconnect = new FakeEvent<undefined>();
  readonly posted: SidebarRequestEnvelope[] = [];
  disconnected = false;
  constructor(readonly name: string) {}
  postMessage(msg: unknown): void {
    this.posted.push(msg as SidebarRequestEnvelope);
  }
  disconnect(): void {
    this.disconnected = true;
  }
  reply(env: SidebarEnvelope): void {
    this.onMessage.emit(env);
  }
  drop(): void {
    this.onDisconnect.emit(undefined);
  }
}

interface FakeRuntime {
  id?: string;
  connect: ReturnType<typeof vi.fn>;
  lastError?: { message?: string };
}

const g = globalThis as unknown as { chrome?: { runtime?: FakeRuntime } };

function installChrome(opts: { id?: string; connectThrows?: string } = {}) {
  const ports: FakePort[] = [];
  const connect = vi.fn((...args: unknown[]) => {
    if (opts.connectThrows) throw new Error(opts.connectThrows);
    const info = (typeof args[0] === 'string' ? args[1] : args[0]) as { name?: string } | undefined;
    const port = new FakePort(info?.name ?? '');
    ports.push(port);
    return port;
  });
  const runtime: FakeRuntime = { id: opts.id, connect };
  g.chrome = { runtime };
  return { ports, connect, runtime };
}

const emptyState: SidebarState = {
  scripts: [],
  settings: { onboardingDone: false },
  errors: {},
  companion: { state: 'unknown' },
};

afterEach(() => {
  delete g.chrome;
  vi.useRealTimers();
});

describe('createBridge mode selection', () => {
  it('uses extension mode when chrome.runtime.id is set', async () => {
    const { connect, ports } = installChrome({ id: 'abc' });
    const bridge = createBridge();
    expect(bridge.mode).toBe('extension');
    const p = bridge.request({ type: 'getState' });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith({ name: SIDEBAR_PORT_NAME });
    const env = ports[0]!.posted[0]!;
    ports[0]!.reply({ requestId: env.requestId, ok: true, result: emptyState });
    await expect(p).resolves.toEqual(emptyState);
  });

  it('uses external mode with the stable extension id when runtime.id is missing', async () => {
    const { connect, ports } = installChrome();
    const bridge = createBridge();
    expect(bridge.mode).toBe('external');
    const p = bridge.request({ type: 'getState' });
    expect(connect).toHaveBeenCalledWith(EXTENSION_ID, { name: SIDEBAR_PORT_NAME });
    const env = ports[0]!.posted[0]!;
    ports[0]!.reply({ requestId: env.requestId, ok: true, result: emptyState });
    await expect(p).resolves.toEqual(emptyState);
  });

  it('rejects every request with a clear message when chrome.runtime is missing', async () => {
    delete g.chrome;
    const bridge = createBridge();
    expect(bridge.mode).toBe('external');
    await expect(bridge.request({ type: 'getState' })).rejects.toThrow(NOT_REACHABLE_MESSAGE);
    await expect(bridge.request({ type: 'listTabs' })).rejects.toThrow('Extension not reachable');
    expect(NOT_REACHABLE_MESSAGE).toBe(
      'Extension not reachable. Load Sitecraft and open this page from http://localhost:4173/harness/',
    );
    const off = bridge.onEvent(() => {});
    expect(() => off()).not.toThrow();
  });

  it('rejects when connect itself throws', async () => {
    installChrome({ connectThrows: 'Invalid extension id' });
    const bridge = createBridge();
    await expect(bridge.request({ type: 'getState' })).rejects.toThrow('Extension not reachable');
  });
});

describe('request and reply matching', () => {
  it('posts an envelope with a unique requestId and the request', () => {
    const { ports } = installChrome({ id: 'abc' });
    const bridge = createBridge();
    void bridge.request({ type: 'getState' }).catch(() => {});
    void bridge.request({ type: 'listTabs' }).catch(() => {});
    const [a, b] = ports[0]!.posted;
    expect(a!.request).toEqual({ type: 'getState' });
    expect(b!.request).toEqual({ type: 'listTabs' });
    expect(typeof a!.requestId).toBe('string');
    expect(a!.requestId.length).toBeGreaterThan(0);
    expect(a!.requestId).not.toBe(b!.requestId);
  });

  it('matches replies by requestId even when they arrive out of order', async () => {
    const { ports } = installChrome({ id: 'abc' });
    const bridge = createBridge();
    const first = bridge.request({ type: 'listTabs' });
    const second = bridge.request({ type: 'getDefaultTab' });
    const port = ports[0]!;
    const [envA, envB] = port.posted;
    const tab = { tabId: 1, windowId: 1, url: 'https://a.com/', title: 'A', active: true };
    port.reply({ requestId: envB!.requestId, ok: true, result: tab });
    port.reply({ requestId: envA!.requestId, ok: true, result: [tab] });
    await expect(second).resolves.toEqual(tab);
    await expect(first).resolves.toEqual([tab]);
  });

  it('ignores replies for unknown requestIds', async () => {
    const { ports } = installChrome({ id: 'abc' });
    const bridge = createBridge();
    const p = bridge.request({ type: 'getState' });
    const port = ports[0]!;
    port.reply({ requestId: 'nope', ok: true, result: null });
    port.reply({ requestId: port.posted[0]!.requestId, ok: true, result: emptyState });
    await expect(p).resolves.toEqual(emptyState);
  });

  it('rejects with the error text when the reply is not ok', async () => {
    const { ports } = installChrome({ id: 'abc' });
    const bridge = createBridge();
    const p = bridge.request({ type: 'deleteScript', id: 'x' });
    const port = ports[0]!;
    port.reply({ requestId: port.posted[0]!.requestId, ok: false, error: 'No such script' });
    await expect(p).rejects.toThrow('No such script');
  });

  it('reuses one port for many requests', () => {
    const { connect } = installChrome({ id: 'abc' });
    const bridge = createBridge();
    void bridge.request({ type: 'getState' }).catch(() => {});
    void bridge.request({ type: 'getState' }).catch(() => {});
    void bridge.request({ type: 'getState' }).catch(() => {});
    expect(connect).toHaveBeenCalledTimes(1);
  });
});

describe('events', () => {
  it('delivers events to subscribers and stops after unsubscribe', () => {
    const { ports } = installChrome({ id: 'abc' });
    const bridge = createBridge();
    const seen: SidebarEvent[] = [];
    const off = bridge.onEvent((ev) => seen.push(ev));
    const port = ports[0]!;
    const ev: SidebarEvent = { type: 'runProgress', runId: 'r1', status: 'Thinking' };
    port.reply({ event: ev });
    expect(seen).toEqual([ev]);
    off();
    port.reply({ event: { type: 'runProgress', runId: 'r1', status: 'Done' } });
    expect(seen).toHaveLength(1);
  });

  it('does not treat events as replies', async () => {
    const { ports } = installChrome({ id: 'abc' });
    const bridge = createBridge();
    const p = bridge.request({ type: 'getState' });
    const port = ports[0]!;
    port.reply({ event: { type: 'companionStatus', status: { state: 'connected' } } });
    port.reply({ requestId: port.posted[0]!.requestId, ok: true, result: emptyState });
    await expect(p).resolves.toEqual(emptyState);
  });

  it('keeps delivering to other listeners when one throws', () => {
    const { ports } = installChrome({ id: 'abc' });
    const bridge = createBridge();
    const seen: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    bridge.onEvent(() => {
      throw new Error('boom');
    });
    bridge.onEvent((ev) => seen.push(ev.type));
    ports[0]!.reply({ event: { type: 'runProgress', runId: 'r', status: 's' } });
    expect(seen).toEqual(['runProgress']);
    errSpy.mockRestore();
  });
});

describe('reconnect', () => {
  it('rejects pending requests with Disconnected and reconnects on the next request', async () => {
    const { ports, connect, runtime } = installChrome({ id: 'abc' });
    const bridge = createBridge();
    const pending = bridge.request({ type: 'getState' });
    runtime.lastError = { message: 'Receiving end does not exist.' };
    ports[0]!.drop();
    runtime.lastError = undefined;
    await expect(pending).rejects.toThrow('Disconnected');

    const next = bridge.request({ type: 'getState' });
    expect(connect).toHaveBeenCalledTimes(2);
    const port = ports[1]!;
    expect(port.posted).toHaveLength(1);
    port.reply({ requestId: port.posted[0]!.requestId, ok: true, result: emptyState });
    await expect(next).resolves.toEqual(emptyState);
  });

  it('adds the reachability hint when an external port drops before any reply', async () => {
    const { ports, runtime } = installChrome();
    const bridge = createBridge();
    expect(bridge.mode).toBe('external');
    const pending = bridge.request({ type: 'getState' });
    runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
    ports[0]!.drop();
    runtime.lastError = undefined;
    await expect(pending).rejects.toThrow('Disconnected');
    await expect(pending).rejects.toThrow('Receiving end does not exist');
    await expect(pending).rejects.toThrow(NOT_REACHABLE_MESSAGE);

    // Once the extension has answered on a port, a later drop is a plain disconnect.
    const p2 = bridge.request({ type: 'getState' });
    const port = ports[1]!;
    port.reply({ requestId: port.posted[0]!.requestId, ok: true, result: emptyState });
    await expect(p2).resolves.toEqual(emptyState);
    const p3 = bridge.request({ type: 'getState' });
    port.drop();
    await expect(p3).rejects.toThrow(/^Disconnected$/);
  });

  it('ignores late replies on a dropped port', async () => {
    const { ports } = installChrome({ id: 'abc' });
    const bridge = createBridge();
    const pending = bridge.request({ type: 'getState' });
    const old = ports[0]!;
    const env = old.posted[0]!;
    old.drop();
    await expect(pending).rejects.toThrow('Disconnected');
    expect(() => old.reply({ requestId: env.requestId, ok: true, result: emptyState })).not.toThrow();
  });

  it('reconnects on its own when there are event listeners', () => {
    vi.useFakeTimers();
    const { ports, connect } = installChrome({ id: 'abc' });
    const bridge = createBridge();
    const seen: SidebarEvent[] = [];
    bridge.onEvent((ev) => seen.push(ev));
    expect(connect).toHaveBeenCalledTimes(1);
    ports[0]!.drop();
    vi.advanceTimersByTime(5000);
    expect(connect).toHaveBeenCalledTimes(2);
    ports[1]!.reply({ event: { type: 'companionStatus', status: { state: 'connected' } } });
    expect(seen).toHaveLength(1);
  });

  it('stops reconnecting once the last listener is gone', () => {
    vi.useFakeTimers();
    const { ports, connect } = installChrome({ id: 'abc' });
    const bridge = createBridge();
    const off = bridge.onEvent(() => {});
    off();
    ports[0]!.drop();
    vi.advanceTimersByTime(10000);
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
