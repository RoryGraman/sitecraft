/**
 * Pure helpers for the setup wizard (scripts/setup.mjs).
 *
 * Everything here is side-effect free and unit tested. File reads are
 * injected so tests can fake a Chrome profile on disk.
 */
import path from 'node:path';

export const EXTENSION_ID = 'hoadedohbfjjmkajibiafgoajoicjdba';

/** Browsers the wizard can guide. Same ids as the companion installer. */
export const BROWSER_APPS = {
  chrome: { label: 'Google Chrome', darwinApp: 'Google Chrome', darwinDir: 'Google/Chrome', linuxBin: 'google-chrome', linuxDir: 'google-chrome' },
  brave: { label: 'Brave', darwinApp: 'Brave Browser', darwinDir: 'BraveSoftware/Brave-Browser', linuxBin: 'brave-browser', linuxDir: 'BraveSoftware/Brave-Browser' },
  edge: { label: 'Microsoft Edge', darwinApp: 'Microsoft Edge', darwinDir: 'Microsoft Edge', linuxBin: 'microsoft-edge', linuxDir: 'microsoft-edge' },
};

export function isWizardBrowser(id) {
  return Object.prototype.hasOwnProperty.call(BROWSER_APPS, id);
}

/** The browser's user data directory, or null when the platform is unknown. */
export function browserDataDir(browser, home, platform) {
  const app = BROWSER_APPS[browser];
  if (!app) return null;
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', ...app.darwinDir.split('/'));
  if (platform === 'linux') return path.join(home, '.config', ...app.linuxDir.split('/'));
  return null;
}

/** Profile directory names inside a user data dir that can hold extensions. */
export function isProfileDirName(name) {
  return name === 'Default' || /^Profile \d+$/.test(name);
}

/**
 * What one profile says about the extension.
 * `reader(file)` returns file text or null when unreadable.
 */
export function readProfileExtensionState(profileDir, reader) {
  for (const file of ['Secure Preferences', 'Preferences']) {
    const raw = reader(path.join(profileDir, file));
    if (raw === null) continue;
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }
    const entry = data?.extensions?.settings?.[EXTENSION_ID];
    if (!entry || typeof entry !== 'object') continue;
    return {
      installed: true,
      path: typeof entry.path === 'string' ? entry.path : null,
      userScriptsEnabled: entry.user_scripts_enabled === true,
    };
  }
  return { installed: false, path: null, userScriptsEnabled: false };
}

/**
 * Scan every profile of a browser. With `distPath` given, a profile that
 * loads the extension from that folder always wins; stale installs in other
 * profiles then only serve as a fallback. Without `distPath`, a profile with
 * the toggle on wins, then any installed profile.
 * `fs` needs { listDir(dir): string[]|null, readFile(file): string|null }.
 */
export function scanBrowserForExtension(dataDir, fs, distPath) {
  const names = fs.listDir(dataDir);
  if (names === null) return { browserFound: false, installed: false, path: null, userScriptsEnabled: false, profile: null };
  let bestDist = null;
  let bestOther = null;
  for (const name of names.filter(isProfileDirName)) {
    const state = readProfileExtensionState(path.join(dataDir, name), fs.readFile);
    if (!state.installed) continue;
    const candidate = { ...state, profile: name };
    const matchesDist = distPath !== undefined && pathMatchesDist(candidate.path, distPath);
    if (matchesDist) {
      if (candidate.userScriptsEnabled) return { browserFound: true, ...candidate };
      if (!bestDist) bestDist = candidate;
    } else {
      if (distPath === undefined && candidate.userScriptsEnabled) return { browserFound: true, ...candidate };
      if (!bestOther) bestOther = candidate;
    }
  }
  const best = bestDist ?? bestOther;
  if (best) return { browserFound: true, ...best };
  return { browserFound: true, installed: false, path: null, userScriptsEnabled: false, profile: null };
}

