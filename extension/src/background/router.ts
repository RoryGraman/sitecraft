/**
 * Sidebar request router.
 *
 * One router serves every attached port (side panel pages and the dev harness).
 * Requests arrive as { requestId, request } envelopes and are answered with
 * { requestId, ok, result | error }. Unsolicited events ({ event }) are
 * broadcast to every port: stateChanged on every store write, companionStatus
 * on native client status changes, run events from the run manager, and
 * activeTabChanged from the tab watcher (see tabs.ts and index.ts).
 */

import { SCHEMA_VERSION, errorMessage, parseExportFile, validateSiteScript } from '@sitecraft/shared';
import type {
  ContentMessage,
  ExportFile,
  ImportResult,
  OnboardingStatus,
  SidebarEvent,
  SidebarReplyEnvelope,
  SidebarRequest,
  SidebarRequestEnvelope,
  SidebarState,
  SiteScript,
  StoredState,
  TabInfo,
} from '@sitecraft/shared';
import { nowIso } from '../lib/ids';
import type { NativeClient } from './native';
import { syncUserScripts, type RegisterAllFn, type RunManager, type RunStartRequest } from './runs';
import type { StateStore } from './state';
import { isWebTab, protocolOf, toActiveTab, toTabInfo } from './tabs';

export type PortKind = 'internal' | 'external';

