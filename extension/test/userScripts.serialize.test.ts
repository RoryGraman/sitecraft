import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SiteScript } from '@sitecraft/shared';
import { registerAll } from '../src/background/userScripts';

interface FakeUserScripts {
  getScripts: ReturnType<typeof vi.fn>;
  register: ReturnType<typeof vi.fn>;
  unregister: ReturnType<typeof vi.fn>;
}

const g = globalThis as unknown as { chrome?: unknown };

function installChrome(): FakeUserScripts {
  const us: FakeUserScripts = {
    getScripts: vi.fn(() => Promise.resolve([])),
    register: vi.fn(() => Promise.resolve()),
    unregister: vi.fn(() => Promise.resolve()),
  };
  g.chrome = { userScripts: us };
  return us;
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

afterEach(() => {
  delete g.chrome;
});

describe('registerAll serialization', () => {
  it('runs overlapping calls one after the other, so registers never interleave with the next unregister', async () => {
    const log: string[] = [];
    const us = installChrome();
    let call = 0;
    us.unregister.mockImplementation(async () => {
      call += 1;
      log.push(`unregister#${call}`);
      // Yield twice so an unserialized second call could sneak in here.
      await Promise.resolve();
      await Promise.resolve();
    });
    us.register.mockImplementation(async (scripts: { id: string }[]) => {
      log.push(`register:${scripts[0]?.id ?? '?'}`);
      await Promise.resolve();
    });

    const first = registerAll([mk({ urlPattern: 'https://a.com/*' }), mk({ urlPattern: 'https://b.com/*' })]);
    const second = registerAll([mk({ urlPattern: 'https://c.com/*' })]);
    const [r1, r2] = await Promise.all([first, second]);

    expect(r1.registered).toBe(2);
    expect(r2.registered).toBe(1);
    const secondUnregister = log.indexOf('unregister#2');
    expect(secondUnregister).toBeGreaterThan(0);
    const registersBeforeSecond = log.slice(0, secondUnregister).filter((l) => l.startsWith('register:'));
    // Both registers of the first call happen before the second call unregisters.
    expect(registersBeforeSecond).toHaveLength(2);
    expect(log[log.length - 1]).toMatch(/^register:/);
  });

  it('a failing call does not block later calls', async () => {
    const us = installChrome();
    us.unregister.mockRejectedValueOnce(new Error('boom'));
    await expect(registerAll([mk()])).rejects.toThrow('boom');
    us.unregister.mockResolvedValue(undefined);
    await expect(registerAll([mk()])).resolves.toMatchObject({ registered: 1 });
  });
});
