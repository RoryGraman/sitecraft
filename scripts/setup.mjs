/**
 * Sitecraft one-command setup.
 *
 *   ./setup            (from the repository root)
 *
 * Installs dependencies, builds the project, installs the companion, checks
 * the Claude login, then guides the two Chrome steps that no script can do:
 * Load unpacked, and Allow User Scripts. You do each step in the browser and
 * press Enter; the wizard reads the browser profile to confirm it.
 *
 * Safe to run again at any time. Finished steps are detected and skipped.
 * No dependencies: this file runs before `pnpm install`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  BROWSER_APPS,
  DETAILS_URL,
  EXTENSIONS_URL,
  EXTENSION_RECORD_FILE,
  NODE_MIN_MAJOR,
  USAGE,
  browserDataDir,
  clipboardCommand,
  nodeMajor,
  openUrlCommand,
  parseSetupArgs,
  pathMatchesDist,
  readExtensionRecord,
  recordIsFresh,
  scanBrowserForExtension,
} from './setupLib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'extension', 'dist');
const CLI = path.join(ROOT, 'companion', 'bin', 'sitecraft.js');
const STARTED = Date.now();
/** The companion writes this when the extension pings it. Env override for tests. */
const RECORD = process.env.SITECRAFT_SETUP_RECORD ?? path.join(os.homedir(), '.sitecraft', EXTENSION_RECORD_FILE);

const MAX_BUFFER = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const tty = process.stdout.isTTY === true;
const paint = (code, s) => (tty ? `[${code}m${s}[0m` : s);
const green = (s) => paint('32', s);
const red = (s) => paint('31', s);
const yellow = (s) => paint('33', s);
const cyan = (s) => paint('36', s);
const bold = (s) => paint('1', s);
const dim = (s) => paint('2', s);

const OK = green('✓');
const BAD = red('✗');
const DOT = cyan('→');

function out(line = '') {
  process.stdout.write(line + '\n');
}

function heading(n, title) {
  out();
  out(bold(`${n}. ${title}`));
}

/** Blank lines that set a call to action apart from the log above it. */
function gap(lines = 8) {
  for (let i = 0; i < lines; i++) out();
}

function fatal(message, ...help) {
  out(`${BAD} ${message}`);
  for (const h of help) out(`  ${h}`);
  process.exit(1);
}

/** Run a command quietly. On failure print the output tail. */
function run(cmd, args, { cwd = ROOT, label = cmd } = {}) {
  const started = Date.now();
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (res.error || res.status !== 0) {
    out(`${BAD} ${label} failed`);
    const text = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim() || String(res.error ?? 'unknown error');
    for (const line of text.split('\n').slice(-15)) out(dim(`  ${line}`));
    process.exit(1);
  }
  out(`${OK} ${label} ${dim(`(${seconds}s)`)}`);
  return res.stdout ?? '';
}

