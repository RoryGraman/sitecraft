import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  BROWSER_APPS,
  EXTENSION_ID,
  browserDataDir,
  clipboardCommand,
  isProfileDirName,
  nodeMajor,
  openUrlCommand,
  parseSetupArgs,
  pathMatchesDist,
  readProfileExtensionState,
  scanBrowserForExtension,
} from '../setupLib.mjs';

function prefs(entry) {
  return JSON.stringify({ extensions: { settings: { [EXTENSION_ID]: entry } } });
}

describe('parseSetupArgs', () => {
  it('defaults to chrome with nothing skipped', () => {
    const { opts, errors } = parseSetupArgs([]);
    expect(errors).toEqual([]);
    expect(opts).toEqual({ browser: 'chrome', skipChrome: false, skipLogin: false, noOpen: false, uninstall: false, help: false });
  });

  it('parses every flag', () => {
    const { opts, errors } = parseSetupArgs(['--browser', 'brave', '--skip-chrome', '--skip-login', '--no-open', '--uninstall']);
    expect(errors).toEqual([]);
    expect(opts.browser).toBe('brave');
    expect(opts.skipChrome).toBe(true);
    expect(opts.skipLogin).toBe(true);
    expect(opts.noOpen).toBe(true);
    expect(opts.uninstall).toBe(true);
  });

  it('accepts --browser=edge and --help', () => {
    const { opts, errors } = parseSetupArgs(['--browser=edge', '--help']);
    expect(errors).toEqual([]);
    expect(opts.browser).toBe('edge');
    expect(opts.help).toBe(true);
  });

  it('rejects an unknown browser and an unknown flag', () => {
    expect(parseSetupArgs(['--browser', 'safari']).errors).toHaveLength(1);
    expect(parseSetupArgs(['--wat']).errors).toHaveLength(1);
  });
});

describe('nodeMajor', () => {
  it('reads the major version', () => {
    expect(nodeMajor('v23.11.0')).toBe(23);
    expect(nodeMajor('20.1.0')).toBe(20);
    expect(nodeMajor('weird')).toBe(0);
  });
});

describe('isProfileDirName', () => {
  it('accepts Default and Profile N only', () => {
    expect(isProfileDirName('Default')).toBe(true);
    expect(isProfileDirName('Profile 1')).toBe(true);
    expect(isProfileDirName('Profile 12')).toBe(true);
    expect(isProfileDirName('System Profile')).toBe(false);
    expect(isProfileDirName('Crashpad')).toBe(false);
  });
});

describe('readProfileExtensionState', () => {
  it('reads the entry from Secure Preferences', () => {
    const files = {
      [path.join('/p', 'Secure Preferences')]: prefs({ path: '/repo/extension/dist', user_scripts_enabled: true }),
    };
    const state = readProfileExtensionState('/p', (f) => files[f] ?? null);
    expect(state).toEqual({ installed: true, path: '/repo/extension/dist', userScriptsEnabled: true });
  });

  it('falls back to Preferences', () => {
    const files = {
      [path.join('/p', 'Preferences')]: prefs({ path: '/x' }),
    };
    const state = readProfileExtensionState('/p', (f) => files[f] ?? null);
    expect(state).toEqual({ installed: true, path: '/x', userScriptsEnabled: false });
  });

  it('handles a missing entry and bad JSON', () => {
    expect(readProfileExtensionState('/p', () => null).installed).toBe(false);
    expect(readProfileExtensionState('/p', () => 'not json').installed).toBe(false);
    expect(readProfileExtensionState('/p', () => '{}').installed).toBe(false);
  });
});

