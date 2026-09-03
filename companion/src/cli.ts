/**
 * `sitecraft` command line entry.
 *
 *   sitecraft host                 native messaging host (default; Chrome
 *                                  passes chrome-extension://<id>/ as argv[2])
 *   sitecraft install [options]    write the wrapper + host manifest(s)
 *   sitecraft uninstall [options]  remove them
 *   sitecraft doctor [options]     check the install and the Claude login
 *   sitecraft --help
 *
 * In host mode nothing may be written to stdout except frames. Every other
 * mode prints plain text to stdout.
 */
import { accessSync, constants as fsConstants, existsSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTENSION_ID, errorMessage, isRecord } from '@sitecraft/shared';
import pkg from '../package.json';
import { checkClaudeLogin, runAgent, type AgentRunOptions } from './agent.js';
import { writeExtensionRecord } from './hello.js';
import { startHost } from './host.js';
import {
  BROWSER_IDS,
  hostManifestDir,
  hostManifestPath,
  install,
  isBrowserId,
  isValidExtensionId,
  parseWrapperScript,
  supportedBrowsers,
  uninstall,
  wrapperPath,
  type BrowserId,
} from './install.js';
import { createLogger, sitecraftHome, type Logger } from './log.js';

export const VERSION: string = (pkg as { version: string }).version;

const CLI_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'sitecraft.js');
const CONFIG_FILENAME = 'config.json';
const AUTH_TIMEOUT_MS = 60_000;

const USAGE = `sitecraft ${VERSION}

Usage:
  sitecraft host                      Run the native messaging host (default).
  sitecraft install [options]         Install the host for one or more browsers.
  sitecraft uninstall [options]       Remove the host manifest(s).
  sitecraft doctor [options]          Check the install and the Claude login.
  sitecraft --help                    Show this help.

Options:
  --extension-id <id>   Extension id to allow. Default: ${EXTENSION_ID}
  --browser <a,b>       Browsers: ${BROWSER_IDS.join(', ')}. Default: chrome
                        (uninstall and doctor default to every supported browser)

Files:
  ~/.sitecraft/sitecraft-host.sh      Wrapper the browser launches.
  ~/.sitecraft/config.json            Optional: { "model": "...", "maxTurns": 16 }
  ~/.sitecraft/companion.log          Host log.
`;

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  command: string;
  flags: Map<string, string | true>;
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const [first, ...rest] = argv;
  const command = first === undefined || first.startsWith('chrome-extension://') ? 'host' : first;
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(arg.slice(2), next);
      i++;
    } else {
      flags.set(arg.slice(2), true);
    }
  }
  return { command, flags, positional };
}

function flagString(flags: Map<string, string | true>, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = flags.get(n);
    if (typeof v === 'string') return v;
  }
  return undefined;
}

function parseBrowsers(raw: string | undefined, fallback: BrowserId[]): BrowserId[] {
  if (raw === undefined) return fallback;
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const out: BrowserId[] = [];
  for (const id of ids) {
    if (!isBrowserId(id)) throw new Error(`Unknown browser "${id}". Choose from: ${BROWSER_IDS.join(', ')}.`);
    if (!out.includes(id)) out.push(id);
  }
  if (out.length === 0) throw new Error('No browsers given.');
  return out;
}

// ---------------------------------------------------------------------------
// Output helpers (never used in host mode)
// ---------------------------------------------------------------------------

function out(line = ''): void {
  process.stdout.write(line + '\n');
}

