import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXTENSION_ID, NATIVE_HOST_NAME } from '@sitecraft/shared';
import {
  BROWSER_IDS,
  HOST_MANIFEST_FILENAME,
  buildHostManifest,
  buildWrapperScript,
  hostManifestDir,
  hostManifestPath,
  install,
  isBrowserId,
  supportedBrowsers,
  uninstall,
  wrapperPath,
  type BrowserId,
} from '../src/install.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'sitecraft-install-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('hostManifestDir', () => {
  const H = '/Users/me';
  const mac = (rest: string) => path.join(H, 'Library', 'Application Support', rest, 'NativeMessagingHosts');

  it.each<[BrowserId, string]>([
    ['chrome', mac('Google/Chrome')],
    ['chrome-beta', mac('Google/Chrome Beta')],
    ['chrome-canary', mac('Google/Chrome Canary')],
    ['chromium', mac('Chromium')],
    ['brave', mac('BraveSoftware/Brave-Browser')],
    ['edge', mac('Microsoft Edge')],
    ['arc', mac('Arc/User Data')],
  ])('darwin %s', (browser, expected) => {
    expect(hostManifestDir(browser, H, 'darwin')).toBe(expected);
  });

  const lin = (rest: string) => path.join(H, '.config', rest, 'NativeMessagingHosts');

  it.each<[BrowserId, string]>([
    ['chrome', lin('google-chrome')],
    ['chrome-beta', lin('google-chrome-beta')],
    ['chromium', lin('chromium')],
    ['brave', lin('BraveSoftware/Brave-Browser')],
    ['edge', lin('microsoft-edge')],
  ])('linux %s', (browser, expected) => {
    expect(hostManifestDir(browser, H, 'linux')).toBe(expected);
  });

  it('throws for browsers that do not exist on linux', () => {
    expect(() => hostManifestDir('arc', H, 'linux')).toThrow(/arc/);
    expect(() => hostManifestDir('chrome-canary', H, 'linux')).toThrow(/chrome-canary/);
  });

  it('throws on win32', () => {
    expect(() => hostManifestDir('chrome', 'C:\\Users\\me', 'win32')).toThrow(/Windows/);
  });

  it('hostManifestPath appends the manifest filename', () => {
    expect(HOST_MANIFEST_FILENAME).toBe(`${NATIVE_HOST_NAME}.json`);
    expect(hostManifestPath('chrome', H, 'darwin')).toBe(path.join(mac('Google/Chrome'), HOST_MANIFEST_FILENAME));
  });

  it('supportedBrowsers lists what hostManifestDir accepts', () => {
    expect(supportedBrowsers('darwin')).toEqual(BROWSER_IDS);
    expect(supportedBrowsers('linux')).toEqual(['chrome', 'chrome-beta', 'chromium', 'brave', 'edge']);
    expect(supportedBrowsers('win32')).toEqual([]);
  });

  it('isBrowserId guards strings', () => {
    expect(isBrowserId('chrome')).toBe(true);
    expect(isBrowserId('firefox')).toBe(false);
  });
});

describe('buildWrapperScript / buildHostManifest', () => {
  it('builds a sh wrapper that execs node with the cli in host mode', () => {
    expect(buildWrapperScript({ nodePath: '/opt/node/bin/node', cliPath: '/x/bin/sitecraft.js' })).toBe(
      '#!/bin/sh\nexec "/opt/node/bin/node" "/x/bin/sitecraft.js" host "$@"\n',
    );
  });

  it('builds a manifest restricted to the extension origin', () => {
    expect(buildHostManifest({ extensionId: 'abcdefghijklmnopabcdefghijklmnop', wrapperPath: '/h/.sitecraft/sitecraft-host.sh' })).toEqual({
      name: NATIVE_HOST_NAME,
      description: 'Sitecraft companion (Claude Agent SDK host)',
      path: '/h/.sitecraft/sitecraft-host.sh',
      type: 'stdio',
      allowed_origins: ['chrome-extension://abcdefghijklmnopabcdefghijklmnop/'],
    });
  });

  it('wrapperPath lives under <home>/.sitecraft', () => {
    expect(wrapperPath('/h')).toBe(path.join('/h', '.sitecraft', 'sitecraft-host.sh'));
  });
});

