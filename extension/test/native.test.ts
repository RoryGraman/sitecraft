import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INSPECT_MAX_CHARS, NATIVE_HOST_NAME } from '@sitecraft/shared';
import type { AgentRequest, AgentScriptOutput, HostInbound, HostOutbound } from '@sitecraft/shared';
import {
  CHECK_AUTH_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  PING_TIMEOUT_MS,
  RUN_TIMEOUT_MS,
  createNativeClient,
  type NativeClient,
} from '../src/background/native';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type MessageListener = (message: unknown, port: chrome.runtime.Port) => void;
type DisconnectListener = (port: chrome.runtime.Port) => void;

interface FakePort {
  port: chrome.runtime.Port;
  postMessage: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  sent(): HostInbound[];
  last(): HostInbound;
  emitMessage(msg: HostOutbound): void;
  emitDisconnect(errorMessage?: string): void;
}

const fakeRuntime: { lastError: { message?: string } | undefined } = { lastError: undefined };

function makeFakePort(): FakePort {
  const messageListeners = new Set<MessageListener>();
  const disconnectListeners = new Set<DisconnectListener>();
  const postMessage = vi.fn();
  const disconnect = vi.fn();
  const raw = {
    name: 'fake',
    postMessage,
    disconnect,
    onMessage: {
      addListener: (l: MessageListener) => {
        messageListeners.add(l);
      },
      removeListener: (l: MessageListener) => {
        messageListeners.delete(l);
      },
      hasListener: (l: MessageListener) => messageListeners.has(l),
    },
    onDisconnect: {
      addListener: (l: DisconnectListener) => {
        disconnectListeners.add(l);
      },
      removeListener: (l: DisconnectListener) => {
        disconnectListeners.delete(l);
      },
      hasListener: (l: DisconnectListener) => disconnectListeners.has(l),
    },
  };
  const port = raw as unknown as chrome.runtime.Port;
  const sent = (): HostInbound[] => postMessage.mock.calls.map((c) => c[0] as HostInbound);
  return {
    port,
    postMessage,
    disconnect,
    sent,
    last: () => {
      const all = sent();
      const msg = all[all.length - 1];
      if (!msg) throw new Error('nothing was sent');
      return msg;
    },
    emitMessage: (msg) => {
      for (const l of [...messageListeners]) l(msg, port);
    },
    emitDisconnect: (errorMessage) => {
      fakeRuntime.lastError = errorMessage === undefined ? undefined : { message: errorMessage };
      try {
        for (const l of [...disconnectListeners]) l(port);
      } finally {
        fakeRuntime.lastError = undefined;
      }
    },
  };
}

interface Harness {
  client: NativeClient;
  connect: ReturnType<typeof vi.fn>;
  ports: FakePort[];
  port(): FakePort;
}

function setup(hostName = NATIVE_HOST_NAME): Harness {
  const ports: FakePort[] = [];
  const connect = vi.fn((_name: string) => {
    const fp = makeFakePort();
    ports.push(fp);
    return fp.port;
  });
  const client = createNativeClient(hostName, connect);
  return {
    client,
    connect,
    ports,
    port: () => {
      const fp = ports[ports.length - 1];
      if (!fp) throw new Error('not connected');
      return fp;
    },
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const samplePayload: AgentRequest = {
  request: 'hide the sidebar',
  page: { url: 'https://example.com/', title: 'Example', snapshot: '<html></html>' },
  existingScripts: [],
};

const sampleScript: AgentScriptOutput = {
  name: 'Hide sidebar',
  description: 'Hides the sidebar.',
  kind: 'css',
  urlPattern: 'https://example.com/*',
  priority: 3,
  code: '#side { display: none }',
};

function makeHooks() {
  return {
    onProgress: vi.fn(),
    inspect: vi.fn(async (_selector: string) => '<div id="x"></div>'),
  };
}

/** Tracks whether a promise has settled without awaiting it. */
function track<T>(p: Promise<T>): { settled: () => boolean } {
  let done = false;
  p.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  return { settled: () => done };
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { chrome?: unknown }).chrome = { runtime: fakeRuntime };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createNativeClient: connection', () => {
  it('does not connect until the first request', () => {
    const { client, connect } = setup();
    expect(connect).not.toHaveBeenCalled();
    expect(client.status()).toEqual({ state: 'unknown' });
  });

  it('connects once with the host name and reuses the port', () => {
    const { client, connect, port } = setup('com.example.host');
    void client.ping();
    void client.ping();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith('com.example.host');
    expect(port().sent()).toHaveLength(2);
  });

  it('reports checking while the first ping is in flight', () => {
    const { client } = setup();
    void client.ping();
    expect(client.status().state).toBe('checking');
  });

  it('resolves ping with an error status when connect throws', async () => {
    const connect = vi.fn((_name: string): chrome.runtime.Port => {
      throw new Error('nativeMessaging permission missing');
    });
    const client = createNativeClient('x', connect);
    await expect(client.ping()).resolves.toEqual({
      state: 'error',
      detail: 'nativeMessaging permission missing',
    });
  });
});