/** File under ~/.sitecraft that the companion writes on each extension ping. */
export const EXTENSION_RECORD_FILE = 'extension.json';

/** Parse the companion's extension record. Null when missing or malformed. */
export function readExtensionRecord(text) {
  if (typeof text !== 'string') return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  if (typeof data.at !== 'string' || Number.isNaN(Date.parse(data.at))) return null;
  if (typeof data.version !== 'string' || typeof data.userScriptsEnabled !== 'boolean') return null;
  return { at: data.at, version: data.version, userScriptsEnabled: data.userScriptsEnabled };
}

/** True when the record was written at or after `sinceMs` (2 s tolerance). */
export function recordIsFresh(record, sinceMs) {
  return record !== null && Date.parse(record.at) >= sinceMs - 2000;
}

/** True when Chrome loads the extension from this checkout's dist. */
export function pathMatchesDist(loadedPath, distPath) {
  if (typeof loadedPath !== 'string' || loadedPath === '') return false;
  const norm = (p) => path.resolve(p).replace(/\/+$/, '');
  return norm(loadedPath) === norm(distPath);
}

// ---------------------------------------------------------------------------
// Command-line flags
// ---------------------------------------------------------------------------

export const USAGE = `Sitecraft setup

Usage:
  ./setup [options]           Install everything and guide the Chrome steps.

Options:
  --browser <id>    chrome (default), brave, or edge.
  --skip-chrome     Do not open or watch the browser. Print the steps only.
  --skip-login      Do not run the Claude login check.
  --no-open         Detect and wait, but never open browser pages.
  --uninstall       Remove the companion (wrapper and host manifests).
  --help            Show this help.

Safe to run again at any time. The Chrome steps are skipped when done.
`;

export function parseSetupArgs(argv) {
  const opts = { browser: 'chrome', skipChrome: false, skipLogin: false, noOpen: false, uninstall: false, help: false };
  const errors = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--skip-chrome') opts.skipChrome = true;
    else if (a === '--skip-login') opts.skipLogin = true;
    else if (a === '--no-open') opts.noOpen = true;
    else if (a === '--uninstall') opts.uninstall = true;
    else if (a === '--browser') {
      const v = argv[++i];
      if (v === undefined || !isWizardBrowser(v)) errors.push(`--browser needs one of: ${Object.keys(BROWSER_APPS).join(', ')}`);
      else opts.browser = v;
    } else if (a.startsWith('--browser=')) {
      const v = a.slice('--browser='.length);
      if (!isWizardBrowser(v)) errors.push(`--browser needs one of: ${Object.keys(BROWSER_APPS).join(', ')}`);
      else opts.browser = v;
    } else {
      errors.push(`Unknown option "${a}". Try --help.`);
    }
  }
  return { opts, errors };
}

// ---------------------------------------------------------------------------
// Version checks
// ---------------------------------------------------------------------------

/** Major version from a Node version string such as "v23.11.0". */
export function nodeMajor(version) {
  const m = /^v?(\d+)\./.exec(version);
  return m ? Number(m[1]) : 0;
}

export const NODE_MIN_MAJOR = 20;

// ---------------------------------------------------------------------------
// Platform commands
// ---------------------------------------------------------------------------

/** Command that opens a browser page, or null when unsupported. */
export function openUrlCommand(browser, url, platform) {
  const app = BROWSER_APPS[browser];
  if (!app) return null;
  if (platform === 'darwin') return ['open', '-a', app.darwinApp, url];
  if (platform === 'linux') return [app.linuxBin, url];
  return null;
}

/** Clipboard command for this platform, or null. */
export function clipboardCommand(platform) {
  if (platform === 'darwin') return ['pbcopy'];
  if (platform === 'linux') return ['xclip', '-selection', 'clipboard'];
  return null;
}

export const EXTENSIONS_URL = 'chrome://extensions/';
export const DETAILS_URL = `chrome://extensions/?id=${EXTENSION_ID}`;