function err(line: string): void {
  process.stderr.write(line + '\n');
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface HostConfig {
  model?: string;
  maxTurns?: number;
}

export function readHostConfig(home: string, logger: Logger): HostConfig {
  const file = path.join(sitecraftHome(home), CONFIG_FILENAME);
  if (!existsSync(file)) return {};
  try {
    const rec: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isRecord(rec)) {
      logger.warn('config.json ignored: not an object', file);
      return {};
    }
    const config: HostConfig = {};
    if (typeof rec.model === 'string' && rec.model.trim() !== '') config.model = rec.model.trim();
    else if (rec.model !== undefined) logger.warn('config.json: "model" must be a non-empty string; ignored');
    if (typeof rec.maxTurns === 'number' && Number.isInteger(rec.maxTurns) && rec.maxTurns >= 1 && rec.maxTurns <= 200) {
      config.maxTurns = rec.maxTurns;
    } else if (rec.maxTurns !== undefined) {
      logger.warn('config.json: "maxTurns" must be an integer from 1 to 200; ignored');
    }
    return config;
  } catch (e) {
    logger.warn('config.json ignored: could not parse', errorMessage(e));
    return {};
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdHost(origin: string | undefined): Promise<number> {
  const logger = createLogger();
  process.title = 'sitecraft-host';
  // Anything that prints to stdout would corrupt the frame stream. Route
  // console output to the log file instead.
  const toLog = (...args: unknown[]) => logger.info(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  console.log = toLog;
  console.info = toLog;
  console.debug = toLog;

  const config = readHostConfig(os.homedir(), logger);
  const agentOptions: AgentRunOptions = { ...config, logger };
  logger.info('Host starting', { version: VERSION, node: process.version, pid: process.pid, origin: origin ?? null, config });

  const handle = startHost(
    { stdin: process.stdin, stdout: process.stdout },
    {
      runAgent,
      checkLogin: () => checkClaudeLogin({ timeoutMs: AUTH_TIMEOUT_MS, model: config.model, logger }),
      version: VERSION,
      logger,
      agentOptions,
      onHello: (hello) => {
        writeExtensionRecord(os.homedir(), hello, VERSION).catch((e: unknown) => {
          logger.warn('Could not record the extension hello', errorMessage(e));
        });
      },
    },
  );

  const onSignal = (signal: NodeJS.Signals) => {
    logger.info(`Received ${signal}`);
    handle.stop();
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  process.once('SIGHUP', onSignal);
  process.on('uncaughtException', (e) => {
    logger.error('Uncaught exception', e.stack ?? e.message);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', errorMessage(reason));
  });

  await handle.done;
  logger.info('Host stopped');
  return 0;
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * The node path to pin in the wrapper. process.execPath is a resolved real
 * path (for Homebrew: a versioned Cellar directory that a node upgrade
 * removes). Prefer the PATH entry that points at the same binary, such as
 * /opt/homebrew/bin/node, which the package manager keeps current.
 */
export function stableNodePath(execPath: string = process.execPath, pathEnv: string | undefined = process.env.PATH): string {
  const real = safeRealpath(execPath);
  for (const dir of (pathEnv ?? '').split(path.delimiter)) {
    if (dir === '') continue;
    const candidate = path.join(dir, 'node');
    if (existsSync(candidate) && safeRealpath(candidate) === real) return candidate;
  }
  return execPath;
}

async function cmdInstall(args: ParsedArgs): Promise<number> {
  const extensionId = flagString(args.flags, 'extension-id', 'id') ?? EXTENSION_ID;
  if (!isValidExtensionId(extensionId)) {
    err(`Invalid extension id "${extensionId}". Expected 32 letters a through p.`);
    return 1;
  }
  const browsers = parseBrowsers(flagString(args.flags, 'browser', 'browsers'), ['chrome']);
  const nodePath = stableNodePath();
  const res = await install({
    extensionId,
    browsers,
    home: os.homedir(),
    nodePath,
    cliPath: CLI_PATH,
    platform: process.platform,
  });
  out('Installed the Sitecraft companion.');
  out(`  node:      ${nodePath}`);
  out(`  cli:       ${CLI_PATH}`);
  out(`  wrapper:   ${res.wrapperPath}`);
  res.manifestPaths.forEach((p, i) => out(`  manifest:  ${p} (${browsers[i]})`));
  out(`  extension: ${extensionId}`);
  out();
  out('Next: reload the extension, open the Sitecraft side panel, and click Retry.');
  return 0;
}

async function cmdUninstall(args: ParsedArgs): Promise<number> {
  const browsers = parseBrowsers(flagString(args.flags, 'browser', 'browsers'), supportedBrowsers(process.platform));
  if (browsers.length === 0) {
    err(`No supported browsers on platform "${process.platform}".`);
    return 1;
  }
  const removed = await uninstall({ browsers, home: os.homedir(), platform: process.platform });
  if (removed.length === 0) {
    out('Nothing to remove.');
  } else {
    out('Removed:');
    for (const p of removed) out(`  ${p}`);
  }
  return 0;
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** True when the browser's profile directory (the parent of NativeMessagingHosts) exists. */
function browserPresent(browser: BrowserId, home: string, platform: NodeJS.Platform): boolean {
  try {
    return existsSync(path.dirname(hostManifestDir(browser, home, platform)));
  } catch {
    return false;
  }
}

function checkManifest(p: string, wrapper: string, extensionId: string): { ok: boolean; note: string } {
  if (!existsSync(p)) return { ok: false, note: 'missing' };
  try {
    const m = JSON.parse(readFileSync(p, 'utf8')) as { path?: unknown; allowed_origins?: unknown };
    const origins = Array.isArray(m.allowed_origins) ? (m.allowed_origins as unknown[]) : [];
    if (m.path !== wrapper) return { ok: false, note: `points at ${String(m.path)}; run "sitecraft install"` };
    if (!origins.includes(`chrome-extension://${extensionId}/`)) {
      return { ok: false, note: `allows ${origins.join(', ') || 'no origin'}; expected ${extensionId}` };
    }
    return { ok: true, note: 'ok' };
  } catch (e) {
    return { ok: false, note: `unreadable: ${errorMessage(e)}` };
  }
}

async function cmdDoctor(args: ParsedArgs): Promise<number> {
  const home = os.homedir();
  const platform = process.platform;
  const extensionId = flagString(args.flags, 'extension-id', 'id') ?? EXTENSION_ID;
  const explicit = flagString(args.flags, 'browser', 'browsers');
  const browsers = parseBrowsers(explicit, supportedBrowsers(platform));
  let failures = 0;

  out(`Sitecraft doctor (companion ${VERSION})`);
  out(`  node:      ${process.version} at ${process.execPath}`);
  out(`  cli:       ${CLI_PATH}${existsSync(CLI_PATH) ? '' : ' (missing)'}`);
  out(`  platform:  ${platform}`);
  out(`  extension: ${extensionId}`);

  const wrapper = wrapperPath(home);
  const wrapperOk = existsSync(wrapper);
  const wrapperExec = wrapperOk && isExecutable(wrapper);
  out(`  wrapper:   ${wrapper} ${wrapperOk ? (wrapperExec ? 'ok' : 'FAIL not executable') : 'FAIL missing'}`);
  if (!wrapperExec) failures++;

  // The wrapper pins absolute paths. Check that they still exist (a node
  // upgrade or a moved checkout breaks the host silently otherwise).
  if (wrapperOk) {
    const parsed = parseWrapperScript(readFileSync(wrapper, 'utf8'));
    if (!parsed) {
      out('  wrapper:   FAIL unexpected content; run "sitecraft install"');
      failures++;
    } else {
      const nodeOk = isExecutable(parsed.nodePath);
      const cliOk = existsSync(parsed.cliPath);
      out(`  wrapper:   node ${parsed.nodePath} ${nodeOk ? 'ok' : 'FAIL missing; run "sitecraft install"'}`);
      out(`  wrapper:   cli  ${parsed.cliPath} ${cliOk ? 'ok' : 'FAIL missing; run "sitecraft install"'}`);
      if (!nodeOk || !cliOk) failures++;
    }
  }

  // Without --browser, report only browsers that exist on this machine.
  const candidates = explicit !== undefined ? browsers : browsers.filter((b) => browserPresent(b, home, platform));
  if (explicit === undefined) {
    out(`  browsers:  ${candidates.length > 0 ? candidates.join(', ') : 'none found'} (pass --browser to check others)`);
  }
  let manifestsOk = 0;
  for (const b of candidates) {
    let p: string;
    try {
      p = hostManifestPath(b, home, platform);
    } catch (e) {
      out(`  manifest:  ${b}: ${errorMessage(e)}`);
      if (explicit !== undefined) failures++;
      continue;
    }
    const res = checkManifest(p, wrapper, extensionId);
    // A missing manifest for a browser the user did not ask about is information, not a failure.
    const label = res.ok ? 'ok' : explicit === undefined && res.note === 'missing' ? 'not installed' : `FAIL ${res.note}`;
    out(`  manifest:  ${p} ${label} (${b})`);
    if (res.ok) manifestsOk++;
    else if (explicit !== undefined) failures++;
  }
  if (manifestsOk === 0) {
    failures++;
    out('  No usable host manifest found. Run "sitecraft install".');
  }

  // Use the same model the host will use, so this check matches real runs.
  const config = readHostConfig(home, createLogger({ file: null, toStderr: true, level: 'warn' }));
  out(`  config:    ${config.model ? `model ${config.model}` : 'default model'}${config.maxTurns ? `, maxTurns ${config.maxTurns}` : ''}`);
  out('  claude:    checking login...');
  try {
    const login = await checkClaudeLogin({ timeoutMs: AUTH_TIMEOUT_MS, model: config.model });
    out(`  claude:    ${login.ok ? 'ok' : 'FAIL'} ${login.detail}`);
    if (!login.ok) failures++;
  } catch (e) {
    out(`  claude:    FAIL ${errorMessage(e)}`);
    failures++;
  }

  out();
  out(failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`);
  return failures === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.flags.has('help') || args.flags.has('h') || args.command === 'help' || args.command === '--help' || args.command === '-h') {
    out(USAGE);
    return 0;
  }
  if (args.command === '--version' || args.command === '-v' || args.flags.has('version')) {
    out(VERSION);
    return 0;
  }
  try {
    switch (args.command) {
      case 'host':
        return await cmdHost(argv.find((a) => a.startsWith('chrome-extension://')));
      case 'install':
        return await cmdInstall(args);
      case 'uninstall':
        return await cmdUninstall(args);
      case 'doctor':
        return await cmdDoctor(args);
      default:
        err(`Unknown command "${args.command}".\n`);
        err(USAGE);
        return 2;
    }
  } catch (e) {
    err(`sitecraft ${args.command}: ${errorMessage(e)}`);
    return 1;
  }
}

const argv = process.argv.slice(2);
const isHostMode = parseArgs(argv).command === 'host';

main(argv).then(
  (code) => {
    process.exitCode = code;
    // Let pending writes drain, then force the exit if something (an SDK
    // child, a timer) is still holding the event loop open.
    setTimeout(() => process.exit(code), isHostMode ? 500 : 1500).unref();
  },
  (e: unknown) => {
    err(`sitecraft: ${errorMessage(e)}`);
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 500).unref();
  },
);
