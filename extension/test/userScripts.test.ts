import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderJsBundle, shortHash, type SiteScript } from '@sitecraft/shared';
import { isUserScriptsAvailable, registerAll } from '../src/background/userScripts';

interface FakeUserScripts {
  getScripts: ReturnType<typeof vi.fn>;
  register: ReturnType<typeof vi.fn>;
  unregister: ReturnType<typeof vi.fn>;
}

const g = globalThis as unknown as { chrome?: unknown };

function installChrome(userScripts: FakeUserScripts | undefined): FakeUserScripts | undefined {
  g.chrome = userScripts ? { userScripts } : {};
  return userScripts;
}

function fakeUserScripts(): FakeUserScripts {
  return {
    getScripts: vi.fn(() => Promise.resolve([])),
    register: vi.fn(() => Promise.resolve()),
    unregister: vi.fn(() => Promise.resolve()),
  };
}

let counter = 0;

function mk(overrides: Partial<SiteScript> = {}): SiteScript {
  counter += 1;
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id: `id-${counter}`,
    name: `Script ${counter}`,
    description: 'A test script.',
    urlPattern: 'https://a.com/*',
    kind: 'js',
    priority: 3,
    code: "console.log('hi')",
    enabled: true,
    trial: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  counter = 0;
});

afterEach(() => {
  delete g.chrome;
});

describe('isUserScriptsAvailable', () => {
  it('returns true when chrome.userScripts.getScripts can be called', () => {
    const us = installChrome(fakeUserScripts());
    expect(isUserScriptsAvailable()).toBe(true);
    expect(us?.getScripts).toHaveBeenCalledTimes(1);
  });

  it('returns false when chrome.userScripts is undefined', () => {
    installChrome(undefined);
    expect(isUserScriptsAvailable()).toBe(false);
  });

  it('returns false when chrome itself is undefined', () => {
    delete g.chrome;
    expect(isUserScriptsAvailable()).toBe(false);
  });

  it('returns false when getScripts throws synchronously', () => {
    const us = fakeUserScripts();
    us.getScripts.mockImplementation(() => {
      throw new Error('User scripts are not enabled.');
    });
    installChrome(us);
    expect(isUserScriptsAvailable()).toBe(false);
  });
});

describe('registerAll', () => {
  it('skips when the API is unavailable', async () => {
    installChrome(undefined);
    const result = await registerAll([mk()]);
    expect(result).toEqual({ registered: 0, skipped: true });
  });

  it('unregisters everything, then registers one bundle per urlPattern with exact arguments', async () => {
    const us = installChrome(fakeUserScripts()) as FakeUserScripts;
    const a1 = mk({ id: 'a1', urlPattern: 'https://a.com/*', priority: 2 });
    const a2 = mk({ id: 'a2', urlPattern: 'https://a.com/*', priority: 1 });
    const b1 = mk({ id: 'b1', urlPattern: 'https://b.com/*' });
    const disabled = mk({ id: 'off', urlPattern: 'https://c.com/*', enabled: false });
    const css = mk({ id: 'css', kind: 'css', urlPattern: 'https://d.com/*', code: 'body{}' });

    const result = await registerAll([a1, a2, b1, disabled, css]);

    expect(result).toEqual({ registered: 2, skipped: false });
    expect(us.unregister).toHaveBeenCalledTimes(1);
    expect(us.unregister).toHaveBeenCalledWith();
    expect(us.register).toHaveBeenCalledTimes(2);
    expect(us.register).toHaveBeenNthCalledWith(1, [
      {
        id: 'sitecraft-' + shortHash('https://a.com/*'),
        matches: ['https://a.com/*'],
        js: [{ code: renderJsBundle([a2, a1]) }],
        world: 'MAIN',
        runAt: 'document_end',
        allFrames: false,
      },
    ]);
    expect(us.register).toHaveBeenNthCalledWith(2, [
      {
        id: 'sitecraft-' + shortHash('https://b.com/*'),
        matches: ['https://b.com/*'],
        js: [{ code: renderJsBundle([b1]) }],
        world: 'MAIN',
        runAt: 'document_end',
        allFrames: false,
      },
    ]);

    const unregisterOrder = us.unregister.mock.invocationCallOrder[0] ?? Infinity;
    const firstRegisterOrder = us.register.mock.invocationCallOrder[0] ?? -Infinity;
    expect(unregisterOrder).toBeLessThan(firstRegisterOrder);
  });

  it('still unregisters when there are no js bundles and registers nothing', async () => {
    const us = installChrome(fakeUserScripts()) as FakeUserScripts;
    const result = await registerAll([mk({ enabled: false }), mk({ kind: 'css', code: 'a{}' })]);
    expect(result).toEqual({ registered: 0, skipped: false });
    expect(us.unregister).toHaveBeenCalledTimes(1);
    expect(us.register).not.toHaveBeenCalled();
  });

  it('a rejected pattern does not block the other bundles and is reported', async () => {
    const us = installChrome(fakeUserScripts()) as FakeUserScripts;
    us.register.mockImplementation((entries: Array<{ matches: string[] }>) => {
      if (entries[0]?.matches[0] === 'https://bad.com/*') {
        return Promise.reject(new Error('Invalid match pattern.'));
      }
      return Promise.resolve();
    });
    const bad1 = mk({ id: 'bad1', urlPattern: 'https://bad.com/*', priority: 1 });
    const bad2 = mk({ id: 'bad2', urlPattern: 'https://bad.com/*', priority: 2 });
    const good = mk({ id: 'good', urlPattern: 'https://good.com/*' });
    const onBundleError = vi.fn();

    const result = await registerAll([good, bad2, bad1], onBundleError);

    expect(result).toEqual({ registered: 1, skipped: false });
    expect(us.register).toHaveBeenCalledTimes(2);
    expect(onBundleError).toHaveBeenCalledTimes(1);
    expect(onBundleError).toHaveBeenCalledWith(['bad1', 'bad2'], 'Invalid match pattern.');
  });

  it('reports non-Error rejections as strings', async () => {
    const us = installChrome(fakeUserScripts()) as FakeUserScripts;
    us.register.mockImplementation(() => Promise.reject('string failure'));
    const onBundleError = vi.fn();

    const result = await registerAll([mk({ id: 's1' })], onBundleError);

    expect(result).toEqual({ registered: 0, skipped: false });
    expect(onBundleError).toHaveBeenCalledWith(['s1'], 'string failure');
  });

  it('does not throw when register fails and no callback is given', async () => {
    const us = installChrome(fakeUserScripts()) as FakeUserScripts;
    us.register.mockImplementation(() => Promise.reject(new Error('nope')));
    await expect(registerAll([mk()])).resolves.toEqual({ registered: 0, skipped: false });
  });
});
