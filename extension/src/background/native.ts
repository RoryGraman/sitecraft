/**
 * Native messaging client for the companion host.
 *
 * Owns one chrome.runtime.Port to the companion. Connects lazily on the first
 * request, matches replies to requests by requestId, relays inspect calls back
 * to the current run, and drops the port after 60 s without pending requests.
 */

import { INSPECT_MAX_CHARS, NATIVE_HOST_NAME, errorMessage } from '@sitecraft/shared';
import type {
  AgentRequest,
  AgentScriptOutput,
  CompanionStatus,
  ExtensionHello,
  HostInbound,
  HostOutbound,
} from '@sitecraft/shared';

export const PING_TIMEOUT_MS = 5_000;
export const CHECK_AUTH_TIMEOUT_MS = 90_000;
export const RUN_TIMEOUT_MS = 6 * 60_000;
/** Close the port this long after the last pending request settles. */
export const IDLE_TIMEOUT_MS = 60_000;

export interface RunHooks {
  /** Called with each progress line the companion streams for this run. */
  onProgress(status: string): void;
  /** Return the live outer HTML for a selector on the run's tab. */
  inspect(selector: string): Promise<string>;
}

export interface RunOptions {
  /** Aborting sends a cancel to the companion and rejects the run with "cancelled". */
  signal?: AbortSignal;
  /** Overrides RUN_TIMEOUT_MS. */
  timeoutMs?: number;
}

export interface NativeClient {
  /**
   * Checks that the companion answers. Never rejects: transport failures
   * (not installed, forbidden, exited, timed out) come back as the status.
   */
  ping(timeoutMs?: number): Promise<CompanionStatus>;
  /**
   * Asks the companion whether the Claude login works. Never rejects:
   * transport failures resolve as { ok: false, detail }.
   */
  checkAuth(timeoutMs?: number): Promise<{ ok: boolean; detail: string }>;
  /** Runs the agent. Rejects on agent errors, disconnects, timeouts and cancel. */
  run(payload: AgentRequest, hooks: RunHooks, opts?: RunOptions): Promise<AgentScriptOutput>;
  /** Last known companion status. Self-initiated closes do not change it. */
  status(): CompanionStatus;
  onStatus(cb: (s: CompanionStatus) => void): () => void;
  /** Closes the port and rejects every pending request with "disconnected". */
  disconnect(): void;
}

export type NativeConnect = (name: string) => chrome.runtime.Port;

/** Maps the onDisconnect lastError message to a companion status. */
export function companionStatusFromDisconnect(
  message: string | undefined,
  hadPending: boolean,
): CompanionStatus {
  if (message === undefined || message === '') {
    return hadPending ? { state: 'error', detail: 'Companion disconnected.' } : { state: 'unknown' };
  }
  const lower = message.toLowerCase();
  if (lower.includes('not found')) return { state: 'not-installed', detail: message };
  if (lower.includes('forbidden')) return { state: 'forbidden', detail: message };
  return { state: 'error', detail: message };
}

/** Thrown into pending requests when the host side closes the port. */
class DisconnectError extends Error {
  override readonly name = 'DisconnectError';
}

interface Pending {
  resolve(msg: HostOutbound): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
  hooks?: RunHooks;
  cleanup?: () => void;
}

interface RequestExtras {
  hooks?: RunHooks;
  signal?: AbortSignal;
  onTimeout?: () => void;
}