/** The slice of chrome.tabs the router uses. Injected so tests need no global chrome. */
export interface TabsApi {
  query(info: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]>;
  reload(tabId: number): Promise<void>;
  create(props: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab>;
}

export interface RouterDeps {
  store: StateStore;
  native: NativeClient;
  runs: RunManager;
  registerAll: RegisterAllFn;
  isUserScriptsAvailable(): boolean;
  /** Defaults to chrome.tabs. */
  tabs?: TabsApi;
  /** Clock for the login check cache. Defaults to Date.now. */
  now?(): number;
  /** Reloads the extension. Harness builds only; production leaves it out. */
  devReload?: () => void;
}

export interface RequestContext {
  kind: PortKind;
  /** port.sender.origin, when Chrome reports one. */
  origin?: string;
}

export interface Router {
  /** Serves requests on the port until it disconnects. */
  attachPort(port: chrome.runtime.Port, kind?: PortKind): void;
  /** Handles one request. Rejects with a readable message on failure. */
  handle(req: SidebarRequest, ctx: RequestContext): Promise<unknown>;
  /** Sends an event to every attached port. */
  broadcast(ev: SidebarEvent): void;
  portCount(): number;
  /** Detaches every port and stops listening to the store and the native client. */
  dispose(): void;
}

/** A successful login check is trusted for this long. */
export const AUTH_OK_TTL_MS = 5 * 60_000;
/** A failed login check is repeated at most this often (the onboarding page polls every 2 s). */
export const AUTH_FAIL_TTL_MS = 5_000;

type AuthResult = { ok: boolean; detail: string };

function isRequestEnvelope(msg: unknown): msg is SidebarRequestEnvelope {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as { requestId?: unknown; request?: unknown };
  if (typeof m.requestId !== 'string') return false;
  return typeof m.request === 'object' && m.request !== null && typeof (m.request as { type?: unknown }).type === 'string';
}

function defaultTabs(): TabsApi {
  return {
    query: (info) => chrome.tabs.query(info),
    reload: (tabId) => chrome.tabs.reload(tabId),
    create: (props) => chrome.tabs.create(props),
  };
}

// ---------------------------------------------------------------------------
// tabs (the web-tab rule itself lives in tabs.ts)
// ---------------------------------------------------------------------------

function originOf(url: string | undefined): string | null {
  if (typeof url !== 'string' || url === '') return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function isHttpTab(tab: chrome.tabs.Tab): boolean {
  const protocol = protocolOf(tab.url);
  return protocol === 'http:' || protocol === 'https:';
}

/** Most recently active first. Falls back to the active flag when lastAccessed is missing. */
function byRecency(a: chrome.tabs.Tab, b: chrome.tabs.Tab): number {
  const la = typeof a.lastAccessed === 'number' ? a.lastAccessed : 0;
  const lb = typeof b.lastAccessed === 'number' ? b.lastAccessed : 0;
  if (la !== lb) return lb - la;
  return Number(b.active) - Number(a.active);
}

// ---------------------------------------------------------------------------
// external origins
// ---------------------------------------------------------------------------

/** Only the dev harness may connect from a web page: http on localhost or 127.0.0.1, any port. */
export function isAllowedExternalOrigin(origin: string | undefined): boolean {
  if (typeof origin !== 'string' || origin === '') return false;
  try {
    const u = new URL(origin);
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

export function createRouter(deps: RouterDeps): Router {
  const { store, native, runs } = deps;
  const tabs = deps.tabs ?? defaultTabs();
  const clock = deps.now ?? (() => Date.now());
  const ports = new Set<chrome.runtime.Port>();

  let latest: StoredState | null = null;
  let authCache: { result: AuthResult; at: number } | null = null;
  let authInFlight: Promise<AuthResult> | null = null;

  // ----- state -----

  async function currentState(): Promise<StoredState> {
    if (latest) return latest;
    latest = await store.load();
    return latest;
  }

  function toSidebarState(state: StoredState): SidebarState {
    return { scripts: state.scripts, settings: state.settings, errors: state.errors, companion: native.status() };
  }

  async function sidebarState(): Promise<SidebarState> {
    return toSidebarState(await currentState());
  }

  function sync(): Promise<unknown> {
    return syncUserScripts(store, deps.registerAll);
  }

  async function findScript(id: string): Promise<SiteScript> {
    const script = (await store.getScripts()).find((s) => s.id === id);
    if (!script) throw new Error(`Script not found: ${id}`);
    return script;
  }

  /** Applies a user edit after validating the whole resulting record. */
  async function updateValidated(id: string, patch: Partial<SiteScript>): Promise<void> {
    const existing = await findScript(id);
    const valid = validateSiteScript({ ...existing, ...patch });
    if (!valid.ok) throw new Error(valid.error);
    const clean: Partial<SiteScript> = {};
    for (const key of Object.keys(patch) as (keyof SiteScript)[]) {
      if (key === 'id' || patch[key] === undefined) continue;
      (clean as Record<string, unknown>)[key] = valid.value[key];
    }
    await store.patchScript(id, clean);
  }

  // ----- tabs -----

  async function listTabs(): Promise<TabInfo[]> {
    const all = await tabs.query({});
    return all.filter(isWebTab).map(toTabInfo);
  }

  async function getDefaultTab(ctx: RequestContext): Promise<TabInfo | null> {
    if (ctx.kind === 'internal') {
      const [activeTab] = await tabs.query({ active: true, lastFocusedWindow: true });
      if (activeTab && isWebTab(activeTab)) return toTabInfo(activeTab);
    }
    const all = await tabs.query({});
    const candidates = all.filter(isWebTab).filter((t) => {
      if (ctx.kind === 'internal') return true;
      // The harness page itself is never the target.
      return isHttpTab(t) && originOf(t.url) !== ctx.origin;
    });
    candidates.sort(byRecency);
    const best = candidates[0];
    return best ? toTabInfo(best) : null;
  }

  /** The active tab of one window, or of the last focused window. Null when it is not a web page. */
  async function getActiveTab(windowId: number | undefined): Promise<TabInfo | null> {
    const query: chrome.tabs.QueryInfo =
      typeof windowId === 'number' ? { active: true, windowId } : { active: true, lastFocusedWindow: true };
    const [activeTab] = await tabs.query(query);
    return activeTab ? toActiveTab(activeTab) : null;
  }

  // ----- import / export -----

  async function exportScripts(): Promise<string> {
    const file: ExportFile = {
      format: 'sitecraft-scripts',
      version: SCHEMA_VERSION,
      exportedAt: nowIso(),
      scripts: await store.getScripts(),
    };
    return JSON.stringify(file, null, 2);
  }

  async function importScripts(json: string): Promise<ImportResult> {
    const parsed = parseExportFile(json);
    if (!parsed.ok) throw new Error(parsed.error);
    const { file, invalid } = parsed.value;
    const merged = new Map((await store.getScripts()).map((s) => [s.id, s]));
    for (const script of file.scripts) merged.set(script.id, script);
    await store.replaceScripts([...merged.values()]);
    await sync();
    return {
      imported: file.scripts.length,
      skipped: invalid.length,
      errors: invalid.map((label) => `Skipped invalid script ${label}.`),
    };
  }

  // ----- onboarding -----

  function checkAuthCached(): Promise<AuthResult> {
    if (authCache) {
      const ttl = authCache.result.ok ? AUTH_OK_TTL_MS : AUTH_FAIL_TTL_MS;
      if (clock() - authCache.at < ttl) return Promise.resolve(authCache.result);
    }
    if (!authInFlight) {
      authInFlight = native
        .checkAuth()
        .then((result) => {
          authCache = { result, at: clock() };
          return result;
        })
        .finally(() => {
          authInFlight = null;
        });
    }
    return authInFlight;
  }

  function freshAuthOk(): boolean {
    return authCache !== null && authCache.result.ok && clock() - authCache.at < AUTH_OK_TTL_MS;
  }

  /**
   * Live status of the three onboarding checks. With `quick`, the Claude login
   * check (a real model call) runs only when a fresh success is not cached;
   * otherwise it is reported as unknown. Returning users get a fast answer.
   */
  async function checkOnboarding(quick: boolean): Promise<OnboardingStatus> {
    const userScriptsEnabled = deps.isUserScriptsAvailable();
    const companion = await native.ping();
    let claudeLogin: OnboardingStatus['claudeLogin'];
    if (companion.state !== 'connected') {
      claudeLogin = { state: 'unknown', detail: 'Waiting for the companion.' };
    } else if (quick && !freshAuthOk()) {
      claudeLogin = { state: 'unknown', detail: 'Not checked yet.' };
    } else {
      const auth = await checkAuthCached();
      claudeLogin = { state: auth.ok ? 'ok' : 'error', detail: auth.detail };
    }
    return { userScriptsEnabled, companion, claudeLogin };
  }

  // ----- dispatch -----

  async function handle(req: SidebarRequest, ctx: RequestContext): Promise<unknown> {
    switch (req.type) {
      case 'getState':
        return sidebarState();
      case 'listTabs':
        return listTabs();
      case 'getDefaultTab':
        return getDefaultTab(ctx);
      case 'getActiveTab':
        return getActiveTab(req.windowId);
      case 'devReload':
        // Harness builds only. The worker restarts and the harness page reconnects.
        if (!deps.devReload) throw new Error('Not available in this build.');
        deps.devReload();
        return sidebarState();
      case 'runRequest': {
        const start: RunStartRequest = { tabId: req.tabId, text: req.text };
        if (req.targetScriptId !== undefined) start.targetScriptId = req.targetScriptId;
        if (req.model !== undefined) start.model = req.model;
        return runs.start(start);
      }
      case 'cancelRun':
        runs.cancel(req.runId);
        return sidebarState();
      case 'keepScript':
        await findScript(req.id);
        await store.patchScript(req.id, { trial: false });
        return sidebarState();
      case 'undoScript':
        await findScript(req.id);
        await store.patchScript(req.id, { enabled: false });
        await sync();
        if (req.tabId !== undefined) {
          // The script is off either way. A closed tab is not an error.
          try {
            await tabs.reload(req.tabId);
          } catch (e) {
            console.warn('Sitecraft: could not reload the tab after undo', e);
          }
        }
        return sidebarState();
      case 'toggleScript':
        if (typeof req.enabled !== 'boolean') throw new Error('enabled must be true or false.');
        await findScript(req.id);
        await store.patchScript(req.id, { enabled: req.enabled });
        await sync();
        return sidebarState();
      case 'setPriority':
        await updateValidated(req.id, { priority: req.priority });
        await sync();
        return sidebarState();
      case 'updateCode':
        await updateValidated(req.id, { code: req.code });
        await sync();
        return sidebarState();
      case 'updateScript':
        await updateValidated(req.id, req.patch);
        await sync();
        return sidebarState();
      case 'deleteScript':
        await store.deleteScript(req.id);
        await sync();
        return sidebarState();
      case 'clearError':
        await store.clearError(req.id);
        return sidebarState();
      case 'exportScripts':
        return exportScripts();
      case 'importScripts':
        return importScripts(req.json);
      case 'checkCompanion':
        // An explicit retry: forget the cached login result too.
        authCache = null;
        return native.ping();
      case 'checkOnboarding':
        return checkOnboarding(req.quick === true);
      case 'setOnboardingDone':
        await store.patchSettings({ onboardingDone: req.done });
        return sidebarState();
      case 'reloadTab':
        await tabs.reload(req.tabId);
        return sidebarState();
      case 'openUrl':
        await tabs.create({ url: req.url });
        return sidebarState();
      default:
        throw new Error(`Unknown request type: ${String((req as { type?: unknown }).type)}`);
    }
  }

  // ----- ports -----

  function post(port: chrome.runtime.Port, msg: SidebarReplyEnvelope | { event: SidebarEvent }): void {
    if (!ports.has(port)) return;
    try {
      port.postMessage(msg);
    } catch (e) {
      // The other end is gone. onDisconnect may still fire; drop it now anyway.
      ports.delete(port);
      console.warn('Sitecraft: could not post to a sidebar port', e);
    }
  }

  async function dispatch(port: chrome.runtime.Port, env: SidebarRequestEnvelope, ctx: RequestContext): Promise<void> {
    let reply: SidebarReplyEnvelope;
    try {
      reply = { requestId: env.requestId, ok: true, result: await handle(env.request, ctx) };
    } catch (e) {
      reply = { requestId: env.requestId, ok: false, error: errorMessage(e) };
    }
    post(port, reply);
  }

  function broadcast(ev: SidebarEvent): void {
    for (const port of [...ports]) post(port, { event: ev });
  }

  /**
   * Sends the active tab of every window to a port that has just attached.
   * A side panel that reconnects after a service worker restart missed any
   * activeTabChanged broadcast in between. This snapshot brings it up to date.
   * Nothing is sent when the port dropped before the tabs were read.
   */
  async function sendActiveTabs(port: chrome.runtime.Port): Promise<void> {
    let list: chrome.tabs.Tab[];
    try {
      list = await tabs.query({ active: true });
    } catch (e) {
      console.warn('Sitecraft: could not send the active tabs', e);
      return;
    }
    for (const t of list) {
      post(port, { event: { type: 'activeTabChanged', windowId: t.windowId, tab: toActiveTab(t), reason: 'sync' } });
    }
  }

  function attachPort(port: chrome.runtime.Port, kind: PortKind = 'internal'): void {
    const ctx: RequestContext = { kind };
    if (port.sender?.origin !== undefined) ctx.origin = port.sender.origin;
    ports.add(port);
    port.onMessage.addListener((msg: unknown) => {
      if (!ports.has(port) || !isRequestEnvelope(msg)) return;
      void dispatch(port, msg, ctx);
    });
    port.onDisconnect.addListener(() => {
      ports.delete(port);
    });
    // Only the side panel follows a window. The harness picks its own target.
    if (kind === 'internal') void sendActiveTabs(port);
  }

  const unsubscribeStore = store.onChange((state) => {
    latest = state;
    broadcast({ type: 'stateChanged', state: toSidebarState(state) });
  });
  const unsubscribeNative = native.onStatus((status) => {
    broadcast({ type: 'companionStatus', status });
  });

  return {
    attachPort,
    handle,
    broadcast,
    portCount: () => ports.size,
    dispose() {
      unsubscribeStore();
      unsubscribeNative();
      ports.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// script errors reported by the content script
// ---------------------------------------------------------------------------

const MAX_ERROR_MESSAGE_CHARS = 2000;

function isScriptError(msg: unknown): msg is Extract<ContentMessage, { type: 'scriptError' }> {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as { type?: unknown; scriptId?: unknown; message?: unknown; url?: unknown };
  return m.type === 'scriptError' && typeof m.scriptId === 'string' && typeof m.message === 'string' && typeof m.url === 'string';
}

/** Records a runtime error for a known script. Returns true when stored. */
export async function handleScriptError(msg: unknown, store: StateStore): Promise<boolean> {
  if (!isScriptError(msg)) return false;
  const known = (await store.getScripts()).some((s) => s.id === msg.scriptId);
  if (!known) return false;
  await store.setError({
    scriptId: msg.scriptId,
    message: msg.message.slice(0, MAX_ERROR_MESSAGE_CHARS),
    url: msg.url,
    at: nowIso(),
  });
  return true;
}

/** Listens for scriptError messages from the content script. Returns a function that removes the listener. */
export function installScriptErrorHandler(
  store: StateStore,
  onMessage: typeof chrome.runtime.onMessage = chrome.runtime.onMessage,
): () => void {
  const listener = (msg: unknown): undefined => {
    handleScriptError(msg, store).catch((e: unknown) => {
      console.error('Sitecraft: could not record a script error', e);
    });
    return undefined;
  };
  onMessage.addListener(listener);
  return () => {
    onMessage.removeListener(listener);
  };
}
