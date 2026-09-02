/**
 * Run orchestration (spec section 7).
 *
 * snapshot -> companion -> validate -> save -> register -> reload -> runDone.
 * Any failure before the save leaves storage untouched and ends in a runDone
 * with ok:false. The tab helpers at the bottom talk to the content script
 * first and fall back to chrome.scripting.executeScript with the self-contained
 * functions from content/snapshot.ts.
 */

import { INSPECT_MAX_CHARS, SNAPSHOT_MAX_CHARS, matchesPattern, validateAgentOutput } from '@sitecraft/shared';
import type {
  AgentRequest,
  AgentScriptOutput,
  PageContext,
  RunOutcome,
  RunStarted,
  SidebarEvent,
  SiteScript,
} from '@sitecraft/shared';
import { newId, nowIso } from '../lib/ids';
import { elementOuterHtmlInPage, snapshotInPage, type PageInspectResult } from '../content/snapshot';
import type { NativeClient } from './native';
import type { StateStore } from './state';
import { isUserScriptsAvailable } from './userScripts';
import type { RegisterAllResult, registerAll } from './userScripts';

export type RegisterAllFn = typeof registerAll;

export interface RunStartRequest {
  tabId: number;
  text: string;
  /** Set when the user asks to modify an existing script. */
  targetScriptId?: string;
  /** Model id for this run. Unset: the companion's configured default. */
  model?: string;
}

export interface RunManagerDeps {
  store: StateStore;
  native: NativeClient;
  takeSnapshot(tabId: number): Promise<PageContext>;
  reloadTab(tabId: number): Promise<void>;
  registerAll: RegisterAllFn;
  emit(ev: SidebarEvent): void;
  /** Live outer HTML for a selector on a tab. Defaults to inspectInTab. */
  inspect?(tabId: number, selector: string): Promise<string>;
}

export interface RunManager {
  /** Validates the request, starts the run in the background and returns its id at once. */
  start(req: RunStartRequest): Promise<RunStarted>;
  /** Aborts a run. The run ends with a "Run cancelled." outcome. Unknown ids are ignored. */
  cancel(runId: string): void;
  isActive(runId: string): boolean;
}

/** Same default as lib/domSnapshot.ts. */
const DEFAULT_MAX_REPEATED_SIBLINGS = 5;

const REGISTER_ERROR_PREFIX = 'Chrome refused to register this script';

