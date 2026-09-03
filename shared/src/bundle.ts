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

import { matchesPattern } from './matchPattern.js';
import { PRIORITIES, type SiteScript } from './types.js';

export interface JsBundle {
  /** Stable id for chrome.userScripts registration: 'sitecraft-' + short hash of urlPattern. */
  id: string;
  urlPattern: string;
  code: string;
  scriptIds: string[];
}

/** Prefix for chrome.userScripts registration ids. */
const BUNDLE_ID_PREFIX = 'sitecraft-';

function isActiveJs(s: SiteScript): boolean {
  return s.enabled && s.kind === 'js';
}

function isActiveCss(s: SiteScript): boolean {
  return s.enabled && s.kind === 'css';
}

/** Priority ascending (1 first), then createdAt ascending. Stable for equal keys. */
function byPriorityThenCreated(a: SiteScript, b: SiteScript): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.createdAt < b.createdAt) return -1;
  if (a.createdAt > b.createdAt) return 1;
  return 0;
}

/**
 * Group enabled JS scripts by exact urlPattern and produce one bundle per group.
 * Disabled scripts and CSS scripts are ignored. Order of output is by urlPattern (sorted).
 */
export function buildJsBundles(scripts: SiteScript[]): JsBundle[] {
  const groups = new Map<string, SiteScript[]>();
  for (const s of scripts) {
    if (!isActiveJs(s)) continue;
    const group = groups.get(s.urlPattern);
    if (group) {
      group.push(s);
    } else {
      groups.set(s.urlPattern, [s]);
    }
  }

  const patterns = [...groups.keys()].sort();
  return patterns.map((urlPattern) => {
    const ordered = [...(groups.get(urlPattern) ?? [])].sort(byPriorityThenCreated);
    return {
      id: BUNDLE_ID_PREFIX + shortHash(urlPattern),
      urlPattern,
      code: renderJsBundle(ordered),
      scriptIds: ordered.map((s) => s.id),
    };
  });
}

/**
 * Produce the runnable bundle source for one group of JS scripts.
 * Exported separately so tests can execute it directly.
 *
 * Each script becomes the body of its own async function with "use strict",
 * so script code never leaks into the page's global scope. Levels run in
 * priority order; scripts in one level run in parallel; each is awaited.
 */
export function renderJsBundle(scripts: SiteScript[]): string {
  const levels: string[] = [];
  for (const priority of PRIORITIES) {
    const entries = scripts
      .filter((s) => s.priority === priority)
      .sort(byPriorityThenCreated)
      .map(renderScriptEntry);
    if (entries.length === 0) continue;
    levels.push(`    [\n${entries.join(',\n')}\n    ]`);
  }

  return [
    '(() => {',
    '  const __report = (id, err) => {',
    "    try { window.postMessage({ source: 'sitecraft', type: 'script-error', scriptId: id, message: String(err && err.message || err) }, '*'); } catch {}",
    '  };',
    '  const __levels = [',
    levels.join(',\n'),
    '  ];',
    '  (async () => {',
    '    for (const level of __levels) {',
    '      await Promise.all(level.map(async (s) => { try { await s.run(); } catch (e) { __report(s.id, e); } }));',
    '    }',
    '  })();',
    '})();',
    '',
  ].join('\n');
}

function renderScriptEntry(s: SiteScript): string {
  // A trailing newline after the user code keeps a final line comment from
  // swallowing the closing brace.
  return [
    `      { id: ${JSON.stringify(s.id)}, name: ${JSON.stringify(s.name)}, run: async function () { "use strict";`,
    s.code,
    '      } }',
  ].join('\n');
}

/**
 * Concatenate enabled CSS scripts, ordered by priority (1 first), then by createdAt.
 * Each block is preceded by a comment with the script id and name.
 * Returns '' when there is nothing to inject.
 */
export function buildCssBundle(scripts: SiteScript[]): string {
  const ordered = scripts.filter(isActiveCss).sort(byPriorityThenCreated);
  if (ordered.length === 0) return '';
  return ordered
    .map((s) => `/* sitecraft:${s.id} ${safeCommentText(s.name)} */\n${s.code}`)
    .join('\n\n');
}

/** CSS bundle for the enabled css scripts whose pattern matches `url`. Empty when none. */
export function cssForUrl(scripts: SiteScript[], url: string): string {
  return buildCssBundle(scripts.filter((s) => isActiveCss(s) && matchesPattern(s.urlPattern, url)));
}

/** Keep a name from terminating the CSS comment that wraps it. */
function safeCommentText(text: string): string {
  return text.replace(/\*\//g, '* /');
}

/** Deterministic short hash (8 hex chars) of a string. FNV-1a 32-bit. */
export function shortHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