describe('createNativeClient: ping', () => {
  it('sends a ping with a uuid requestId and resolves connected on pong', async () => {
    const { client, port } = setup();
    const p = client.ping();
    const msg = port().last();
    expect(msg.type).toBe('ping');
    expect(msg.requestId).toMatch(UUID_RE);
    port().emitMessage({ type: 'pong', requestId: msg.requestId, companionVersion: '0.1.0', node: 'v23.0.0' });
    await expect(p).resolves.toMatchObject({ state: 'connected', companionVersion: '0.1.0' });
    expect(client.status()).toMatchObject({ state: 'connected', companionVersion: '0.1.0' });
  });

  it('notifies onStatus listeners and supports unsubscribe', async () => {
    const { client, port } = setup();
    const cb = vi.fn();
    const off = client.onStatus(cb);
    const p = client.ping();
    port().emitMessage({ type: 'pong', requestId: port().last().requestId, companionVersion: '0.1.0', node: 'v23' });
    await p;
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ state: 'checking' }));
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ state: 'connected' }));
    off();
    cb.mockClear();
    port().emitDisconnect('Native host has exited.');
    expect(cb).not.toHaveBeenCalled();
  });

  it('resolves with an error status after the default 5 s timeout', async () => {
    expect(PING_TIMEOUT_MS).toBe(5_000);
    const { client } = setup();
    const p = client.ping();
    const t = track(p);
    await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS - 1);
    expect(t.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toMatchObject({ state: 'error', detail: expect.stringMatching(/timed out/) });
    expect(client.status().state).toBe('error');
  });

  it('closes the port after a ping timeout so the next ping starts fresh', async () => {
    const { client, connect, port } = setup();
    const p = client.ping();
    await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS);
    await p;
    expect(port().disconnect).toHaveBeenCalledTimes(1);
    void client.ping();
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('honours a custom timeout', async () => {
    const { client } = setup();
    const p = client.ping(100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toMatchObject({ state: 'error' });
  });

  it('keeps the port open on a ping timeout while another request is pending', async () => {
    const { client, port } = setup();
    const run = client.run(samplePayload, makeHooks());
    const runId = port().last().requestId;
    const p = client.ping();
    await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS);
    await expect(p).resolves.toMatchObject({ state: 'error' });
    expect(port().disconnect).not.toHaveBeenCalled();
    port().emitMessage({ type: 'result', requestId: runId, ok: true, script: sampleScript });
    await expect(run).resolves.toEqual(sampleScript);
  });

  it('drops the port and fails pending requests when postMessage throws', async () => {
    const { client, connect, port } = setup();
    const p1 = client.ping();
    port().emitMessage({ type: 'pong', requestId: port().last().requestId, companionVersion: '0.1.0', node: 'v23' });
    await p1;
    const auth = client.checkAuth();
    port().postMessage.mockImplementationOnce(() => {
      throw new Error('Attempting to use a disconnected port object');
    });
    const run = client.run(samplePayload, makeHooks());
    await expect(run).rejects.toThrow('disconnected port object');
    await expect(auth).resolves.toEqual({ ok: false, detail: expect.stringContaining('disconnected port object') });
    expect(port().disconnect).toHaveBeenCalledTimes(1);
    expect(client.status().state).toBe('error');
    void client.ping();
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('ignores replies for unknown requestIds', () => {
    const { client, port } = setup();
    void client.ping();
    port().emitMessage({ type: 'pong', requestId: 'nope', companionVersion: '0.1.0', node: 'v23' });
    expect(client.status().state).toBe('checking');
  });

  it('matches replies to requests by requestId', async () => {
    const { client, port } = setup();
    const p1 = client.ping();
    const id1 = port().last().requestId;
    const p2 = client.ping();
    const id2 = port().last().requestId;
    expect(id1).not.toBe(id2);
    const t1 = track(p1);
    port().emitMessage({ type: 'pong', requestId: id2, companionVersion: '0.1.0', node: 'v23' });
    await expect(p2).resolves.toMatchObject({ state: 'connected' });
    await flush();
    expect(t1.settled()).toBe(false);
    port().emitMessage({ type: 'pong', requestId: id1, companionVersion: '0.1.0', node: 'v23' });
    await expect(p1).resolves.toMatchObject({ state: 'connected' });
  });
});

describe('createNativeClient: checkAuth', () => {
  it('resolves with the authResult payload', async () => {
    const { client, port } = setup();
    const p = client.checkAuth();
    const msg = port().last();
    expect(msg.type).toBe('checkAuth');
    port().emitMessage({ type: 'authResult', requestId: msg.requestId, ok: true, detail: 'Logged in.' });
    await expect(p).resolves.toEqual({ ok: true, detail: 'Logged in.' });
  });

  it('resolves ok:false after the default 90 s timeout', async () => {
    expect(CHECK_AUTH_TIMEOUT_MS).toBe(90_000);
    const { client } = setup();
    const p = client.checkAuth();
    const t = track(p);
    await vi.advanceTimersByTimeAsync(CHECK_AUTH_TIMEOUT_MS - 1);
    expect(t.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toEqual({ ok: false, detail: expect.stringMatching(/timed out/) });
  });
});

describe('createNativeClient: run', () => {
  it('sends the payload and resolves with the script on a successful result', async () => {
    const { client, port } = setup();
    const hooks = makeHooks();
    const p = client.run(samplePayload, hooks);
    const msg = port().last();
    expect(msg).toEqual({ type: 'run', requestId: expect.stringMatching(UUID_RE), payload: samplePayload });
    port().emitMessage({ type: 'result', requestId: msg.requestId, ok: true, script: sampleScript });
    await expect(p).resolves.toEqual(sampleScript);
  });

  it('marks the companion connected after a successful result without a prior pong', async () => {
    const { client, port } = setup();
    const p = client.run(samplePayload, makeHooks());
    expect(client.status().state).toBe('checking');
    port().emitMessage({ type: 'result', requestId: port().last().requestId, ok: true, script: sampleScript });
    await p;
    expect(client.status().state).toBe('connected');
  });

  it('rejects with the companion error on a failed result', async () => {
    const { client, port } = setup();
    const p = client.run(samplePayload, makeHooks());
    port().emitMessage({ type: 'result', requestId: port().last().requestId, ok: false, error: 'Agent gave up.' });
    await expect(p).rejects.toThrow('Agent gave up.');
  });

  it('forwards progress to hooks.onProgress for that run only', () => {
    const { client, port } = setup();
    const hooks1 = makeHooks();
    const hooks2 = makeHooks();
    void client.run(samplePayload, hooks1);
    const id1 = port().last().requestId;
    void client.run(samplePayload, hooks2);
    const id2 = port().last().requestId;
    port().emitMessage({ type: 'progress', requestId: id2, status: 'Reading the page' });
    expect(hooks2.onProgress).toHaveBeenCalledWith('Reading the page');
    expect(hooks1.onProgress).not.toHaveBeenCalled();
    port().emitMessage({ type: 'progress', requestId: id1, status: 'Writing CSS' });
    expect(hooks1.onProgress).toHaveBeenCalledWith('Writing CSS');
  });

  it('answers inspect requests through hooks.inspect', async () => {
    const { client, port } = setup();
    const hooks = makeHooks();
    void client.run(samplePayload, hooks);
    const runId = port().last().requestId;
    port().emitMessage({ type: 'inspect', requestId: 'insp-1', runId, selector: '#x' });
    await flush();
    expect(hooks.inspect).toHaveBeenCalledWith('#x');
    expect(port().sent()).toContainEqual({
      type: 'inspectResult',
      requestId: 'insp-1',
      ok: true,
      html: '<div id="x"></div>',
    });
  });

  it('caps inspect html at INSPECT_MAX_CHARS', async () => {
    const { client, port } = setup();
    const hooks = makeHooks();
    hooks.inspect.mockResolvedValue('a'.repeat(INSPECT_MAX_CHARS + 500));
    void client.run(samplePayload, hooks);
    const runId = port().last().requestId;
    port().emitMessage({ type: 'inspect', requestId: 'insp-2', runId, selector: 'body' });
    await flush();
    const reply = port().last();
    expect(reply.type).toBe('inspectResult');
    if (reply.type !== 'inspectResult' || !reply.ok) throw new Error('expected ok inspectResult');
    expect(reply.html).toHaveLength(INSPECT_MAX_CHARS);
  });

  it('replies ok:false when hooks.inspect throws', async () => {
    const { client, port } = setup();
    const hooks = makeHooks();
    hooks.inspect.mockRejectedValue(new Error('no such element'));
    void client.run(samplePayload, hooks);
    const runId = port().last().requestId;
    port().emitMessage({ type: 'inspect', requestId: 'insp-3', runId, selector: '#nope' });
    await flush();
    expect(port().sent()).toContainEqual({
      type: 'inspectResult',
      requestId: 'insp-3',
      ok: false,
      error: 'no such element',
    });
  });

  it('replies ok:false for an unknown runId', async () => {
    const { client, port } = setup();
    void client.run(samplePayload, makeHooks());
    port().emitMessage({ type: 'inspect', requestId: 'insp-4', runId: 'not-a-run', selector: '#x' });
    await flush();
    expect(port().sent()).toContainEqual({
      type: 'inspectResult',
      requestId: 'insp-4',
      ok: false,
      error: expect.stringContaining('not-a-run'),
    });
  });

  it('rejects after the default 6 minute timeout and sends cancel', async () => {
    expect(RUN_TIMEOUT_MS).toBe(6 * 60_000);
    const { client, port } = setup();
    const p = client.run(samplePayload, makeHooks());
    const requestId = port().last().requestId;
    const t = track(p);
    await vi.advanceTimersByTimeAsync(RUN_TIMEOUT_MS - 1);
    expect(t.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).rejects.toThrow(/timed out/);
    expect(port().sent()).toContainEqual({ type: 'cancel', requestId });
  });

  it('honours opts.timeoutMs', async () => {
    const { client } = setup();
    const p = client.run(samplePayload, makeHooks(), { timeoutMs: 1_000 });
    const rejected = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
  });

  it('cancels through opts.signal', async () => {
    const { client, port } = setup();
    const ac = new AbortController();
    const p = client.run(samplePayload, makeHooks(), { signal: ac.signal });
    const requestId = port().last().requestId;
    ac.abort();
    await expect(p).rejects.toThrow('cancelled');
    expect(port().sent()).toContainEqual({ type: 'cancel', requestId });
  });

  it('rejects at once when the signal is already aborted', async () => {
    const { client, connect } = setup();
    const ac = new AbortController();
    ac.abort();
    await expect(client.run(samplePayload, makeHooks(), { signal: ac.signal })).rejects.toThrow('cancelled');
    expect(connect).not.toHaveBeenCalled();
  });

  it('ignores a result that arrives after cancel', async () => {
    const { client, port } = setup();
    const ac = new AbortController();
    const p = client.run(samplePayload, makeHooks(), { signal: ac.signal });
    const requestId = port().last().requestId;
    ac.abort();
    await expect(p).rejects.toThrow('cancelled');
    expect(() =>
      port().emitMessage({ type: 'result', requestId, ok: true, script: sampleScript }),
    ).not.toThrow();
  });
});

describe('createNativeClient: disconnect from the host side', () => {
  it.each([
    ['Specified native messaging host not found.', 'not-installed'],
    ['Access to the specified native messaging host is forbidden.', 'forbidden'],
    ['Native host has exited.', 'error'],
    ['Failed to start native messaging host.', 'error'],
    ['Error when communicating with the native messaging host.', 'error'],
  ])('maps "%s" to %s', async (message, state) => {
    const { client, port } = setup();
    const p = client.ping();
    port().emitDisconnect(message);
    await expect(p).resolves.toEqual({ state, detail: message });
    expect(client.status()).toEqual({ state, detail: message });
  });

  it('rejects every pending request with the disconnect message', async () => {
    const { client, port } = setup();
    const ping = client.ping();
    const run = client.run(samplePayload, makeHooks());
    const auth = client.checkAuth();
    port().emitDisconnect('Native host has exited.');
    await expect(ping).resolves.toEqual({ state: 'error', detail: 'Native host has exited.' });
    await expect(run).rejects.toThrow('Native host has exited.');
    await expect(auth).resolves.toEqual({ ok: false, detail: 'Native host has exited.' });
  });

  it('sets unknown on a disconnect while idle with no error', async () => {
    const { client, port } = setup();
    const p = client.ping();
    port().emitMessage({ type: 'pong', requestId: port().last().requestId, companionVersion: '0.1.0', node: 'v23' });
    await p;
    expect(client.status().state).toBe('connected');
    port().emitDisconnect();
    expect(client.status()).toEqual({ state: 'unknown' });
  });

  it('sets error on a disconnect with pending requests and no error message', async () => {
    const { client, port } = setup();
    const p = client.run(samplePayload, makeHooks());
    port().emitDisconnect();
    await expect(p).rejects.toThrow();
    expect(client.status().state).toBe('error');
  });

  it('reconnects on the next request after a disconnect', async () => {
    const { client, connect, ports, port } = setup();
    const p = client.ping();
    port().emitDisconnect('Native host has exited.');
    await p;
    void client.ping();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(ports).toHaveLength(2);
  });

  it('ignores events from a stale port', async () => {
    const { client, ports, port } = setup();
    const p = client.ping();
    port().emitDisconnect('Native host has exited.');
    await p;
    const p2 = client.ping();
    const id2 = port().last().requestId;
    const t2 = track(p2);
    const stale = ports[0];
    if (!stale) throw new Error('missing first port');
    stale.emitMessage({ type: 'pong', requestId: id2, companionVersion: '0.1.0', node: 'v23' });
    await flush();
    expect(t2.settled()).toBe(false);
    stale.emitDisconnect('Native host has exited.');
    await flush();
    expect(t2.settled()).toBe(false);
    expect(client.status().state).toBe('checking');
  });
});

describe('createNativeClient: idle timer and disconnect()', () => {
  it('disconnects the port 60 s after the last request settles', async () => {
    expect(IDLE_TIMEOUT_MS).toBe(60_000);
    const { client, connect, port } = setup();
    const cb = vi.fn();
    const p = client.ping();
    port().emitMessage({ type: 'pong', requestId: port().last().requestId, companionVersion: '0.1.0', node: 'v23' });
    await p;
    client.onStatus(cb);
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1);
    expect(port().disconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(port().disconnect).toHaveBeenCalledTimes(1);
    // Last known status is kept and no status event fires for a self-initiated close.
    expect(client.status().state).toBe('connected');
    expect(cb).not.toHaveBeenCalled();
    void client.ping();
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('does not disconnect while a request is pending', async () => {
    const { client, port } = setup();
    const p1 = client.ping();
    port().emitMessage({ type: 'pong', requestId: port().last().requestId, companionVersion: '0.1.0', node: 'v23' });
    await p1;
    await vi.advanceTimersByTimeAsync(30_000);
    const p2 = client.checkAuth();
    const id2 = port().last().requestId;
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
    expect(port().disconnect).not.toHaveBeenCalled();
    port().emitMessage({ type: 'authResult', requestId: id2, ok: true, detail: 'ok' });
    await p2;
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1);
    expect(port().disconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(port().disconnect).toHaveBeenCalledTimes(1);
  });

  it('disconnect() closes the port and rejects pending requests', async () => {
    const { client, connect, port } = setup();
    const p = client.run(samplePayload, makeHooks());
    client.disconnect();
    expect(port().disconnect).toHaveBeenCalledTimes(1);
    await expect(p).rejects.toThrow(/disconnected/);
    void client.ping();
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('disconnect() before any connection is a no-op', () => {
    const { client, connect } = setup();
    expect(() => client.disconnect()).not.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('createNativeClient: log', () => {
  it('writes companion log messages to console.debug', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const { client, port } = setup();
    void client.ping();
    port().emitMessage({ type: 'log', level: 'info', message: 'hello from the host' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.join(' ')).toContain('hello from the host');
  });
});
