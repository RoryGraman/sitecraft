/**
 * Bundle generation.
 *
 * JS: one bundle per group of scripts that share a urlPattern. The bundle runs
 * priority levels in order (1 first). All scripts in one level run in parallel.
 * Each script is wrapped in its own try/catch. A crash is reported with
 * window.postMessage({ source: 'sitecraft', type: 'script-error', scriptId, message }, '*')
 * and does not block other scripts.
 *
 * CSS: all matching enabled CSS records concatenated, priority 1 first, so
 * later (higher-number) rules win on equal specificity.
 */

import type { SiteScript } from './types.js';

export interface JsBundle {
  /** Stable id for chrome.userScripts registration: 'sitecraft-' + short hash of urlPattern. */
  id: string;
  urlPattern: string;
  code: string;
  scriptIds: string[];
}

/**
 * Group enabled JS scripts by exact urlPattern and produce one bundle per group.
 * Disabled scripts and CSS scripts are ignored. Order of output is by urlPattern (sorted).
 */
export function buildJsBundles(scripts: SiteScript[]): JsBundle[] {
  void scripts;
  throw new Error('not implemented');
}

/**
 * Produce the runnable bundle source for one group of JS scripts.
 * Exported separately so tests can execute it directly.
 */
export function renderJsBundle(scripts: SiteScript[]): string {
  void scripts;
  throw new Error('not implemented');
}

/**
 * Concatenate enabled CSS scripts, ordered by priority (1 first), then by createdAt.
 * Each block is preceded by a comment with the script id and name.
 * Returns '' when there is nothing to inject.
 */
export function buildCssBundle(scripts: SiteScript[]): string {
  void scripts;
  throw new Error('not implemented');
}

/** Deterministic short hash (8 hex chars) of a string. FNV-1a 32-bit. */
export function shortHash(input: string): string {
  void input;
  throw new Error('not implemented');
}
