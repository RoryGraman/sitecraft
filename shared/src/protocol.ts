/**
 * Message protocol.
 *
 * Two channels:
 *  1. Sidebar (or dev harness page) <-> Background service worker, over a chrome.runtime Port.
 *  2. Background <-> Companion (Node), over Chrome native messaging.
 *
 * Every request carries a `requestId` string. Replies echo it back.
 */

import type {
  AgentScriptOutput,
  CompanionStatus,
  OnboardingStatus,
  Priority,
  ScriptError,
  Settings,
  SiteScript,
  TabInfo,
} from './types.js';

// ---------------------------------------------------------------------------
// Channel 1: Sidebar <-> Background
// ---------------------------------------------------------------------------

/** Name used for chrome.runtime.connect({ name }). */
export const SIDEBAR_PORT_NAME = 'sitecraft-sidebar';

export interface SidebarState {
  scripts: SiteScript[];
  settings: Settings;
  errors: Record<string, ScriptError>;
  companion: CompanionStatus;
}

export type SidebarRequest =
  | { type: 'getState' }
  | { type: 'listTabs' }
  | { type: 'getDefaultTab' }
  | {
      /**
       * The active web tab of one window, or null when that tab is not a web
       * page (chrome://, the Web Store, and so on). Without windowId the last
       * focused window is used. The side panel passes its own window id.
       */
      type: 'getActiveTab';
      windowId?: number;
    }
  | {
      /** Harness builds only: chrome.runtime.reload(). Production builds reject it. */
      type: 'devReload';
    }
  | {
      type: 'runRequest';
      tabId: number;
      text: string;
      /** Set when the user asks to modify an existing script. */
      targetScriptId?: string;
      /** Model id for this run. Unset: the companion's configured default. */
      model?: string;
    }
  | { type: 'cancelRun'; runId: string }
  | { type: 'keepScript'; id: string }
  | { type: 'undoScript'; id: string; tabId?: number }
  | { type: 'toggleScript'; id: string; enabled: boolean }
  | { type: 'setPriority'; id: string; priority: Priority }
  | { type: 'updateCode'; id: string; code: string }
  | { type: 'updateScript'; id: string; patch: Partial<Pick<SiteScript, 'name' | 'description' | 'urlPattern'>> }
  | { type: 'deleteScript'; id: string }
  | { type: 'clearError'; id: string }
  | { type: 'exportScripts' }
  | { type: 'importScripts'; json: string }
  | { type: 'checkCompanion' }
  | {
      type: 'checkOnboarding';
      /** True: skip the (paid, slow) Claude login check unless a fresh result is cached. */
      quick?: boolean;
    }
  | { type: 'setOnboardingDone'; done: boolean }
  | { type: 'reloadTab'; tabId: number }
  | { type: 'openUrl'; url: string };

export interface RunStarted {
  runId: string;
}

export type RunOutcome =
  | { ok: true; script: SiteScript; isUpdate: boolean }
  | { ok: false; error: string };

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

/** Response payload type for each request type. */
export type SidebarResponseFor<R extends SidebarRequest> = R extends { type: 'getState' }
  ? SidebarState
  : R extends { type: 'listTabs' }
    ? TabInfo[]
    : R extends { type: 'getDefaultTab' | 'getActiveTab' }
      ? TabInfo | null
      : R extends { type: 'runRequest' }
        ? RunStarted
        : R extends { type: 'exportScripts' }
          ? string
          : R extends { type: 'importScripts' }
            ? ImportResult
            : R extends { type: 'checkCompanion' }
              ? CompanionStatus
              : R extends { type: 'checkOnboarding' }
                ? OnboardingStatus
                : SidebarState;

/** Envelope sent sidebar -> background. */
export interface SidebarRequestEnvelope {
  requestId: string;
  request: SidebarRequest;
}

/** Envelope sent background -> sidebar in reply to a request. */
export type SidebarReplyEnvelope =
  | { requestId: string; ok: true; result: unknown }
  | { requestId: string; ok: false; error: string };

/**
 * Why an activeTabChanged event was sent.
 * - 'activated': the user switched tabs (tabs.onActivated).
 * - 'updated': the active tab's URL, title, or load status changed (tabs.onUpdated).
 * - 'sync': a snapshot for a side panel port that has just attached, one per window.
 * The harness moves its target only on 'activated'.
 */
export type ActiveTabReason = 'activated' | 'updated' | 'sync';