function tryRun(cmd, args, input) {
  try {
    const res = spawnSync(cmd, args, { encoding: 'utf8', input, maxBuffer: MAX_BUFFER });
    return !res.error && res.status === 0 ? (res.stdout ?? '') : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Browser profile access
// ---------------------------------------------------------------------------

const realFs = {
  listDir(dir) {
    try {
      return readdirSync(dir);
    } catch {
      return null;
    }
  },
  readFile(file) {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  },
};

function dataDirFor(browser) {
  return process.env.SITECRAFT_SETUP_DATA_DIR ?? browserDataDir(browser, os.homedir(), process.platform);
}

function scan(browser) {
  const dir = dataDirFor(browser);
  if (dir === null) return { browserFound: false, installed: false, path: null, userScriptsEnabled: false, profile: null };
  return scanBrowserForExtension(dir, realFs, DIST);
}

/** The extension's latest hello, if the companion recorded one during this run. */
function freshRecord() {
  const rec = readExtensionRecord(realFs.readFile(RECORD));
  return rec && recordIsFresh(rec, STARTED) ? rec : null;
}

function openPage(browser, url, noOpen) {
  if (noOpen) {
    out(`  ${DOT} Open ${cyan(url)}`);
    return;
  }
  const cmd = openUrlCommand(browser, url, process.platform);
  if (cmd && tryRun(cmd[0], cmd.slice(1)) !== null) {
    out(`  ${DOT} I opened ${cyan(url)} in ${BROWSER_APPS[browser].label}.`);
  } else {
    out(`  ${DOT} Open ${cyan(url)} yourself. I could not launch the browser.`);
  }
}

function copyToClipboard(text) {
  const cmd = clipboardCommand(process.platform);
  if (!cmd) return false;
  return tryRun(cmd[0], cmd.slice(1), text) !== null;
}

// One shared reader for the whole run. `stdinEnded` guards against a closed
// stream (Ctrl+D, or a piped EOF): once closed, every read returns null at
// once, so a retry loop bails instead of spinning on empty input.
let reader = null;
let stdinEnded = false;

function getReader() {
  if (!reader) {
    reader = readline.createInterface({ input: process.stdin, output: process.stdout });
    reader.on('close', () => {
      stdinEnded = true;
    });
  }
  return reader;
}

/** Read one line. Returns the trimmed text, or null when stdin has closed. */
async function prompt(question) {
  if (stdinEnded) return null;
  try {
    return (await getReader().question(question)).trim();
  } catch {
    return null;
  }
}

/**
 * Confirm a manual step. The user does it in the browser, then presses Enter
 * and the wizard checks the profile. On a miss it shows `fail` and asks again.
 * Typing "skip" bails out. With no interactive input (piped stdin, CI, or a
 * closed stream) it stops instead of blocking or spinning.
 * Returns the state on success, 'skipped' if the user skips, null otherwise.
 */
async function confirmWhenReady(check, { instruction, fail }) {
  let state = check();
  if (state) return state;
  if (!process.stdin.isTTY) return null;
  for (;;) {
    const answer = await prompt(instruction);
    if (answer === null) return null;
    const choice = answer.toLowerCase();
    if (choice === 'go' || choice === 'g' || choice === 'skip' || choice === 's') return 'skipped';
    state = check();
    if (state) return state;
    out(`  ${yellow('•')} ${fail}`);
  }
}

/** How the loaded copy relates to this checkout's dist. */
function distStatus(state) {
  if (!state.installed) return 'absent';
  if (state.path === null) return 'unknown';
  return pathMatchesDist(state.path, DIST) ? 'match' : 'mismatch';
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function checkNode() {
  heading(1, 'Check the tools');
  const major = nodeMajor(process.version);
  if (major < NODE_MIN_MAJOR) {
    fatal(`Node ${process.version} is too old. Sitecraft needs Node ${NODE_MIN_MAJOR} or newer.`, 'Install it from https://nodejs.org and run ./setup again.');
  }
  out(`${OK} Node ${process.version}`);
}

function ensurePnpm() {
  let version = tryRun('pnpm', ['--version']);
  if (version !== null) {
    out(`${OK} pnpm ${version.trim()}`);
    return;
  }
  out(`  ${DOT} pnpm is missing. Trying corepack.`);
  tryRun('corepack', ['enable']);
  version = tryRun('pnpm', ['--version']);
  if (version === null) {
    fatal('pnpm is not available.', 'Install it with: npm install -g pnpm@9', 'Then run ./setup again.');
  }
  out(`${OK} pnpm ${version.trim()} (via corepack)`);
}

function installAndBuild() {
  heading(2, 'Build Sitecraft');
  run('pnpm', ['install'], { label: 'Dependencies installed' });
  run('pnpm', ['build'], { label: 'Extension and companion built' });
}

function installCompanion(browser) {
  heading(3, 'Install the companion');
  run(process.execPath, [CLI, 'install', '--browser', browser], { label: 'Companion installed (native messaging host)' });
  out(dim('  Chrome starts it on demand. There is no daemon to manage.'));
}

function checkClaudeLogin(skip) {
  heading(4, 'Check the Claude login');
  if (skip) {
    out(`${yellow('•')} Skipped (--skip-login).`);
    return;
  }
  out(dim('  One small request goes to Claude. This can take ~15 seconds.'));
  const res = spawnSync(process.execPath, [CLI, 'doctor'], { cwd: ROOT, encoding: 'utf8', maxBuffer: MAX_BUFFER });
  const text = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const claudeLine = text.split('\n').find((l) => l.includes('claude:') && !l.includes('checking'));
  if (res.status === 0) {
    out(`${OK} ${claudeLine?.trim() ?? 'All companion checks passed.'}`);
    return;
  }
  const fails = text.split('\n').filter((l) => l.includes('FAIL'));
  for (const line of fails) out(`${BAD} ${line.trim()}`);
  if (fails.some((l) => l.includes('claude:'))) {
    out(`  ${DOT} Run ${cyan('claude')} in a terminal, sign in, then run ${cyan('./setup')} again.`);
    out(dim('  You can also finish now; the panel has a Retry button for this check.'));
  } else {
    out(`  ${DOT} Fix the items above, then run ${cyan('./setup')} again.`);
  }
}

async function chromeSteps(browser, { skipChrome, noOpen }) {
  heading(5, `Load the extension in ${BROWSER_APPS[browser].label}`);
  if (skipChrome) {
    out(`${yellow('•')} Skipped (--skip-chrome). Manual steps:`);
    out(`  1. Open ${cyan(EXTENSIONS_URL)} and turn on Developer mode (top right).`);
    out(`  2. Click "Load unpacked" and choose ${cyan(DIST)}`);
    out(`  3. On ${cyan(DETAILS_URL)} turn on "Allow User Scripts".`);
    out(`  4. Click "Update" at the top of ${cyan(EXTENSIONS_URL)} (or the reload icon on the Sitecraft card), so the extension restarts.`);
    return 'skipped';
  }

  let state = scan(browser);
  if (!state.browserFound) {
    out(`${yellow('•')} No ${BROWSER_APPS[browser].label} profile found on this machine.`);
    out(`  ${DOT} Install the browser, then run ${cyan('./setup')} again.`);
    return false;
  }

  // Two signals, in order of trust. First: the record the companion writes
  // when the extension pings it (on load, and each time the panel opens).
  // Second: Chrome's preferences file, which is written lazily in both
  // directions. Both are advisory; the panel checklist is the final check.

  // Step A: the extension is loaded from this checkout.
  const loadCheck = () => {
    const rec = freshRecord();
    if (rec) return { source: 'companion', profile: null, userScriptsEnabled: rec.userScriptsEnabled };
    const s = scan(browser);
    return distStatus(s) === 'match' ? { ...s, source: 'profile' } : null;
  };
  let loaded = loadCheck();
  if (!loaded) {
    gap();
    if (distStatus(state) === 'mismatch') {
      out(`${yellow('•')} Chrome lists a Sitecraft loaded from another folder:`);
      out(dim(`    ${state.path}`));
      out(`  ${DOT} Remove that copy first, then load this one:`);
    } else {
      out('  In the browser:');
      out(`    1. Turn on ${bold('Developer mode')} (top right of the extensions page).`);
      out(`    2. Click ${bold('Load unpacked')} and choose:`);
    }
    const copied = copyToClipboard(DIST);
    out(`       ${cyan(DIST)}`);
    if (copied) out(dim('       The path is on your clipboard. In the picker press Cmd+Shift+G and paste.'));
    openPage(browser, EXTENSIONS_URL, noOpen);
    const found = await confirmWhenReady(loadCheck, {
      instruction: `\n\n  ${DOT} Press Enter once it shows in the list (or type "go" to continue): `,
      fail: '\nNot announced yet. Check it shows in the list, then press Enter again, or type "go".',
    });
    if (!found || found === 'skipped') {
      out(`${yellow('•')} Not confirmed. The panel checklist will confirm it.`);
      return 'unconfirmed';
    }
    loaded = found;
  }
  out(`${OK} Extension loaded ${dim(loaded.source === 'companion' ? '(it announced itself to the companion)' : `(profile: ${loaded.profile})`)}`);

  // Step B: the Allow User Scripts toggle.
  const toggleCheck = () => {
    const rec = freshRecord();
    if (rec && rec.userScriptsEnabled) return rec;
    const s = scan(browser);
    return s.userScriptsEnabled ? s : null;
  };
  if (!toggleCheck()) {
    gap();
    out('  In the browser:');
    out(`    1. Turn on ${bold('Allow User Scripts')} on the page I opened.`);
    out(`    2. Click ${bold('Update')} at the top of the extensions page (or the reload icon on the Sitecraft card).`);
    out(dim('       The switch alone does not restart the extension. Update does, and the restart reports the switch.'));
    openPage(browser, DETAILS_URL, noOpen);
    const found = await confirmWhenReady(toggleCheck, {
      instruction: `\n\n  ${DOT} Press Enter once you clicked Update (or type "go" to continue): `,
      fail: '\nThe switch still reads off. Turn it on, click Update at the top of the page, then press Enter. Or type "go".',
    });
    if (!found || found === 'skipped') {
      out(`${yellow('•')} Not confirmed. The panel checklist will confirm it.`);
      return 'unconfirmed';
    }
  }
  out(`${OK} User scripts allowed`);
  return true;
}

function summary(state) {
  const done = state === true;
  gap(6);
  if (state === 'skipped') {
    out(bold('Terminal setup is done.'));
    out('  Finish the Chrome steps above. The side panel shows a live checklist.');
    out();
    return;
  }
  if (state === 'unconfirmed') {
    out(bold('Terminal setup is done.'));
    out('  I could not confirm the Chrome steps from disk. Chrome saves that lazily.');
    out(`  Click the ${bold('Sitecraft')} icon. The panel checklist confirms the extension and the switch.`);
    out();
    return;
  }
  out(bold(done ? green('Sitecraft is ready.') : yellow('Almost there.')));
  if (done) {
    out(`  1. Open any website.`);
    out(`  2. Click the ${bold('Sitecraft')} icon (find it under the puzzle icon; pin it).`);
    out(`  3. Ask for a change: ${dim('"hide the promo banner"')}`);
  } else {
    out(`  Finish the steps above, then run ${cyan('./setup')} again.`);
    out('  The panel itself also shows a live setup checklist.');
  }
  out();
}

async function uninstall() {
  if (!existsSync(path.join(ROOT, 'companion', 'dist', 'cli.js'))) {
    ensurePnpm();
    run('pnpm', ['install'], { label: 'Dependencies installed' });
    run('pnpm', ['build'], { label: 'Built' });
  }
  const res = spawnSync(process.execPath, [CLI, 'uninstall'], { cwd: ROOT, encoding: 'utf8', maxBuffer: MAX_BUFFER });
  process.stdout.write(res.stdout ?? '');
  process.stderr.write(res.stderr ?? '');
  out('Also remove the extension on chrome://extensions if it is loaded.');
  process.exit(res.status ?? 1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const { opts, errors } = parseSetupArgs(process.argv.slice(2));
if (errors.length > 0) {
  for (const e of errors) out(`${BAD} ${e}`);
  process.exit(2);
}
if (opts.help) {
  out(USAGE);
  process.exit(0);
}
out(bold('Sitecraft setup'));
out(dim(`  ${ROOT}`));
if (opts.uninstall) {
  await uninstall();
}
checkNode();
ensurePnpm();
installAndBuild();
installCompanion(opts.browser);
checkClaudeLogin(opts.skipLogin);
const state = await chromeSteps(opts.browser, opts);
summary(state);
process.exit(state === false ? 1 : 0);
