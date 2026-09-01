import { describe, expect, it, vi } from 'vitest';
import type { SiteScript } from '@sitecraft/shared';
import { MAX_ERROR_REPORTS_PER_PAGE, computeJsIds, installErrorRelay } from '../src/content/lib';

function mk(overrides: Partial<SiteScript> = {}): SiteScript {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id: 'id',
    name: 'Script',
    description: '',
    urlPattern: 'https://a.com/*',
    kind: 'js',
    priority: 3,
    code: 'x',
    enabled: true,
    trial: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function post(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data, source: window }));
}

describe('installErrorRelay: trust checks', () => {
  it('forwards only ids the predicate accepts', () => {
    const send = vi.fn();
    const remove = installErrorRelay(window, send, (id) => id === 'known');
    post({ source: 'sitecraft', type: 'script-error', scriptId: 'forged', message: 'x' });
    post({ source: 'sitecraft', type: 'script-error', scriptId: 'known', message: 'real' });
    remove();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'scriptError', scriptId: 'known', message: 'real' }));
  });

  it('stops forwarding after the per-page cap', () => {
    const send = vi.fn();
    const remove = installErrorRelay(window, send, () => true);
    for (let i = 0; i < MAX_ERROR_REPORTS_PER_PAGE + 15; i++) {
      post({ source: 'sitecraft', type: 'script-error', scriptId: 'a', message: String(i) });
    }
    remove();
    expect(send).toHaveBeenCalledTimes(MAX_ERROR_REPORTS_PER_PAGE);
  });
});

describe('computeJsIds', () => {
  it('returns the ids of enabled js scripts matching the url', () => {
    const scripts = [
      mk({ id: 'js-on', kind: 'js', enabled: true }),
      mk({ id: 'js-off', kind: 'js', enabled: false }),
      mk({ id: 'css-on', kind: 'css', enabled: true }),
      mk({ id: 'js-other', kind: 'js', enabled: true, urlPattern: 'https://b.com/*' }),
    ];
    expect([...computeJsIds(scripts, 'https://a.com/page')]).toEqual(['js-on']);
    expect(computeJsIds('garbage', 'https://a.com/').size).toBe(0);
  });
});