class CancelledError extends Error {
  constructor() {
    super('Run cancelled.');
    this.name = 'CancelledError';
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// userScripts sync shared by runs, router and the background entry
// ---------------------------------------------------------------------------

export interface SyncResult extends RegisterAllResult {
  /** Script ids Chrome refused, with the message. */
  failed: Record<string, string>;
}

/**
 * Registers every stored (or given) script and records a ScriptError for each
 * script in a bundle Chrome refused.
 */
export async function syncUserScripts(
  store: StateStore,
  register: RegisterAllFn,
  scripts?: SiteScript[],
): Promise<SyncResult> {
  const list = scripts ?? (await store.getScripts());
  const byId = new Map(list.map((s) => [s.id, s]));
  const failed: Record<string, string> = {};
  const writes: Promise<void>[] = [];
  const result = await register(list, (ids, message) => {
    for (const id of ids) {
      failed[id] = message;
      writes.push(
        store.setError({
          scriptId: id,
          message: `${REGISTER_ERROR_PREFIX}: ${message}`,
          url: byId.get(id)?.urlPattern ?? '',
          at: nowIso(),
        }),
      );
    }
  });
  await Promise.all(writes);
  return { ...result, failed };
}

/** How syncUserScriptsIfEmpty inspects the current registrations. Injectable for tests. */
export interface UserScriptsProbe {
  isAvailable(): boolean;
  getScripts(): Promise<{ id: string }[]>;
}

const defaultProbe: UserScriptsProbe = {
  isAvailable: isUserScriptsAvailable,
  getScripts: () => chrome.userScripts.getScripts(),
};

/**
 * Re-register the stored scripts when the worker starts and Chrome holds no
 * registrations. Turning "Allow User Scripts" on reloads the extension but
 * fires neither onInstalled nor onStartup, so without this a script the toggle
 * had suppressed stays dead until a full browser restart. It also covers a
 * restart where the toggle reset off and the user turns it back on.
 *
 * Does nothing when user scripts are unavailable (toggle off) or when Chrome
 * still holds the persistent registrations, so it never churns a working page.
 * Returns the sync result, or null when it did nothing.
 */
export async function syncUserScriptsIfEmpty(
  store: StateStore,
  register: RegisterAllFn,
  probe: UserScriptsProbe = defaultProbe,
): Promise<SyncResult | null> {
  if (!probe.isAvailable()) return null;
  let existing: { id: string }[];
  try {
    existing = await probe.getScripts();
  } catch {
    return null;
  }
  if (existing.length > 0) return null;
  return syncUserScripts(store, register);
}

// ---------------------------------------------------------------------------
// run manager
// ---------------------------------------------------------------------------

export function createRunManager(deps: RunManagerDeps): RunManager {
  const inspect = deps.inspect ?? inspectInTab;
  const active = new Map<string, AbortController>();

  function progress(runId: string, status: string): void {
    deps.emit({ type: 'runProgress', runId, status });
  }

  async function save(output: AgentScriptOutput, target: SiteScript | undefined): Promise<SiteScript> {
    if (target) {
      return deps.store.patchScript(target.id, { ...output, enabled: true, trial: true });
    }
    const now = nowIso();
    const script: SiteScript = { id: newId(), ...output, enabled: true, trial: true, createdAt: now, updatedAt: now };
    await deps.store.upsertScript(script);
    return script;
  }

  async function execute(runId: string, req: RunStartRequest, signal: AbortSignal): Promise<RunOutcome> {
    const checkCancelled = (): void => {
      if (signal.aborted) throw new CancelledError();
    };

    progress(runId, 'Reading the page.');
    const page = await deps.takeSnapshot(req.tabId);
    checkCancelled();

    const scripts = await deps.store.getScripts();
    checkCancelled();
    let target: SiteScript | undefined;
    if (req.targetScriptId !== undefined) {
      target = scripts.find((s) => s.id === req.targetScriptId);
      if (!target) throw new Error('The script to modify was not found. It may have been deleted.');
    }
    const payload: AgentRequest = {
      request: req.text,
      page,
      existingScripts: scripts.filter((s) => matchesPattern(s.urlPattern, page.url)),
    };
    if (target) payload.targetScript = target;
    if (req.model !== undefined) payload.model = req.model;

    progress(runId, 'Asking Claude.');
    const output = await deps.native.run(
      payload,
      {
        onProgress: (status) => progress(runId, status),
        inspect: (selector) => inspect(req.tabId, selector),
      },
      { signal },
    );
    checkCancelled();

    const valid = validateAgentOutput(output);
    if (!valid.ok) throw new Error(`Claude returned an invalid script: ${valid.error}`);
    // The page content is untrusted. A script may only target the site the
    // user is looking at, so a prompt-injected pattern for another site is refused.
    if (!matchesPattern(valid.value.urlPattern, page.url)) {
      throw new Error(
        `Claude returned a script for a different site. Its pattern ${valid.value.urlPattern} does not match ${page.url}. Nothing was saved.`,
      );
    }

    progress(runId, 'Saving the script.');
    const script = await save(valid.value, target);

    progress(runId, 'Applying it.');
    const sync = await syncUserScripts(deps.store, deps.registerAll, await deps.store.getScripts());
    const refused = sync.failed[script.id];
    if (refused !== undefined) {
      throw new Error(`The script was saved but ${REGISTER_ERROR_PREFIX.toLowerCase()}: ${refused}`);
    }
    if (script.kind === 'js' && sync.skipped) {
      throw new Error(
        'The script was saved but user scripts are not enabled. Turn on "Allow User Scripts" for Sitecraft at chrome://extensions, then reload the page.',
      );
    }

    progress(runId, 'Reloading the tab.');
    try {
      await deps.reloadTab(req.tabId);
    } catch (e) {
      console.warn('Sitecraft: could not reload the tab after applying a script', e);
    }
    return { ok: true, script, isUpdate: target !== undefined };
  }

  async function finish(runId: string, req: RunStartRequest, controller: AbortController): Promise<void> {
    let outcome: RunOutcome;
    try {
      outcome = await execute(runId, req, controller.signal);
    } catch (e) {
      outcome = { ok: false, error: controller.signal.aborted ? 'Run cancelled.' : errorMessage(e) };
    }
    active.delete(runId);
    deps.emit({ type: 'runDone', runId, outcome });
  }

  return {
    async start(req) {
      const text = req.text.trim();
      if (text === '') throw new Error('The request is empty. Describe what you want to change.');
      if (!Number.isInteger(req.tabId)) throw new Error('Pick a tab first.');
      const runId = newId();
      const controller = new AbortController();
      active.set(runId, controller);
      const request: RunStartRequest = { tabId: req.tabId, text };
      if (req.targetScriptId !== undefined) request.targetScriptId = req.targetScriptId;
      if (typeof req.model === 'string' && req.model.trim() !== '') request.model = req.model;
      // Start on the next macrotask so the caller's reply reaches the sidebar
      // before any event for this run does.
      setTimeout(() => {
        void finish(runId, request, controller);
      }, 0);
      return { runId };
    },

    cancel(runId) {
      active.get(runId)?.abort();
    },

    isActive(runId) {
      return active.has(runId);
    },
  };
}

// ---------------------------------------------------------------------------
// tab helpers (chrome.tabs + chrome.scripting)
// ---------------------------------------------------------------------------

/** Sitecraft can only read and customize http, https and file pages. */
export function isSupportedPageUrl(url: string | undefined): boolean {
  if (typeof url !== 'string' || url === '') return false;
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:' || protocol === 'file:';
  } catch {
    return false;
  }
}

/** Sends a message to the tab's content script. Undefined when nothing answers. */
async function sendToTab(tabId: number, message: unknown): Promise<unknown> {
  try {
    return (await chrome.tabs.sendMessage(tabId, message)) as unknown;
  } catch {
    return undefined;
  }
}

/** Runs a self-contained function in the tab's top frame and returns its result. */
async function executeInTab<Args extends unknown[], Result>(
  tabId: number,
  func: (...args: Args) => Result,
  args: Args,
): Promise<Result | undefined> {
  const results = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return results[0]?.result as Result | undefined;
}

/** Page context for a run: URL, title and trimmed DOM snapshot. */
export async function takeSnapshotFromTab(tabId: number): Promise<PageContext> {
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url;
  if (!isSupportedPageUrl(url)) {
    throw new Error('Sitecraft works on http, https and file pages only. Pick another tab.');
  }
  const fromContentScript = await sendToTab(tabId, { type: 'takeSnapshot', maxChars: SNAPSHOT_MAX_CHARS });
  let snapshot = typeof fromContentScript === 'string' ? fromContentScript : '';
  if (snapshot === '') {
    const injected = await executeInTab(tabId, snapshotInPage, [SNAPSHOT_MAX_CHARS, DEFAULT_MAX_REPEATED_SIBLINGS]);
    snapshot = typeof injected === 'string' ? injected : '';
  }
  if (snapshot === '') throw new Error('Could not read the page. Reload the tab and try again.');
  return { url: url as string, title: tab.title ?? '', snapshot };
}

function isInspectResult(value: unknown): value is PageInspectResult {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { ok?: unknown; html?: unknown; count?: unknown; error?: unknown };
  if (v.ok === true) return typeof v.html === 'string' && typeof v.count === 'number';
  if (v.ok === false) return typeof v.error === 'string';
  return false;
}

/**
 * Text for the companion's inspect_page tool: match count plus the first
 * match's trimmed outer HTML. Throws on an invalid selector.
 */
export async function inspectInTab(tabId: number, selector: string): Promise<string> {
  let result = await sendToTab(tabId, { type: 'inspect', selector, maxChars: INSPECT_MAX_CHARS });
  if (!isInspectResult(result)) {
    result = await executeInTab(tabId, elementOuterHtmlInPage, [selector, INSPECT_MAX_CHARS]);
  }
  if (!isInspectResult(result)) throw new Error('Could not inspect the page.');
  if (!result.ok) throw new Error(result.error);
  const shown = JSON.stringify(selector);
  if (result.count === 0) return `No element matches ${shown}.`;
  const verb = result.count === 1 ? 'element matches' : 'elements match';
  return `${result.count} ${verb} ${shown}. First match:\n${result.html}`;
}

/** chrome.tabs.reload as a plain function, for injection. */
export function reloadTab(tabId: number): Promise<void> {
  return chrome.tabs.reload(tabId);
}
