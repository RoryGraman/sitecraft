/**
 * Bridge: the side panel (or the dev harness page) talking to the background
 * service worker over a chrome.runtime Port.
 *
 * Envelope protocol (see shared/src/protocol.ts):
 *   send    { requestId, request }
 *   receive { requestId, ok: true, result } | { requestId, ok: false, error } | { event }
 *
 * The port is opened lazily and reopened after a disconnect (the service
 * worker restarts often). Requests that were pending on a dropped port reject
 * with 'Disconnected'.
 */

import {
  EXTENSION_ID,
  SIDEBAR_PORT_NAME,
  errorMessage,
  isEventEnvelope,
  isReplyEnvelope,
  type SidebarEvent,
  type SidebarRequest,
  type SidebarRequestEnvelope,
  type SidebarResponseFor,
} from '@sitecraft/shared';
import { newId } from './ids';

export interface Bridge {
  request<R extends SidebarRequest>(req: R): Promise<SidebarResponseFor<R>>;
  onEvent(cb: (ev: SidebarEvent) => void): () => void;
  readonly mode: 'extension' | 'external';
}

export const NOT_REACHABLE_MESSAGE =
  'Extension not reachable. Load Sitecraft and open this page from http://localhost:4173/harness/';

const RECONNECT_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 5000;

type Port = chrome.runtime.Port;
type Runtime = typeof chrome.runtime;

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
}

/** chrome.runtime as seen from this page, if any. Typed loosely so tests can install a fake. */
function getRuntime(): Runtime | undefined {
  const g = globalThis as { chrome?: { runtime?: Runtime } };
  return g.chrome?.runtime;
}

function lastErrorMessage(): string | undefined {
  try {
    return getRuntime()?.lastError?.message;
  } catch {
    return undefined;
  }
}

abstract class PortBridge implements Bridge {
  abstract readonly mode: 'extension' | 'external';

  private port: Port | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(ev: SidebarEvent) => void>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = RECONNECT_DELAY_MS;
  /** True once the current port has delivered any message. */
  private sawMessage = false;

  /** Open a port. Throws when the runtime is missing or connect fails. */
  protected abstract openPort(runtime: Runtime): Port;

  request<R extends SidebarRequest>(req: R): Promise<SidebarResponseFor<R>> {
    return new Promise<SidebarResponseFor<R>>((resolve, reject) => {
      let port: Port;
      try {
        port = this.ensurePort();
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      const requestId = newId();
      this.pending.set(requestId, {
        resolve: (value) => resolve(value as SidebarResponseFor<R>),
        reject,
      });
      const envelope: SidebarRequestEnvelope = { requestId, request: req };
      try {
        port.postMessage(envelope);
      } catch (e) {
        this.pending.delete(requestId);
        reject(new Error(`Disconnected: ${errorMessage(e)}`));
        this.dropPort(port);
      }
    });
  }

  onEvent(cb: (ev: SidebarEvent) => void): () => void {
    this.listeners.add(cb);
    // Open the port now so events flow before the first request.
    try {
      this.ensurePort();
    } catch {
      // The first request will report the problem.
    }
    return () => {
      this.listeners.delete(cb);
      if (this.listeners.size === 0) this.clearReconnectTimer();
    };
  }

  private ensurePort(): Port {
    if (this.port) return this.port;
    const runtime = getRuntime();
    if (!runtime || typeof runtime.connect !== 'function') {
      throw new Error(NOT_REACHABLE_MESSAGE);
    }
    let port: Port;
    try {
      port = this.openPort(runtime);
    } catch (e) {
      throw new Error(`${NOT_REACHABLE_MESSAGE} (${errorMessage(e)})`);
    }
    this.port = port;
    this.sawMessage = false;
    this.clearReconnectTimer();
    port.onMessage.addListener((msg: unknown) => {
      if (this.port !== port) return;
      this.sawMessage = true;
      this.handleMessage(msg);
    });
    port.onDisconnect.addListener(() => {
      if (this.port !== port) return;
      const detail = lastErrorMessage();
      this.dropPort(port, detail);
    });
    return port;
  }

  private handleMessage(msg: unknown): void {
    if (isReplyEnvelope(msg)) {
      const entry = this.pending.get(msg.requestId);
      if (!entry) return;
      this.pending.delete(msg.requestId);
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(new Error(msg.error));
      return;
    }
    if (isEventEnvelope(msg)) {
      // Successful traffic resets the reconnect backoff.
      this.reconnectDelay = RECONNECT_DELAY_MS;
      for (const cb of [...this.listeners]) {
        try {
          cb(msg.event);
        } catch (e) {
          console.error('Sitecraft bridge: event listener failed', e);
        }
      }
    }
  }

  private dropPort(port: Port, detail?: string): void {
    if (this.port === port) this.port = null;
    let message = detail ? `Disconnected: ${detail}` : 'Disconnected';
    // A web page whose port drops before any reply almost always means the
    // extension is not loaded. Say so.
    if (this.mode === 'external' && !this.sawMessage) message = `${message}. ${NOT_REACHABLE_MESSAGE}`;
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) entry.reject(new Error(message));
    if (this.listeners.size > 0) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.port || this.listeners.size === 0) return;
      try {
        this.ensurePort();
      } catch {
        this.scheduleReconnect();
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

/** Runs inside the extension (side panel page). */
export class ExtensionBridge extends PortBridge {
  readonly mode = 'extension' as const;
  protected openPort(runtime: Runtime): Port {
    return runtime.connect({ name: SIDEBAR_PORT_NAME });
  }
}

/** Runs on an ordinary web page (the dev harness) via externally_connectable. */
export class ExternalBridge extends PortBridge {
  readonly mode = 'external' as const;
  constructor(private readonly extensionId: string = EXTENSION_ID) {
    super();
  }
  protected openPort(runtime: Runtime): Port {
    return runtime.connect(this.extensionId, { name: SIDEBAR_PORT_NAME });
  }
}

/** Pick the bridge for the current page. */
export function createBridge(): Bridge {
  const runtime = getRuntime();
  if (runtime && typeof runtime.id === 'string' && runtime.id.length > 0) {
    return new ExtensionBridge();
  }
  return new ExternalBridge();
}
