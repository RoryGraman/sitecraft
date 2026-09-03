/**
 * Core data model. One customization = one SiteScript record.
 * Stored in chrome.storage.local by the extension.
 */

export type ScriptKind = 'css' | 'js';

export type Priority = 1 | 2 | 3 | 4 | 5;

export const PRIORITIES: readonly Priority[] = [1, 2, 3, 4, 5];

export const DEFAULT_PRIORITY: Priority = 3;

export interface SiteScript {
  id: string; // uuid
  name: string; // short label, agent-written
  description: string; // one sentence, agent-written
  urlPattern: string; // Chrome match pattern, e.g. https://www.youtube.com/*
  kind: ScriptKind;
  priority: Priority; // 1 runs first
  code: string;
  enabled: boolean;
  trial: boolean; // true until the user clicks Keep
  createdAt: string; // ISO date
  updatedAt: string; // ISO date
}

/** The agent's structured output. The extension adds id/enabled/trial/dates. */
export interface AgentScriptOutput {
  name: string;
  description: string;
  kind: ScriptKind;
  urlPattern: string;
  priority: Priority;
  code: string;
}

/** Last runtime error recorded for a script (from page-load execution). */
export interface ScriptError {
  scriptId: string;
  message: string;
  url: string;
  at: string; // ISO date
}

export interface Settings {
  onboardingDone: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  onboardingDone: false,
};

export const NATIVE_HOST_NAME = 'com.sitecraft.companion';

/** Current storage schema version. Bump when StoredState shape changes. */
export const SCHEMA_VERSION = 1;

/** Full shape of chrome.storage.local for this extension. */
export interface StoredState {
  schemaVersion: number;
  scripts: SiteScript[];
  settings: Settings;
  errors: Record<string, ScriptError>; // keyed by scriptId
}

/** Export/import file format. */
export interface ExportFile {
  format: 'sitecraft-scripts';
  version: number; // == SCHEMA_VERSION at export time
  exportedAt: string; // ISO date
  scripts: SiteScript[];
}

export interface CompanionStatus {
  state: 'unknown' | 'checking' | 'connected' | 'not-installed' | 'forbidden' | 'error';
  detail?: string;
  companionVersion?: string;
}

export interface OnboardingStatus {
  userScriptsEnabled: boolean;
  companion: CompanionStatus;
  claudeLogin: { state: 'unknown' | 'checking' | 'ok' | 'error'; detail?: string };
}

/** Models the panel offers for a run. Shown in the Chat composer. */
export const MODELS = [
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-fable-5', label: 'Fable 5' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
] as const;

export interface TabInfo {
  tabId: number;
  windowId: number;
  url: string;
  title: string;
  active: boolean;
}