/** Unsolicited events, background -> sidebar. No requestId. */
export type SidebarEvent =
  | { type: 'stateChanged'; state: SidebarState }
  | { type: 'runProgress'; runId: string; status: string }
  | { type: 'runDone'; runId: string; outcome: RunOutcome }
  | { type: 'companionStatus'; status: CompanionStatus }
  | {
      /**
       * The active tab of a window changed, or its URL or title changed.
       * `tab` is null when the active tab is not a web page. Sent to every
       * port; each panel keeps only events for its own window. Also sent to a
       * side panel port when it attaches (reason 'sync'), so a reconnect after
       * a service worker restart brings the panel up to date.
       */
      type: 'activeTabChanged';
      windowId: number;
      tab: TabInfo | null;
      reason: ActiveTabReason;
    };

export type SidebarEnvelope = SidebarReplyEnvelope | { event: SidebarEvent };

export function isReplyEnvelope(msg: unknown): msg is SidebarReplyEnvelope {
  return typeof msg === 'object' && msg !== null && 'requestId' in msg && 'ok' in msg;
}

export function isEventEnvelope(msg: unknown): msg is { event: SidebarEvent } {
  return typeof msg === 'object' && msg !== null && 'event' in msg;
}

// ---------------------------------------------------------------------------
// Channel 2: Background <-> Companion (native messaging)
// ---------------------------------------------------------------------------

export interface PageContext {
  url: string;
  title: string;
  /** Trimmed DOM snapshot (see extension/src/lib/domSnapshot.ts). */
  snapshot: string;
}

export interface AgentRequest {
  /** The user's plain-language request. */
  request: string;
  page: PageContext;
  /** Scripts already saved for this site (matching the page URL). */
  existingScripts: SiteScript[];
  /** Set when the user wants to modify one existing script. */
  targetScript?: SiteScript;
  /** Model id picked in the panel. Overrides the companion's default for this run. */
  model?: string;
}

/** What the extension reports about itself with each ping. */
export interface ExtensionHello {
  version: string;
  userScriptsEnabled: boolean;
}

/** Extension -> Companion */
export type HostInbound =
  | {
      type: 'ping';
      requestId: string;
      /** The companion records this to disk, so the setup wizard can see the extension is loaded. */
      extension?: ExtensionHello;
    }
  | { type: 'checkAuth'; requestId: string }
  | { type: 'run'; requestId: string; payload: AgentRequest }
  | { type: 'cancel'; requestId: string }
  | { type: 'inspectResult'; requestId: string; ok: true; html: string }
  | { type: 'inspectResult'; requestId: string; ok: false; error: string };

/** Companion -> Extension */
export type HostOutbound =
  | { type: 'pong'; requestId: string; companionVersion: string; node: string }
  | { type: 'authResult'; requestId: string; ok: boolean; detail: string }
  | { type: 'progress'; requestId: string; status: string }
  | {
      type: 'inspect';
      /** A fresh id for this inspect call. The extension echoes it in inspectResult. */
      requestId: string;
      /** The run this inspect belongs to. */
      runId: string;
      selector: string;
    }
  | { type: 'result'; requestId: string; ok: true; script: AgentScriptOutput }
  | { type: 'result'; requestId: string; ok: false; error: string }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string };

/** Chrome limit: a single message from host to extension must be under 1 MB. */
export const NATIVE_MAX_MESSAGE_BYTES = 1024 * 1024;

/** Cap for the DOM snapshot sent to the agent, in characters. */
export const SNAPSHOT_MAX_CHARS = 60_000;

/** How many consecutive same-tag same-class siblings a snapshot keeps. */
export const SNAPSHOT_MAX_REPEATED_SIBLINGS = 5;

/** Cap for one inspect_page result, in characters. */
export const INSPECT_MAX_CHARS = 20_000;

// ---------------------------------------------------------------------------
// Channel 3: Page (MAIN world user script) -> Content script -> Background
// ---------------------------------------------------------------------------

/** window.postMessage payload posted by the generated JS bundle on script error. */
export interface ScriptErrorPost {
  source: 'sitecraft';
  type: 'script-error';
  scriptId: string;
  message: string;
}

/** chrome.runtime.sendMessage payloads from the content script. */
export type ContentMessage =
  | { type: 'scriptError'; scriptId: string; message: string; url: string }
  | { type: 'cssBlocked'; url: string };