describe('install', () => {
  it('writes the wrapper (0755) and one manifest per browser', async () => {
    const res = await install({
      extensionId: EXTENSION_ID,
      browsers: ['chrome', 'brave'],
      home,
      nodePath: '/usr/local/bin/node',
      cliPath: '/repo/companion/bin/sitecraft.js',
      platform: 'darwin',
    });

    expect(res.wrapperPath).toBe(path.join(home, '.sitecraft', 'sitecraft-host.sh'));
    expect(res.manifestPaths).toEqual([hostManifestPath('chrome', home, 'darwin'), hostManifestPath('brave', home, 'darwin')]);

    const wrapper = await readFile(res.wrapperPath, 'utf8');
    expect(wrapper).toBe('#!/bin/sh\nexec "/usr/local/bin/node" "/repo/companion/bin/sitecraft.js" host "$@"\n');
    const mode = (await stat(res.wrapperPath)).mode & 0o777;
    expect(mode).toBe(0o755);

    for (const p of res.manifestPaths) {
      const manifest = JSON.parse(await readFile(p, 'utf8')) as Record<string, unknown>;
      expect(manifest).toEqual({
        name: NATIVE_HOST_NAME,
        description: 'Sitecraft companion (Claude Agent SDK host)',
        path: res.wrapperPath,
        type: 'stdio',
        allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
      });
    }
  });

  it('overwrites an existing wrapper and fixes its mode', async () => {
    const wp = wrapperPath(home);
    await mkdir(path.dirname(wp), { recursive: true });
    await writeFile(wp, 'old', { mode: 0o600 });
    const res = await install({
      extensionId: EXTENSION_ID,
      browsers: ['chrome'],
      home,
      nodePath: '/n',
      cliPath: '/c',
      platform: 'darwin',
    });
    expect(await readFile(res.wrapperPath, 'utf8')).toContain('exec "/n" "/c" host');
    expect((await stat(res.wrapperPath)).mode & 0o777).toBe(0o755);
  });

  it('rejects an unsupported browser before writing anything', async () => {
    await expect(
      install({ extensionId: EXTENSION_ID, browsers: ['arc'], home, nodePath: '/n', cliPath: '/c', platform: 'linux' }),
    ).rejects.toThrow(/arc/);
    expect(await exists(wrapperPath(home))).toBe(false);
  });

  it('rejects an invalid extension id', async () => {
    await expect(
      install({ extensionId: 'not-an-id', browsers: ['chrome'], home, nodePath: '/n', cliPath: '/c', platform: 'darwin' }),
    ).rejects.toThrow(/extension id/i);
  });
});

describe('uninstall', () => {
  it('removes the manifests and the wrapper once no manifest remains', async () => {
    const res = await install({
      extensionId: EXTENSION_ID,
      browsers: ['chrome', 'edge'],
      home,
      nodePath: '/n',
      cliPath: '/c',
      platform: 'darwin',
    });
    const removed = await uninstall({ browsers: ['chrome'], home, platform: 'darwin' });
    expect(removed).toEqual([hostManifestPath('chrome', home, 'darwin')]);
    expect(await exists(hostManifestPath('chrome', home, 'darwin'))).toBe(false);
    expect(await exists(hostManifestPath('edge', home, 'darwin'))).toBe(true);
    expect(await exists(res.wrapperPath)).toBe(true);

    const removed2 = await uninstall({ browsers: ['edge'], home, platform: 'darwin' });
    expect(removed2).toEqual([hostManifestPath('edge', home, 'darwin'), res.wrapperPath]);
    expect(await exists(res.wrapperPath)).toBe(false);
  });

  it('returns an empty list when nothing is installed', async () => {
    expect(await uninstall({ browsers: ['chrome', 'brave'], home, platform: 'darwin' })).toEqual([]);
  });
});
