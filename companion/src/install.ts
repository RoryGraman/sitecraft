/**
 * Native messaging host installer.
 *
 * Writes a small sh wrapper under ~/.sitecraft that execs node with the CLI
 * in host mode, then writes one host manifest per browser pointing at that
 * wrapper. The manifest allows only this extension's origin.
 */
import { chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NATIVE_HOST_NAME } from '@sitecraft/shared';
import { sitecraftHome } from './log.js';

export type BrowserId = 'chrome' | 'chrome-beta' | 'chrome-canary' | 'chromium' | 'brave' | 'edge' | 'arc';

export const BROWSER_IDS: readonly BrowserId[] = ['chrome', 'chrome-beta', 'chrome-canary', 'chromium', 'brave', 'edge', 'arc'];

export const HOST_MANIFEST_FILENAME = `${NATIVE_HOST_NAME}.json`;
export const WRAPPER_FILENAME = 'sitecraft-host.sh';
export const HOST_DESCRIPTION = 'Sitecraft companion (Claude Agent SDK host)';

const DARWIN_DIRS: Record<BrowserId, string> = {
  chrome: 'Google/Chrome',
  'chrome-beta': 'Google/Chrome Beta',
  'chrome-canary': 'Google/Chrome Canary',
  chromium: 'Chromium',
  brave: 'BraveSoftware/Brave-Browser',
  edge: 'Microsoft Edge',
  arc: 'Arc/User Data',
};

const LINUX_DIRS: Partial<Record<BrowserId, string>> = {
  chrome: 'google-chrome',
  'chrome-beta': 'google-chrome-beta',
  chromium: 'chromium',
  brave: 'BraveSoftware/Brave-Browser',
  edge: 'microsoft-edge',
};

export function isBrowserId(v: string): v is BrowserId {
  return (BROWSER_IDS as readonly string[]).includes(v);
}

/** Browsers that have a known manifest directory on this platform. */
export function supportedBrowsers(platform: NodeJS.Platform): BrowserId[] {
  if (platform === 'darwin') return [...BROWSER_IDS];
  if (platform === 'linux') return BROWSER_IDS.filter((b) => LINUX_DIRS[b] !== undefined);
  return [];
}

/** Directory that holds native messaging host manifests for one browser. */
export function hostManifestDir(browser: BrowserId, home: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    throw new Error('Windows is not supported yet. Native hosts on Windows need a registry entry.');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', ...DARWIN_DIRS[browser].split('/'), 'NativeMessagingHosts');
  }
  if (platform === 'linux') {
    const dir = LINUX_DIRS[browser];
    if (!dir) throw new Error(`Browser "${browser}" has no known native messaging directory on Linux.`);
    return path.join(home, '.config', ...dir.split('/'), 'NativeMessagingHosts');
  }
  throw new Error(`Platform "${platform}" is not supported.`);
}

export function hostManifestPath(browser: BrowserId, home: string, platform: NodeJS.Platform): string {
  return path.join(hostManifestDir(browser, home, platform), HOST_MANIFEST_FILENAME);
}

export function wrapperPath(home: string): string {
  return path.join(sitecraftHome(home), WRAPPER_FILENAME);
}

export function buildWrapperScript(opts: { nodePath: string; cliPath: string }): string {
  return `#!/bin/sh\nexec "${opts.nodePath}" "${opts.cliPath}" host "$@"\n`;
}

export interface HostManifest {
  name: string;
  description: string;
  path: string;
  type: 'stdio';
  allowed_origins: string[];
}

export function buildHostManifest(opts: { extensionId: string; wrapperPath: string }): HostManifest {
  return {
    name: NATIVE_HOST_NAME,
    description: HOST_DESCRIPTION,
    path: opts.wrapperPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${opts.extensionId}/`],
  };
}

/** Chrome extension ids are 32 lowercase letters a through p. */
export function isValidExtensionId(id: string): boolean {
  return /^[a-p]{32}$/.test(id);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export interface InstallOptions {
  extensionId: string;
  browsers: BrowserId[];
  home: string;
  nodePath: string;
  cliPath: string;
  platform: NodeJS.Platform;
}

export interface InstallResult {
  wrapperPath: string;
  manifestPaths: string[];
}

export async function install(opts: InstallOptions): Promise<InstallResult> {
  if (!isValidExtensionId(opts.extensionId)) {
    throw new Error(`Invalid extension id "${opts.extensionId}". Expected 32 letters a through p.`);
  }
  if (opts.browsers.length === 0) throw new Error('No browsers given.');
  // Resolve every path first so an unsupported browser fails before any write.
  const manifestPaths = opts.browsers.map((b) => hostManifestPath(b, opts.home, opts.platform));

  const wrapper = wrapperPath(opts.home);
  await mkdir(path.dirname(wrapper), { recursive: true });
  await writeFile(wrapper, buildWrapperScript({ nodePath: opts.nodePath, cliPath: opts.cliPath }), { mode: 0o755 });
  await chmod(wrapper, 0o755);

  const manifest = JSON.stringify(buildHostManifest({ extensionId: opts.extensionId, wrapperPath: wrapper }), null, 2) + '\n';
  for (const p of manifestPaths) {
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, manifest, { mode: 0o644 });
  }
  return { wrapperPath: wrapper, manifestPaths };
}

export interface UninstallOptions {
  browsers: BrowserId[];
  home: string;
  platform: NodeJS.Platform;
}

/**
 * Remove the manifests for the given browsers. The wrapper is removed too
 * once no known browser still has a manifest. Returns the removed paths.
 */
export async function uninstall(opts: UninstallOptions): Promise<string[]> {
  const removed: string[] = [];
  for (const browser of opts.browsers) {
    const p = hostManifestPath(browser, opts.home, opts.platform);
    if (await fileExists(p)) {
      await rm(p, { force: true });
      removed.push(p);
    }
  }
  const wrapper = wrapperPath(opts.home);
  if (await fileExists(wrapper)) {
    let stillUsed = false;
    for (const browser of supportedBrowsers(opts.platform)) {
      if (await fileExists(hostManifestPath(browser, opts.home, opts.platform))) {
        stillUsed = true;
        break;
      }
    }
    if (!stillUsed) {
      await rm(wrapper, { force: true });
      removed.push(wrapper);
    }
  }
  return removed;
}