describe('scanBrowserForExtension', () => {
  const dataDir = '/data';

  function fakeFs(profiles) {
    return {
      listDir: (dir) => (dir === dataDir ? [...Object.keys(profiles), 'Crashpad'] : null),
      readFile: (file) => {
        for (const [name, entry] of Object.entries(profiles)) {
          if (file === path.join(dataDir, name, 'Secure Preferences')) return entry === null ? '{}' : prefs(entry);
        }
        return null;
      },
    };
  }

  it('reports a missing browser', () => {
    const res = scanBrowserForExtension('/nope', { listDir: () => null, readFile: () => null });
    expect(res.browserFound).toBe(false);
    expect(res.installed).toBe(false);
  });

  it('prefers the profile with the toggle on', () => {
    const res = scanBrowserForExtension(
      dataDir,
      fakeFs({
        Default: { path: '/a', user_scripts_enabled: false },
        'Profile 1': { path: '/b', user_scripts_enabled: true },
      }),
    );
    expect(res).toMatchObject({ browserFound: true, installed: true, path: '/b', userScriptsEnabled: true, profile: 'Profile 1' });
  });

  it('reports installed without the toggle', () => {
    const res = scanBrowserForExtension(dataDir, fakeFs({ Default: { path: '/a' } }));
    expect(res).toMatchObject({ installed: true, userScriptsEnabled: false, profile: 'Default' });
  });

  it('prefers the dist profile over a stale profile whose toggle is on', () => {
    const res = scanBrowserForExtension(
      dataDir,
      fakeFs({
        Default: { path: '/old/clone/dist', user_scripts_enabled: true },
        'Profile 1': { path: '/repo/extension/dist', user_scripts_enabled: false },
      }),
      '/repo/extension/dist',
    );
    expect(res).toMatchObject({ path: '/repo/extension/dist', userScriptsEnabled: false, profile: 'Profile 1' });
  });

  it('finds the dist profile among several toggle-off installs', () => {
    const res = scanBrowserForExtension(
      dataDir,
      fakeFs({
        Default: { path: '/somewhere/else', user_scripts_enabled: false },
        'Profile 1': { path: '/repo/extension/dist', user_scripts_enabled: false },
      }),
      '/repo/extension/dist',
    );
    expect(res).toMatchObject({ path: '/repo/extension/dist', profile: 'Profile 1' });
  });

  it('falls back to a mismatched install when no profile has the dist path', () => {
    const res = scanBrowserForExtension(dataDir, fakeFs({ Default: { path: '/somewhere/else' } }), '/repo/extension/dist');
    expect(res).toMatchObject({ installed: true, path: '/somewhere/else' });
  });

  it('reports a browser with no install', () => {
    const res = scanBrowserForExtension(dataDir, fakeFs({ Default: null }));
    expect(res).toMatchObject({ browserFound: true, installed: false });
  });
});

describe('pathMatchesDist', () => {
  it('matches with and without a trailing slash', () => {
    expect(pathMatchesDist('/r/extension/dist', '/r/extension/dist')).toBe(true);
    expect(pathMatchesDist('/r/extension/dist/', '/r/extension/dist')).toBe(true);
    expect(pathMatchesDist('/other/dist', '/r/extension/dist')).toBe(false);
    expect(pathMatchesDist(null, '/r/extension/dist')).toBe(false);
  });
});

describe('platform commands', () => {
  it('builds the open command per platform', () => {
    expect(openUrlCommand('chrome', 'chrome://extensions/', 'darwin')).toEqual(['open', '-a', 'Google Chrome', 'chrome://extensions/']);
    expect(openUrlCommand('brave', 'x', 'linux')).toEqual(['brave-browser', 'x']);
    expect(openUrlCommand('chrome', 'x', 'win32')).toBeNull();
  });

  it('builds the clipboard command per platform', () => {
    expect(clipboardCommand('darwin')).toEqual(['pbcopy']);
    expect(clipboardCommand('linux')).toEqual(['xclip', '-selection', 'clipboard']);
    expect(clipboardCommand('win32')).toBeNull();
  });

  it('builds profile dirs per platform', () => {
    expect(browserDataDir('chrome', '/home/u', 'darwin')).toBe('/home/u/Library/Application Support/Google/Chrome');
    expect(browserDataDir('edge', '/home/u', 'linux')).toBe('/home/u/.config/microsoft-edge');
    expect(browserDataDir('chrome', '/home/u', 'win32')).toBeNull();
    expect(Object.keys(BROWSER_APPS)).toEqual(['chrome', 'brave', 'edge']);
  });
});