function isHostOutbound(msg: unknown): msg is HostOutbound {
  return typeof msg === 'object' && msg !== null && typeof (msg as { type?: unknown }).type === 'string';
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

function readLastErrorMessage(): string | undefined {
  // Must be read inside the onDisconnect callback, or Chrome logs an unchecked error.
  if (typeof chrome === 'undefined') return undefined;
  return chrome.runtime?.lastError?.message;
}

export function createNativeClient(
  hostName: string = NATIVE_HOST_NAME,
  connect: NativeConnect = (n) => chrome.runtime.connectNative(n),
  /** What to report about the extension with each ping. Omit to send a bare ping. */
  hello?: () => ExtensionHello,
): NativeClient {
  let port: chrome.runtime.Port | null = null;
  let status: CompanionStatus = { state: 'unknown' };
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Map<string, Pending>();
  const listeners = new Set<(s: CompanionStatus) => void>();

  function setStatus(next: CompanionStatus): void {
    status = next;
    for (const cb of [...listeners]) {
      try {
        cb(next);
      } catch (e) {
        console.error('Sitecraft: companion status listener failed', e);
      }
    }
  }

  function clearIdleTimer(): void {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function scheduleIdleTimer(): void {
    clearIdleTimer();
    if (port === null) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (pending.size === 0) closePort();
    }, IDLE_TIMEOUT_MS);
  }

  /** Self-initiated close. Keeps the last known status. */
  function closePort(): void {
    const p = port;
    port = null;
    clearIdleTimer();
    if (p === null) return;
    try {
      p.disconnect();
    } catch (e) {
      console.warn('Sitecraft: port.disconnect failed', e);
    }
  }

  function ensurePort(): chrome.runtime.Port {
    if (port !== null) return port;
    const p = connect(hostName);
    port = p;
    p.onMessage.addListener((msg: unknown) => {
      if (port !== p) return;
      handleMessage(msg);
    });
    p.onDisconnect.addListener(() => {
      if (port !== p) return;
      handleDisconnect();
    });
    if (status.state !== 'connected') setStatus({ state: 'checking' });
    return p;
  }

  function safePost(msg: HostInbound): void {
    if (port === null) return;
    try {
      port.postMessage(msg);
    } catch (e) {
      console.warn('Sitecraft: postMessage to companion failed', e);
    }
  }

  /** Removes a pending entry and starts the idle timer when nothing is left. */
  function take(requestId: string): Pending | undefined {
    const entry = pending.get(requestId);
    if (!entry) return undefined;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.cleanup?.();
    if (pending.size === 0) scheduleIdleTimer();
    return entry;
  }

  function rejectAll(err: Error): void {
    const entries = [...pending.values()];
    pending.clear();
    clearIdleTimer();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.cleanup?.();
      entry.reject(err);
    }
  }

  function handleDisconnect(): void {
    const message = readLastErrorMessage();
    port = null;
    clearIdleTimer();
    const next = companionStatusFromDisconnect(message, pending.size > 0);
    setStatus(next);
    rejectAll(new DisconnectError(next.detail ?? 'Companion disconnected.'));
  }

  /** The port is unusable (a send failed). Drop it and fail everything on it. */
  function failPort(detail: string): void {
    closePort();
    setStatus({ state: 'error', detail });
    rejectAll(new DisconnectError(detail));
  }

  /** A reply of any kind proves the companion is alive. */
  function markConnected(): void {
    if (status.state === 'connected') return;
    const next: CompanionStatus = { state: 'connected' };
    if (status.companionVersion !== undefined) next.companionVersion = status.companionVersion;
    setStatus(next);
  }

  function handleMessage(msg: unknown): void {
    if (!isHostOutbound(msg)) return;
    switch (msg.type) {
      case 'log':
        console.debug(`Sitecraft companion [${msg.level}]: ${msg.message}`);
        return;
      case 'progress': {
        const hooks = pending.get(msg.requestId)?.hooks;
        if (!hooks) return;
        try {
          hooks.onProgress(msg.status);
        } catch (e) {
          console.error('Sitecraft: onProgress hook failed', e);
        }
        return;
      }
      case 'inspect':
        void handleInspect(msg);
        return;
      case 'pong': {
        const entry = take(msg.requestId);
        if (!entry) return;
        setStatus({
          state: 'connected',
          companionVersion: msg.companionVersion,
          detail: `Companion ${msg.companionVersion} on Node ${msg.node}`,
        });
        entry.resolve(msg);
        return;
      }
      case 'authResult':
      case 'result': {
        const entry = take(msg.requestId);
        if (!entry) return;
        markConnected();
        entry.resolve(msg);
        return;
      }
      default:
        return;
    }
  }

  async function handleInspect(msg: Extract<HostOutbound, { type: 'inspect' }>): Promise<void> {
    const hooks = pending.get(msg.runId)?.hooks;
    let reply: HostInbound;
    if (!hooks) {
      reply = {
        type: 'inspectResult',
        requestId: msg.requestId,
        ok: false,
        error: `No active run with id ${msg.runId}.`,
      };
    } else {
      try {
        const raw = await hooks.inspect(msg.selector);
        const html = typeof raw === 'string' ? raw : String(raw ?? '');
        reply = { type: 'inspectResult', requestId: msg.requestId, ok: true, html: html.slice(0, INSPECT_MAX_CHARS) };
      } catch (e) {
        reply = { type: 'inspectResult', requestId: msg.requestId, ok: false, error: errorMessage(e) };
      }
    }
    safePost(reply);
  }

  function request(
    msg: HostInbound & { requestId: string },
    timeoutMs: number,
    extras: RequestExtras = {},
  ): Promise<HostOutbound> {
    return new Promise<HostOutbound>((resolve, reject) => {
      let p: chrome.runtime.Port;
      try {
        p = ensurePort();
      } catch (e) {
        reject(toError(e));
        return;
      }
      clearIdleTimer();
      const id = msg.requestId;
      const timer = setTimeout(() => {
        if (!take(id)) return;
        extras.onTimeout?.();
        reject(new Error(`Companion ${msg.type} timed out after ${timeoutMs} ms.`));
      }, timeoutMs);
      const entry: Pending = { resolve, reject, timer };
      if (extras.hooks) entry.hooks = extras.hooks;
      const signal = extras.signal;
      if (signal) {
        const onAbort = (): void => {
          if (!take(id)) return;
          safePost({ type: 'cancel', requestId: id });
          reject(new Error('cancelled'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        entry.cleanup = () => signal.removeEventListener('abort', onAbort);
      }
      pending.set(id, entry);
      try {
        p.postMessage(msg);
      } catch (e) {
        take(id);
        reject(toError(e));
        failPort(errorMessage(e));
      }
    });
  }

  async function ping(timeoutMs: number = PING_TIMEOUT_MS): Promise<CompanionStatus> {
    const requestId = crypto.randomUUID();
    const msg: HostInbound = hello ? { type: 'ping', requestId, extension: hello() } : { type: 'ping', requestId };
    try {
      await request(msg, timeoutMs);
    } catch (e) {
      if (!(e instanceof DisconnectError)) {
        // Timed out or could not connect. Drop the port so a retry starts a
        // fresh host process, unless another request still needs it.
        if (pending.size === 0) closePort();
        setStatus({ state: 'error', detail: errorMessage(e) });
      }
    }
    return status;
  }

  async function checkAuth(timeoutMs: number = CHECK_AUTH_TIMEOUT_MS): Promise<{ ok: boolean; detail: string }> {
    const requestId = crypto.randomUUID();
    try {
      const res = await request({ type: 'checkAuth', requestId }, timeoutMs);
      if (res.type !== 'authResult') return { ok: false, detail: 'Unexpected reply from the companion.' };
      return { ok: res.ok, detail: res.detail };
    } catch (e) {
      return { ok: false, detail: errorMessage(e) };
    }
  }

  async function run(payload: AgentRequest, hooks: RunHooks, opts: RunOptions = {}): Promise<AgentScriptOutput> {
    if (opts.signal?.aborted) throw new Error('cancelled');
    const requestId = crypto.randomUUID();
    const timeoutMs = opts.timeoutMs ?? RUN_TIMEOUT_MS;
    const extras: RequestExtras = {
      hooks,
      onTimeout: () => safePost({ type: 'cancel', requestId }),
    };
    if (opts.signal) extras.signal = opts.signal;
    const res = await request({ type: 'run', requestId, payload }, timeoutMs, extras);
    if (res.type !== 'result') throw new Error('Unexpected reply from the companion.');
    if (!res.ok) throw new Error(res.error);
    return res.script;
  }

  function disconnect(): void {
    closePort();
    rejectAll(new Error('disconnected'));
  }

  return {
    ping,
    checkAuth,
    run,
    status: () => status,
    onStatus: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    disconnect,
  };
}
